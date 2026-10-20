// Generators for the sample attachments (real, openable PDF, DOCX, PNG, CSV, ICS, VCF and RTF content) and
// a small seeded random generator, so the sample mailbox is identical on every run.
'use strict';
const zlib = require('zlib');

// Deterministic pseudo random numbers in [0, 1)
function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Standard CRC-32 (PNG, ZIP)
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// File generators
// ---------------------------------------------------------------------------
function png(width, height, pixel) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      raw[o++] = r; raw[o++] = g; raw[o++] = b;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8 bit RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const WINANSI = { '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97 };
function pdfString(s) {
  const out = [];
  for (const ch of s) {
    const c = ch.codePointAt(0);
    let b = c < 256 ? c : WINANSI[ch] ?? 0x3f;
    if (b === 0x28 || b === 0x29 || b === 0x5c) out.push(0x5c);
    out.push(b);
  }
  return Buffer.from(out);
}

// Minimal but valid PDF: Helvetica text pages, optionally an uncompressed grayscale image on page 1
function pdf(title, lines, { image } = {}) {
  const objs = [];
  const add = (body) => objs.push(body) && objs.length;
  const catalog = add(null);
  const pagesObj = add(null);
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  let img = 0;
  if (image) {
    img = add(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} ` +
      `/ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${image.data.length} >>\nstream\n`), image.data, Buffer.from('\nendstream')]));
  }
  const perPage = 50;
  const firstPage = image ? 22 : perPage;
  const chunks = [lines.slice(0, firstPage)];
  for (let i = firstPage; i < lines.length; i += perPage) chunks.push(lines.slice(i, i + perPage));
  const pageIds = [];
  chunks.forEach((pageLines, i) => {
    const parts = [Buffer.from(`BT /F2 15 Tf 56 790 Td `), pdfString(`(${title})`), Buffer.from(` Tj ET\nBT /F1 10 Tf 56 760 Td 14 TL\n`)];
    for (const l of pageLines) parts.push(pdfString(`(${l})`), Buffer.from(' Tj T*\n'));
    parts.push(Buffer.from(`ET\nBT /F1 8 Tf 520 30 Td (${i + 1}/${chunks.length}) Tj ET\n`));
    if (i === 0 && img) {
      const w = 483, h = Math.round((483 * image.height) / image.width);
      parts.push(Buffer.from(`q ${w} 0 0 ${h} 56 ${430 - h} cm /Im1 Do Q\n`));
    }
    const stream = Buffer.concat(parts);
    const content = add(Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`), stream, Buffer.from('endstream')]));
    pageIds.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >>` +
      `${i === 0 && img ? ` /XObject << /Im1 ${img} 0 R >>` : ''} >> /Contents ${content} 0 R >>`));
  });
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${pageIds.map((p) => `${p} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  const info = add(Buffer.concat([Buffer.from('<< /Title '), pdfString(`(${title})`), Buffer.from(' /Producer (sample-content.js) >>')]));

  const out = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let pos = out[0].length;
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(pos);
    const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'), Buffer.from('\nendobj\n')]);
    out.push(b);
    pos += b.length;
  });
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${pos}\n%%EOF\n`;
  out.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(out);
}

function zip(files) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = Buffer.from(f.data);
    const comp = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8);
    h.writeUInt16LE(0x6000, 10); h.writeUInt16LE(0x5b53, 12); // 12:00, 2025-10-19
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(name.length, 26);
    local.push(h, name, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10);
    c.writeUInt16LE(0x6000, 12); c.writeUInt16LE(0x5b53, 14);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}

const xmlEsc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function docx(title, paragraphs) {
  const run = (t, props = '') => `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${xmlEsc(t)}</w:t></w:r>`;
  const body = `<w:p>${run(title, '<w:b/><w:sz w:val="32"/>')}</w:p>` + paragraphs.map((p) => `<w:p>${run(p)}</w:p>`).join('');
  return zip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { name: 'word/document.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      `<w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>` },
  ]);
}

const icsDate = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
function ics({ uid, summary, location, start, end, organizer, stamp }) {
  return Buffer.from(['BEGIN:VCALENDAR', 'PRODID:-//Contoso AG//Beispiel//DE', 'VERSION:2.0', 'METHOD:REQUEST', 'BEGIN:VEVENT',
    `UID:${uid}`, `DTSTAMP:${icsDate(stamp)}`, `DTSTART:${icsDate(start)}`, `DTEND:${icsDate(end)}`, `SUMMARY:${summary}`,
    `LOCATION:${location}`, `ORGANIZER;CN=${organizer.name}:mailto:${organizer.email}`, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n'), 'utf8');
}

function vcf(p) {
  return Buffer.from(['BEGIN:VCARD', 'VERSION:3.0', `N:${p.last};${p.first};;;`, `FN:${p.name}`, `ORG:${p.company}`, `TITLE:${p.title}`,
    `TEL;TYPE=WORK,VOICE:${p.phone}`, `EMAIL;TYPE=INTERNET:${p.email}`, 'END:VCARD', ''].join('\r\n'), 'utf8');
}

const csv = (rows) => Buffer.from('\ufeff' + rows.map((r) => r.join(';')).join('\r\n') + '\r\n', 'utf8');

function rtf(text) {
  let out = '';
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (ch === '\n') out += '\\par\n';
    else if (ch === '\\' || ch === '{' || ch === '}') out += '\\' + ch;
    else if (c < 128) out += ch;
    else if (c < 256) out += `\\'${c.toString(16)}`;
    else out += `\\u${c > 32767 ? c - 65536 : c}?`;
  }
  return '{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0\\fswiss\\fcharset0 Calibri;}}\\viewkind4\\uc1\\pard\\f0\\fs22 ' + out + '\\par\n}';
}

const MIME = {
  pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', png: 'image/png',
  csv: 'text/csv', ics: 'text/calendar', vcf: 'text/vcard', txt: 'text/plain',
};
const file = (name, data, extra = {}) => ({ name, data, mime: MIME[(name.match(/\.(\w+)$/) || [])[1]] || 'application/octet-stream', ...extra });

module.exports = { mulberry32, png, pdf, docx, ics, vcf, csv, rtf, file };
