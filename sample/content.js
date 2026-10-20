// Fictitious mailbox content for sample/generate.js.
//
// Everything here is invented: persons, phone numbers, addresses, amounts and texts. Company names and
// domains are Microsoft's fictitious example companies (contoso.com, fabrikam.com, ...); spam and phishing
// senders use the reserved top-level domain .example. Attachments are real, openable files (PDF, DOCX,
// PNG, CSV, ICS, VCF) generated on the fly by files.js. The output is deterministic for a given seed.
'use strict';
const { mulberry32, png, pdf, docx, ics, vcf, csv, rtf, file } = require('./files');

// ---------------------------------------------------------------------------
// Mailbox
// ---------------------------------------------------------------------------
// The main language is English; a few messages deliberately use German, French, Russian, Japanese, Chinese,
// Arabic and emoji to cover character set edge cases.
module.exports = function buildMailbox(seed = 20261019) {
  const rnd = mulberry32(seed >>> 0);
  const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const chance = (p) => rnd() < p;
  const noise = (n) => { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = (rnd() * 256) | 0; return b; };
  const hex = (n) => noise(n).toString('hex').toUpperCase();

  const NOW = new Date(Date.UTC(2026, 9, 19, 14, 30));
  const DAY = 86400000;
  const at = (d, h, m = 0) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, m));
  const addDays = (d, n) => new Date(d.getTime() + n * DAY);
  const addMin = (d, n) => new Date(d.getTime() + n * 60000);
  const workday = (d) => (d.getUTCDay() === 6 ? addDays(d, 2) : d.getUTCDay() === 0 ? addDays(d, 1) : d);
  const randomDate = (from, to) => {
    let d = workday(new Date(from.getTime() + rnd() * (to.getTime() - from.getTime())));
    d = at(d, int(6, 15), int(0, 59));
    return d > NOW ? addDays(NOW, -int(1, 3)) : d;
  };
  const WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MO = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const two = (n) => String(n).padStart(2, '0');
  const fmtDate = (d) => `${d.getUTCDate()} ${MO[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  const fmtShort = (d) => `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}`;
  const fmtLong = (d) => `${WD[d.getUTCDay()]}, ${fmtDate(d)} ${two(d.getUTCHours() + 2)}:${two(d.getUTCMinutes())}`;
  const money = (n) => n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const kw = (d) => { const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7)); return Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / DAY + 1) / 7); };

  // --- Companies and persons ------------------------------------------------
  const C = {
    contoso: { name: 'Contoso Ltd.', domain: 'contoso.com', street: '10 Example Street', city: '8000 Zurich, Switzerland' },
    fabrikam: { name: 'Fabrikam Inc.', domain: 'fabrikam.com', street: '3 Sample Road', city: 'Manchester M1 1AA, UK' },
    northwind: { name: 'Northwind Traders', domain: 'northwindtraders.com', street: '21 Harbour Street', city: '4000 Basel, Switzerland' },
    alpine: { name: 'Alpine Ski House SA', domain: 'alpineskihouse.com', street: '5 Route des Alpes', city: '1950 Sion, Switzerland' },
    tailspin: { name: 'Tailspin Toys', domain: 'tailspintoys.com', street: '8 Lake Drive', city: 'Seattle, WA 98101, USA' },
    trey: { name: 'Trey Research Inc.', domain: 'treyresearch.net', street: '1-2-3 Example-cho', city: 'Tokyo, Japan' },
    litware: { name: 'Litware Hosting Ltd.', domain: 'litwareinc.com', street: '1 Server Lane', city: 'Dublin, Ireland' },
    wwi: { name: 'Wide World Importers', domain: 'wideworldimporters.com', street: '44 Industry Road', city: 'Rotterdam, Netherlands' },
    proseware: { name: 'Proseware GmbH', domain: 'proseware.com', street: 'Lizenzgasse 2', city: '80331 München, Germany' },
    woodgrove: { name: 'Woodgrove Bank', domain: 'woodgrovebank.com' },
    margie: { name: "Margie's Travel", domain: 'margiestravel.com' },
    blueyonder: { name: 'Blue Yonder Airlines', domain: 'blueyonderairlines.com' },
    lucerne: { name: 'Lucerne Publishing', domain: 'lucernepublishing.com' },
    adventure: { name: 'Adventure Works', domain: 'adventure-works.com' },
    coho: { name: 'Coho Winery', domain: 'cohowinery.com' },
    fourth: { name: 'Fourth Coffee', domain: 'fourthcoffee.com' },
  };
  const translit = (s) => s.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const phone = () => `+41 ${pick(['44', '31', '61', '41', '27'])} 000 ${two(int(10, 99))} ${two(int(10, 99))}`;
  const person = (first, last, co, title, extra = {}) => ({
    first, last, name: `${first} ${last}`, title, co, company: co.name, phone: phone(),
    email: `${translit(first)}.${translit(last)}@${co.domain}`, ...extra,
  });
  const service = (name, local, co) => ({ name, first: name, last: '', email: `${local}@${co.domain}`, co, company: co.name, service: true });

  const owner = person('Alex', 'Morgan', C.contoso, 'Project Manager');
  const emma = person('Emma', 'Clarke', C.contoso, 'Head of Engineering');
  const sarah = person('Sarah', 'Brunner', C.contoso, 'UX Designer');
  const ryan = person('Ryan', 'Patel', C.contoso, 'Software Engineer');
  const nadia = person('Nadia', 'Steiner', C.contoso, 'Marketing & Communications');
  const thomas = person('Thomas', 'Baker', C.contoso, 'CEO');
  const laura = person('Laura', 'Frey', C.contoso, 'HR Manager');
  const simon = person('Simon', 'Kälin', C.contoso, 'Controller');
  const colleagues = [emma, sarah, ryan, nadia, simon];
  const servicedesk = service('IT Service Desk', 'servicedesk', C.contoso);
  const firstNames = ['Lea', 'Noah', 'Mia', 'Luca', 'Elena', 'David', 'Nina', 'James', 'Sophie', 'Oliver', 'Julia', 'Samuel', 'Chiara',
    'Patrick', 'Lara', 'Michael', 'Grace', 'Adrian', 'Priya', 'Daniel', 'Hannah', 'Mateo'];
  const lastNames = ['Hughes', 'Müller', 'Smith', 'Fischer', 'Bachmann', 'Johnson', 'Moser', 'Graf', 'Nguyen', 'Roth', 'Suter',
    'Walker', 'Lüthi', 'Imhof', 'Kim', 'Vogel', 'Egli', 'Arnold', 'Garcia', 'Brändli', 'Christen', 'Odermatt'];
  const staff = firstNames.map((f, i) => person(f, lastNames[(i * 7) % lastNames.length], C.contoso, pick(['Software Engineer', 'Project Manager', 'Consultant', 'Support', 'Account Manager'])));

  const lukas = person('Lucas', 'Miller', C.fabrikam, 'Head of E-Commerce');
  const petra = person('Petra', 'Schmid', C.fabrikam, 'Purchasing');
  const daniel = person('Daniel', 'Wyss', C.northwind, 'CIO');
  const irina = person('Ирина', 'Петрова', C.northwind, 'Database Specialist', { email: 'irina.petrova@northwindtraders.com' });
  const zoe = person('Zoë', 'Lévêque', C.alpine, 'Product Owner');
  const marco = person('Marco', 'Rossi', C.alpine, 'Responsable marketing');
  const jonas = person('Jonas', 'Weber', C.tailspin, 'Head of Sales');
  const yamada = { ...person('太郎', '山田', C.trey, 'Senior Researcher', { email: 'taro.yamada@treyresearch.net' }), name: '山田 太郎', first: 'Taro' };
  const wang = { ...person('芳', '王', C.wwi, 'Sourcing Manager', { email: 'fang.wang@wideworldimporters.com' }), name: '王芳 (Wang Fang)', first: 'Fang' };
  const layla = { ...person('Layla', 'Haddad', C.blueyonder, 'Corporate Sales', { email: 'layla.haddad@blueyonderairlines.com' }), name: 'ليلى حداد (Layla Haddad)' };
  const kevin = person('Kevin', 'Hughes', C.wwi, 'Key Account Manager');
  const juergen = person('Jürgen', 'Weiß', C.proseware, 'Vertriebsleiter');
  const litware = service('Litware Support', 'support', C.litware);
  const wwiShipping = service('Wide World Importers Shipping', 'shipping', C.wwi);
  const proseware = service('Proseware Licensing', 'licensing', C.proseware);
  const bank = service('Woodgrove Bank Online Banking', 'noreply', C.woodgrove);
  const travel = service("Margie's Travel", 'bookings', C.margie);
  const airline = service('Blue Yonder Airlines', 'checkin', C.blueyonder);
  const coffee = service('Fourth Coffee Office Service', 'service', C.fourth);
  const newsletters = [
    { from: service('Digital Weekly | Lucerne Publishing', 'newsletter', C.lucerne), title: 'Digital Weekly', color: '#0b5394' },
    { from: service('Adventure Works Outdoor', 'news', C.adventure), title: 'Adventure Works Outdoor News', color: '#38761d' },
    { from: service('Coho Winery', 'wineletter', C.coho), title: 'Coho Wine Letter', color: '#741b47' },
  ];
  const spam = (name, local, domain) => ({ name, first: name, email: `${local}@${domain}`, co: { name, domain }, company: name, service: true });

  // --- Images ----------------------------------------------------------------
  const LOGO = png(160, 48, (x, y) => {
    const dx = x - 24, dy = y - 24, r = Math.sqrt(dx * dx + dy * dy);
    if (x < 48) return r > 10 && r < 16 && !(dx > 4 && Math.abs(dy) < 6) ? [255, 255, 255] : [0, 94, 184];
    if (y >= 15 && y <= 23 && x >= 58 && x <= 150) return [40, 40, 40];
    if (y >= 29 && y <= 33 && x >= 58 && x <= 128) return [150, 150, 150];
    return [255, 255, 255];
  });
  const LOGO_CID = 'image001.png@01DB2A6F.5C3E9A10';
  const photo = (w, h, amp, hue) => png(w, h, (x, y) => {
    const sky = y < h * 0.55;
    const n = (rnd() - 0.5) * amp;
    const ridge = Math.sin(x / (w / 9)) * h * 0.06 + Math.sin(x / (w / 23)) * h * 0.02;
    if (sky && y < h * 0.45 + ridge) return [Math.min(255, 110 + y * 0.2 + n) | 0, Math.min(255, 160 + y * 0.15 + n) | 0, 235 + (n / 4) | 0];
    if (y < h * 0.62 + ridge) return [120 + n | 0, 125 + n | 0, 135 + n | 0];
    return [Math.max(0, 60 + hue + n) | 0, Math.max(0, 120 + n - (y - h * 0.6) * 0.1) | 0, 50 + n | 0];
  });
  const grayImage = (width, height) => ({ width, height, data: noise(width * height) });

  // --- Text helpers ------------------------------------------------------------
  const hi = (p) => (p.co === C.contoso ? pick(['Hi Alex', 'Hello Alex', 'Hey Alex', 'Hi all']) : pick(['Dear Mr Morgan', 'Hello Alex', 'Dear Alex']));
  const bye = (p) => (p.co === C.contoso
    ? `${pick(['Cheers', 'Thanks', 'Best', 'Thanks a lot', 'See you'])}\n${p.first}`
    : signature(p));
  const signature = (p, closing) => p.service ? '' :
    `${closing || pick(['Best regards', 'Kind regards', 'Many thanks and best regards'])}\n\n${p.name}\n${p.title}\n${p.company}\n` +
    `${p.co.street ? `${p.co.street}, ${p.co.city}\n` : ''}Phone ${p.phone}`;
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const linkify = (s) => s.replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}">${u}</a>`);
  const htmlOf = (text, { logo } = {}) => {
    const paras = linkify(esc(text)).split(/\n{2,}/).map((p) => `<p class="MsoNormal">${p.replace(/\n/g, '<br>\n')}</p>`).join('\n');
    return '<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8">' +
      '<meta name="Generator" content="Microsoft Word 15 (filtered medium)"><style>p.MsoNormal{margin:0 0 11pt;font-family:Aptos,Calibri,sans-serif;font-size:11pt}</style></head>\n' +
      `<body lang="EN-GB" link="#467886"><div class="WordSection1">\n${paras}` +
      (logo ? `\n<p class="MsoNormal"><img width="160" height="48" src="cid:${LOGO_CID}" alt="Contoso Ltd."></p>` : '') + '\n</div></body></html>';
  };
  const quote = (m) => `\n\n________________________________\nFrom: ${m.from.name} <${m.from.email}>\nSent: ${fmtLong(m.date)}\n` +
    `To: ${m.to.map((p) => p.name).join('; ')}\n${m.cc.length ? `Cc: ${m.cc.map((p) => p.name).join('; ')}\n` : ''}Subject: ${m.subject}\n\n${m.text}`;
  const normalize = (s) => s.replace(/^((AW|WG|RE|FW|Fwd|TR):\s*)+/i, '');

  const mail = (o) => {
    const m = { cls: 'IPM.Note', to: [owner], cc: [], bcc: [], attachments: [], importance: 1, format: 'html', read: true, ...o };
    if (m.logo) m.attachments = [...m.attachments, file('image001.png', LOGO, { cid: LOGO_CID, hidden: true })];
    if (m.format === 'html' && !m.html) m.html = htmlOf(m.text, m);
    if (m.format === 'rtf') m.rtf = rtf(m.text);
    const pre = /^((AW|WG|RE|FW|TR):\s*)/i.exec(m.subject);
    if (pre) m.prefix = pre[1];
    return m;
  };
  const replyTo = (orig, text, { all = false, delayMin = int(20, 600), extra = {} } = {}) => mail({
    from: owner, to: [orig.from], cc: all ? orig.cc.filter((p) => p !== owner) : [], sent: true,
    subject: `RE: ${normalize(orig.subject)}`, date: addMin(orig.date, delayMin),
    text: `${text}\n\n${orig.from.co === C.contoso ? 'Thanks,\nAlex' : signature(owner)}${quote(orig)}`, logo: true, ...extra,
  });

  // --- Mail templates ------------------------------------------------------------
  const TOPICS = [
    ['webshop status', 'the webshop status'], ['sprint planning', 'the next sprint planning'], ['budget 2027', 'the 2027 budget'],
    ['release 3.2', 'release 3.2'], ['Northwind workshop', 'the Northwind workshop'], ['hosting migration', 'the move to the new hosting'],
    ['resource planning', 'resource planning'], ['test concept', 'the test concept'],
  ];
  const cap = (s) => s[0].toUpperCase() + s.slice(1);
  const T = {
    meeting(d) {
      const p = pick(colleagues);
      const [short, acc] = pick(TOPICS);
      const when = workday(addDays(d, int(1, 5)));
      return {
        from: p, cc: chance(0.3) ? [pick(colleagues.filter((c) => c !== p))] : [], logo: chance(0.5),
        subject: `${pick(['Meeting', 'Catch-up', 'Sync'])}: ${short}`,
        text: `${hi(p)}\n\n${pick([`Do you have half an hour on ${WD[when.getUTCDay()]} (${fmtShort(when)}) to go through ${acc}?`,
          `Let's talk about ${acc} before we get back to the customer.`, `I'd like to go over ${acc} with you.`])} ` +
          `${pick(['Tuesday or Thursday afternoon would work for me.', 'I put a suggestion in your calendar.',
            'Meeting room "Rigi" or online in Teams, whatever suits you.'])}\n\n${bye(p)}`,
        reply: pick(['Works for me, see you then!', 'Thursday at 2 pm would be great.', 'Sure, I will bring the numbers.']),
      };
    },
    question(d) {
      const p = pick(colleagues);
      const [short] = pick(TOPICS);
      return {
        from: p, subject: pick([`Quick question about ${short}`, `Question re ${short}`, 'Quick question']),
        text: `${hi(p)}\n\n${pick(['Do you know if the customer has signed the quote yet?',
          'Where can I find the latest version of the specification? I only see v1 in the Teams folder.',
          'Could you log your hours for this month by tomorrow noon? I am doing the month-end closing.',
          'Do you still have the credentials for the test environment? My login stopped working yesterday.',
          'Should we bring this up in Monday\'s weekly or discuss it separately?',
          'Did you see that the build on the release branch has been red since this morning?'])}\n\n${bye(p)}`,
        reply: pick(['Yes, that is done.', 'I will have a look right away and get back to you.', 'Good question – I will find out and let you know by tomorrow.']),
      };
    },
    status(d) {
      const p = pick([emma, ryan, sarah]);
      const w = kw(d);
      const rows = [['Date', 'Project', 'Activity', 'Hours']];
      for (let i = 0; i < int(8, 16); i++) rows.push([fmtShort(addDays(d, -int(0, 6))), pick(['Fabrikam webshop', 'Northwind ERP', 'Alpine app', 'Internal']),
        pick(['Development', 'Testing', 'Meeting', 'Concept', 'Code review', 'Support']), (int(2, 16) / 2).toFixed(1)]);
      const attachments = [file(`Hours_W${w}_${p.last}.csv`, csv(rows))];
      if (chance(0.5)) attachments.push(file(`Status_report_W${w}.docx`, docx(`Status report week ${w}`, [
        `Written by ${p.name}, ${fmtDate(d)}.`, 'Done: search, checkout bug fixes, alignment with the customer.',
        'Open: performance tests, sign-off of the copy by marketing.', 'Risks: availability of the ERP interface.',
        'Next steps: pilot run with selected customers, training preparation.'])));
      return { from: p, subject: `Weekly report week ${w}`, attachments, logo: true,
        text: `${hi(p)}\n\nPlease find attached my weekly report for week ${w} and my logged hours.\n\n${pick(['Nothing special to report.',
          'The customer raised two new requirements that we still need to estimate.', 'We are slightly behind plan but will catch up next week.'])}\n\n${bye(p)}` };
    },
    offer(d) {
      const p = pick([kevin, kevin, lukas]);
      const no = `${d.getUTCFullYear()}-${int(100, 999)}`;
      const items = [['Notebook Contoso Pro 14"', 1890], ['Monitor 27" 4K', 549], ['USB-C docking station', 249], ['Wireless headset', 179], ['3-year service contract', 1200]];
      const lines = [`Quote no. ${no}`, `Date: ${fmtDate(d)}`, '', `Customer: ${owner.company}, ${owner.name}`, ''];
      let total = 0;
      for (const [name, price] of items.slice(0, int(2, 5))) {
        const qty = int(1, 12);
        total += qty * price;
        lines.push(`${String(qty).padStart(3)} x ${name.padEnd(30)} CHF ${money(qty * price).padStart(12)}`);
      }
      lines.push('', `Total excl. VAT: CHF ${money(total)}`, `VAT 8.1 %: CHF ${money(total * 0.081)}`, `Total incl. VAT: CHF ${money(total * 1.081)}`,
        '', 'Valid for 30 days. Delivery about 2 weeks after order.');
      return { from: p, subject: `Quote ${no}`, attachments: [file(`Quote_${no}.pdf`, pdf(`Quote ${no}`, lines))],
        text: `${hi(p)}\n\nThank you for your enquiry. Please find our quote no. ${no} attached.\n\nLet me know if you have any questions.\n\n${signature(p)}`,
        reply: 'Thanks for the quote. We will review it internally and get back to you by the end of the week.' };
    },
    invoice(d) {
      const co = pick([C.litware, C.wwi, C.proseware, C.fourth]);
      const from = { [C.litware.domain]: service('Litware Accounts', 'invoices', C.litware), [C.wwi.domain]: service('Wide World Importers Billing', 'billing', C.wwi),
        [C.proseware.domain]: service('Proseware Billing', 'billing', C.proseware), [C.fourth.domain]: service('Fourth Coffee Invoices', 'invoices', C.fourth) }[co.domain];
      const no = `INV-${d.getUTCFullYear()}${two(d.getUTCMonth() + 1)}-${int(1000, 9999)}`;
      const amount = int(80, 4800) + int(0, 95) / 100;
      return { from, folder: 'invoices', subject: `Invoice ${no} – ${co.name}`,
        attachments: [file(`Invoice_${no}.pdf`, pdf(`Invoice ${no}`, [`${co.name}`, `${co.street || ''}, ${co.city || ''}`, '', `Invoice date: ${fmtDate(d)}`,
          `Customer: ${owner.company}, ${C.contoso.street}, ${C.contoso.city}`, '', `Services ${MO[d.getUTCMonth()]} ${d.getUTCFullYear()}`,
          `Amount excl. VAT: CHF ${money(amount)}`, `VAT 8.1 %: CHF ${money(amount * 0.081)}`, `Total: CHF ${money(amount * 1.081)}`, '',
          'Payable within 30 days.', 'IBAN: CH00 0000 0000 0000 0000 0 (sample account)']))],
        text: `Hello\n\nPlease find attached our invoice ${no} for CHF ${money(amount * 1.081)}, payable within 30 days.\n\nThank you for your business.\n\n${co.name}\nAccounts` };
    },
    it(d) {
      const items = [
        ['Planned maintenance this Saturday', 'This Saturday between 6:00 and 12:00 the servers will be maintained. Email and VPN will only be partially available during this time.', 1],
        ['Reminder: your password expires in 7 days', 'Your password expires in 7 days. Please change it in time via the self-service portal (https://password.contoso.com). We will never ask you for your password by email.', 2],
        ['VPN outage resolved', 'This morning\'s VPN outage has been resolved. If you still have problems, please restart the client.', 1],
        ['New version of Microsoft Teams is being rolled out', 'Over the next few days a new version of Microsoft Teams will be installed automatically. No action is required on your part.', 1],
        ['Phishing alert: fake parcel emails', 'Fake emails announcing a parcel delivery are currently circulating. Please do not click any links and report such emails with the "Report phishing" button.', 2],
      ];
      const [subject, body, importance] = pick(items);
      return { from: servicedesk, to: [service('All Staff', 'all', C.contoso)], subject, importance,
        text: `Dear colleagues\n\n${body}\n\nBest regards\nYour IT Service Desk\nExt. 4444 | servicedesk@contoso.com` };
    },
    hr(d) {
      const [subject, body] = pick([
        ['Holiday planning 2027', 'Please enter your holiday requests for 2027 in the HR portal by the end of the month.'],
        ['Expense claims due at month end', 'A quick reminder: please submit your expenses with all receipts by the last working day of the month.'],
        ['New colleague in the team', 'From the 1st of next month Lea Hughes joins us as a software engineer. Please give her a warm welcome!'],
        ['Training budget', 'The training budget for next year has been approved. Please send your requests by the end of November.'],
      ]);
      return { from: laura, to: [service('All Staff', 'all', C.contoso)], subject, logo: true, text: `Dear all\n\n${body}\n\nBest wishes\nLaura` };
    },
    newsletter(d) {
      const n = pick(newsletters);
      const issue = int(10, 52);
      const articles = Array.from({ length: int(4, 7) }, (_, i) => ({
        title: pick(['The key trends this autumn', 'Interview: how AI changes everyday work', 'Five tips for safer passwords',
          'Product of the month', 'Looking back at the trade fair', 'Our weekend recommendation', 'New in our range', 'Behind the scenes']),
        text: Array.from({ length: int(2, 4) }, () => pick(['Lorem ipsum dolor sit amet, consetetur sadipscing elitr, sed diam nonumy eirmod tempor invidunt ut labore et dolore magna aliquyam erat.',
          'Our editors have gathered the most interesting news for you.', 'Read what experts have to say and which questions are still open.',
          'You can find all the details on our website with just a few clicks.', 'As a subscriber you benefit from exclusive offers.'])).join(' '),
        img: `https://images.${n.from.co.domain}/newsletter/${issue}/teaser-${i + 1}.jpg`,
      }));
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${n.title} #${issue}</title>` +
        `<style>body{margin:0;background:#f2f2f2;font-family:Arial,sans-serif}.wrap{max-width:640px;margin:0 auto;background:#fff}h1{margin:0;padding:24px;background:${n.color};color:#fff;font-size:24px}` +
        `.art{padding:16px 24px;border-bottom:1px solid #eee}.art img{width:100%;height:auto;display:block}.btn{display:inline-block;padding:8px 16px;background:${n.color};color:#fff;text-decoration:none;border-radius:4px}` +
        `.foot{padding:24px;font-size:11px;color:#777}</style></head><body><div class="wrap"><img src="https://images.${n.from.co.domain}/newsletter/header.png" width="640" alt="">` +
        `<h1>${n.title} – Issue ${issue}</h1>` +
        articles.map((a) => `<div class="art"><img src="${a.img}" alt=""><h2>${esc(a.title)}</h2><p>${esc(a.text)}</p><p><a class="btn" href="https://www.${n.from.co.domain}/article/${int(1000, 9999)}?utm_source=newsletter">Read more</a></p></div>`).join('') +
        `<table width="100%" cellpadding="8"><tr>${['Facebook', 'Instagram', 'LinkedIn'].map((s) => `<td align="center"><a href="https://www.${n.from.co.domain}/social/${s.toLowerCase()}">${s}</a></td>`).join('')}</tr></table>` +
        `<div class="foot">You receive this newsletter because you subscribed on ${n.from.co.domain}. <a href="https://www.${n.from.co.domain}/unsubscribe">Unsubscribe</a><br>${n.from.co.name}, 1 Example Street</div>` +
        `<img src="https://track.${n.from.co.domain}/open.gif?u=${hex(6)}" width="1" height="1" alt=""></div></body></html>`;
      return { from: n.from, folder: 'newsletter', subject: `${n.title} #${issue}: ${articles[0].title}`, html, read: chance(0.6),
        text: `${n.title} – Issue ${issue}\n\n` + articles.map((a) => `${a.title}\n${a.text}`).join('\n\n') + `\n\nUnsubscribe: https://www.${n.from.co.domain}/unsubscribe` };
    },
    bank(d) {
      return { from: bank, subject: `Your ${MO[(d.getUTCMonth() + 11) % 12]} statement is ready`,
        text: 'Hello\n\nYour monthly account statement is now available in online banking.\n\nFor security reasons this message contains no links. Please log in to online banking as usual.\n\nKind regards\nWoodgrove Bank' };
    },
    travel(d) {
      const city = pick(['Hamburg', 'Vienna', 'Milan', 'Lyon', 'Munich']);
      const ref = `MT${int(100000, 999999)}`;
      const start = workday(addDays(d, int(10, 30)));
      return { from: travel, subject: `Booking confirmation ${ref} – hotel in ${city}`,
        attachments: [file(`Booking_${ref}.pdf`, pdf(`Booking confirmation ${ref}`, [`Guest: ${owner.name}`, `Hotel: Hotel Example ${city}`,
          `Check-in: ${fmtDate(start)}`, `Check-out: ${fmtDate(addDays(start, 2))}`, 'Room: single room, breakfast included', 'Free cancellation up to 48 hours before arrival.'])),
        file('Trip.ics', ics({ uid: `${ref}@margiestravel.com`, summary: `Hotel ${city}`, location: `Hotel Example ${city}`, start: at(start, 13), end: at(addDays(start, 2), 9), organizer: travel, stamp: d }))],
        text: `Dear ${owner.name}\n\nThank you for your booking. Your reservation ${ref} is confirmed.\n\nCheck-in: ${fmtDate(start)}\nCheck-out: ${fmtDate(addDays(start, 2))}\n\nHave a great trip!\nYour Margie's Travel team` };
    },
    flight(d) {
      const city = pick(['Hamburg', 'Vienna', 'Amsterdam', 'Lisbon']);
      const no = `BY${int(100, 999)}`;
      return { from: airline, subject: `Your boarding pass for flight ${no} to ${city}`,
        attachments: [file(`Boarding_pass_${no}.pdf`, pdf(`Boarding pass ${no}`, ['Passenger: MORGAN/ALEX MR', `Flight: ${no}  Zurich (ZRH) – ${city}`, `Date: ${fmtDate(addDays(d, 1))}`,
          `Seat: ${int(3, 30)}${pick(['A', 'C', 'D', 'F'])}   Boarding: 07:15   Gate: ${pick(['A', 'B', 'E'])}${int(10, 60)}`], { image: grayImage(120, 120) }))],
        text: `Dear Mr Morgan\n\nPlease find attached your boarding pass for flight ${no} to ${city}. Please be at the gate at least 30 minutes before departure.\n\nHave a pleasant flight.\nBlue Yonder Airlines` };
    },
    ticket(d) {
      const no = int(100000, 999999);
      const issue = pick(['SSL certificate expiring', 'Disk space on server web02', 'Backup job failed', 'DNS record for shop.contoso.com']);
      return { from: litware, format: 'text', subject: `[Ticket #${no}] ${issue}`,
        text: `Hello\n\nYour ticket #${no} has been updated.\n\nStatus: ${pick(['In progress', 'Resolved', 'Waiting for customer'])}\nPriority: ${pick(['Normal', 'High'])}\n\n` +
          `--- Reply from Litware Support ---\n${pick(['We have analysed the problem and deployed a fix. Please check whether everything works again.',
            'Please send us the exact error message and the time it occurred.', 'The certificate has been renewed and is valid for one year.'])}\n\n` +
          `Please reply directly to this email and keep the ticket number in the subject.\n\n--\nLitware Hosting Ltd. | Support 24/7 | https://support.litwareinc.com` };
    },
    delivery(d) {
      const no = `B${int(400000, 499999)}`;
      return { from: wwiShipping, format: 'text', subject: `Shipping notice for your order ${no}`,
        text: `Hello\n\nYour order ${no} has left our warehouse and is expected to arrive on ${fmtDate(workday(addDays(d, 2)))}.\n\n` +
          `Tracking number: 99.00.${int(100000, 999999)}.${int(10000000, 99999999)}\n\nKind regards\nWide World Importers – Shipping` };
    },
    autoreply(d) {
      const p = pick([lukas, petra, daniel, jonas, kevin]);
      const back = workday(addDays(d, int(5, 15)));
      return { from: p, format: 'text', subject: `Automatic reply: ${pick(['Quote', 'Meeting', 'Project question', 'Documents'])}`,
        text: `Thank you for your message. I am out of the office until ${fmtDate(back)} with limited access to email.\n\n` +
          `For urgent matters please contact info@${p.co.domain}.\n\n${p.name}` };
    },
    research(d) {
      const q = Math.floor(d.getUTCMonth() / 3) + 1;
      return { from: yamada, subject: `Research results Q${q} ${d.getUTCFullYear()}`,
        attachments: [file(`TreyResearch_Q${q}_${d.getUTCFullYear()}.pdf`, pdf(`Research results Q${q}`, ['Summary', '',
          'Participants: 1,240', 'Satisfaction: 4.3 / 5', 'Most requested feature: offline mode', '', 'Detailed figures in the appendix.']))],
        text: `Dear Mr Morgan\n\nPlease find attached our research results for Q${q}. The survey shows a clear demand for an offline mode in the mobile app.\n\n` +
          `I would be happy to walk you through the details in a short call next week.\n\nBest regards\nTaro Yamada (山田 太郎)\nSenior Researcher, Trey Research Inc.`,
        reply: 'Dear Taro\n\nThank you very much, this is very helpful. Next Tuesday at 9:00 CET works for me.' };
    },
    french(d) {
      return { from: zoe, cc: [marco], subject: pick(['Question concernant la maquette', 'Retour sur la version bêta', 'Planification de la prochaine réunion']),
        text: `Bonjour Monsieur Morgan\n\nMerci pour l'envoi de la nouvelle version. Nous avons encore quelques remarques concernant l'écran d'accueil et la réservation des cours de ski.\n\n` +
          `Seriez-vous disponible pour un appel cette semaine ?\n\n${signature(zoe, 'Meilleures salutations')}`,
        reply: 'Bonjour Madame Lévêque\n\nMerci pour votre retour. Jeudi à 10h00 me convient parfaitement.' };
    },
    coffee(d) {
      return { from: coffee, subject: 'Your office coffee order is on its way',
        text: 'Hello\n\nThank you for your order: 6 kg of "Espresso Classico" beans and 2 l of descaler.\nDelivery within 2–3 working days.\n\nYour Fourth Coffee team ☕' };
    },
    license(d) {
      return { from: proseware, importance: 2, subject: 'Your "Proseware Designer" licence expires in 30 days',
        text: `Hello\n\nYour licence for Proseware Designer (10 users) expires on ${fmtDate(addDays(d, 30))}. Renew now in the licensing portal to avoid any interruption.\n\nProseware GmbH` };
    },
    customer(d) {
      const p = pick([lukas, petra, daniel, jonas]);
      return { from: p, subject: pick(['Question about the last delivery', 'Enquiry about a new project', 'Annual review meeting', 'Documents for the audit']),
        text: `${hi(p)}\n\n${pick(['We have a quick question about the last delivery. When would be a good time for a short call?',
          'We are planning a new project for next year and would like to hear your view.', 'I would like to schedule our annual review meeting with you.',
          'For our internal audit we need an overview of the hours worked this year.'])}\n\n${signature(p)}`,
        reply: 'Thank you for your message. I will give you a call tomorrow.' };
    },
  };
  const WEIGHTS = { meeting: 3, question: 3, status: 1, offer: 1, invoice: 1.5, it: 1, hr: 0.7, newsletter: 2, bank: 0.5, travel: 0.4,
    flight: 0.3, ticket: 0.6, delivery: 0.6, autoreply: 0.3, research: 0.3, french: 0.2, coffee: 0.2, license: 0.2, customer: 2 };
  const weightTotal = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  const randomTemplate = () => { let r = rnd() * weightTotal; for (const [k, w] of Object.entries(WEIGHTS)) if ((r -= w) < 0) return k; return 'meeting'; };

  // --- Folders ----------------------------------------------------------------------
  const folder = (name, cls = 'IPF.Note', extra = {}) => ({ name, cls, items: [], children: [], ...extra });
  const inbox = folder('Inbox', 'IPF.Note', { kind: 'inbox' });
  const projects = folder('Customers / Projects');
  const pFabrikam = folder('Fabrikam Webshop Relaunch');
  const pNorthwind = folder('Northwind ERP Migration');
  const pAlpine = folder('Alpine Ski House App');
  const pDone = folder('01 Completed');
  const pTailspin = folder('Tailspin Toys CRM');
  pDone.children.push(pTailspin);
  projects.children.push(pFabrikam, pNorthwind, pAlpine, pDone);
  const fNewsletter = folder('Newsletters');
  const fInvoices = folder('Invoices: 2026');
  const fImportant = folder('⭐ Important');
  const fLater = folder('Read later');
  inbox.children.push(projects, fNewsletter, fInvoices, fImportant, fLater);
  const drafts = folder('Drafts', 'IPF.Note', { kind: 'drafts' });
  const sent = folder('Sent Items', 'IPF.Note', { kind: 'sent' });
  const deleted = folder('Deleted Items', 'IPF.Note', { kind: 'deleted' });
  const junk = folder('Junk Email', 'IPF.Note', { kind: 'junk' });
  const outbox = folder('Outbox', 'IPF.Note', { kind: 'outbox' });
  const archive = folder('Archive', 'IPF.Note', { kind: 'archive' });
  const calendar = folder('Calendar', 'IPF.Appointment', { kind: 'calendar' });
  const contacts = folder('Contacts', 'IPF.Contact', { kind: 'contacts' });
  const tasks = folder('Tasks', 'IPF.Task', { kind: 'tasks' });
  const route = { invoices: fInvoices, newsletter: fNewsletter };

  const fromTemplate = (key, date, target, { read } = {}) => {
    const t = T[key](date);
    const m = mail({ ...t, date, read: read ?? t.read ?? true });
    (target || route[t.folder] || inbox).items.push(m);
    if (t.reply && chance(0.6)) sent.items.push(replyTo(m, t.reply));
    return m;
  };

  // Inbox: everyday traffic of the last ~11 weeks
  const inboxStart = new Date(Date.UTC(2026, 7, 3));
  for (let i = 0; i < 115; i++) {
    const d = randomDate(inboxStart, NOW);
    const recent = NOW - d < 3 * DAY;
    fromTemplate(randomTemplate(), d, null, { read: recent ? chance(0.3) : chance(0.96) });
  }
  // Invoices and newsletters of earlier months of 2026
  for (let i = 0; i < 8; i++) fromTemplate('invoice', randomDate(new Date(Date.UTC(2026, 0, 5)), inboxStart));
  for (let i = 0; i < 10; i++) fromTemplate('newsletter', randomDate(new Date(Date.UTC(2026, 4, 1)), inboxStart));

  // --- Special mails (edge cases for converters) ---------------------------------------
  const d0 = (days, h = 8, m = 0) => at(addDays(NOW, -days), h, m);

  // High importance, unread, flagged
  inbox.items.push(mail({ from: servicedesk, to: [service('All Staff', 'all', C.contoso)], importance: 2, read: false, flagged: true, date: d0(0, 7, 12),
    subject: 'Important: multi-factor authentication mandatory from 1 November',
    text: 'Dear colleagues\n\nFrom 1 November multi-factor authentication (MFA) is mandatory for all accounts. Please set up the authenticator app before then.\n\n' +
      'Instructions: https://intranet.contoso.com/it/mfa\n\nThe service desk is happy to help (ext. 4444).\n\nBest regards\nYour IT Service Desk' }));

  // Inline images (cid), emoji in subject and body
  const team1 = photo(480, 320, 18, 10);
  const team2 = photo(480, 320, 18, 40);
  inbox.items.push(mail({ from: nadia, to: [owner, emma, sarah, ryan, simon], date: d0(2, 12, 40), read: false,
    subject: '🎉 Photos from our team day on Mount Pilatus',
    text: 'Hi all\n\nWhat a great day! 😊 Here are two photos, the rest will follow on Teams.\n\n[Photo 1]\n[Photo 2]\n\nCheers\nNadia',
    html: htmlOf('Hi all\n\nWhat a great day! 😊 Here are two photos, the rest will follow on Teams.').replace('</div></body>',
      '<p class="MsoNormal"><img src="cid:image002.png@01DB2A70.0A1B2C30" width="480" height="320" alt="Group photo"><br>' +
      '<img src="cid:image003.png@01DB2A70.0A1B2C30" width="480" height="320" alt="View"></p><p class="MsoNormal">Cheers<br>Nadia</p></div></body>'),
    attachments: [file('image002.png', team1, { cid: 'image002.png@01DB2A70.0A1B2C30', hidden: true }), file('image003.png', team2, { cid: 'image003.png@01DB2A70.0A1B2C30', hidden: true })] }));

  // Large attachment (several MB, multi-level data tree)
  inbox.items.push(mail({ from: ryan, date: d0(6, 9, 5), subject: 'Panorama from the Säntis (big file!)',
    text: 'Hi Alex\n\nAs promised, the panorama in full resolution. Careful, the file is quite large.\n\nCheers\nRyan',
    attachments: [file('Panorama_Säntis.png', photo(1600, 900, 60, 20))] }));

  // Embedded message (forwarded as attachment) containing an attachment itself
  const license = mail({ from: proseware, to: [sarah], date: d0(9, 6, 50), subject: 'Your licence agreement 2027',
    text: 'Dear Ms Brunner\n\nPlease find attached the licence agreement for 2027 for signature.\n\nKind regards\nProseware GmbH',
    attachments: [file('Licence_agreement_2027.pdf', pdf('Licence agreement 2027', ['Licensee: Contoso Ltd.', 'Product: Proseware Designer, 10 users',
      'Term: 1 January to 31 December 2027', 'Price: CHF 4,800.00 excl. VAT', '', 'Place, date: ____________________', 'Signature: ____________________']))] });
  const fwd = mail({ from: sarah, date: d0(8, 13, 22), subject: 'FW: Your licence agreement 2027', flagged: true,
    text: 'Hi Alex\n\nCould you check the agreement? I attached the original email. Thomas would need to sign it.\n\nThanks\nSarah',
    attachments: [{ name: 'Your licence agreement 2027', embedded: license }] });
  inbox.items.push(fwd);
  fImportant.items.push(mail({ ...fwd, date: addMin(fwd.date, 1), html: undefined }));

  // RTF body only (older Outlook clients)
  inbox.items.push(mail({ from: thomas, to: [owner, emma, simon], format: 'rtf', date: d0(12, 15, 30), importance: 2,
    subject: 'Minutes of the management meeting on ' + fmtShort(d0(13)),
    text: 'Hi all\n\nHere are the key points from the management meeting:\n\n1. Budget 2027: approved in principle, detailed planning by mid-November.\n' +
      '2. Hiring: two additional engineering positions approved.\n3. Office refurbishment: starts in January, takes about six weeks.\n\nPlease treat this as confidential.\n\nThomas' }));

  // German message with umlauts and ß
  inbox.items.push(mail({ from: juergen, date: d0(7, 10, 20), subject: 'Rückfrage zur Lieferung – Größe & Maße der Geräte',
    text: 'Sehr geehrter Herr Morgan\n\nVielen Dank für Ihre Bestellung. Bevor wir liefern, hätten wir noch eine Rückfrage zu den Maßen: Passen die Geräte in Größe „L“ (60 × 45 × 30 cm) ' +
      'in Ihre Büroräume, oder benötigen Sie die schmalere Ausführung?\n\nFür Rückfragen stehe ich Ihnen gern zur Verfügung.\n\n' + signature(juergen, 'Mit freundlichen Grüßen') }));

  // Cyrillic, Japanese, Chinese and Arabic names and text
  pNorthwind.items.push(mail({ from: irina, cc: [daniel], date: d0(4, 8, 15), read: false,
    subject: 'Миграция данных / Data migration: test run 2 status',
    text: 'Dear Mr Morgan\n\nThe second test run of the data migration is complete. 98.7 % of the records were migrated without errors; ' +
      'the remaining 1.3 % are addresses with special characters (e.g. "Zürich", "Genève", "Łódź"). Details attached.\n\nС уважением / Best regards\nИрина Петрова',
    attachments: [file('Migration_test2_errors.csv', csv([['Record', 'Field', 'Value', 'Error'], ['10234', 'City', 'Łódź', 'Charset'],
      ['10871', 'Street', 'Rue de Genève 4', 'Charset'], ['11002', 'Name', 'Müller-Lüdenscheidt', 'Length > 20'], ['11523', 'City', 'São Paulo', 'Charset']]))] }));
  inbox.items.push(mail({ ...T.research(d0(15, 3, 10)), from: yamada, date: d0(15, 3, 10), subject: 'Invitation: research presentation 東京 / Zurich', read: true }));
  inbox.items.push(mail({ from: wang, date: d0(3, 2, 45), subject: '关于样品的确认 / Sample confirmation',
    text: 'Dear Alex\n\n您好！样品已经寄出，预计下周到达。\nThe samples have been shipped and should arrive next week. Please confirm once you receive them.\n\n谢谢 / Thank you\n王芳 (Wang Fang)\nSourcing Manager, Wide World Importers' }));
  inbox.items.push(mail({ from: layla, date: d0(10, 6, 30), subject: 'Corporate travel offer 2027 | عرض السفر للشركات',
    text: 'Dear Alex\n\nمرحباً، يسعدنا أن نقدم لكم عرضنا الخاص بالسفر للشركات.\nWe are pleased to send you our corporate travel offer for 2027 with discounted fares on all European routes.\n\n' +
      'Best regards\nليلى حداد (Layla Haddad)\nCorporate Sales, Blue Yonder Airlines' }));

  // No subject
  inbox.items.push(mail({ from: ryan, subject: '', date: d0(1, 11, 2), read: false, text: 'Here is the link I mentioned earlier: https://intranet.contoso.com/wiki/Release-3.2\n\nRyan' }));

  // Very long subject
  inbox.items.push(mail({ from: sarah, cc: [emma, ryan], date: d0(5, 14, 48), subject: 'Summary of the feedback from the usability test on 14 October ' +
    'with all open issues, priorities, owners and a proposal for how we proceed until the go-live in December 2026',
    text: 'Hi Alex\n\nThe subject says it all 😅 – you will find the details in the document.\n\nCheers\nSarah',
    attachments: [file('Usability_test_feedback.docx', docx('Usability test on 14 October', Array.from({ length: 30 }, (_, i) =>
      `${i + 1}. ${pick(['Navigation', 'Search', 'Checkout', 'Filters', 'Login', 'Cart'])}: ${pick(['unclear label', 'too many clicks', 'confusing error message', 'cut off on smartphones', 'not found'])} – priority ${pick(['high', 'medium', 'low'])}`)))] }));

  // Many recipients
  inbox.items.push(mail({ from: laura, to: [owner, ...colleagues, thomas, ...staff], date: d0(3, 9, 30), logo: true,
    subject: 'Invitation: Christmas dinner 2026', read: false,
    text: 'Dear all\n\nOn Friday, 11 December, we celebrate together from 6 pm at restaurant "The Example". ' +
      'Please sign up via the intranet by the end of October and let us know about any allergies.\n\nLooking forward to seeing you!\nLaura',
    attachments: [file('Christmas_dinner.ics', ics({ uid: 'xmas2026@contoso.com', summary: 'Contoso Christmas dinner', location: 'Restaurant "The Example"',
      start: new Date(Date.UTC(2026, 11, 11, 17)), end: new Date(Date.UTC(2026, 11, 11, 22)), organizer: laura, stamp: d0(3) }))] }));

  // Meeting request (non-note message class in a mail folder)
  const review = { start: at(workday(addDays(NOW, 3)), 12), end: at(workday(addDays(NOW, 3)), 13) };
  inbox.items.push(mail({ cls: 'IPM.Schedule.Meeting.Request', from: emma, to: [owner, ryan, sarah], date: d0(1, 7, 40), read: false,
    subject: 'Invitation: Sprint Review 3.2', location: 'Meeting room "Rigi" / Microsoft Teams', start: review.start, end: review.end,
    text: `Hi all\n\nI am inviting you to the sprint review of release 3.2. We will demo the new features and collect feedback.\n\n` +
      `When: ${fmtLong(review.start)}–${two(review.end.getUTCHours() + 2)}:00\nWhere: Meeting room "Rigi" / Microsoft Teams\n\nEmma` }));

  // Attachment with special characters and without extension, contact card
  inbox.items.push(mail({ from: kevin, date: d0(10, 10, 0), subject: 'Business card and presentation',
    text: `${hi(kevin)}\n\nAs discussed, here are my contact details and the presentation from our booth.\n\n${signature(kevin)}`,
    attachments: [file('Kevin Hughes.vcf', vcf(kevin)), file('Presentation – What’s new 2027 «Overview».pdf', pdf('What\'s new in 2027', ['Overview of the new products', '',
      '• Notebook Contoso Pro 16"', '• 32" monitor with USB-C', '• Conference system "Roundtable"'])), file('README', Buffer.from('This file has no file extension.\r\n', 'utf8'), { mime: 'application/octet-stream' })] }));

  // --- Project threads --------------------------------------------------------------------
  // Fabrikam: kick-off with many attachments, PDF with mixed compressible/incompressible blocks, long thread
  const kickoffDate = new Date(Date.UTC(2026, 7, 24, 7, 45));
  const kickoffLines = [];
  for (let s = 1; s <= 8; s++) {
    kickoffLines.push(`Chapter ${s}: ${pick(['Background', 'Goals', 'Requirements', 'Architecture', 'Schedule', 'Organisation', 'Risks', 'Budget'])}`, '');
    for (let l = 0; l < 30; l++) kickoffLines.push(pick(['The new webshop must be fast and easy to use on all devices.',
      'The existing ERP system is connected via a REST interface.', 'Content is maintained in English and French.',
      'Payments: credit cards, digital wallets and invoice.', 'The go-live plan foresees a gradual rollout.',
      'The project team meets weekly for a status meeting.', 'Open issues are tracked and prioritised on the shared board.']));
    kickoffLines.push('');
  }
  const kickoff = mail({ from: lukas, cc: [petra], date: kickoffDate, subject: 'Kick-off documents webshop relaunch',
    text: `${hi(lukas)}\n\nThank you for the productive kick-off meeting. As discussed, here are the documents:\n\n- Kick-off presentation\n- Specification v2\n` +
      `- Rough schedule\n- Our logo for the design\n- Invitation to the next workshop\n\n${signature(lukas)}`,
    attachments: [
      file('Kick-off presentation.pdf', pdf('Kick-off webshop relaunch', kickoffLines, { image: grayImage(360, 240) })),
      file('Specification_webshop_v2.docx', docx('Specification webshop relaunch v2', kickoffLines.filter(Boolean).slice(0, 120))),
      file('Schedule.csv', csv([['Phase', 'Start', 'End', 'Owner'], ['Concept', '2026-08-24', '2026-09-25', 'Contoso'], ['Design', '2026-09-28', '2026-10-23', 'Contoso'],
        ['Build', '2026-10-26', '2026-12-04', 'Contoso'], ['Test', '2026-12-07', '2026-12-18', 'Fabrikam'], ['Go-live', '2027-01-11', '2027-01-11', 'both']])),
      file('Logo_Fabrikam.png', png(240, 80, (x, y) => (x > 20 && x < 70 && y > 15 && y < 65 ? [200, 30, 40] : y > 34 && y < 46 && x > 85 && x < 220 ? [60, 60, 60] : [255, 255, 255]))),
      file('Workshop.ics', ics({ uid: 'ws1-webshop@fabrikam.com', summary: 'Webshop workshop: design', location: 'Fabrikam Inc., Manchester', start: new Date(Date.UTC(2026, 8, 3, 8)),
        end: new Date(Date.UTC(2026, 8, 3, 11)), organizer: lukas, stamp: kickoffDate })),
    ] });
  pFabrikam.items.push(kickoff);
  sent.items.push(replyTo(kickoff, 'Thank you for the documents, Lucas. We are looking forward to working together!', { all: true, delayMin: 95 }));
  let last = mail({ from: lukas, date: new Date(Date.UTC(2026, 9, 6, 8, 10)), subject: 'Acceptance of the test environment',
    text: `${hi(lukas)}\n\nWhen can we start the acceptance test of the test environment?\n\n${signature(lukas)}` });
  pFabrikam.items.push(last);
  const thread = [
    [owner, 'Dear Lucas\n\nThe test environment will be ready on Monday. You will receive the credentials separately.'],
    [lukas, 'Perfect, thanks. We will start on Tuesday with three testers.'],
    [owner, 'Great. Please log any bugs directly on the board so we can prioritise them quickly.'],
    [lukas, 'The first feedback is in. Overall we are very happy – only the checkout on the iPhone still causes problems.'],
    [owner, 'Thanks for the feedback. The checkout bug is fixed and deployed to the test environment.'],
  ];
  for (const [from, text] of thread) {
    const m = mail({ from, to: [from === owner ? lukas : owner], date: addMin(last.date, int(60, 1500)), subject: `RE: ${normalize(last.subject)}`,
      text: `${text}\n\n${from === owner ? signature(owner) : signature(lukas)}${quote(last)}`, sent: from === owner, logo: from === owner });
    (from === owner ? sent : pFabrikam).items.push(m);
    last = m;
  }
  for (let i = 0; i < 6; i++) {
    const d = randomDate(new Date(Date.UTC(2026, 8, 1)), NOW);
    pFabrikam.items.push(mail({ from: pick([lukas, petra]), date: d, subject: pick(['Copy for the home page', 'Product images', 'Question on shipping costs', 'Design sign-off', 'Invoice: second instalment']),
      text: `${hi(lukas)}\n\n${pick(['Attached is the final copy for the home page.', 'The product images are now in the shared folder.',
        'Could you double-check the shipping cost rules?', 'Our management has signed off the design.'])}\n\n${signature(lukas)}`,
      attachments: chance(0.4) ? [file('Home_page_copy.docx', docx('Home page copy', ['Welcome to the new Fabrikam webshop!', 'Discover our range.']))] : [] }));
  }
  // Northwind
  for (let i = 0; i < 7; i++) {
    const d = randomDate(new Date(Date.UTC(2026, 5, 1)), NOW);
    pNorthwind.items.push(mail({ from: pick([daniel, daniel, irina]), date: d,
      subject: pick(['Migration plan phase 2', 'Downtime window for the cutover', 'Test data for accounts receivable', 'Warehouse interface', 'Steering committee minutes']),
      text: `${hi(daniel)}\n\n${pick(['Attached is the updated migration plan.', 'For the cutover we suggest the weekend of 14/15 November.',
        'The test data for accounts receivable is ready.', 'Please find attached the minutes of the last steering committee.'])}\n\n${signature(daniel)}`,
      attachments: chance(0.5) ? [file(`Northwind_${pick(['Migration_plan', 'Steering_committee', 'Test_concept'])}.pdf`, pdf('Northwind ERP migration', kickoffLines.slice(0, int(20, 120))))] : [] }));
  }
  // Alpine Ski House (partly French)
  for (let i = 0; i < 3; i++) fromTemplate('french', randomDate(new Date(Date.UTC(2026, 6, 1)), NOW), pAlpine);
  for (let i = 0; i < 3; i++) {
    const d = randomDate(new Date(Date.UTC(2026, 6, 1)), NOW);
    pAlpine.items.push(mail({ from: zoe, date: d, subject: pick(['Beta feedback', 'Booking flow for ski lessons', 'App Store release date']),
      text: `Hello Alex\n\n${pick(['Here is our feedback on the beta version.', 'The booking flow for ski lessons needs one more step for the instructor selection.',
        'Can we aim for an App Store release before Christmas?'])}\n\n${signature(zoe)}` }));
  }
  pAlpine.items.push(mail({ from: marco, date: randomDate(new Date(Date.UTC(2026, 8, 1)), NOW), subject: 'Logos et captures d\'écran pour l\'App Store',
    text: `Bonjour Alex\n\nVoici les images pour l'App Store. Merci de vérifier les formats.\n\n${signature(marco, 'Meilleures salutations')}`,
    attachments: [file('AppStore_1.png', photo(300, 600, 14, 70)), file('AppStore_2.png', photo(300, 600, 14, 90))] }));
  // Tailspin (completed project, 2025)
  for (let i = 0; i < 6; i++) {
    const d = randomDate(new Date(Date.UTC(2025, 1, 1)), new Date(Date.UTC(2025, 6, 31)));
    pTailspin.items.push(mail({ from: jonas, date: d, subject: pick(['CRM: customer data import', 'Sales team training', 'CRM project completed', 'CRM licences']),
      text: `${hi(jonas)}\n\n${pick(['The customer data import went smoothly.', 'The training was a great success, thank you!', 'We hereby confirm the successful completion of the project.'])}\n\n${signature(jonas)}` }));
  }

  // --- Important folder, flagged -------------------------------------------------------------
  fImportant.items.push(mail({ from: thomas, date: d0(20, 6, 30), flagged: true, subject: 'Confidential: reorganisation of engineering',
    text: 'Hi Alex\n\nPlease treat the attached presentation as confidential, we will inform the team on Monday.\n\nThomas', logo: true,
    attachments: [file('Reorganisation_engineering.pdf', pdf('Reorganisation of engineering (confidential)', ['New team structure from 1 January', '', 'Web team: Emma Clarke', 'Mobile team: Ryan Patel', 'Data team: open']))] }));

  // --- Sent items (originals) ----------------------------------------------------------------
  sent.items.push(mail({ from: owner, to: [emma, sarah, ryan], bcc: [thomas], sent: true, date: d0(7, 14, 10), logo: true, subject: 'Drinks to celebrate the project start',
    text: 'Hi all\n\nOn Friday at 5 pm we are having drinks to celebrate the start of the webshop project. Come along!\n\nAlex' }));
  sent.items.push(mail({ from: owner, to: [daniel], cc: [emma], sent: true, date: d0(11, 9, 45), logo: true, subject: 'Quote for phase 2 of the ERP migration',
    text: `Dear Daniel\n\nPlease find attached our quote for phase 2 of the ERP migration.\n\n${signature(owner)}`,
    attachments: [file('Quote_Contoso_Northwind_phase2.pdf', pdf('Quote phase 2', ['Scope: migration of receivables, payables, warehouse', 'Effort: 64 person-days', 'Price: CHF 96,000.00 excl. VAT']))] }));

  // --- Drafts --------------------------------------------------------------------------------
  drafts.items.push(mail({ from: owner, to: [daniel], draft: true, date: d0(0, 10, 5), subject: 'Cutover date', text: 'Dear Daniel\n\nRegarding the cutover date, I would suggest' }));
  drafts.items.push(mail({ from: owner, to: [], draft: true, date: d0(2, 16, 0), subject: '', text: '' }));
  drafts.items.push(mail({ from: owner, to: [emma], draft: true, date: d0(4, 11, 20), subject: 'Draft status report October', text: 'Hi Emma\n\nHere is my draft, please do not forward yet.\n\nAlex',
    attachments: [file('Status_report_October_DRAFT.docx', docx('Status report October (draft)', ['Summary to follow.']))] }));

  // --- Deleted items ---------------------------------------------------------------------------
  for (let i = 0; i < 12; i++) fromTemplate(pick(['newsletter', 'it', 'coffee', 'delivery', 'autoreply', 'bank']), randomDate(new Date(Date.UTC(2026, 6, 1)), NOW), deleted);

  // --- Junk: phishing with scripts, forms and tracking pixels (must not run in a viewer) -------
  const phish = spam('Woodgrove Bank Security', 'security', 'woodgrove-secure.example');
  junk.items.push(mail({ from: phish, date: d0(1, 2, 13), read: false, subject: 'Your account has been restricted – immediate verification required',
    text: 'Dear customer, your account has been restricted. Please verify your details within 24 hours.',
    html: '<html><head><script>document.title="A script ran!";alert("This script should never have run.")</script></head>' +
      '<body onload="document.body.style.background=\'red\'"><h2>Your account has been restricted</h2><p>Dear customer,</p>' +
      '<p>we noticed unusual activity. Please verify your details within 24 hours.</p>' +
      '<form action="https://login.woodgrove-secure.example/verify" method="post"><input name="email" placeholder="Email"><input name="pw" type="password" placeholder="Password">' +
      '<button type="submit">Verify now</button></form><iframe src="https://woodgrove-secure.example/frame"></iframe>' +
      '<img src="https://track.woodgrove-secure.example/pixel.gif?id=8F3A" width="1" height="1"></body></html>' }));
  junk.items.push(mail({ from: spam('Prize Draw Office', 'winner', 'lucky-winner.example'), date: d0(3, 23, 47), read: false,
    subject: 'CONGRATULATIONS!!! You have won $1,000,000', format: 'text', text: 'Congratulations! Your email address has been drawn. Send us your bank details to receive your prize.' }));
  junk.items.push(mail({ from: spam('Parcel Service', 'info', 'parcel-delivery.example'), date: d0(5, 4, 2), subject: 'Your parcel could not be delivered',
    text: 'Your parcel could not be delivered. Pay the $1.99 customs fee via the following link: https://parcel-delivery.example/pay',
    attachments: [file('Shipment_details.pdf', pdf('Shipment details', ['Shipment: 00000000', 'Status: delivery failed']))] }));

  // --- Archive: Archive / year / month -------------------------------------------------------------
  for (const year of [2023, 2024, 2025]) {
    const yf = folder(String(year));
    for (let mo = 0; mo < 12; mo++) {
      const mf = folder(`${two(mo + 1)} ${MO[mo]}`);
      const count = int(3, 9);
      for (let i = 0; i < count; i++) {
        const d = randomDate(new Date(Date.UTC(year, mo, 1)), new Date(Date.UTC(year, mo + 1, 0, 23)));
        const t = T[randomTemplate()](d);
        mf.items.push(mail({ ...t, date: d, read: true }));
      }
      yf.children.push(mf);
    }
    archive.children.push(yf);
  }

  // --- Calendar, contacts, tasks --------------------------------------------------------------------
  const appt = (subject, start, minutes, location, text, extra = {}) => ({ cls: 'IPM.Appointment', subject, start, end: addMin(start, minutes), location,
    text, from: owner, to: [], cc: [], bcc: [], attachments: [], date: addDays(start, -int(3, 20)), read: true, importance: 1, format: 'text', ...extra });
  // Wall-clock time in Zurich (CET/CEST, DST from the last Sunday in March to the last Sunday in October) -> UTC
  const lastSunday = (y, m) => { const d = new Date(Date.UTC(y, m + 1, 0)); return d.getUTCDate() - d.getUTCDay(); };
  const zurich = (y, m, d, h = 0, mi = 0) => {
    const local = Date.UTC(y, m - 1, d, h, mi);
    const dst = local >= Date.UTC(y, 2, lastSunday(y, 2), 2) && local < Date.UTC(y, 9, lastSunday(y, 9), 3);
    return new Date(local - (dst ? 2 : 1) * 3600000);
  };
  calendar.items.push(
    // Recurring series (stored as Outlook recurrence blobs, see generate-sample.js)
    appt('Weekly Team', zurich(2026, 8, 3, 9), 30, 'Microsoft Teams', 'Weekly team meeting, every Monday.', {
      reminder: 15,
      recurrence: { freq: 'weekly', interval: 1, days: [1], end: 'never', deleted: ['2026-08-31'],
        modified: [{ date: '2026-09-14', start: [10, 0], end: [10, 30], subject: 'Weekly Team (moved)' }] } }),
    appt('Stand-up', zurich(2026, 9, 1, 8, 45), 15, 'Teams', 'Daily stand-up of the webshop team.', {
      recurrence: { freq: 'weekly', interval: 1, days: [1, 2, 3, 4, 5], end: 'until', until: '2026-12-18', deleted: [], modified: [] } }),
    appt('Month-end closing', zurich(2026, 1, 30, 14), 60, 'Meeting room "Pilatus"', 'Last Friday of every month.', {
      reminder: 30, recurrence: { freq: 'monthly', interval: 1, days: [5], nth: 5, end: 'count', count: 12, deleted: [], modified: [] } }),
    appt('Emma\'s birthday 🎂', zurich(2026, 5, 14), 1440, '', '', {
      allDay: true, busy: 0, recurrence: { freq: 'yearly', interval: 1, monthDay: 14, end: 'never', deleted: [], modified: [] } }),
    appt('Vacation', zurich(2026, 11, 2), 5 * 1440, '', 'Out of office, deputy: Emma Clarke.', { allDay: true, busy: 3 }),
    appt('Sprint Review 3.2', review.start, 60, 'Meeting room "Rigi" / Microsoft Teams', 'Organised by Emma Clarke.'),
    appt('Webshop workshop: design', new Date(Date.UTC(2026, 8, 3, 8)), 180, 'Fabrikam Inc., Manchester', 'Attendees: Lucas Miller, Petra Schmid, Sarah Brunner.'),
    appt('Dentist', at(addDays(NOW, 9), 13, 30), 60, 'Example Dental Practice', 'Private.', { sensitivity: 2, reminder: 60 }),
    appt('ERP cutover Northwind', new Date(Date.UTC(2026, 10, 14, 6)), 36 * 60, 'Basel / remote', 'Whole weekend, on call.'),
    appt('Contoso Christmas dinner', new Date(Date.UTC(2026, 11, 11, 17)), 300, 'Restaurant "The Example"', 'Sign up via the intranet.'),
    appt('Annual review with Thomas', at(addDays(NOW, -14), 9), 90, 'Thomas\'s office', 'Prepare goals for 2027.'),
    appt('Flight to Hamburg', at(addDays(NOW, 16), 6, 40), 95, 'Zurich (ZRH)', 'Blue Yonder Airlines BY412.'),
  );
  for (const p of [lukas, petra, daniel, irina, zoe, marco, jonas, yamada, wang, layla, kevin, juergen, emma, sarah, ryan, thomas, laura]) {
    contacts.items.push({ cls: 'IPM.Contact', subject: p.name, person: p, mobile: `+41 79 000 ${two(int(10, 99))} ${two(int(10, 99))}`,
      text: p.co === C.contoso ? 'Colleague' : `Contact at ${p.company}.`, from: owner, to: [], cc: [], bcc: [], attachments: [],
      date: randomDate(new Date(Date.UTC(2023, 0, 1)), NOW), read: true, importance: 1, format: 'text' });
  }
  // Outlook stores task dates as midnight of the local date
  const task = (subject, due, status, text) => ({ cls: 'IPM.Task', subject, due: zurich(due.getUTCFullYear(), due.getUTCMonth() + 1, due.getUTCDate()), status, text,
    from: owner, to: [], cc: [], bcc: [], attachments: [], date: addDays(due, -int(5, 20)), read: true, importance: 1, format: 'text' });
  tasks.items.push(
    task('Follow up on Northwind phase 2 quote', addDays(NOW, 3), 0, 'Call Daniel Wyss.'),
    task('Review Proseware licence agreement', addDays(NOW, 5), 1, 'Align with Sarah and Thomas.'),
    task('Submit October expenses', new Date(Date.UTC(2026, 9, 30, 15)), 0, 'Do not forget the Hamburg hotel receipts.'),
    task('Renew certificate for shop.contoso.com', addDays(NOW, -10), 2, 'Done by Litware.'),
    task('Prepare kick-off presentation', new Date(Date.UTC(2026, 7, 21, 15)), 2, 'Done.'),
  );

  return {
    owner,
    folders: [inbox, drafts, sent, deleted, junk, outbox, archive, calendar, contacts, tasks],
    special: { inbox, sent, deleted, drafts, outbox },
  };
};
