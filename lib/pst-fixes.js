// Patches for pst-extractor, the library that reads OST/PST files. Applied once per process by install().
//  - a block cache for reads (the library reads byte by byte)
//  - per-block zlib decompression in 4K-page OST files (Outlook 2013+), keeping block boundaries
//  - 64 KB table row blocks in 4K-page OST files (the library assumes 8 KB and silently truncates large folders)
//  - embedded messages ("forwarded as attachment"), which the library always returns as null
'use strict';
const fs = require('fs');
const { PSTFile } = require('pst-extractor');

// pst-extractor issues one fs.readSync per byte in many places; route all reads through an LRU block cache
function installReadCache(cacheMb) {
  const BLOCK = 64 * 1024;
  const maxBlocks = Math.max(4, Math.floor((cacheMb * 1024 * 1024) / BLOCK));
  const original = PSTFile.prototype.readSync;
  const stats = { hits: 0, misses: 0 };

  PSTFile.prototype.readSync = function (buffer, length, position) {
    if (!(this.pstFD > 0)) return original.call(this, buffer, length, position);
    if (!this._blockCache) this._blockCache = new Map();
    const cache = this._blockCache;
    let done = 0;
    while (done < length) {
      const pos = position + done;
      const index = Math.floor(pos / BLOCK);
      let block = cache.get(index);
      if (block) {
        stats.hits++;
        cache.delete(index); // LRU: move to the end
        cache.set(index, block);
      } else {
        stats.misses++;
        const buf = Buffer.allocUnsafe(BLOCK);
        const n = fs.readSync(this.pstFD, buf, 0, BLOCK, index * BLOCK);
        block = n === BLOCK ? buf : buf.subarray(0, n);
        cache.set(index, block);
        if (cache.size > maxBlocks) cache.delete(cache.keys().next().value);
      }
      const offset = pos - index * BLOCK;
      if (offset >= block.length) break; // EOF
      const n = Math.min(length - done, block.length - offset);
      block.copy(buffer, done, offset, offset + n);
      done += n;
    }
    return done;
  };
  return stats;
}

// In 4K-page OST files Outlook deflates each data block individually and only when that saves space,
// so one attachment can mix compressed and raw blocks. pst-extractor decides from the first block for
// the whole stream ("incorrect header check"). Replace that with a per-block decision.
function installCompressionFix() {
  const { PSTNodeInputStream } = require('pst-extractor/dist/PSTNodeInputStream.class');
  const zlib = require('zlib');
  const ZLIB_LEVELS = new Set([0x01, 0x5e, 0x9c, 0xda]);
  const looksZlib = (b) => b.length >= 2 && b[0] === 0x78 && ZLIB_LEVELS.has(b[1]);
  const inflate = (b) => {
    if (!looksZlib(b)) return null;
    try { return zlib.inflateSync(b); } catch { return null; }
  };

  PSTNodeInputStream.prototype.detectZlib = function () {
    const Long = this._length.constructor;
    const file = this.pstFile;
    let data = null;
    let blockEnds = null;
    if (this.allData) {
      data = inflate(this.allData);
    } else if (this.indexItems.length) {
      // peek at each block's first two bytes; only read everything if some block is compressed
      const head = Buffer.alloc(2);
      const anyCompressed = this.indexItems.some((i) => {
        if (i.size < 2) return false;
        file.seek(i.fileOffset);
        file.readCompletely(head);
        return looksZlib(head);
      });
      if (anyCompressed) {
        let inflatedAny = false;
        const parts = this.indexItems.map((i) => {
          const raw = Buffer.alloc(i.size);
          file.seek(i.fileOffset);
          file.readCompletely(raw);
          const out = inflate(raw);
          if (out) inflatedAny = true;
          return out || raw;
        });
        if (inflatedAny) {
          data = Buffer.concat(parts);
          // keep the block boundaries: heaps spanning several blocks address them by block index
          let end = 0;
          blockEnds = parts.map((p) => Long.fromNumber((end += p.length)));
        }
      }
    }
    if (data) {
      this._blockEnds = blockEnds;
      this.allData = data;
      this.indexItems = [];
      this.skipPoints = [];
      this._length = Long.fromNumber(data.length);
    }
    this.currentBlock = 0;
    this._currentLocation = Long.ZERO;
    if (!this.allData && this.indexItems.length) file.seek(this.indexItems[0].fileOffset);
  };
  // Table rows stored in a subnode are packed per data block: 8176 bytes in PSTs, but 65512 bytes
  // (64 KB minus trailer) in 4K-page OSTs; pst-extractor always assumes 8176
  const { PSTTable7C } = require('pst-extractor/dist/PSTTable7C.class');
  Object.defineProperty(PSTTable7C.prototype, 'BLOCK_SIZE', {
    configurable: true,
    set() {},
    get() {
      const f = this.pstNodeInputStream && this.pstNodeInputStream.pstFile;
      return f && f.pstFileType === PSTFile.PST_TYPE_2013_UNICODE ? 65512 : 8176;
    },
  });
  const getBlockOffsets = PSTNodeInputStream.prototype.getBlockOffsets;
  PSTNodeInputStream.prototype.getBlockOffsets = function () {
    return this._blockEnds || getBlockOffsets.call(this);
  };
}

// pst-extractor creates attachments without a descriptor node and then refuses to build embedded messages
// ("forwarded as attachment", PR_ATTACH_METHOD 5), so they always come back as null. Rebuild them from the
// attachment's own subnodes instead.
function installEmbeddedMessageFix() {
  const Long = require('long');
  const { PSTAttachment } = require('pst-extractor/dist/PSTAttachment.class');
  const { PSTNodeInputStream } = require('pst-extractor/dist/PSTNodeInputStream.class');
  const { PSTTableBC } = require('pst-extractor/dist/PSTTableBC.class');
  const { PSTUtil } = require('pst-extractor/dist/PSTUtil.class');
  Object.defineProperty(PSTAttachment.prototype, 'embeddedPSTMessage', {
    configurable: true,
    get() {
      if (this.getIntItem(0x3705) !== 5) return null; // ATTACH_EMBEDDED_MSG
      const item = this.pstTableItems ? this.pstTableItems.get(0x3701) : null;
      if (!item) return null;
      let stream = null;
      let subnodes = new Map();
      if (item.entryValueType === 0x0102 && !item.isExternalValueReference) {
        stream = new PSTNodeInputStream(this.pstFile, item.data);
      } else if (item.entryValueType === 0x000d && item.data && item.data.length >= 4) {
        const node = this.localDescriptorItems ? this.localDescriptorItems.get(item.data.readUInt32LE(0)) : null;
        if (node) {
          stream = new PSTNodeInputStream(this.pstFile, node);
          if (node.subNodeOffsetIndexIdentifier > 0) subnodes = this.pstFile.getPSTDescriptorItems(Long.fromNumber(node.subNodeOffsetIndexIdentifier));
        }
      }
      if (!stream) return null;
      return PSTUtil.createAppropriatePSTMessageObject(this.pstFile, null, new PSTTableBC(stream), subnodes);
    },
  });
}

let installed = null;
// Returns the read cache statistics ({ hits, misses }); the cache size of the first call wins
function install(cacheMb = 64) {
  if (!installed) {
    installed = installReadCache(cacheMb);
    installCompressionFix();
    installEmbeddedMessageFix();
  }
  return installed;
}

module.exports = { install };
