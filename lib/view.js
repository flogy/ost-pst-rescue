// "view" command: turns an OST/PST file into a static, read-only HTML viewer (folder tree, message list, reading
// pane, calendar, contacts and tasks). The viewer (lib/viewer/) works when opened straight from disk (file://).
//
// Built for large files (1 GB+):
//  - items are streamed; only the current folder's summaries and one chunk of message bodies are kept in memory
//  - the output is index.html plus small data/*.js chunks (JSONP) that the viewer loads on demand
//  - attachments are written to data/a/<message>/; inline images (cid:) are embedded into the message HTML
'use strict';
const fs = require('fs');
const path = require('path');
const { UserError, openMailbox, walkFolders, forEachItem, storeRelative, progress, safe, str, toNumber, readAttachment, safeFileName, formatBytes, rtfToText } = require('./mailbox');
const pim = require('./pim');

const VIEWER_DIR = path.join(__dirname, 'viewer');
const LOCALES_DIR = path.join(__dirname, '..', 'locales');
const RECIPIENT_TYPES = { 1: 'to', 2: 'cc', 3: 'bcc' };
const time = (d) => (d instanceof Date && !isNaN(d) ? d.getTime() : null);

function truncate(s, maxBytes) {
  if (!s || s.length * 2 <= maxBytes) return { value: s, truncated: false };
  return { value: s.slice(0, Math.floor(maxBytes / 2)), truncated: true };
}

// ---------------------------------------------------------------------------
// Output writer
// ---------------------------------------------------------------------------
class Writer {
  constructor(outDir, opts) {
    this.outDir = outDir;
    this.opts = opts;
    this.dataDir = path.join(outDir, 'data');
    fs.mkdirSync(path.join(this.dataDir, 'l'), { recursive: true });
    fs.mkdirSync(path.join(this.dataDir, 'm'), { recursive: true });
    this.bodyChunkId = 0;
    this.bodyItems = {};
    this.bodyBytes = 0;
    this.bytesWritten = 0;
    this.files = 0;
  }
  write(rel, content) {
    fs.writeFileSync(path.join(this.dataDir, rel), content);
    this.bytesWritten += Buffer.byteLength(content);
    this.files++;
  }
  // returns the path relative to data/
  writeAttachment(key, index, name, data) {
    const rel = `a/${key}/${index + 1}-${safeFileName(name, 'attachment')}`;
    fs.mkdirSync(path.join(this.dataDir, 'a', key), { recursive: true });
    fs.writeFileSync(path.join(this.dataDir, rel), data);
    this.attachmentFiles = (this.attachmentFiles || 0) + 1;
    this.attachmentBytes = (this.attachmentBytes || 0) + data.length;
    return rel;
  }
  // returns the chunk id the message detail was put into
  addDetail(key, detail) {
    const json = JSON.stringify(detail);
    if (this.bodyBytes > 0 && this.bodyBytes + json.length > this.opts.bodyChunkKb * 1024) this.flushBodies();
    this.bodyItems[key] = detail;
    this.bodyBytes += json.length;
    return this.bodyChunkId;
  }
  flushBodies() {
    if (this.bodyBytes === 0) return;
    this.write(`m/${this.bodyChunkId}.js`, `OST.msgs(${this.bodyChunkId},${JSON.stringify(this.bodyItems)});\n`);
    this.bodyChunkId++;
    this.bodyItems = {};
    this.bodyBytes = 0;
  }
  writeList(folderId, rows) {
    let chunks = 0;
    for (let i = 0; i < rows.length; i += this.opts.listChunk) {
      this.write(`l/${folderId}-${chunks}.js`, `OST.list(${folderId},${chunks},${JSON.stringify(rows.slice(i, i + this.opts.listChunk))});\n`);
      chunks++;
    }
    return chunks;
  }
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------
// Calendar, contacts and tasks for the dedicated viewer tabs (read-only previews)
class PimCollector {
  constructor() {
    this.events = {};   // key -> details
    this.occ = [];      // [key, start, end, subjectOverride, changed]; all-day: 'YYYY-MM-DD' (end exclusive)
    this.contacts = [];
    this.tasks = [];
    this.errors = 0;
    this.series = [];   // recurring events, expanded once the overall date range is known
    this.latest = 0;
  }
  add(msg, cls, key, folderId) {
    const kind = pim.classify(cls);
    if (!kind) return;
    const short = (s, n = 4000) => (s && s.length > n ? s.slice(0, n) + ' …' : s || undefined);
    const day = (d) => d.toISOString().slice(0, 10);
    try {
      if (kind === 'event') {
        const ev = pim.readEvent(msg);
        this.events[key] = {
          t: ev.subject, l: ev.location || undefined, d: short(ev.description), f: folderId, a: ev.allDay ? 1 : undefined,
          o: ev.organizer ? (ev.organizer.name ? `${ev.organizer.name} <${ev.organizer.email}>` : ev.organizer.email) : undefined,
          p: ev.attendees.length ? ev.attendees.map((x) => (x.name && x.email && x.name !== x.email ? `${x.name} <${x.email}>` : x.name || x.email)) : undefined,
          r: ev.pattern ? 1 : undefined, rem: ev.reminder ?? undefined, b: ev.busy ?? undefined, s: ev.sensitivity || undefined,
        };
        if (ev.pattern) this.series.push({ key, ev });
        else if (ev.allDay) this.occ.push([key, ...pim.allDayRange(ev).map((s) => s.replace(/(\d{4})(\d\d)(\d\d)/, '$1-$2-$3'))]);
        else this.occ.push([key, ev.start.getTime(), ev.end.getTime()]);
        this.latest = Math.max(this.latest, ev.end.getTime());
      } else if (kind === 'task') {
        const t = pim.readTask(msg);
        const date = (d) => (d instanceof Date && !isNaN(d) ? day(new Date(d.getTime() + 12 * 3600000)) : undefined);
        this.tasks.push({ k: key, t: t.subject, d: short(t.description), f: folderId, due: date(t.due), st: date(t.start),
          done: t.status === 2 ? 1 : undefined, s: t.status, pc: Math.round(t.percent * 100), c: t.completed instanceof Date && !isNaN(t.completed) ? t.completed.getTime() : undefined,
          i: t.importance === 2 ? 1 : undefined });
      } else {
        const c = pim.readContact(msg);
        this.contacts.push({ k: key, n: c.name, g: c.given || undefined, sn: c.surname || undefined, co: c.company || undefined, dp: c.department || undefined,
          ti: c.title || undefined, e: c.emails.length ? c.emails : undefined, ph: c.phones.length ? c.phones : undefined,
          ad: c.addresses.length ? c.addresses : undefined, u: c.urls.length ? c.urls : undefined, bd: c.birthday || undefined,
          nn: c.nickname || undefined, d: short(c.description), f: folderId });
      }
    } catch {
      this.errors++;
    }
  }
  // Expand recurring series up to one year after the latest event (or today, whichever is later)
  finish() {
    const end = new Date(Math.max(this.latest, Date.now()) + 366 * 86400000);
    for (const { key, ev } of this.series) {
      for (const o of pim.occurrences(ev, end)) {
        const date = (d) => d.toISOString().slice(0, 10);
        const row = ev.allDay ? [key, date(o.wallStart), date(new Date(Math.max(o.wallEnd.getTime(), o.wallStart.getTime() + 86400000)))] : [key, o.start.getTime(), o.end.getTime()];
        if (o.subject !== undefined || o.changed) row.push(o.subject ?? null, o.changed ? 1 : 0);
        this.occ.push(row);
      }
    }
    const t = (x) => (typeof x === 'string' ? Date.parse(x) : x);
    this.occ.sort((a, b) => t(a[1]) - t(b[1]));
    this.contacts.sort((a, b) => (a.sn || a.n || '').localeCompare(b.sn || b.n || '', undefined, { sensitivity: 'base' }));
    this.tasks.sort((a, b) => (a.done || 0) - (b.done || 0) || (a.due || '9999').localeCompare(b.due || '9999'));
  }
  counts() { return { events: Object.keys(this.events).length, occurrences: this.occ.length, contacts: this.contacts.length, tasks: this.tasks.length }; }
}

function extractMessage(msg, opts, writer, key) {
  const maxBytes = opts.maxBodyKb * 1024;
  const recipients = [];
  const nRecip = safe(() => msg.numberOfRecipients, 0);
  for (let i = 0; i < nRecip; i++) {
    const r = safe(() => msg.getRecipient(i), null);
    if (!r) continue;
    recipients.push({
      n: str(safe(() => r.displayName, '')),
      e: str(safe(() => r.smtpAddress, '')) || str(safe(() => r.emailAddress, '')),
      t: RECIPIENT_TYPES[safe(() => r.recipientType, 1)] || 'to',
    });
  }

  let html = str(safe(() => msg.bodyHTML, ''));
  const attachments = [];
  const nAtt = safe(() => msg.numberOfAttachments, 0);
  for (let i = 0; i < nAtt; i++) {
    const a = safe(() => msg.getAttachment(i), null);
    if (!a) continue;
    const embedded = safe(() => a.attachMethod, 0) === 5;
    // empty name: the viewer shows a translated placeholder
    const name = str(safe(() => a.longFilename, '')) || str(safe(() => a.filename, '')) ||
      (embedded ? str(safe(() => a.embeddedPSTMessage.subject, '')) : '');
    const mime = str(safe(() => a.mimeTag, ''));
    const cid = str(safe(() => a.contentId, '')).replace(/^<|>$/g, '');
    const att = {
      n: name,
      s: toNumber(safe(() => a.filesize, 0)) || toNumber(safe(() => a.attachSize, 0)),
      m: mime || undefined,
      e: embedded || undefined,
      h: safe(() => a.isAttachmentInvisibleInHtml, false) || undefined,
    };
    const data = embedded ? null : safe(() => readAttachment(a), null);
    if (data) att.s = data.length;
    // inline image referenced by the HTML: embed as data: URI so it shows inside the sandboxed frame
    const ref = cid && html ? new RegExp(`cid:${cid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gi') : null;
    if (data && ref && ref.test(html) && data.length <= opts.maxInlineKb * 1024) {
      const type = mime || (/\.(jpe?g)$/i.test(name) ? 'image/jpeg' : /\.gif$/i.test(name) ? 'image/gif' : 'image/png');
      html = html.replace(ref, `data:${type};base64,${data.toString('base64')}`);
      att.i = 1;
      att.h = true; // shown inside the message, not in the attachment bar (like Outlook)
    }
    if (data && opts.attachments) att.f = writer.writeAttachment(key, i, name, data);
    attachments.push(att);
  }

  let text = str(safe(() => msg.body, ''));
  if (!html && !text) {
    const rtf = safe(() => msg.bodyRTF, '');
    if (rtf) text = rtfToText(rtf);
  }
  const h = truncate(html, maxBytes);
  const t = truncate(h.value ? '' : text, maxBytes); // plain text only needed when there is no HTML
  const headers = truncate(str(safe(() => msg.transportMessageHeaders, '')), 64 * 1024);

  return {
    summary: {
      fromName: str(safe(() => msg.senderName, '')) || str(safe(() => msg.sentRepresentingName, '')),
      fromEmail: str(safe(() => msg.senderEmailAddress, '')) || str(safe(() => msg.sentRepresentingEmailAddress, '')),
      to: str(safe(() => msg.displayTo, '')),
      subject: str(safe(() => msg.subject, '')),
      date: time(safe(() => msg.messageDeliveryTime, null)) ?? time(safe(() => msg.clientSubmitTime, null)) ??
        time(safe(() => msg.creationTime, null)),
      read: safe(() => msg.isRead, true),
      attach: attachments.length > 0 || safe(() => msg.hasAttachments, false),
      importance: safe(() => msg.importance, 1),
      size: toNumber(safe(() => msg.messageSize, 0)),
      cls: str(safe(() => msg.messageClass, '')),
    },
    detail: {
      sent: time(safe(() => msg.clientSubmitTime, null)),
      cc: str(safe(() => msg.displayCC, '')),
      r: recipients,
      a: attachments,
      html: h.value || undefined,
      text: t.value || undefined,
      trunc: h.truncated || t.truncated || undefined,
      hdr: headers.value || undefined,
      mid: str(safe(() => msg.internetMessageId, '')) || undefined,
    },
  };
}

// Viewer translations: locales/<code>.json (ISO 639-1, optionally with region, e.g. "de" or "pt-BR") are copied
// to data/i18n/<code>.js; every file found there becomes selectable in the viewer
function writeLocales(writer) {
  const languages = [];
  const files = fs.existsSync(LOCALES_DIR) ? fs.readdirSync(LOCALES_DIR).filter((f) => /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*\.json$/.test(f)) : [];
  fs.mkdirSync(path.join(writer.dataDir, 'i18n'), { recursive: true });
  for (const f of files) {
    const code = f.replace(/\.json$/, '');
    let dict;
    try {
      dict = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, f), 'utf8'));
    } catch (err) {
      console.error(`Translation file ${f} is invalid and was skipped: ${err.message}`);
      continue;
    }
    writer.write(`i18n/${code}.js`, `OST.i18n(${JSON.stringify(code)},${JSON.stringify(dict)});\n`);
    languages.push({ code, name: (dict._meta && dict._meta.name) || code });
  }
  if (!languages.some((l) => l.code === 'en')) console.error('Warning: locales/en.json is missing (default language and fallback for missing texts).');
  return languages.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function buildViewer(opts) {
  const out = opts.out || opts.input.replace(/\.(ost|pst)$/i, '') + '_html';
  const box = openMailbox(opts.input, opts);
  if (fs.existsSync(out) && fs.readdirSync(out).length) {
    if (!opts.force) throw new UserError(`Output folder ${out} is not empty. Use --force to overwrite.`);
    // only remove what this tool generates
    for (const f of ['data', 'assets', 'index.html']) fs.rmSync(path.join(out, f), { recursive: true, force: true });
  }
  console.log(`Reading ${opts.input} (${box.kind}, ${formatBytes(box.size)}) …`);
  const writer = new Writer(out, opts);
  const collector = new PimCollector();
  const folders = [];
  const errors = [];
  let total = 0;
  const bar = progress((secs) => `${total} items, ${folders.length} folders, ${(total / Math.max(secs, 0.001)).toFixed(0)}/s`);

  walkFolders(box.pst.getRootFolder(), (folder, segments, parentId) => {
    const id = folders.length;
    const name = segments.length ? segments[segments.length - 1] : str(safe(() => folder.displayName, '')); // empty: translated placeholder
    // path below the top of the mailbox, shown in search results and calendar/contact details
    const info = { id, parent: parentId ?? null, depth: segments.length, name, path: storeRelative(segments),
      cls: str(safe(() => folder.containerClass, '')), count: 0, unread: 0, chunks: 0 };
    folders.push(info);
    const where = segments.join(' / ') || '(root)';
    const rows = [];
    forEachItem(folder, (msg) => {
      total++;
      bar.tick();
      const key = String(safe(() => msg.descriptorNodeId, `${id}-${rows.length}`));
      const { summary: s, detail } = extractMessage(msg, opts, writer, key);
      collector.add(msg, s.cls, key, id);
      const chunk = writer.addDetail(key, detail);
      // compact row: [key, chunk, date, fromName, fromEmail, to, subject, flags, size, class]
      const flags = (s.read ? 0 : 1) | (s.attach ? 2 : 0) | (s.importance === 2 ? 4 : 0) | (s.importance === 0 ? 8 : 0);
      rows.push([key, chunk, s.date, s.fromName, s.fromEmail, s.to, s.subject, flags, s.size, s.cls === 'IPM.Note' ? '' : s.cls]);
      if (!s.read) info.unread++;
    }, (err, msg) => errors.push(`${where}: ${msg ? 'item skipped (' + err.message + ')' : err.message}`));
    rows.sort((a, b) => (b[2] ?? 0) - (a[2] ?? 0)); // newest first
    info.count = rows.length;
    info.chunks = writer.writeList(id, rows);
    return id;
  }, (err, segments) => errors.push(`${segments.join(' / ')}: subfolders not readable (${err.message})`));
  writer.flushBodies();
  const secs = bar.done();
  box.close();

  collector.finish();
  const meta = {
    store: box.store, file: path.basename(opts.input), fileSize: box.size, format: box.format, kind: box.kind,
    generated: Date.now(), total, folders, errors: errors.slice(0, 500), errorCount: errors.length,
    languages: writeLocales(writer), pim: collector.counts(),
  };
  writer.write('cal.js', `OST.cal(${JSON.stringify({ events: collector.events, occ: collector.occ })});\n`);
  writer.write('contacts.js', `OST.contacts(${JSON.stringify(collector.contacts)});\n`);
  writer.write('tasks.js', `OST.tasks(${JSON.stringify(collector.tasks)});\n`);
  writer.write('tree.js', `OST.tree(${JSON.stringify(meta)});\n`);
  fs.mkdirSync(path.join(out, 'assets'), { recursive: true });
  fs.copyFileSync(path.join(VIEWER_DIR, 'index.html'), path.join(out, 'index.html'));
  for (const f of ['viewer.css', 'viewer.js']) fs.copyFileSync(path.join(VIEWER_DIR, f), path.join(out, 'assets', f));

  console.log(`Finished in ${secs.toFixed(1)} s: ${total} items in ${folders.length} folders, ` +
    `${writer.files} data files (${formatBytes(writer.bytesWritten)}), ${errors.length} errors.`);
  const pc = meta.pim;
  if (pc.events || pc.contacts || pc.tasks) console.log(`Calendar: ${pc.events} events (${pc.occurrences} occurrences), contacts: ${pc.contacts}, tasks: ${pc.tasks}` +
    (collector.errors ? ` – ${collector.errors} item(s) could not be read for these views` : ''));
  if (writer.attachmentFiles) console.log(`Attachments: ${writer.attachmentFiles} files (${formatBytes(writer.attachmentBytes)}) in data/a/`);
  console.log(`Open: ${path.resolve(out, 'index.html')}`);
  if (errors.length) console.log('First errors:\n  ' + errors.slice(0, 5).join('\n  '));
}

module.exports = { buildViewer };
