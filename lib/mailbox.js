// Opening OST/PST files and walking their folders and items, plus small helpers shared by all commands.
'use strict';
const fs = require('fs');
const path = require('path');
const { PSTFile } = require('pst-extractor');
const fixes = require('./pst-fixes');

// Error with a message meant for the user (printed without a stack trace)
class UserError extends Error {}

const FORMATS = { 14: 'ANSI (32-bit)', 15: 'ANSI (32-bit)', 23: 'Unicode (64-bit)', 36: 'Unicode 4K (Outlook 2013+)' };

// Opens an OST or PST file. Returns { pst, file, kind: 'OST' | 'PST', format, size, store, cache, close() }.
function openMailbox(file, { cacheMb = 64 } = {}) {
  if (!file) throw new UserError('No input file given.');
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new UserError(`File not found: ${file}`);
  const cache = fixes.install(cacheMb);
  let pst;
  try {
    pst = new PSTFile(path.resolve(file));
  } catch (err) {
    throw new UserError(`${file} is not a readable OST/PST file (${err.message}). Is Outlook still running?`);
  }
  // header byte 8-9 ("wMagicClient"): "SO" = OST, "SM" = PST
  const magic = Buffer.alloc(2);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, magic, 0, 2, 8); } finally { fs.closeSync(fd); }
  return {
    pst,
    file,
    kind: magic.toString('latin1') === 'SO' ? 'OST' : 'PST',
    format: FORMATS[pst.pstFileType] || String(pst.pstFileType),
    size: fs.statSync(file).size,
    store: str(safe(() => pst.getMessageStore().displayName, '')),
    cache,
    close: () => pst.close(),
  };
}

// Depth-first walk over all folders. visit(folder, segments, parentValue) returns the value passed to the
// children; segments are the folder names from the root (the root itself has none, unnamed folders are '').
function walkFolders(root, visit, onError = () => {}) {
  (function walk(folder, segments, parentValue) {
    const value = visit(folder, segments, parentValue);
    if (!safe(() => folder.hasSubfolders, false)) return;
    let subfolders = [];
    try {
      subfolders = folder.getSubFolders();
    } catch (err) {
      onError(err, segments);
    }
    for (const sub of subfolders) walk(sub, [...segments, str(safe(() => sub.displayName, ''))], value);
  })(root, [], undefined);
}

// Calls fn(item) for every item of a folder; onError(err, item) for unreadable items (item is null when the
// folder listing itself failed).
function forEachItem(folder, fn, onError = () => {}) {
  if (!(safe(() => folder.contentCount, 0) > 0)) return;
  for (;;) {
    let item;
    try {
      item = folder.getNextChild();
    } catch (err) {
      onError(err, null);
      return;
    }
    if (!item) return;
    try {
      fn(item);
    } catch (err) {
      onError(err, item);
    }
  }
}

// Folder path below the top of the mailbox. Depending on the Outlook/Exchange version and language the mail
// folders sit below one or two technical levels, e.g. "Root - Mailbox/IPM_SUBTREE/Inbox" or
// "Top of Outlook data file/Inbox".
const TOP_OF_STORE = /^(ipm_subtree|top of information store|top of personal folders|top of outlook data file|oberste ebene des informationsspeichers|oberste ebene der persönlichen ordner|oberste ebene der outlook-datendatei|haut de la banque d'informations|partie supérieure de la banque d'informations)$/i;
function storeRelative(segments) {
  const top = segments.findIndex((s) => TOP_OF_STORE.test(s.trim()));
  return top >= 0 ? segments.slice(top + 1) : segments.slice(1);
}

// Progress line on stderr, at most once per second
function progress(format) {
  const started = Date.now();
  let last = 0;
  return {
    tick(force) {
      const now = Date.now();
      if (!force && now - last < 1000) return;
      last = now;
      process.stderr.write(`\r  ${format((now - started) / 1000)}, RAM ${(process.memoryUsage().rss / 1024 ** 2).toFixed(0)} MB   `);
    },
    done() {
      this.tick(true);
      process.stderr.write('\n');
      return (Date.now() - started) / 1000;
    },
  };
}

// Property access that never throws; null/undefined become the fallback
const safe = (fn, fallback) => {
  try {
    const v = fn();
    return v === undefined || v === null ? fallback : v;
  } catch {
    return fallback;
  }
};
const str = (v) => (typeof v === 'string' ? v.replace(/\0+$/, '') : '');
// pst-extractor returns some sizes as Long objects ({ low, high })
const toNumber = (v) => (v && typeof v === 'object' ? (typeof v.toNumber === 'function' ? v.toNumber() : (v.high || 0) * 2 ** 32 + ((v.low || 0) >>> 0)) : Number(v) || 0);

function readAttachment(attachment) {
  const stream = attachment.fileInputStream;
  if (!stream) return null;
  const buf = Buffer.alloc(toNumber(stream.length));
  stream.readCompletely(buf);
  return buf;
}

// File or folder name that is valid on Windows, macOS and Linux
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
function safeFileName(s, fallback = '_') {
  let n = String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^[\s.]+|[\s.]+$/g, '');
  if (!n) n = fallback;
  if (RESERVED.test(n)) n += '_';
  return n.slice(0, 100);
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

// Minimal RTF -> plain text fallback for messages that only carry PR_RTF_COMPRESSED
function rtfToText(rtf) {
  let out = '';
  let depth = 0;
  const skipDepth = [];
  for (let i = 0; i < rtf.length; i++) {
    const c = rtf[i];
    const skipping = skipDepth.length && depth >= skipDepth[skipDepth.length - 1];
    if (c === '{') { depth++; continue; }
    if (c === '}') {
      if (skipDepth.length && depth === skipDepth[skipDepth.length - 1]) skipDepth.pop();
      depth--;
      continue;
    }
    if (c === '\\') {
      const next = rtf[i + 1];
      if (next === '\\' || next === '{' || next === '}') { if (!skipping) out += next; i++; continue; }
      if (next === '*') { skipDepth.push(depth); i++; continue; }
      if (next === "'") {
        if (!skipping) out += String.fromCharCode(parseInt(rtf.substr(i + 2, 2), 16));
        i += 3;
        continue;
      }
      const m = /^([a-z]+)(-?\d+)? ?/.exec(rtf.slice(i + 1, i + 40));
      if (m) {
        const word = m[1];
        i += m[0].length;
        if (['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'header', 'footer'].includes(word)) skipDepth.push(depth);
        else if (!skipping) {
          if (word === 'par' || word === 'line') out += '\n';
          else if (word === 'tab') out += '\t';
          else if (word === 'u' && m[2]) { out += String.fromCharCode((Number(m[2]) + 65536) % 65536); if (rtf[i + 1] === '?') i++; }
        }
      }
      continue;
    }
    if (!skipping && c !== '\r' && c !== '\n') out += c;
  }
  return out.replace(/\n{3,}/g, '\n\n').trim();
}


module.exports = {
  UserError, openMailbox, walkFolders, forEachItem, storeRelative, progress,
  safe, str, toNumber, readAttachment, safeFileName, formatBytes, rtfToText,
};
