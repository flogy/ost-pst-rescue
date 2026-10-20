#!/usr/bin/env node
// End-to-end test: generates the sample mailbox as OST and PST, reads every item back and compares it with the
// content model, then runs the exporters and checks their output (mbox, iCalendar, vCard, HTML viewer data).
//
// Usage: npm test   (or: node test/run.js [--keep])
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ost-pst-rescue-test-'));
const SEED = 20261019;
let failures = 0;
const ok = (msg) => console.log(`  ok    ${msg}`);
const fail = (msg) => { failures++; console.log(`  FAIL  ${msg}`); };
const check = (cond, msg) => (cond ? ok(msg) : fail(msg));
const run = (script, args) => {
  const r = spawnSync(process.execPath, [path.join(ROOT, script), ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) fail(`${script} exited with ${r.status}: ${(r.stderr || '').slice(-500)}`);
  return r.stdout || '';
};

// ---------------------------------------------------------------------------
console.log('Generating sample files');
const files = { ost: path.join(TMP, 'sample.ost'), pst: path.join(TMP, 'sample.pst') };
run('sample/generate.js', [files.ost, files.pst, '--seed', String(SEED)]);
for (const f of Object.values(files)) check(fs.existsSync(f), `${path.basename(f)} written`);

// ---------------------------------------------------------------------------
// Round trip: every item of the model must come back unchanged
const { PSTFile } = require('pst-extractor');
const buildMailbox = require(path.join(ROOT, 'sample', 'content'));
require(path.join(ROOT, 'lib', 'pst-fixes')).install();

function roundTrip(file) {
  const box = buildMailbox(SEED);
  const expected = [];
  (function walk(list, trail) {
    for (const f of list) {
      for (const m of f.items) expected.push({ path: [...trail, f.name].join('/'), m });
      walk(f.children, [...trail, f.name]);
    }
  })(box.folders, []);

  const pst = new PSTFile(file);
  const got = new Map();
  const top = (p) => p.replace(/^(Root - Mailbox\/IPM_SUBTREE|Top of Outlook data file)\//, '');
  const readAll = (s) => { const b = Buffer.alloc(s.length.toNumber()); s.readCompletely(b); return b; };
  let stored = 0;
  let read = 0;
  (function walk(folder, segs) {
    if (folder.contentCount > 0) {
      stored += folder.contentCount;
      let msg;
      while ((msg = folder.getNextChild())) {
        read++;
        const atts = [];
        for (let i = 0; i < msg.numberOfAttachments; i++) {
          const a = msg.getAttachment(i);
          const em = a.attachMethod === 5 ? a.embeddedPSTMessage : null;
          const s = em ? null : a.fileInputStream;
          atts.push({ data: s ? readAll(s) : null, cid: a.contentId, em });
        }
        const created = msg.creationTime ? msg.creationTime.getTime() : 0;
        got.set(`${top(segs.join('/'))}|${msg.subject}|${created}`, { msg, atts });
      }
    }
    if (folder.hasSubfolders) for (const s of folder.getSubFolders()) walk(s, [...segs, s.displayName]);
  })(pst.getRootFolder(), []);

  const problems = [];
  const crlf = (s) => (s || '').replace(/\r\n/g, '\n');
  for (const { path: p, m } of expected) {
    const g = got.get(`${p}|${m.subject}|${m.draft ? m.date.getTime() : m.date.getTime() + 3000}`);
    const id = `${p} "${m.subject.slice(0, 40)}"`;
    if (!g) { problems.push(`${id}: not found`); continue; }
    const msg = g.msg;
    if (msg.messageClass !== m.cls) problems.push(`${id}: class ${msg.messageClass}`);
    if (m.format === 'rtf') { if (!(msg.bodyRTF || '').includes('\\rtf1')) problems.push(`${id}: RTF body missing`); }
    else if (crlf(msg.body) !== (m.text || '')) problems.push(`${id}: text body differs`);
    if (m.format === 'html' && msg.bodyHTML !== m.html) problems.push(`${id}: HTML body differs`);
    if (msg.numberOfRecipients !== m.to.length + m.cc.length + m.bcc.length) problems.push(`${id}: recipients`);
    if (g.atts.length !== m.attachments.length) problems.push(`${id}: ${g.atts.length} of ${m.attachments.length} attachments`);
    m.attachments.forEach((a, i) => {
      const ga = g.atts[i];
      if (!ga) return;
      if (a.embedded) { if (!ga.em || ga.em.subject !== a.embedded.subject) problems.push(`${id}: embedded message`); }
      else if (!ga.data || !ga.data.equals(a.data)) problems.push(`${id}: attachment ${a.name} differs`);
      if (a.cid && ga.cid !== a.cid) problems.push(`${id}: content id`);
    });
  }
  pst.close(); // properties are read lazily, so only now
  check(read === expected.length && stored === read, `${path.basename(file)}: ${read} items read (${expected.length} expected, ${stored} stored)`);
  check(!problems.length, `${path.basename(file)}: all items identical to the model${problems.length ? ` – ${problems.slice(0, 5).join('; ')}` : ''}`);
}
// Expected numbers, derived from the content model
const COUNT = (() => {
  const all = [];
  (function walk(list) { for (const f of list) { all.push(...f.items); walk(f.children); } })(buildMailbox(SEED).folders);
  const n = (re) => all.filter((m) => re.test(m.cls)).length;
  return { total: all.length, mail: n(/^IPM\.(Note|Schedule)/), events: n(/^IPM\.Appointment/), tasks: n(/^IPM\.Task/), contacts: n(/^IPM\.Contact/) };
})();

console.log('Reading the samples back');
roundTrip(files.ost);
roundTrip(files.pst);

// ---------------------------------------------------------------------------
// iCalendar / vCard structure (RFC 5545 / RFC 2426): CRLF, folding, nesting, required properties
function validateCard(file, expectCounts) {
  if (!fs.existsSync(file)) return fail(`${path.basename(file)} missing`);
  const text = fs.readFileSync(file, 'utf8');
  const problems = [];
  if (/[^\r]\n/.test(text)) problems.push('bare LF');
  text.split('\r\n').forEach((l, i) => { if (Buffer.byteLength(l) > 75) problems.push(`line ${i + 1} longer than 75 octets`); });
  const stack = [];
  const counts = {};
  const need = { VEVENT: ['UID', 'DTSTAMP', 'DTSTART'], VTODO: ['UID', 'DTSTAMP'], VCARD: ['VERSION', 'FN', 'N'], VTIMEZONE: ['TZID'], VALARM: ['ACTION', 'TRIGGER'] };
  for (const l of text.replace(/\r\n[ \t]/g, '').split('\r\n').filter(Boolean)) {
    const m = /^(BEGIN|END):(\S+)$/.exec(l);
    if (m && m[1] === 'BEGIN') { stack.push({ name: m[2], props: new Set() }); continue; }
    if (m) {
      const c = stack.pop();
      if (!c || c.name !== m[2]) { problems.push(`BEGIN/END mismatch at ${m[2]}`); continue; }
      counts[c.name] = (counts[c.name] || 0) + 1;
      for (const p of need[c.name] || []) if (!c.props.has(p)) problems.push(`${c.name} without ${p}`);
      continue;
    }
    if (!/^[A-Za-z-]+[;:]/.test(l)) problems.push('malformed line');
    else if (stack.length) stack[stack.length - 1].props.add(l.split(/[;:]/)[0]);
  }
  if (stack.length) problems.push('unclosed component');
  for (const [k, v] of Object.entries(expectCounts)) if (counts[k] !== v) problems.push(`${v} ${k} expected, ${counts[k] || 0} found`);
  check(!problems.length, `${path.basename(file)}: ${JSON.stringify(counts)}${problems.length ? ` – ${[...new Set(problems)].slice(0, 5).join('; ')}` : ''}`);
  return text;
}

console.log('Exporting to mbox, iCalendar and vCard');
for (const [kind, file] of Object.entries(files)) {
  const out = path.join(TMP, `${kind}.mbox`);
  run('rescue.js', ['export', file, out, '--single', '--gmail-labels', '--force']);
  const mbox = fs.readFileSync(out, 'utf8');
  const messages = (mbox.match(/^From /gm) || []).length;
  check(messages === COUNT.mail, `${kind}.mbox: ${messages} messages (${COUNT.mail} expected)`);
  check(/^X-Gmail-Labels: Inbox\/Customers - Projects\/Fabrikam Webshop Relaunch$/m.test(mbox), `${kind}.mbox: folder labels`);
  // the weekly series has one changed occurrence -> one extra VEVENT
  const folded = validateCard(path.join(TMP, `${kind}.calendar.ics`), { VEVENT: COUNT.events + 1, VTIMEZONE: 1, VCALENDAR: 1 });
  const ics = folded && folded.replace(/\r\n[ \t]/g, ''); // unfold content lines
  if (ics) {
    check(ics.includes('RRULE:FREQ=MONTHLY;INTERVAL=1;BYDAY=FR;BYSETPOS=-1;COUNT=12'), `${kind}: "last Friday" series`);
    check(/EXDATE;TZID=[^:]+:20260831T090000/.test(ics) && /RECURRENCE-ID;TZID=[^:]+:20260914T090000/.test(ics), `${kind}: deleted and changed occurrence`);
    check(/RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR;WKST=MO;UNTIL=20261218T074500Z/.test(ics), `${kind}: series end date in UTC`);
  }
  validateCard(path.join(TMP, `${kind}.tasks.ics`), { VTODO: COUNT.tasks });
  validateCard(path.join(TMP, `${kind}.contacts.vcf`), { VCARD: COUNT.contacts });
}

// ---------------------------------------------------------------------------
console.log('Building the HTML viewer');
const html = path.join(TMP, 'viewer');
run('rescue.js', ['view', files.pst, html, '--force']);
const data = (name) => {
  const src = fs.readFileSync(path.join(html, 'data', name), 'utf8');
  let value;
  const OST = new Proxy({}, { get: () => (...args) => { value = args[args.length - 1]; } });
  new Function('OST', src)(OST);
  return value;
};
check(fs.existsSync(path.join(html, 'index.html')), 'index.html written');
const tree = data('tree.js');
check(tree.total === COUNT.total && tree.errorCount === 0, `tree.js: ${tree.total} items (${COUNT.total} expected), ${tree.errorCount} errors`);
check(['de', 'en'].every((c) => tree.languages.some((l) => l.code === c)), 'translations de/en included');
const cal = data('cal.js');
const weekly = Object.entries(cal.events).find(([, e]) => e.t === 'Weekly Team');
const weeklyOcc = weekly ? cal.occ.filter((o) => o[0] === weekly[0]) : [];
check(weeklyOcc.length > 20 && weeklyOcc.some((o) => o[4] === 1), `calendar: weekly series expanded to ${weeklyOcc.length} occurrences incl. the changed one`);
check(data('contacts.js').length === COUNT.contacts && data('tasks.js').length === COUNT.tasks, 'contacts and tasks for the viewer tabs');
const script = fs.readFileSync(path.join(html, 'assets', 'viewer.js'), 'utf8');
try { new Function(script); ok('viewer script parses'); } catch (err) { fail(`viewer script: ${err.message}`); }

// ---------------------------------------------------------------------------
if (process.argv.includes('--keep')) console.log(`\nOutput kept in ${TMP}`);
else fs.rmSync(TMP, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
