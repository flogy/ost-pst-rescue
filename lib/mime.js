// Rebuilds Outlook messages as MIME (RFC 5322 / 2045) and writes them to mbox files (mboxrd).
//
// Each message gets its text and HTML body, attachments, inline images (multipart/related) and embedded
// messages (message/rfc822). For received mail the original internet headers (Received, Return-Path, ...)
// are kept; everything else is rebuilt from the Outlook properties.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { safe, str, readAttachment, rtfToText } = require('./mailbox');

// ---------------------------------------------------------------------------
// MIME helpers
// ---------------------------------------------------------------------------
const isAscii = (s) => /^[\x20-\x7e]*$/.test(s);

// RFC 2047 encoded-words, split on character boundaries so no word exceeds 75 characters
function encodeWords(s) {
  if (isAscii(s)) return s;
  const words = [];
  let chunk = '';
  for (const ch of s) {
    if (Buffer.byteLength(chunk + ch) > 45) { words.push(chunk); chunk = ''; }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w).toString('base64')}?=`).join('\n ');
}

function formatAddress(name, email) {
  name = (name || '').replace(/[\r\n]+/g, ' ').trim();
  email = (email || '').trim();
  if (!email) return name ? `${encodeWords(name)} :;` : '';
  if (!name || name === email) return `<${email}>`;
  const display = isAscii(name)
    ? (/[()<>\[\]:;@\\,."]/.test(name) ? `"${name.replace(/(["\\])/g, '\\$1')}"` : name)
    : encodeWords(name);
  return `${display} <${email}>`;
}

const header = (name, value) => `${name}: ${value}`;
const addressHeader = (name, list) => list.length ? `${name}: ${list.join(',\n ')}` : null;

function rfc2822Date(d) {
  return d.toUTCString().replace('GMT', '+0000');
}
function asctime(d) {
  const p = d.toUTCString().split(' '); // "Tue, 20 Oct 2026 10:00:00 GMT"
  return `${p[0].slice(0, 3)} ${p[2]} ${p[1].padStart(2, ' ')} ${p[4]} ${p[3]}`;
}

function wrapBase64(buf) {
  return buf.toString('base64').replace(/.{76}/g, '$&\n');
}

// Quoted-printable with LF line endings; "From " at line start is encoded so mbox readers never misread it
function quotedPrintable(text) {
  const out = [];
  for (const rawLine of text.replace(/\r\n?/g, '\n').split('\n')) {
    const bytes = Buffer.from(rawLine, 'utf8');
    let line = '';
    let encoded = '';
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      const last = i === bytes.length - 1;
      let t;
      if ((b === 0x20 || b === 0x09) && last) t = '=' + b.toString(16).toUpperCase().padStart(2, '0');
      else if (b === 0x46 && i === 0 && rawLine.startsWith('From ')) t = '=46';
      else if ((b >= 0x21 && b <= 0x7e && b !== 0x3d) || b === 0x20 || b === 0x09) t = String.fromCharCode(b);
      else t = '=' + b.toString(16).toUpperCase().padStart(2, '0');
      if (line.length + t.length > 75) { encoded += line + '=\n'; line = ''; }
      line += t;
    }
    out.push(encoded + line);
  }
  return out.join('\n');
}

const MIME_BY_EXT = {
  pdf: 'application/pdf', doc: 'application/msword', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip', txt: 'text/plain', csv: 'text/csv', htm: 'text/html', html: 'text/html', xml: 'application/xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml',
  tif: 'image/tiff', tiff: 'image/tiff', ics: 'text/calendar', vcf: 'text/vcard', eml: 'message/rfc822',
  mp3: 'audio/mpeg', mp4: 'video/mp4', msg: 'application/vnd.ms-outlook',
};

function fileParams(filename) {
  // RFC 2231 for modern clients, encoded-word fallback for old ones
  const quoted = isAscii(filename) ? `"${filename.replace(/(["\\])/g, '\\$1')}"` : `"${encodeWords(filename).replace(/\n /g, ' ')}"`;
  const ext = isAscii(filename) ? '' : `;\n filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`;
  return { quoted, ext };
}

const boundary = () => `----=_Part_${crypto.randomBytes(12).toString('hex')}`;

// ---------------------------------------------------------------------------
// Message -> MIME (array of string/Buffer chunks)
// ---------------------------------------------------------------------------
const STRIP_FROM_ORIGINAL = /^(content-[a-z-]+|mime-version|status|x-status|x-mozilla-[a-z-]+|x-folder)$/i;

function smtpOf(...candidates) {
  for (const c of candidates) {
    const v = str(c);
    if (v && v.includes('@') && !v.startsWith('/')) return v;
  }
  return '';
}

function parseHeaderBlock(raw) {
  const fields = [];
  for (const line of raw.replace(/\r\n?/g, '\n').split('\n')) {
    if (!line) break; // end of header block
    if (/^[ \t]/.test(line) && fields.length) fields[fields.length - 1].lines.push(line);
    else {
      const m = /^([^:\s]+):/.exec(line);
      if (m) fields.push({ name: m[1], lines: [line] });
    }
  }
  return fields;
}

function collectAttachments(msg, stats) {
  const list = [];
  const n = safe(() => msg.numberOfAttachments, 0);
  for (let i = 0; i < n; i++) {
    const a = safe(() => msg.getAttachment(i), null);
    if (!a) { stats.attachmentErrors++; continue; }
    list.push(a);
  }
  return list;
}

function buildMessage(msg, ctx, depth = 0) {
  const { opts, stats } = ctx;
  const chunks = [];
  const push = (...s) => { for (const x of s) if (x !== null && x !== undefined) chunks.push(x); };

  const date = safe(() => msg.clientSubmitTime, null) || safe(() => msg.messageDeliveryTime, null) || safe(() => msg.creationTime, null);
  const subject = str(safe(() => msg.subject, ''));
  const senderName = str(safe(() => msg.senderName, '')) || str(safe(() => msg.sentRepresentingName, ''));
  const senderEmail = smtpOf(safe(() => msg.getStringItem(0x5d01), ''), safe(() => msg.senderEmailAddress, ''),
    safe(() => msg.getStringItem(0x5d02), ''), safe(() => msg.sentRepresentingEmailAddress, ''));

  const recips = { 1: [], 2: [], 3: [] };
  const nRecip = safe(() => msg.numberOfRecipients, 0);
  for (let i = 0; i < nRecip; i++) {
    const r = safe(() => msg.getRecipient(i), null);
    if (!r) continue;
    const type = safe(() => r.recipientType, 1);
    (recips[type] || recips[1]).push(formatAddress(str(safe(() => r.displayName, '')), smtpOf(safe(() => r.smtpAddress, ''), safe(() => r.emailAddress, ''))));
  }
  if (!recips[1].length && str(safe(() => msg.displayTo, ''))) recips[1].push(...str(msg.displayTo).split(';').map((n) => formatAddress(n, '')).filter(Boolean));

  // Headers: original internet headers when present (received mail), otherwise rebuilt from MAPI properties
  const headers = [];
  const original = parseHeaderBlock(str(safe(() => msg.transportMessageHeaders, '')));
  const have = new Set();
  for (const f of original) {
    if (STRIP_FROM_ORIGINAL.test(f.name)) continue;
    headers.push(f.lines.join('\n'));
    have.add(f.name.toLowerCase());
  }
  const add = (name, value) => {
    if (!value || have.has(name.toLowerCase())) return;
    headers.push(header(name, value));
    have.add(name.toLowerCase());
  };
  if (date) add('Date', rfc2822Date(date));
  add('From', formatAddress(senderName, senderEmail) || 'unknown');
  if (!have.has('to')) { const h = addressHeader('To', recips[1]); if (h) { headers.push(h); have.add('to'); } }
  if (!have.has('cc')) { const h = addressHeader('Cc', recips[2]); if (h) { headers.push(h); have.add('cc'); } }
  if (!original.length) { const h = addressHeader('Bcc', recips[3]); if (h) headers.push(h); }
  add('Subject', encodeWords(subject.replace(/[\r\n]+/g, ' ')));
  add('Message-ID', str(safe(() => msg.internetMessageId, '')));
  add('In-Reply-To', str(safe(() => msg.inReplyToId, '')));
  add('References', str(safe(() => msg.getStringItem(0x1039), '')).replace(/\s+/g, '\n '));
  const cls = str(safe(() => msg.messageClass, ''));
  if (cls && cls !== 'IPM.Note') headers.push(header('X-MS-Message-Class', cls));
  const importance = safe(() => msg.importance, 1);
  if (importance === 2 && !have.has('importance')) headers.push(header('Importance', 'high'));
  if (importance === 0 && !have.has('importance')) headers.push(header('Importance', 'low'));
  if (depth === 0) {
    headers.push(header('Status', safe(() => msg.isRead, true) ? 'RO' : 'O'));
    if (opts.single) headers.push(header('X-Folder', encodeWords(ctx.folderPath)));
    // raw UTF-8 like Google Takeout; labels containing a comma are quoted
    if (ctx.label) headers.push(header('X-Gmail-Labels', ctx.label.includes(',') ? `"${ctx.label.replace(/"/g, '')}"` : ctx.label));
  }
  headers.push('MIME-Version: 1.0');

  // Bodies
  let html = str(safe(() => msg.bodyHTML, ''));
  let text = str(safe(() => msg.body, ''));
  if (!html && !text) {
    const rtf = safe(() => msg.bodyRTF, '');
    if (rtf) text = rtfToText(rtf);
  }

  // Attachments
  const atts = collectAttachments(msg, stats);
  const inline = [];
  const regular = [];
  const omitted = [];
  for (const a of atts) {
    const method = safe(() => a.attachMethod, 1);
    const name = str(safe(() => a.longFilename, '')) || str(safe(() => a.filename, '')) || str(safe(() => a.displayName, ''));
    const cid = str(safe(() => a.contentId, '')).replace(/^<|>$/g, '');
    const entry = { a, method, name, cid };
    if (!opts.attachments && method !== 5) { omitted.push(name || 'attachment'); continue; }
    if (cid && html && html.includes(`cid:${cid}`)) inline.push(entry);
    else regular.push(entry);
  }
  if (omitted.length) text = (text || '') + `\n\n[${omitted.length} attachment(s) not exported: ${omitted.join(', ')}]`;

  const textPart = () => [
    'Content-Type: text/plain; charset=utf-8\nContent-Transfer-Encoding: quoted-printable\n\n', quotedPrintable(text || ''), '\n'];
  const htmlPart = () => [
    'Content-Type: text/html; charset=utf-8\nContent-Transfer-Encoding: quoted-printable\n\n', quotedPrintable(html), '\n'];

  const attachmentPart = ({ a, method, name, cid }, isInline) => {
    if (method === 5) {
      // embedded Outlook item -> message/rfc822
      const embedded = safe(() => a.embeddedPSTMessage, null);
      if (embedded && depth < 5) {
        stats.embedded++;
        const { quoted } = fileParams((name || str(safe(() => embedded.subject, '')) || 'message') + '.eml');
        return [`Content-Type: message/rfc822\nContent-Disposition: attachment; filename=${quoted}\n\n`, ...buildMessage(embedded, ctx, depth + 1), '\n'];
      }
      stats.attachmentErrors++;
      return null;
    }
    let data;
    try {
      data = readAttachment(a) || Buffer.alloc(0);
    } catch (err) {
      stats.attachmentErrors++;
      return null;
    }
    stats.attachments++;
    stats.attachmentBytes += data.length;
    const filename = name || `attachment${cid ? '-' + cid : ''}`;
    const ext = (filename.split('.').pop() || '').toLowerCase();
    const mime = str(safe(() => a.mimeTag, '')) || MIME_BY_EXT[ext] || 'application/octet-stream';
    const { quoted, ext: ext2231 } = fileParams(filename);
    return [
      `Content-Type: ${mime}; name=${quoted}\n` +
      `Content-Transfer-Encoding: base64\n` +
      `Content-Disposition: ${isInline ? 'inline' : 'attachment'}; filename=${quoted}${ext2231}\n` +
      (cid ? `Content-ID: <${cid}>\n` : '') + '\n',
      wrapBase64(data), '\n'];
  };

  const multipart = (subtype, parts) => {
    const b = boundary();
    const out = [`Content-Type: multipart/${subtype};\n boundary="${b}"\n\n`];
    for (const p of parts) if (p) out.push(`--${b}\n`, ...p);
    out.push(`--${b}--\n`);
    return out;
  };

  let body = html && text ? multipart('alternative', [textPart(), htmlPart()]) : html ? htmlPart() : textPart();
  if (inline.length) body = multipart('related', [body, ...inline.map((e) => attachmentPart(e, true))]);
  if (regular.length) body = multipart('mixed', [body, ...regular.map((e) => attachmentPart(e, false))]);

  push(headers.join('\n') + '\n', ...body);
  return chunks;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
class MboxFile {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.fd = fs.openSync(file, 'w');
    this.pending = [];
    this.pendingBytes = 0;
    this.bytes = 0;
  }
  writeMessage(fromLine, chunks) {
    this.add(fromLine + '\n');
    for (const c of chunks) {
      // mboxrd: quote any line that looks like a From_ separator (only possible in original header lines)
      this.add(typeof c === 'string' ? c.replace(/^(>*From )/gm, '>$1') : c);
    }
    this.add('\n');
    if (this.pendingBytes > 4 * 1024 * 1024) this.flush();
  }
  add(chunk) {
    const b = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    this.pending.push(b);
    this.pendingBytes += b.length;
  }
  flush() {
    if (!this.pending.length) return;
    const b = Buffer.concat(this.pending);
    fs.writeSync(this.fd, b);
    this.bytes += b.length;
    this.pending = [];
    this.pendingBytes = 0;
  }
  close() {
    this.flush();
    fs.closeSync(this.fd);
  }
}

module.exports = { buildMessage, MboxFile, smtpOf, asctime };
