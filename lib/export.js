// "export" command: mail to mbox, appointments and tasks to iCalendar, contacts to vCard.
'use strict';
const fs = require('fs');
const path = require('path');
const { UserError, openMailbox, walkFolders, forEachItem, storeRelative, progress, safe, str, safeFileName, formatBytes } = require('./mailbox');
const { buildMessage, MboxFile, smtpOf, asctime } = require('./mime');
const { PimExport, NON_MAIL } = require('./pim');

// Folder path glob: "*" within one level, "**" across levels, "X/**" also matches X itself; case-insensitive
function globToRegex(pattern) {
  let p = pattern.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  let suffix = '';
  if (p.endsWith('/**')) { p = p.slice(0, -3); suffix = '(?:/.*)?'; }
  const re = p.split(/(\*\*|\*|\?|\[!?[^\]/]+\])/).map((part) => {
    if (part === '**') return '.*';
    if (part === '*') return '[^/]*';
    if (part === '?') return '[^/]';
    if (/^\[.+\]$/.test(part)) return '[' + part.slice(1, -1).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']';
    return part.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }).join('');
  return new RegExp(`^${re}${suffix}$`, 'i');
}

// A folder matches when its full path or its path below the top of the mailbox matches
function matches(segments, regexes) {
  const relative = storeRelative(segments).join('/');
  return regexes.some((re) => re.test(segments.join('/')) || (relative && re.test(relative)));
}

// Label for X-Gmail-Labels: folder path below the top of the mailbox, "/" separating levels
function folderLabel(segments, opts) {
  const splitPath = (p) => p.split('/').map((s) => s.trim()).filter(Boolean);
  let segs = storeRelative(segments).map((s) => s.replace(/\//g, opts.labelSlash).replace(/\s+/g, ' ').trim());
  const strip = splitPath(opts.labelStrip);
  if (strip.length && strip.every((s, i) => segs[i] && segs[i].toLowerCase() === s.toLowerCase())) segs = segs.slice(strip.length);
  return [...splitPath(opts.labelPrefix), ...segs].join('/') || 'Inbox';
}

function collectFolders(pst) {
  const out = [];
  walkFolders(pst.getRootFolder(), (folder, segments) => {
    if (segments.length) out.push({ folder, segments: segments.map((s) => s || '(no name)') }); // skip the unnamed root
  }, (err, segments) => console.error(`Subfolders of "${segments.join('/')}" not readable: ${err.message}`));
  return out;
}

// --list: folder tree with item counts
function listFolders(opts) {
  const box = openMailbox(opts.input, opts);
  console.log(`${box.kind}: ${opts.input}\n`);
  for (const { folder, segments } of collectFolders(box.pst)) {
    const count = safe(() => folder.contentCount, 0);
    const cls = str(safe(() => folder.containerClass, ''));
    console.log(`${'  '.repeat(segments.length - 1)}${segments[segments.length - 1]}  (${count}${cls && cls !== 'IPF.Note' ? ', ' + cls : ''})`);
  }
  console.log('\nPaths for --include/--exclude, e.g. "Inbox", "Inbox/**", "*/Projects"');
  box.close();
}

function exportMailbox(opts) {
  const base = opts.input.replace(/\.(ost|pst)$/i, '');
  const out = opts.out || (opts.single ? base + '.mbox' : base + '_mbox');
  const box = openMailbox(opts.input, opts);
  const folders = collectFolders(box.pst);
  const include = opts.include.map(globToRegex);
  const exclude = opts.exclude.map(globToRegex);
  const selected = folders.filter((f) => (!include.length || matches(f.segments, include)) && !matches(f.segments, exclude));
  if (!selected.length) throw new UserError('No folders selected. Use --list to show the available folder paths.');

  // calendar/tasks/contacts next to the mbox output
  const pimBase = opts.single ? out.replace(/\.mbox$/i, '') + '.' : path.join(out, '');
  const pimFiles = { calendar: pimBase + 'calendar.ics', tasks: pimBase + 'tasks.ics', contacts: pimBase + 'contacts.vcf' };
  const existing = [out, ...(opts.single && !opts.mailOnly ? Object.values(pimFiles) : [])]
    .filter((f) => fs.existsSync(f) && (!fs.statSync(f).isDirectory() || fs.readdirSync(f).length));
  if (existing.length) {
    if (!opts.force) throw new UserError(`Output already exists: ${existing.join(', ')}. Use --force to overwrite.`);
    for (const f of existing) fs.rmSync(f, { recursive: true, force: true });
  }
  if (!opts.single) fs.mkdirSync(out, { recursive: true });
  const pim = opts.mailOnly ? null : new PimExport(pimFiles);

  console.log(`Reading ${opts.input} (${box.kind}, ${formatBytes(box.size)}), ${selected.length} of ${folders.length} folders selected …`);
  const labels = new Map();
  const stats = { messages: 0, nonMail: new Map(), errors: [], attachments: 0, attachmentBytes: 0, attachmentErrors: 0, embedded: 0 };
  const single = opts.single ? new MboxFile(out) : null;
  const usedPaths = new Set();
  const written = [];
  const bar = progress((secs) => `${stats.messages} messages, ${(stats.messages / Math.max(secs, 0.001)).toFixed(0)}/s`);

  for (const { folder, segments } of selected) {
    if (!safe(() => folder.contentCount, 0)) continue;
    const folderPath = segments.join('/');
    let mbox = single;
    let file = out;
    if (!single) {
      const rel = segments.map((s) => safeFileName(s)).join(path.sep);
      let candidate = rel + '.mbox';
      for (let n = 2; usedPaths.has(candidate.toLowerCase()); n++) candidate = `${rel} (${n}).mbox`;
      usedPaths.add(candidate.toLowerCase());
      file = path.join(out, candidate);
    }
    let folderMessages = 0;
    const ctx = { opts, stats, folderPath, label: opts.gmailLabels ? folderLabel(segments, opts) : '' };

    forEachItem(folder, (msg) => {
      const cls = str(safe(() => msg.messageClass, ''));
      if (NON_MAIL.test(cls)) {
        const handled = pim ? pim.add(msg, cls, folderPath) : false;
        if (!handled) stats.nonMail.set(cls, (stats.nonMail.get(cls) || 0) + 1);
        if (!opts.allItems) return;
      }
      const chunks = buildMessage(msg, ctx);
      const date = safe(() => msg.messageDeliveryTime, null) || safe(() => msg.clientSubmitTime, null) || new Date(0);
      const envelope = smtpOf(safe(() => msg.getStringItem(0x5d01), ''), safe(() => msg.senderEmailAddress, '')) || 'MAILER-DAEMON';
      if (!mbox) mbox = new MboxFile(file);
      mbox.writeMessage(`From ${envelope} ${asctime(date)}`, chunks);
      stats.messages++;
      folderMessages++;
      if (ctx.label) labels.set(ctx.label, (labels.get(ctx.label) || 0) + 1);
      bar.tick();
    }, (err, msg) => stats.errors.push(`${folderPath}: ${msg ? 'item skipped (' + err.message + ')' : err.message}`));

    if (mbox && !single) {
      mbox.close();
      written.push({ file, bytes: mbox.bytes });
    }
  }
  if (single) {
    single.close();
    written.push({ file: out, bytes: single.bytes });
  }
  const pimWritten = pim ? pim.close() : [];
  box.close();
  const secs = bar.done();

  // Summary: what went where, and what was not exported
  const n = (v) => v.toLocaleString('en-US');
  const rel = (f) => { const r = path.relative(process.cwd(), path.resolve(f)); return !r || r.startsWith('..') ? path.resolve(f) : r; };
  const fileOf = (kind) => (pimWritten.find((w) => w.kind === kind) || {}).file;
  console.log(`\nExport finished in ${secs.toFixed(1)} s\n`);
  console.log(`  Mail       ${n(stats.messages).padStart(7)}  -> ${opts.single ? rel(out) : `${written.length} mbox file(s) in ${rel(out)}`} ` +
    `(${formatBytes(written.reduce((s, w) => s + w.bytes, 0))}), ${n(stats.attachments)} attachments, ${n(stats.embedded)} attached messages`);
  if (pim) {
    const c = pim.counts;
    const line = (label, count, kind, extra = '') => console.log(`  ${label.padEnd(10)} ${n(count).padStart(7)}  ${count ? `-> ${rel(fileOf(kind))}${extra}` : ''}`);
    line('Calendar', c.events, 'calendar', c.recurring ? ` (${n(c.recurring)} recurring series, ${n(c.modified)} changed occurrences)` : '');
    line('Tasks', c.tasks, 'tasks');
    line('Contacts', c.contacts, 'contacts');
  }
  const notExported = [];
  if (pim) for (const [reason, count] of pim.skipped) notExported.push(`${n(count).padStart(7)}  ${reason}`);
  for (const [cls, count] of stats.nonMail) {
    notExported.push(`${n(count).padStart(7)}  ${cls}${pim ? '' : ' (--mail-only)'}${opts.allItems ? ' (included in the mbox as text)' : ''}`);
  }
  if (notExported.length) console.log('\n  Not exported:\n' + notExported.map((l) => '  ' + l).join('\n'));
  if (pim && pim.counts.simplified) console.log(`\n  Note: ${n(pim.counts.simplified)} recurring series use a pattern iCalendar cannot express; only their first occurrence was exported.`);
  if (pim && pim.counts.modified) console.log('  Note: changed occurrences of recurring series keep their new time, subject and location, but not individual notes.');
  const errors = [...stats.errors, ...(pim ? pim.errors : [])];
  if (stats.attachmentErrors) console.log(`\n  ${n(stats.attachmentErrors)} attachment(s) could not be read.`);
  if (errors.length) console.log(`\n  ${n(errors.length)} error(s), first:\n    ` + errors.slice(0, 5).join('\n    '));
  if (labels.size) console.log('\n  Labels:\n' + [...labels].map(([l, c]) => `    ${l}  (${n(c)})`).join('\n'));
}

module.exports = { exportMailbox, listFolders, globToRegex };
