#!/usr/bin/env node
// Writes the fictitious sample mailbox from content.js as OST and/or PST, structured like the
// files current Outlook writes:
//   OST  NDB version 36: 64-bit Unicode with 4K pages, zlib-compressed data blocks, no encryption
//        (Outlook 2013+ / Microsoft 365 in Exchange cached mode)
//   PST  NDB version 23: 64-bit Unicode with 512-byte pages, "compressible encryption" (NDB_CRYPT_PERMUTE)
// Both files contain the same mailbox. Converters are exercised by: deep folder trees, folder names with
// "/", ":" and emoji, multi-block heaps and table rows in subnodes (large folders), bodies stored in
// subnodes, HTML/plain/RTF-only bodies, inline (cid) images, embedded messages, multi-MB attachments,
// mixed compressed/raw blocks (OST), non-mail items (appointments, contacts, tasks, meeting requests),
// Unicode (umlauts, Cyrillic, Japanese, emoji), drafts, BCC, many recipients and junk mail with scripts.
//
// Usage: node sample/generate.js [file.ost] [file.pst] [--seed N]
//   without file names: sample-mailbox.ost and sample-mailbox.pst
//
// References: [MS-PST], libpff "Personal Folder File (PFF) format" (4k page sections).
'use strict';
const fs = require('fs');
const zlib = require('zlib');
const { PSTUtil } = require('pst-extractor/dist/PSTUtil.class');
const buildMailbox = require('./content');
const { mulberry32 } = require('./files');

const ARGS = process.argv.slice(2);
const seedAt = ARGS.indexOf('--seed');
const SEED = seedAt >= 0 ? Number(ARGS[seedAt + 1]) : 20261019;
const OUTPUTS = ARGS.filter((a, i) => !a.startsWith('--') && ARGS[i - 1] !== '--seed');
if (!OUTPUTS.length) OUTPUTS.push('sample-mailbox.ost', 'sample-mailbox.pst');
for (const o of OUTPUTS) {
  if (!/\.(ost|pst)$/i.test(o)) { console.error(`Unknown extension (expected .ost or .pst): ${o}`); process.exit(2); }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const FORMATS = {
  ost: { name: 'OST', page: 4096, pageTrailer: 24, blockAlign: 512, blockTrailer: 24, btEntries: 4056, amapOffset: 0x22000,
    amapUnit: 512, blockMax: 65512, wVer: 36, magic: 'SO', crypt: 0, compress: true, dlist: 0x21000, pmap: false, preallocate: true },
  pst: { name: 'PST', page: 512, pageTrailer: 16, blockAlign: 64, blockTrailer: 16, btEntries: 488, amapOffset: 0x4400,
    amapUnit: 64, blockMax: 8176, wVer: 23, magic: 'SM', crypt: 1, compress: false, dlist: 0, pmap: true, preallocate: true },
};
// Largest data block, also the unit heaps and table rows are packed into: 8 KB minus trailer in PSTs,
// 64 KB minus trailer in 4K-page OSTs (set per file in writeFile)
let BLOCK_DATA_MAX = 8176;
const MAX_HEAP_ALLOC = 3580;  // larger values go to subnodes
const xblockMax = () => Math.floor((BLOCK_DATA_MAX - 8) / 8);
const slblockMax = () => Math.floor((BLOCK_DATA_MAX - 8) / 24);

const PT_SHORT = 0x0002, PT_LONG = 0x0003, PT_BOOLEAN = 0x000b, PT_OBJECT = 0x000d, PT_LONGLONG = 0x0014;
const PT_UNICODE = 0x001f, PT_SYSTIME = 0x0040, PT_BINARY = 0x0102;

const NID_TYPE = { HID: 0, INTERNAL: 1, NORMAL_FOLDER: 2, SEARCH_FOLDER: 3, NORMAL_MESSAGE: 4, ATTACHMENT: 5, HIERARCHY_TABLE: 0x0d,
  CONTENTS_TABLE: 0x0e, ASSOC_CONTENTS_TABLE: 0x0f, LTP: 0x1f };
const NID_MESSAGE_STORE = 0x21;
const NID_NAME_TO_ID_MAP = 0x61;
const NID_ROOT_FOLDER = 0x122;
const NID_HIERARCHY_TABLE_TEMPLATE = 0x60d;
const NID_CONTENTS_TABLE_TEMPLATE = 0x60e;
const NID_ASSOC_CONTENTS_TABLE_TEMPLATE = 0x60f;
const NID_ATTACHMENT_TABLE = 0x671;
const NID_RECIPIENT_TABLE = 0x692;

const nid = (type, index) => ((index << 5) | type) >>> 0;
const tableNid = (folderNid, type) => ((folderNid & ~0x1f) | type) >>> 0;

// NDB_CRYPT_PERMUTE: pst-extractor carries the decode table, invert it for encoding
const PERMUTE = Buffer.alloc(256);
PSTUtil.compEnc.forEach((plain, enc) => { PERMUTE[plain] = enc; });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

// [MS-PST] 5.3 ComputeCRC (initial value 0, no final xor)
function crc32(buf, start = 0, end = buf.length) {
  let c = 0;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c >>> 0;
}

// [MS-PST] 5.5 ComputeSig
function computeSig(ib, bid) {
  const x = (Number(BigInt(ib) & 0xffffffffn) ^ Number(BigInt(bid) & 0xffffffffn)) >>> 0;
  return ((x >>> 16) ^ x) & 0xffff;
}

const align = (n, a) => Math.ceil(n / a) * a;
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const utf16 = (s) => Buffer.from(s, 'utf16le');
const split = (buf, size = BLOCK_DATA_MAX) => {
  if (!buf.length) return [buf];
  const out = [];
  for (let o = 0; o < buf.length; o += size) out.push(buf.subarray(o, o + size));
  return out;
};
const filetime = (date) => (BigInt(date.getTime()) + 11644473600000n) * 10000n;

function guidBytes(str) {
  const b = Buffer.from(str.replace(/-/g, ''), 'hex');
  return Buffer.concat([Buffer.from(b.subarray(0, 4)).reverse(), Buffer.from(b.subarray(4, 6)).reverse(), Buffer.from(b.subarray(6, 8)).reverse(), b.subarray(8, 16)]);
}


// ---------------------------------------------------------------------------
// LTP: Heap-on-Node (multi-block), BTH, Property Context, Table Context
// ---------------------------------------------------------------------------
class Heap {
  constructor(clientSig) {
    this.clientSig = clientSig;
    this.blocks = [[]];
    this.used = [12];
    this.userRoot = 0;
  }
  static headerSize(i) {
    if (i === 0) return 12;                        // HNHDR
    return i >= 8 && (i - 8) % 128 === 0 ? 66 : 2; // HNBITMAPHDR / HNPAGEHDR
  }
  fits(i, size) {
    return align(this.used[i] + size, 2) + 4 + 2 * (this.blocks[i].length + 2) <= BLOCK_DATA_MAX;
  }
  alloc(buf) {
    if (buf.length > MAX_HEAP_ALLOC) throw new Error(`heap allocation too large (${buf.length} bytes)`);
    let b = this.blocks.length - 1;
    if (!this.fits(b, buf.length)) {
      b++;
      this.blocks.push([]);
      this.used.push(Heap.headerSize(b));
    }
    this.blocks[b].push(buf);
    this.used[b] += buf.length;
    return ((b << 16) | (this.blocks[b].length << 5)) >>> 0;
  }
  build() {
    return this.blocks.map((allocs, i) => {
      const hdr = Buffer.alloc(Heap.headerSize(i));
      const offsets = [];
      let off = hdr.length;
      for (const a of allocs) { offsets.push(off); off += a.length; }
      offsets.push(off);
      const ibHnpm = align(off, 2);
      hdr.writeUInt16LE(ibHnpm, 0);
      if (i === 0) {
        hdr[2] = 0xec;
        hdr[3] = this.clientSig;
        hdr.writeUInt32LE(this.userRoot, 4);
      }
      const pageMap = Buffer.alloc(4 + offsets.length * 2);
      pageMap.writeUInt16LE(allocs.length, 0);
      offsets.forEach((o, k) => pageMap.writeUInt16LE(o, 4 + k * 2));
      return Buffer.concat([hdr, ...allocs, Buffer.alloc(ibHnpm - off), pageMap]);
    });
  }
}

// Values that do not fit into the heap are stored in subnodes of the node (NID_TYPE_LTP)
function subnodeSpace() {
  let index = 0x100;
  const items = [];
  return { items, add(chunks, subnodes = []) { const n = nid(NID_TYPE.LTP, index++); items.push({ nid: n, chunks, subnodes }); return n; } };
}

// BTH with a single leaf level; records = [[keyBuf, dataBuf], ...] sorted by key
function buildBTH(heap, cbKey, cbEnt, records) {
  const header = Buffer.alloc(8);
  const hid = heap.alloc(header);
  header[0] = 0xb5; header[1] = cbKey; header[2] = cbEnt; header[3] = 0;
  if (records.length) header.writeUInt32LE(heap.alloc(Buffer.concat(records.flat())), 4);
  return hid;
}

function encodeFixed(type, value) {
  switch (type) {
    case PT_SHORT: return u16(value);
    case PT_LONG: return u32(value);
    case PT_BOOLEAN: return Buffer.from([value ? 1 : 0]);
    case PT_LONGLONG: return u64(value);
    case PT_SYSTIME: return u64(filetime(value));
  }
  throw new Error('unsupported type ' + type);
}
const encodeVariable = (type, value) => (type === PT_UNICODE ? utf16(value) : Buffer.from(value));

// props: [[tag, value], ...]; value undefined/null = property absent
function buildPC(props, sub) {
  const heap = new Heap(0xbc);
  const header = Buffer.alloc(8);
  heap.userRoot = heap.alloc(header);
  const records = props.filter(([, v]) => v !== undefined && v !== null)
    .sort((a, b) => (a[0] >>> 16) - (b[0] >>> 16))
    .map(([tag, value]) => {
      const type = tag & 0xffff;
      let hnid;
      if (type === PT_SHORT || type === PT_LONG || type === PT_BOOLEAN) {
        const b = Buffer.alloc(4);
        encodeFixed(type, value).copy(b);
        hnid = b.readUInt32LE(0);
      } else if (type === PT_LONGLONG || type === PT_SYSTIME) {
        hnid = heap.alloc(encodeFixed(type, value));
      } else if (type === PT_OBJECT) {
        hnid = heap.alloc(Buffer.concat([u32(value.nid), u32(value.size)]));
      } else {
        const data = encodeVariable(type, value);
        hnid = data.length > MAX_HEAP_ALLOC ? sub.add(split(data)) : heap.alloc(data);
      }
      const data = Buffer.alloc(6);
      data.writeUInt16LE(type, 0);
      data.writeUInt32LE(hnid, 2);
      return [u16(tag >>> 16), data];
    });
  header[0] = 0xb5; header[1] = 2; header[2] = 6; header[3] = 0;
  if (records.length) header.writeUInt32LE(heap.alloc(Buffer.concat(records.flat())), 4);
  return heap.build();
}

function cellSize(type) {
  switch (type) {
    case PT_LONGLONG: case PT_SYSTIME: return 8;
    case PT_LONG: case PT_UNICODE: case PT_BINARY: return 4;
    case PT_SHORT: return 2;
    case PT_BOOLEAN: return 1;
  }
  throw new Error('unsupported column type ' + type);
}

const TAG_ROW_ID = 0x67f20003;
const TAG_ROW_VER = 0x67f30003;

// columns: [tag, ...]; rows: [{ rowId, values: { [tag]: value } }]
function buildTC(columnTags, rows, sub) {
  const heap = new Heap(0x7c);
  const tags = columnTags.filter((t) => t !== TAG_ROW_ID && t !== TAG_ROW_VER);
  const bySize = (s) => tags.filter((t) => cellSize(t & 0xffff) === s);
  const ordered = [TAG_ROW_ID, TAG_ROW_VER, ...bySize(8), ...bySize(4), ...bySize(2), ...bySize(1)];
  const cols = [];
  let ib = 0;
  const ends = {};
  ordered.forEach((tag, i) => {
    const cb = cellSize(tag & 0xffff);
    cols.push({ tag, ib, cb, iBit: i });
    ib += cb;
    if (cb >= 4) ends.b4 = ib;
    if (cb >= 2) ends.b2 = ib;
    ends.b1 = ib;
  });
  const ib4 = ends.b4, ib2 = ends.b2 ?? ib4, ib1 = ends.b1;
  const rowSize = ib1 + Math.ceil(cols.length / 8);

  // Row index BTH (dwRowID -> dwRowIndex) first, so its header is HID 0x20 like in Outlook's files
  const indexRecords = rows.map((r, i) => [u32(r.rowId), u32(i)]).sort((a, b) => a[0].readUInt32LE(0) - b[0].readUInt32LE(0));
  if (indexRecords.length * 8 > MAX_HEAP_ALLOC) throw new Error(`too many rows for a single-level row index (${rows.length})`);
  const hidRowIndex = buildBTH(heap, 4, 4, indexRecords);
  const tcinfo = Buffer.alloc(22 + cols.length * 8);
  heap.userRoot = heap.alloc(tcinfo);

  let hnidRows = 0;
  if (rows.length) {
    const matrix = Buffer.alloc(rowSize * rows.length);
    rows.forEach((r, ri) => {
      const base = ri * rowSize;
      const values = { ...r.values, [TAG_ROW_ID]: r.rowId, [TAG_ROW_VER]: r.rowVer ?? 1 };
      for (const c of cols) {
        const v = values[c.tag];
        if (v === undefined || v === null) continue;
        const type = c.tag & 0xffff;
        let cell;
        if (type === PT_UNICODE || type === PT_BINARY) {
          const data = encodeVariable(type, v);
          cell = u32(data.length > MAX_HEAP_ALLOC ? sub.add(split(data)) : heap.alloc(data));
        } else cell = encodeFixed(type, v);
        cell.copy(matrix, base + c.ib);
        matrix[base + ib1 + (c.iBit >> 3)] |= 0x80 >> (c.iBit & 7);
      }
    });
    if (matrix.length <= MAX_HEAP_ALLOC) {
      hnidRows = heap.alloc(matrix);
    } else {
      // Row matrix in a subnode: whole rows per 8 KB block, every block but the last padded to full size
      const perBlock = Math.floor(BLOCK_DATA_MAX / rowSize);
      const chunks = [];
      for (let r = 0; r < rows.length; r += perBlock) {
        const part = matrix.subarray(r * rowSize, Math.min(rows.length, r + perBlock) * rowSize);
        chunks.push(r + perBlock < rows.length ? Buffer.concat([part, Buffer.alloc(BLOCK_DATA_MAX - part.length)]) : part);
      }
      hnidRows = sub.add(chunks);
    }
  }

  tcinfo[0] = 0x7c;
  tcinfo[1] = cols.length;
  tcinfo.writeUInt16LE(ib4, 2);
  tcinfo.writeUInt16LE(ib2, 4);
  tcinfo.writeUInt16LE(ib1, 6);
  tcinfo.writeUInt16LE(rowSize, 8);
  tcinfo.writeUInt32LE(hidRowIndex, 10);
  tcinfo.writeUInt32LE(hnidRows, 14);
  [...cols].sort((a, b) => a.tag - b.tag).forEach((c, i) => {
    const o = 22 + i * 8;
    tcinfo.writeUInt32LE(c.tag, o);
    tcinfo.writeUInt16LE(c.ib, o + 4);
    tcinfo[o + 6] = c.cb;
    tcinfo[o + 7] = c.iBit;
  });
  return heap.build();
}

// ---------------------------------------------------------------------------
// Property tags
// ---------------------------------------------------------------------------
const P = {
  IMPORTANCE: 0x00170003, MESSAGE_CLASS: 0x001a001f, PRIORITY: 0x00260003, SENSITIVITY: 0x00360003,
  SUBJECT: 0x0037001f, CLIENT_SUBMIT_TIME: 0x00390040, SUBJECT_PREFIX: 0x003d001f,
  RECEIVED_BY_NAME: 0x0040001f, SENT_REPRESENTING_NAME: 0x0042001f, MESSAGE_TO_ME: 0x0057000b,
  MESSAGE_CC_ME: 0x0058000b, START_DATE: 0x00600040, END_DATE: 0x00610040, SENT_REPRESENTING_ADDRTYPE: 0x0064001f,
  SENT_REPRESENTING_EMAIL: 0x0065001f, CONVERSATION_TOPIC: 0x0070001f, CONVERSATION_INDEX: 0x00710102,
  RECEIVED_BY_ADDRTYPE: 0x0075001f, RECEIVED_BY_EMAIL: 0x0076001f, TRANSPORT_HEADERS: 0x007d001f,
  RECIPIENT_TYPE: 0x0c150003, SENDER_NAME: 0x0c1a001f, SENDER_ADDRTYPE: 0x0c1e001f, SENDER_EMAIL: 0x0c1f001f,
  DISPLAY_BCC: 0x0e02001f, DISPLAY_CC: 0x0e03001f, DISPLAY_TO: 0x0e04001f, MESSAGE_DELIVERY_TIME: 0x0e060040,
  MESSAGE_FLAGS: 0x0e070003, MESSAGE_SIZE: 0x0e080003, MESSAGE_STATUS: 0x0e170003, HASATTACH: 0x0e1b000b,
  NORMALIZED_SUBJECT: 0x0e1d001f, RTF_IN_SYNC: 0x0e1f000b, RESPONSIBILITY: 0x0e0f000b, ATTACH_SIZE: 0x0e200003,
  BODY: 0x1000001f, RTF_COMPRESSED: 0x10090102, HTML: 0x10130102, INTERNET_MESSAGE_ID: 0x1035001f, NATIVE_BODY: 0x10160003,
  FLAG_STATUS: 0x10900003, FOLLOWUP_ICON: 0x10950003,
  RECORD_KEY: 0x0ff90102, OBJECT_TYPE: 0x0ffe0003, ENTRYID: 0x0fff0102, SEARCH_KEY: 0x300b0102,
  DISPLAY_NAME: 0x3001001f, ADDRTYPE: 0x3002001f, EMAIL_ADDRESS: 0x3003001f,
  CREATION_TIME: 0x30070040, LAST_MODIFICATION_TIME: 0x30080040,
  VALID_FOLDER_MASK: 0x35df0003, IPM_SUBTREE_ENTRYID: 0x35e00102, IPM_OUTBOX_ENTRYID: 0x35e20102,
  IPM_WASTEBASKET_ENTRYID: 0x35e30102, IPM_SENTMAIL_ENTRYID: 0x35e40102, FINDER_ENTRYID: 0x35e70102,
  CONTENT_COUNT: 0x36020003, CONTENT_UNREAD: 0x36030003, SUBFOLDERS: 0x360a000b, CONTAINER_CLASS: 0x3613001f,
  ATTACH_DATA: 0x37010102, ATTACH_DATA_OBJ: 0x3701000d, ATTACH_EXTENSION: 0x3703001f, ATTACH_FILENAME: 0x3704001f,
  ATTACH_METHOD: 0x37050003, ATTACH_LONG_FILENAME: 0x3707001f, RENDERING_POSITION: 0x370b0003, ATTACH_MIME_TAG: 0x370e001f,
  ATTACH_CONTENT_ID: 0x3712001f, ATTACH_FLAGS: 0x37140003, ATTACHMENT_HIDDEN: 0x7ffe000b,
  DISPLAY_TYPE: 0x39000003, SMTP_ADDRESS: 0x39fe001f, DISPLAY_NAME_7BIT: 0x39ff001f, SEND_RICH_INFO: 0x3a40000b,
  GIVEN_NAME: 0x3a06001f, BUSINESS_PHONE: 0x3a08001f, SURNAME: 0x3a11001f, COMPANY_NAME: 0x3a16001f, TITLE: 0x3a17001f,
  MOBILE_PHONE: 0x3a1c001f,
  INTERNET_CPID: 0x3fde0003, MESSAGE_LOCALE_ID: 0x3ff10003, MESSAGE_CODEPAGE: 0x3ffd0003,
  SENDER_SMTP: 0x5d01001f, SENT_REPRESENTING_SMTP: 0x5d02001f,
  SOURCE_KEY: 0x65e00102, PARENT_SOURCE_KEY: 0x65e10102, CHANGE_KEY: 0x65e20102,
  PST_HIDDEN_COUNT: 0x66330003, PST_HIDDEN_UNREAD: 0x66340003,
};

// Named properties: tag = 0x8000 + index in this list
const PSETID = {
  Common: '00062008-0000-0000-C000-000000000046', Task: '00062003-0000-0000-C000-000000000046',
  Appointment: '00062002-0000-0000-C000-000000000046', Address: '00062004-0000-0000-C000-000000000046',
  Meeting: '6ED8DA90-450B-101B-98DA-00AA003F1305',
};
const NAMED = [
  { key: 'SmartNoAttach', set: 'Common', lid: 0x8514, type: PT_BOOLEAN },
  { key: 'AgingDontAgeMe', set: 'Common', lid: 0x8582, type: PT_BOOLEAN },
  { key: 'TaskComplete', set: 'Task', lid: 0x811c, type: PT_BOOLEAN },
  { key: 'TaskStatus', set: 'Task', lid: 0x8101, type: PT_LONG },
  { key: 'TaskDueDate', set: 'Task', lid: 0x8105, type: PT_SYSTIME },
  { key: 'BusyStatus', set: 'Appointment', lid: 0x8205, type: PT_LONG },
  { key: 'Location', set: 'Appointment', lid: 0x8208, type: PT_UNICODE },
  { key: 'AppointmentStartWhole', set: 'Appointment', lid: 0x820d, type: PT_SYSTIME },
  { key: 'AppointmentEndWhole', set: 'Appointment', lid: 0x820e, type: PT_SYSTIME },
  { key: 'AppointmentDuration', set: 'Appointment', lid: 0x8213, type: PT_LONG },
  { key: 'AppointmentSubType', set: 'Appointment', lid: 0x8215, type: PT_BOOLEAN },
  { key: 'AppointmentRecur', set: 'Appointment', lid: 0x8216, type: PT_BINARY },
  { key: 'Recurring', set: 'Appointment', lid: 0x8223, type: PT_BOOLEAN },
  { key: 'TimeZoneStruct', set: 'Appointment', lid: 0x8233, type: PT_BINARY },
  { key: 'TimeZoneDescription', set: 'Appointment', lid: 0x8234, type: PT_UNICODE },
  { key: 'ReminderDelta', set: 'Common', lid: 0x8501, type: PT_LONG },
  { key: 'ReminderSet', set: 'Common', lid: 0x8503, type: PT_BOOLEAN },
  { key: 'GlobalObjectId', set: 'Meeting', lid: 0x0003, type: PT_BINARY },
  { key: 'FileUnder', set: 'Address', lid: 0x8005, type: PT_UNICODE },
  { key: 'Email1DisplayName', set: 'Address', lid: 0x8080, type: PT_UNICODE },
  { key: 'Email1AddressType', set: 'Address', lid: 0x8082, type: PT_UNICODE },
  { key: 'Email1EmailAddress', set: 'Address', lid: 0x8083, type: PT_UNICODE },
  { key: 'x-ms-exchange-organization-authas', name: 'x-ms-exchange-organization-authas', type: PT_UNICODE },
];
const N = Object.fromEntries(NAMED.map((n, i) => [n.key, (((0x8000 + i) << 16) | n.type) >>> 0]));

// ---------------------------------------------------------------------------
// Calendar: time zone (TZREG) and recurrence ([MS-OXOCAL] AppointmentRecurrencePattern)
// ---------------------------------------------------------------------------
const ZURICH = {
  description: '(UTC+01:00) Amsterdam, Berlin, Bern, Rome, Stockholm, Vienna',
  bias: -60, stdBias: 0, dstBias: -60,
  std: { month: 10, dow: 0, week: 5, hour: 3 }, // last Sunday in October, 03:00 local
  dst: { month: 3, dow: 0, week: 5, hour: 2 },  // last Sunday in March, 02:00 local
};
function tzReg(tz) {
  const b = Buffer.alloc(48);
  b.writeInt32LE(tz.bias, 0); b.writeInt32LE(tz.stdBias, 4); b.writeInt32LE(tz.dstBias, 8);
  const st = (o, r) => { b.writeUInt16LE(r.month, o + 2); b.writeUInt16LE(r.dow, o + 4); b.writeUInt16LE(r.week, o + 6); b.writeUInt16LE(r.hour, o + 8); };
  st(14, tz.std); // wStandardYear at 12, stStandardDate at 14
  st(32, tz.dst); // wDaylightYear at 30, stDaylightDate at 32
  return b;
}
// UTC -> Zurich wall-clock time (returned as a Date whose UTC fields hold the local time)
function toZurich(utc) {
  const y = utc.getUTCFullYear();
  const lastSundayUtc = (m) => { const d = new Date(Date.UTC(y, m + 1, 0, 1)); d.setUTCDate(d.getUTCDate() - d.getUTCDay()); return d; };
  const dst = utc >= lastSundayUtc(2) && utc < lastSundayUtc(9); // switches happen at 01:00 UTC
  return new Date(utc.getTime() + (dst ? 2 : 1) * 3600000);
}
const minutes1601 = (wallClock) => Math.round((wallClock.getTime() + 11644473600000) / 60000);
const dayMinutes = (ymd) => { const [y, m, d] = ymd.split('-').map(Number); return minutes1601(new Date(Date.UTC(y, m - 1, d))); };

// rec: { freq: daily|weekly|monthly|yearly, interval, days: [0=Sun..6], monthDay, nth (5 = last),
//        end: never|count|until, count, until: 'YYYY-MM-DD', deleted: ['YYYY-MM-DD'],
//        modified: [{ date, start: [h, m], end: [h, m], subject }] }
function recurrenceBlob(rec, startLocal, durationMin) {
  const out = [];
  const w16 = (v) => out.push(u16(v));
  const w32 = (v) => out.push(u32(v));
  const startDate = minutes1601(new Date(Date.UTC(startLocal.getUTCFullYear(), startLocal.getUTCMonth(), startLocal.getUTCDate())));
  const startOffset = startLocal.getUTCHours() * 60 + startLocal.getUTCMinutes();
  const mask = (rec.days || []).reduce((m, d) => m | (1 << d), 0);
  let patternType, period, specific;
  if (rec.freq === 'daily') { patternType = 0; period = rec.interval * 1440; specific = []; }
  else if (rec.freq === 'weekly') { patternType = 1; period = rec.interval; specific = [mask]; }
  else if (rec.nth) { patternType = 3; period = rec.interval * (rec.freq === 'yearly' ? 12 : 1); specific = [mask, rec.nth]; }
  else { patternType = rec.monthDay === -1 ? 4 : 2; period = rec.interval * (rec.freq === 'yearly' ? 12 : 1); specific = [rec.monthDay === -1 ? 31 : rec.monthDay]; }
  const frequency = { daily: 0x200a, weekly: 0x200b, monthly: 0x200c, yearly: 0x200d }[rec.freq];
  const periodMinutes = patternType === 0 ? period : patternType === 1 ? period * 10080 : period * 43200;
  w16(0x3004); w16(0x3004); w16(frequency); w16(patternType); w16(0 /* Gregorian */);
  w32(startDate % periodMinutes); w32(period); w32(0 /* SlidingFlag */);
  specific.forEach(w32);
  w32({ until: 0x2021, count: 0x2022, never: 0x2023 }[rec.end]);
  w32(rec.end === 'count' ? rec.count : 10);
  w32(1 /* FirstDOW: Monday */);
  const modified = rec.modified || [];
  const deleted = [...(rec.deleted || []), ...modified.map((x) => x.date)].map(dayMinutes).sort((a, b) => a - b);
  w32(deleted.length); deleted.forEach(w32);
  const modifiedDays = modified.map((x) => dayMinutes(x.date)).sort((a, b) => a - b);
  w32(modifiedDays.length); modifiedDays.forEach(w32);
  w32(startDate);
  w32(rec.end === 'until' ? dayMinutes(rec.until) : rec.end === 'count' ? startDate + 366 * 1440 : 0x5ae980df); // 31.12.4500 = no end
  w32(0x3006); w32(0x3008); // ReaderVersion2, WriterVersion2 (< 0x3009: no ChangeHighlight)
  w32(startOffset); w32(startOffset + durationMin);
  w16(modified.length);
  const exceptions = modified.map((x) => {
    const day = dayMinutes(x.date);
    return { start: day + x.start[0] * 60 + x.start[1], end: day + x.end[0] * 60 + x.end[1], original: day + startOffset, subject: x.subject };
  });
  for (const e of exceptions) {
    w32(e.start); w32(e.end); w32(e.original); w16(e.subject !== undefined ? 0x0001 : 0);
    if (e.subject !== undefined) { const s = Buffer.from(e.subject, 'latin1'); w16(s.length + 1); w16(s.length); out.push(s); }
  }
  w32(0); // ReservedBlock1Size
  for (const e of exceptions) {
    w32(0); // ReservedBlockEE1Size
    if (e.subject !== undefined) {
      w32(e.start); w32(e.end); w32(e.original);
      w16(e.subject.length); out.push(Buffer.from(e.subject, 'utf16le')); // length in UTF-16 code units
      w32(0); // ReservedBlockEE2Size
    }
  }
  w32(0); // ReservedBlock2Size
  return Buffer.concat(out);
}

const HIERARCHY_COLUMNS = [P.DISPLAY_NAME, P.CONTENT_COUNT, P.CONTENT_UNREAD, P.SUBFOLDERS, P.CONTAINER_CLASS, P.PST_HIDDEN_COUNT, P.PST_HIDDEN_UNREAD];
const CONTENTS_COLUMNS = [P.IMPORTANCE, P.MESSAGE_CLASS, P.SENSITIVITY, P.SUBJECT, P.CLIENT_SUBMIT_TIME, P.SENT_REPRESENTING_NAME,
  P.MESSAGE_TO_ME, P.MESSAGE_CC_ME, P.CONVERSATION_TOPIC, P.CONVERSATION_INDEX, P.DISPLAY_CC, P.DISPLAY_TO, P.MESSAGE_DELIVERY_TIME,
  P.MESSAGE_FLAGS, P.MESSAGE_SIZE, P.MESSAGE_STATUS, P.HASATTACH, P.LAST_MODIFICATION_TIME, P.SEARCH_KEY, P.SOURCE_KEY];
const ASSOC_COLUMNS = [P.MESSAGE_CLASS, P.SUBJECT, P.MESSAGE_FLAGS, P.MESSAGE_SIZE, P.LAST_MODIFICATION_TIME];
const RECIPIENT_COLUMNS = [P.RECIPIENT_TYPE, P.RESPONSIBILITY, P.RECORD_KEY, P.OBJECT_TYPE, P.ENTRYID, P.DISPLAY_NAME, P.ADDRTYPE,
  P.EMAIL_ADDRESS, P.SEARCH_KEY, P.DISPLAY_TYPE, P.SMTP_ADDRESS, P.DISPLAY_NAME_7BIT, P.SEND_RICH_INFO];
const ATTACHMENT_COLUMNS = [P.ATTACH_SIZE, P.ATTACH_FILENAME, P.ATTACH_METHOD, P.RENDERING_POSITION];

// ---------------------------------------------------------------------------
// Writer for one file
// ---------------------------------------------------------------------------
function writeFile(out, fmt, box) {
  BLOCK_DATA_MAX = fmt.blockMax;
  const rnd = mulberry32(SEED ^ 0x5eed); // identical keys in OST and PST
  const bytes = (n) => { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = (rnd() * 256) | 0; return b; };
  const ndb = { blocks: [], nodes: [], nextBid: 4n, nextPageBid: 1n };

  function addBlock(raw, internal = false) {
    if (raw.length > BLOCK_DATA_MAX) throw new Error(`block too large (${raw.length})`);
    const bid = ndb.nextBid | (internal ? 2n : 0n);
    ndb.nextBid += 4n;
    let data = raw;
    if (!internal && fmt.compress) {
      const z = zlib.deflateSync(raw, { level: 6 }); // Outlook deflates a 4K-OST data block only when that saves space
      if (z.length < raw.length) data = z;
    } else if (!internal && fmt.crypt === 1) {
      data = Buffer.allocUnsafe(raw.length);
      for (let i = 0; i < raw.length; i++) data[i] = PERMUTE[raw[i]];
    }
    ndb.blocks.push({ bid, data, size: data.length, cbInflated: raw.length });
    return bid;
  }

  // Data tree: single block, XBLOCK (up to ~8 MB) or XXBLOCK
  function addDataTree(chunks) {
    if (chunks.length === 1) return addBlock(chunks[0]);
    const xblock = (bids, level, total) => {
      const x = Buffer.alloc(8 + bids.length * 8);
      x[0] = 0x01; x[1] = level;
      x.writeUInt16LE(bids.length, 2);
      x.writeUInt32LE(total, 4);
      bids.forEach((b, i) => x.writeBigUInt64LE(b, 8 + i * 8));
      return addBlock(x, true);
    };
    const sizes = chunks.map((c) => c.length);
    const bids = chunks.map((c) => addBlock(c));
    const total = sizes.reduce((a, b) => a + b, 0);
    if (bids.length <= xblockMax()) return xblock(bids, 1, total);
    const xbids = [];
    for (let i = 0; i < bids.length; i += xblockMax()) {
      xbids.push(xblock(bids.slice(i, i + xblockMax()), 1, sizes.slice(i, i + xblockMax()).reduce((a, b) => a + b, 0)));
    }
    if (xbids.length > xblockMax()) throw new Error('data too large');
    return xblock(xbids, 2, total);
  }

  // subnodes: [{ nid, chunks: Buffer[], subnodes: [...] }]
  function addSubnodeTree(subnodes) {
    if (subnodes.length > slblockMax()) throw new Error('too many subnodes');
    const entries = subnodes.map((s) => ({ nid: s.nid, bid: addDataTree(s.chunks), sub: s.subnodes && s.subnodes.length ? addSubnodeTree(s.subnodes) : 0n }))
      .sort((a, b) => a.nid - b.nid);
    const sl = Buffer.alloc(8 + entries.length * 24);
    sl[0] = 0x02; sl[1] = 0x00;
    sl.writeUInt16LE(entries.length, 2);
    entries.forEach((e, i) => {
      sl.writeBigUInt64LE(BigInt(e.nid), 8 + i * 24);
      sl.writeBigUInt64LE(e.bid, 16 + i * 24);
      sl.writeBigUInt64LE(e.sub, 24 + i * 24);
    });
    return addBlock(sl, true);
  }

  function addNode(nidValue, chunks, { parent = 0, subnodes = [] } = {}) {
    ndb.nodes.push({ nid: nidValue, bidData: addDataTree(chunks), bidSub: subnodes.length ? addSubnodeTree(subnodes) : 0n, nidParent: parent });
  }

  // --- Identifiers ---------------------------------------------------------------
  const STORE_UID = bytes(16);
  const REPLICA_GUID = bytes(16);
  let changeCounter = 0x1000;
  const entryId = (n) => Buffer.concat([Buffer.alloc(4), STORE_UID, u32(n)]);
  const sourceKey = () => { const gc = Buffer.alloc(6); gc.writeUIntBE(++changeCounter, 0, 6); return Buffer.concat([REPLICA_GUID, gc]); };
  const changeKey = () => Buffer.concat([REPLICA_GUID, u32(changeCounter++)]);
  const conversationIndex = (date) => {
    const b = Buffer.alloc(22);
    const hi = Buffer.alloc(8);
    hi.writeBigUInt64BE(filetime(date));
    b[0] = 0x01;
    hi.copy(b, 1, 0, 5);
    bytes(16).copy(b, 6);
    return b;
  };
  const owner = box.owner;
  let folderIndex = 1025;   // rgnid[NID_TYPE_NORMAL_FOLDER] starts at 1024
  let messageIndex = 65537; // rgnid[NID_TYPE_NORMAL_MESSAGE] starts at 65536

  // --- Store layout: OST like Exchange cached mode, PST like an Outlook data file -----
  const ipmSubtree = { name: fmt.magic === 'SO' ? 'IPM_SUBTREE' : 'Top of Outlook data file', cls: '', items: [], children: box.folders };
  let rootFolder;
  let finder;
  if (fmt.magic === 'SO') {
    finder = { name: 'Finder', cls: '', items: [], children: [] };
    rootFolder = { name: '', items: [], children: [{ name: 'Root - Mailbox', cls: '', items: [], children: [
      ipmSubtree, finder, { name: 'Common Views', cls: '', items: [], children: [] }, { name: 'Freebusy Data', cls: '', items: [], children: [] }] }] };
  } else {
    finder = { name: 'Search Root', cls: '', items: [], children: [] };
    rootFolder = { name: '', items: [], children: [ipmSubtree, finder] };
  }
  rootFolder.nid = NID_ROOT_FOLDER;
  (function assign(f, isRoot) {
    if (!isRoot) f.nid = nid(NID_TYPE.NORMAL_FOLDER, folderIndex++);
    f.sourceKey = sourceKey();
    f.children.forEach((c) => assign(c, false));
  })(rootFolder, true);

  addNode(NID_MESSAGE_STORE, buildPC([
    [P.RECORD_KEY, STORE_UID],
    [P.DISPLAY_NAME, fmt.magic === 'SO' ? owner.email : 'Outlook Data File'],
    [P.IPM_SUBTREE_ENTRYID, entryId(ipmSubtree.nid)],
    [P.IPM_SENTMAIL_ENTRYID, entryId(box.special.sent.nid)],
    [P.IPM_WASTEBASKET_ENTRYID, entryId(box.special.deleted.nid)],
    [P.IPM_OUTBOX_ENTRYID, entryId(box.special.outbox.nid)],
    [P.FINDER_ENTRYID, entryId(finder.nid)],
    [P.VALID_FOLDER_MASK, 0xff],
    [0x340d0003 /* STORE_SUPPORT_MASK */, 0x00340b7d],
  ], subnodeSpace()));

  // Name-to-ID map
  (function buildNameToIdMap() {
    const sets = [...new Set(NAMED.filter((n) => n.set).map((n) => n.set))];
    const guidStream = Buffer.concat(sets.map((s) => guidBytes(PSETID[s])));
    const stringParts = [];
    let stringOff = 0;
    const buckets = new Map();
    const entries = NAMED.map((n, i) => {
      const e = Buffer.alloc(8);
      let wGuid, hashKey;
      if (n.name) {
        const s = utf16(n.name);
        const part = Buffer.concat([u32(s.length), s]);
        stringParts.push(Buffer.concat([part, Buffer.alloc(align(part.length, 4) - part.length)]));
        e.writeUInt32LE(stringOff, 0);
        stringOff += align(part.length, 4);
        wGuid = (2 << 1) | 1; // PS_PUBLIC_STRINGS, string name
        hashKey = crc32(s);
      } else {
        e.writeUInt32LE(n.lid, 0);
        wGuid = (3 + sets.indexOf(n.set)) << 1;
        hashKey = n.lid;
      }
      e.writeUInt16LE(wGuid, 4);
      e.writeUInt16LE(i, 6);
      const b = ((hashKey ^ wGuid) >>> 0) % 251;
      if (!buckets.has(b)) buckets.set(b, []);
      buckets.get(b).push(e);
      return e;
    });
    const props = [[0x00010003, 251], [0x00020102, guidStream], [0x00030102, Buffer.concat(entries)], [0x00040102, Buffer.concat(stringParts)]];
    for (const [b, list] of buckets) props.push([(((0x1000 + b) << 16) | PT_BINARY) >>> 0, Buffer.concat(list)]);
    addNode(NID_NAME_TO_ID_MAP, buildPC(props, subnodeSpace()));
  })();

  const empty = (cols) => buildTC(cols, [], subnodeSpace());
  addNode(NID_HIERARCHY_TABLE_TEMPLATE, empty(HIERARCHY_COLUMNS));
  addNode(NID_CONTENTS_TABLE_TEMPLATE, empty(CONTENTS_COLUMNS));
  addNode(NID_ASSOC_CONTENTS_TABLE_TEMPLATE, empty(ASSOC_COLUMNS));
  addNode(NID_ATTACHMENT_TABLE, empty(ATTACHMENT_COLUMNS));
  addNode(NID_RECIPIENT_TABLE, empty(RECIPIENT_COLUMNS));

  // --- Messages ------------------------------------------------------------------------
  function recipientRow(person, type, i) {
    const searchKey = Buffer.from(`SMTP:${person.email.toUpperCase()}\0`, 'ascii');
    const oneOff = Buffer.concat([Buffer.alloc(4), guidBytes('A41F2B81-A3BE-1910-9D6E-00DD010F5402'), u16(0), u16(0x8190),
      utf16(person.name + '\0'), utf16('SMTP\0'), utf16(person.email + '\0')]);
    return { rowId: i, values: {
      [P.RECIPIENT_TYPE]: type, [P.RESPONSIBILITY]: false, [P.RECORD_KEY]: oneOff, [P.OBJECT_TYPE]: 6, [P.ENTRYID]: oneOff,
      [P.DISPLAY_NAME]: person.name, [P.ADDRTYPE]: 'SMTP', [P.EMAIL_ADDRESS]: person.email, [P.SEARCH_KEY]: searchKey,
      [P.DISPLAY_TYPE]: 0, [P.SMTP_ADDRESS]: person.email, [P.DISPLAY_NAME_7BIT]: person.name, [P.SEND_RICH_INFO]: false } };
  }

  const isMailLike = (m) => /^IPM\.(Note|Schedule)/.test(m.cls);
  const rfcDate = (d) => d.toUTCString().replace('GMT', '+0000');
  const addressList = (list) => list.map((p) => `${/[^\x20-\x7e]|[,;"]/.test(p.name) ? `"${p.name.replace(/"/g, '')}"` : p.name} <${p.email}>`).join(', ');

  // Returns { chunks, subnodes } of a message object; also used for embedded messages
  function messageObject(m, folder) {
    const sub = subnodeSpace();
    const date = m.date;
    const delivered = m.draft ? null : new Date(date.getTime() + 3000);
    m.normalized = m.prefix ? m.subject.slice(m.prefix.length) : m.subject;
    m.deliveredAt = delivered || date;
    m.hasAttach = m.attachments.some((a) => !a.hidden);
    m.flags = (m.read || m.sent || m.draft ? 0x01 : 0) | (m.draft ? 0x08 : 0) | (m.attachments.length ? 0x10 : 0) | (m.sent || m.draft ? 0x20 : 0);
    m.searchKey = bytes(16);
    m.sourceKey = sourceKey();
    m.convIndex = conversationIndex(date);
    const bodyText = (m.text || '').replace(/\r?\n/g, '\r\n');
    const html = m.format === 'html' && m.html ? Buffer.from(m.html, 'utf8') : null;
    m.size = 1200 + bodyText.length * 2 + (html ? html.length : 0) + m.attachments.reduce((s, a) => s + (a.data ? a.data.length : 4000) + 400, 0);
    const toMe = m.to.some((p) => p.email === owner.email);
    const ccMe = m.cc.some((p) => p.email === owner.email);
    const msgId = `<${bytes(12).toString('hex').toUpperCase()}@${m.from.email.split('@')[1]}>`;

    const props = [
      [P.MESSAGE_CLASS, m.cls], [P.SUBJECT, m.subject], [P.SUBJECT_PREFIX, m.prefix], [P.NORMALIZED_SUBJECT, m.normalized],
      [P.CONVERSATION_TOPIC, m.normalized], [P.CONVERSATION_INDEX, m.convIndex],
      [P.IMPORTANCE, m.importance], [P.PRIORITY, 0], [P.SENSITIVITY, m.sensitivity || 0],
      [P.CLIENT_SUBMIT_TIME, m.draft ? null : date], [P.MESSAGE_DELIVERY_TIME, delivered],
      [P.CREATION_TIME, m.deliveredAt], [P.LAST_MODIFICATION_TIME, m.deliveredAt],
      [P.MESSAGE_FLAGS, m.flags], [P.MESSAGE_SIZE, m.size], [P.MESSAGE_STATUS, 0], [P.HASATTACH, m.hasAttach],
      [P.SENDER_NAME, m.from.name], [P.SENDER_ADDRTYPE, 'SMTP'], [P.SENDER_EMAIL, m.from.email], [P.SENDER_SMTP, m.from.email],
      [P.SENT_REPRESENTING_NAME, m.from.name], [P.SENT_REPRESENTING_ADDRTYPE, 'SMTP'], [P.SENT_REPRESENTING_EMAIL, m.from.email],
      [P.SENT_REPRESENTING_SMTP, m.from.email],
      [P.DISPLAY_TO, m.to.map((p) => p.name).join('; ')], [P.DISPLAY_CC, m.cc.map((p) => p.name).join('; ')],
      [P.DISPLAY_BCC, m.bcc.map((p) => p.name).join('; ')], [P.MESSAGE_TO_ME, toMe], [P.MESSAGE_CC_ME, ccMe],
      [P.INTERNET_CPID, 65001], [P.MESSAGE_CODEPAGE, 65001], [P.MESSAGE_LOCALE_ID, 0x0809], // en-GB
      [P.SEARCH_KEY, m.searchKey], [P.SOURCE_KEY, m.sourceKey], [P.PARENT_SOURCE_KEY, folder ? folder.sourceKey : null],
      [P.CHANGE_KEY, changeKey()],
    ];
    if (m.format === 'rtf') {
      // PR_RTF_COMPRESSED in the uncompressed variant ("MELA"), no plain text or HTML body
      const raw = Buffer.from(m.rtf, 'latin1');
      const hdr = Buffer.alloc(16);
      hdr.writeUInt32LE(raw.length + 12, 0); hdr.writeUInt32LE(raw.length, 4); hdr.writeUInt32LE(0x414c454d, 8);
      props.push([P.RTF_COMPRESSED, Buffer.concat([hdr, raw])], [P.RTF_IN_SYNC, true], [P.NATIVE_BODY, 2]);
    } else {
      props.push([P.BODY, bodyText], [P.HTML, html], [P.NATIVE_BODY, html ? 3 : 1]);
    }
    if (isMailLike(m) && !m.draft) props.push([P.INTERNET_MESSAGE_ID, msgId]);
    if (m.flagged) props.push([P.FLAG_STATUS, 2], [P.FOLLOWUP_ICON, 6]);
    if (m.cls === 'IPM.Schedule.Meeting.Request' || m.cls === 'IPM.Appointment') {
      props.push([P.START_DATE, m.start], [P.END_DATE, m.end], [N.Location, m.location], [N.AppointmentStartWhole, m.start],
        [N.AppointmentEndWhole, m.end], [N.AppointmentDuration, Math.round((m.end - m.start) / 60000)], [N.BusyStatus, m.busy ?? 2],
        [N.AppointmentSubType, !!m.allDay], [N.Recurring, !!m.recurrence],
        [N.TimeZoneStruct, tzReg(ZURICH)], [N.TimeZoneDescription, ZURICH.description],
        // GlobalObjectId: 0x04000000 0x82 0x00 0xE0 0x00 ... (meeting object id class) + random instance id
        [N.GlobalObjectId, Buffer.concat([Buffer.from('040000008200E00074C5B7101A82E008', 'hex'), Buffer.alloc(20), bytes(16)])]);
      if (m.recurrence) props.push([N.AppointmentRecur, recurrenceBlob(m.recurrence, toZurich(m.start), Math.round((m.end - m.start) / 60000))]);
      if (m.reminder) props.push([N.ReminderSet, true], [N.ReminderDelta, m.reminder]);
    }
    if (m.cls === 'IPM.Contact') {
      const p = m.person;
      props.push([P.DISPLAY_NAME, p.name], [P.GIVEN_NAME, p.first], [P.SURNAME, p.last], [P.COMPANY_NAME, p.company], [P.TITLE, p.title],
        [P.BUSINESS_PHONE, p.phone], [P.MOBILE_PHONE, m.mobile], [N.FileUnder, p.last ? `${p.last}, ${p.first}` : p.name],
        [N.Email1DisplayName, `${p.name} (${p.email})`], [N.Email1AddressType, 'SMTP'], [N.Email1EmailAddress, p.email]);
    }
    if (m.cls === 'IPM.Task') {
      props.push([N.TaskDueDate, m.due], [N.TaskStatus, m.status], [N.TaskComplete, m.status === 2]);
    }
    if (isMailLike(m) && !m.sent && !m.draft) {
      props.push([P.RECEIVED_BY_NAME, owner.name], [P.RECEIVED_BY_ADDRTYPE, 'SMTP'], [P.RECEIVED_BY_EMAIL, owner.email]);
      const domain = m.from.email.split('@')[1];
      props.push([P.TRANSPORT_HEADERS,
        `Received: from mail.${domain} (mail.${domain} [192.0.2.${10 + (m.sourceKey[20] % 200)}]) by mx1.contoso.com with ESMTPS; ${rfcDate(delivered)}\r\n` +
        `Authentication-Results: mx1.contoso.com; spf=${domain.endsWith('.example') ? 'fail' : 'pass'} smtp.mailfrom=${domain}\r\n` +
        `From: ${addressList([m.from])}\r\nTo: ${addressList(m.to)}\r\n${m.cc.length ? `Cc: ${addressList(m.cc)}\r\n` : ''}` +
        `Subject: ${m.subject}\r\nDate: ${rfcDate(date)}\r\nMessage-ID: ${msgId}\r\nMIME-Version: 1.0\r\n` +
        `Content-Type: ${m.attachments.length ? 'multipart/mixed' : m.format === 'text' ? 'text/plain; charset="utf-8"' : 'multipart/alternative'}\r\n` +
        `Content-Language: en-GB\r\n\r\n`]);
    }

    const recipients = [
      ...m.to.map((p, i) => recipientRow(p, 1 /* MAPI_TO */, i)),
      ...m.cc.map((p, i) => recipientRow(p, 2 /* MAPI_CC */, m.to.length + i)),
      ...m.bcc.map((p, i) => recipientRow(p, 3 /* MAPI_BCC */, m.to.length + m.cc.length + i)),
    ];
    const subnodes = [{ nid: NID_RECIPIENT_TABLE, chunks: buildTC(RECIPIENT_COLUMNS, recipients, sub), subnodes: [] }];

    const atts = m.attachments.map((a, i) => ({ ...a, nid: nid(NID_TYPE.ATTACHMENT, 0x401 + i) }));
    if (atts.length) {
      subnodes.push({ nid: NID_ATTACHMENT_TABLE, subnodes: [], chunks: buildTC(ATTACHMENT_COLUMNS, atts.map((a) => ({
        rowId: a.nid, values: { [P.ATTACH_SIZE]: (a.data ? a.data.length : 4000) + 400, [P.ATTACH_FILENAME]: a.name,
          [P.ATTACH_METHOD]: a.embedded ? 5 : 1, [P.RENDERING_POSITION]: 0xffffffff } })), sub) });
      for (const a of atts) {
        const asub = subnodeSpace();
        const ext = /\.[^.]+$/.exec(a.name);
        const aprops = [
          [P.DISPLAY_NAME, a.name], [P.RENDERING_POSITION, 0xffffffff], [P.CREATION_TIME, m.deliveredAt], [P.LAST_MODIFICATION_TIME, m.deliveredAt],
        ];
        if (a.embedded) {
          const em = messageObject(a.embedded, null);
          const emNid = asub.add(em.chunks, em.subnodes);
          aprops.push([P.ATTACH_METHOD, 5], [P.ATTACH_SIZE, a.embedded.size], [P.ATTACH_DATA_OBJ, { nid: emNid, size: a.embedded.size }]);
        } else {
          aprops.push([P.ATTACH_METHOD, 1], [P.ATTACH_SIZE, a.data.length + 400], [P.ATTACH_FILENAME, a.name], [P.ATTACH_LONG_FILENAME, a.name],
            [P.ATTACH_EXTENSION, ext ? ext[0] : ''], [P.ATTACH_MIME_TAG, a.mime], [P.ATTACH_DATA, a.data]);
          if (a.cid) aprops.push([P.ATTACH_CONTENT_ID, a.cid], [P.ATTACH_FLAGS, 4 /* ATT_MHTML_REF */]);
          if (a.hidden) aprops.push([P.ATTACHMENT_HIDDEN, true]);
        }
        subnodes.push({ nid: a.nid, chunks: buildPC(aprops, asub), subnodes: asub.items });
      }
    }
    const chunks = buildPC(props, sub);
    return { chunks, subnodes: [...subnodes, ...sub.items] };
  }

  function writeFolder(folder, parentNid) {
    const items = folder.items;
    for (const m of items) {
      m.nid = nid(NID_TYPE.NORMAL_MESSAGE, messageIndex++);
      const obj = messageObject(m, folder);
      addNode(m.nid, obj.chunks, { parent: folder.nid, subnodes: obj.subnodes });
    }
    folder.count = items.length;
    folder.unread = items.filter((m) => !(m.flags & 0x01)).length;
    for (const c of folder.children) writeFolder(c, folder.nid);

    addNode(folder.nid, buildPC([
      [P.DISPLAY_NAME, folder.name], [P.CONTENT_COUNT, folder.count], [P.CONTENT_UNREAD, folder.unread],
      [P.SUBFOLDERS, folder.children.length > 0], [P.SOURCE_KEY, folder.sourceKey], [P.CHANGE_KEY, changeKey()],
      [P.CREATION_TIME, new Date(Date.UTC(2023, 0, 9, 7))], [P.LAST_MODIFICATION_TIME, new Date(Date.UTC(2026, 9, 19, 14))],
      [P.CONTAINER_CLASS, folder.cls || null],
    ], subnodeSpace()), { parent: parentNid });

    const hsub = subnodeSpace();
    addNode(tableNid(folder.nid, NID_TYPE.HIERARCHY_TABLE), buildTC(HIERARCHY_COLUMNS, folder.children.map((c) => ({
      rowId: c.nid, values: { [P.DISPLAY_NAME]: c.name, [P.CONTENT_COUNT]: c.count, [P.CONTENT_UNREAD]: c.unread,
        [P.SUBFOLDERS]: c.children.length > 0, [P.CONTAINER_CLASS]: c.cls || null, [P.PST_HIDDEN_COUNT]: 0, [P.PST_HIDDEN_UNREAD]: 0 } })), hsub),
    { subnodes: hsub.items });

    // Contents table, newest first (Outlook's default sort by delivery time)
    const csub = subnodeSpace();
    const sorted = [...items].sort((a, b) => b.deliveredAt - a.deliveredAt);
    addNode(tableNid(folder.nid, NID_TYPE.CONTENTS_TABLE), buildTC(CONTENTS_COLUMNS, sorted.map((m) => ({
      rowId: m.nid, values: {
        [P.IMPORTANCE]: m.importance, [P.MESSAGE_CLASS]: m.cls, [P.SENSITIVITY]: m.sensitivity || 0, [P.SUBJECT]: m.subject,
        [P.CLIENT_SUBMIT_TIME]: m.draft ? null : m.date, [P.SENT_REPRESENTING_NAME]: m.from.name,
        [P.MESSAGE_TO_ME]: m.to.some((p) => p.email === owner.email), [P.MESSAGE_CC_ME]: m.cc.some((p) => p.email === owner.email),
        [P.CONVERSATION_TOPIC]: m.normalized, [P.CONVERSATION_INDEX]: m.convIndex,
        [P.DISPLAY_CC]: m.cc.map((p) => p.name).join('; ') || null, [P.DISPLAY_TO]: m.to.map((p) => p.name).join('; '),
        [P.MESSAGE_DELIVERY_TIME]: m.draft ? null : m.deliveredAt, [P.MESSAGE_FLAGS]: m.flags, [P.MESSAGE_SIZE]: m.size,
        [P.MESSAGE_STATUS]: 0, [P.HASATTACH]: m.hasAttach, [P.LAST_MODIFICATION_TIME]: m.deliveredAt,
        [P.SEARCH_KEY]: m.searchKey, [P.SOURCE_KEY]: m.sourceKey } })), csub),
    { subnodes: csub.items });
    addNode(tableNid(folder.nid, NID_TYPE.ASSOC_CONTENTS_TABLE), empty(ASSOC_COLUMNS));
  }
  writeFolder(rootFolder, NID_ROOT_FOLDER);

  // --- File layout ------------------------------------------------------------------------
  ndb.blocks.sort((a, b) => (a.bid < b.bid ? -1 : 1));
  ndb.nodes.sort((a, b) => a.nid - b.nid);
  const PAGE = fmt.page;
  const TRAILER_AT = PAGE - fmt.pageTrailer;
  const AMAP_COVERAGE = TRAILER_AT * 8 * fmt.amapUnit;
  const BBT_ENTRY = 24, NBT_ENTRY = 32, BRANCH_ENTRY = 24;

  // Allocation map: one AMap page at the start of every region; in PSTs additionally a (deprecated) PMap
  // page after every 8th AMap
  const amaps = [];
  const pmaps = [];
  const regionOf = (ib) => Math.floor((ib - fmt.amapOffset) / AMAP_COVERAGE);
  const regionStart = (r) => fmt.amapOffset + r * AMAP_COVERAGE;
  const reserved = (r) => PAGE * (fmt.pmap && r % 8 === 0 ? 2 : 1);
  function markAllocated(ib, size) {
    const am = amaps[regionOf(ib)];
    const first = (ib - am.ib) / fmt.amapUnit;
    for (let u = first; u < first + size / fmt.amapUnit; u++) am.bits[u >> 3] |= 0x80 >> (u & 7);
    am.used += size;
  }
  function ensureRegion(r) {
    while (amaps.length <= r) {
      const ib = regionStart(amaps.length);
      amaps.push({ ib, bits: Buffer.alloc(PAGE), used: 0 });
      markAllocated(ib, PAGE);
      if (fmt.pmap && (amaps.length - 1) % 8 === 0) { pmaps.push(ib + PAGE); markAllocated(ib + PAGE, PAGE); }
    }
  }
  let cursor = fmt.amapOffset;
  function allocate(size, alignment) {
    let ib = align(cursor, alignment);
    let r = regionOf(ib);
    if (ib - regionStart(r) < reserved(r)) ib = regionStart(r) + reserved(r);
    if (ib + size > regionStart(r + 1)) { r++; ib = regionStart(r) + reserved(r); }
    ensureRegion(r);
    cursor = ib + size;
    markAllocated(ib, size);
    return ib;
  }
  ensureRegion(0);

  function buildBTree(entries, cbEnt) {
    const pages = [];
    const perLeaf = Math.floor(fmt.btEntries / cbEnt);
    const perBranch = Math.floor(fmt.btEntries / BRANCH_ENTRY);
    let level = [];
    for (let i = 0; i < entries.length; i += perLeaf) {
      const group = entries.slice(i, i + perLeaf);
      level.push({ cLevel: 0, cbEnt, entries: group.map((e) => e.buf), key: group[0].key });
    }
    pages.push(...level);
    for (let depth = 1; level.length > 1; depth++) {
      const next = [];
      for (let i = 0; i < level.length; i += perBranch) {
        const group = level.slice(i, i + perBranch);
        next.push({ cLevel: depth, cbEnt: BRANCH_ENTRY, children: group, key: group[0].key });
      }
      pages.push(...next);
      level = next;
    }
    return { root: level[0], pages };
  }

  for (const b of ndb.blocks) {
    b.total = align(b.size + fmt.blockTrailer, fmt.blockAlign);
    b.ib = allocate(b.total, fmt.blockAlign);
  }
  const nbt = buildBTree(ndb.nodes.map((n) => {
    const e = Buffer.alloc(NBT_ENTRY);
    e.writeBigUInt64LE(BigInt(n.nid), 0);
    e.writeBigUInt64LE(n.bidData, 8);
    e.writeBigUInt64LE(n.bidSub, 16);
    e.writeUInt32LE(n.nidParent, 24);
    return { key: BigInt(n.nid), buf: e };
  }), NBT_ENTRY);
  const bbt = buildBTree(ndb.blocks.map((b) => {
    const e = Buffer.alloc(BBT_ENTRY);
    e.writeBigUInt64LE(b.bid, 0);
    e.writeBigUInt64LE(BigInt(b.ib), 8);
    e.writeUInt16LE(b.size, 16);
    e.writeUInt16LE(2, 18); // cRef
    return { key: b.bid, buf: e };
  }), BBT_ENTRY);
  for (const p of [...nbt.pages, ...bbt.pages]) {
    p.ib = allocate(PAGE, PAGE);
    p.bid = ndb.nextPageBid++;
  }
  if (fmt.pmap && amaps.length > 128) throw new Error('PST larger than 128 AMap regions would need FMap/FPMap pages');

  const fileSize = fmt.preallocate ? regionStart(amaps.length) : align(cursor, PAGE);
  const fd = fs.openSync(out, 'w');
  fs.ftruncateSync(fd, fileSize);
  const writeAt = (buf, ib) => fs.writeSync(fd, buf, 0, buf.length, ib);
  function pageTrailer(page, ptype, bid, sig) {
    page[TRAILER_AT] = ptype;
    page[TRAILER_AT + 1] = ptype;
    page.writeUInt16LE(sig, TRAILER_AT + 2);
    page.writeUInt32LE(crc32(page, 0, TRAILER_AT), TRAILER_AT + 4);
    page.writeBigUInt64LE(BigInt(bid), TRAILER_AT + 8);
  }

  for (const b of ndb.blocks) {
    const buf = Buffer.alloc(b.total);
    b.data.copy(buf, 0);
    const t = b.total - fmt.blockTrailer;
    buf.writeUInt16LE(b.size, t);
    buf.writeUInt16LE(computeSig(b.ib, b.bid), t + 2);
    buf.writeUInt32LE(crc32(b.data), t + 4);
    buf.writeBigUInt64LE(b.bid, t + 8);
    if (fmt.blockTrailer === 24) {
      buf.writeUInt16LE(2, t + 16);
      buf.writeUInt16LE(b.cbInflated, t + 18);
    }
    writeAt(buf, b.ib);
  }

  for (const [tree, ptype] of [[nbt, 0x81], [bbt, 0x80]]) {
    for (const p of tree.pages) {
      const page = Buffer.alloc(PAGE);
      const entries = p.cLevel === 0 ? p.entries : p.children.map((c) => {
        const e = Buffer.alloc(BRANCH_ENTRY);
        e.writeBigUInt64LE(c.key, 0);
        e.writeBigUInt64LE(c.bid, 8);
        e.writeBigUInt64LE(BigInt(c.ib), 16);
        return e;
      });
      entries.forEach((e, i) => e.copy(page, i * p.cbEnt));
      const at = fmt.btEntries;
      if (PAGE === 4096) {
        page.writeUInt16LE(entries.length, at);
        page.writeUInt16LE(Math.floor(fmt.btEntries / p.cbEnt), at + 2);
        page[at + 4] = p.cbEnt;
        page[at + 5] = p.cLevel;
      } else {
        page[at] = entries.length;
        page[at + 1] = Math.floor(fmt.btEntries / p.cbEnt);
        page[at + 2] = p.cbEnt;
        page[at + 3] = p.cLevel;
      }
      pageTrailer(page, ptype, p.bid, computeSig(p.ib, p.bid));
      writeAt(page, p.ib);
    }
  }
  for (const am of amaps) {
    pageTrailer(am.bits, 0x84, am.ib, 0);
    writeAt(am.bits, am.ib);
  }
  for (const ib of pmaps) {
    const page = Buffer.alloc(PAGE, 0xff);
    pageTrailer(page, 0x83, ib, 0);
    writeAt(page, ib);
  }
  if (fmt.dlist) {
    const dlist = Buffer.alloc(PAGE);
    pageTrailer(dlist, 0x86, fmt.dlist, 0);
    writeAt(dlist, fmt.dlist);
  }

  // Header (Unicode)
  const h = Buffer.alloc(564);
  h.write('!BDN', 0, 'ascii');
  h.write(fmt.magic, 8, 'ascii');
  h.writeUInt16LE(fmt.wVer, 10);
  h.writeUInt16LE(19, 12);  // wVerClient
  h[14] = 0x01; h[15] = 0x01;
  h.writeBigUInt64LE(ndb.nextPageBid, 32);
  h.writeUInt32LE(bytes(4).readUInt32LE(0), 40); // dwUnique
  const rgnid = new Array(32).fill(0x400);
  rgnid[NID_TYPE.NORMAL_FOLDER] = folderIndex;
  rgnid[NID_TYPE.SEARCH_FOLDER] = 0x4000;
  rgnid[NID_TYPE.NORMAL_MESSAGE] = messageIndex;
  rgnid[0x08] = 0x8000; // NID_TYPE_ASSOC_MESSAGE
  rgnid.forEach((v, i) => h.writeUInt32LE(v, 44 + i * 4));
  h.writeBigUInt64LE(BigInt(fileSize), 184);
  h.writeBigUInt64LE(BigInt(amaps[amaps.length - 1].ib), 192);
  h.writeBigUInt64LE(BigInt(amaps.reduce((s, am) => s + (AMAP_COVERAGE - am.used), 0)), 200);
  h.writeBigUInt64LE(0n, 208);
  h.writeBigUInt64LE(nbt.root.bid, 216); h.writeBigUInt64LE(BigInt(nbt.root.ib), 224);
  h.writeBigUInt64LE(bbt.root.bid, 232); h.writeBigUInt64LE(BigInt(bbt.root.ib), 240);
  h[248] = 0x02;            // fAMapValid = VALID_AMAP2
  h.fill(0xff, 256, 384);   // rgbFM
  h.fill(0xff, 384, 512);   // rgbFP
  h[512] = 0x80;            // bSentinel
  h[513] = fmt.crypt;       // bCryptMethod
  h.writeBigUInt64LE(ndb.nextBid, 516);
  h.writeUInt32LE(crc32(h, 8, 8 + 471), 4);
  h.writeUInt32LE(crc32(h, 8, 8 + 516), 524);
  writeAt(h, 0);
  fs.closeSync(fd);

  const count = (pred) => ndb.nodes.filter(pred).length;
  console.log(`${out} (${fmt.name}): ${(fileSize / 1048576).toFixed(1)} MB, ${count((n) => (n.nid & 0x1f) === NID_TYPE.NORMAL_MESSAGE)} items, ` +
    `${count((n) => (n.nid & 0x1f) === NID_TYPE.NORMAL_FOLDER)} folders, ${ndb.blocks.length} blocks` +
    `${fmt.compress ? ` (${ndb.blocks.filter((b) => b.size < b.cbInflated).length} compressed)` : ''}, B-tree depth NBT ${nbt.root.cLevel + 1} / BBT ${bbt.root.cLevel + 1}`);
}

for (const out of OUTPUTS) {
  const fmt = FORMATS[out.slice(-3).toLowerCase()];
  writeFile(out, fmt, buildMailbox(SEED));
}
