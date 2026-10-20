// "dates" command: how many mails exist per month, without reading subjects, senders or bodies.
//
// An abrupt start (e.g. exactly 12 months ago) hints at Outlook's "Mail to keep offline" setting: older mail
// then only exists on the server and is missing from the OST file.
'use strict';
const path = require('path');
const { openMailbox, walkFolders, forEachItem, safe, str, formatBytes } = require('./mailbox');

function mailDates(opts) {
  const started = Date.now();
  const box = openMailbox(opts.input, opts);
  const months = new Map(); // "YYYY-MM" -> count
  const perFolder = [];
  let total = 0;
  let undated = 0;
  let nonMail = 0;
  const ym = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const day = (d) => d.toISOString().slice(0, 10);

  walkFolders(box.pst.getRootFolder(), (folder, segments) => {
    let min = null;
    let max = null;
    let count = 0;
    forEachItem(folder, (msg) => {
      if (!/^IPM\.Note/i.test(str(safe(() => msg.messageClass, '')))) { nonMail++; return; }
      const d = safe(() => msg.messageDeliveryTime, null) || safe(() => msg.clientSubmitTime, null);
      count++;
      total++;
      if (!d || isNaN(d) || d.getFullYear() < 1990) { undated++; return; }
      months.set(ym(d), (months.get(ym(d)) || 0) + 1);
      if (!min || d < min) min = d;
      if (!max || d > max) max = d;
    });
    if (count) perFolder.push({ path: segments.map((s) => s || '(no name)').join('/'), count, min, max });
  });
  box.close();

  console.log(`${box.kind}: ${path.basename(opts.input)} (${formatBytes(box.size)}), read in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  console.log(`Mails: ${total} (without date: ${undated}), other items (appointments, contacts, …): ${nonMail}\n`);

  const keys = [...months.keys()].sort();
  if (keys.length) {
    // one line per month from the first to the last, so gaps are visible
    const [y0, m0] = keys[0].split('-').map(Number);
    const [y1, m1] = keys[keys.length - 1].split('-').map(Number);
    const peak = Math.max(...months.values());
    let year = null;
    for (let y = y0, m = m0; y < y1 || (y === y1 && m <= m1); m === 12 ? (y++, (m = 1)) : m++) {
      const key = `${y}-${String(m).padStart(2, '0')}`;
      const n = months.get(key) || 0;
      if (year !== y) {
        console.log(`${y}  (${keys.filter((k) => k.startsWith(`${y}-`)).reduce((s, k) => s + months.get(k), 0)})`);
        year = y;
      }
      console.log(`  ${key}  ${String(n).padStart(5)}  ${'█'.repeat(Math.round((n / peak) * 50))}`);
    }
  }
  if (opts.folders) {
    console.log('\nPer folder (oldest – newest):');
    for (const f of perFolder) console.log(`  ${f.min ? day(f.min) : '?'} – ${f.max ? day(f.max) : '?'}  ${String(f.count).padStart(5)}  ${f.path}`);
  }
}

module.exports = { mailDates };
