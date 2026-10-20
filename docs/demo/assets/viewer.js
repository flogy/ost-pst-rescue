// Mailbox viewer (runs in the browser). Loads data/*.js chunks written by lib/view.js on demand; works from file://.
'use strict';
(function () {
  const PAGE = 300;               // rows rendered per step
  const BODY_CACHE = 6;           // body chunks kept in memory
  const $ = (id) => document.getElementById(id);
  const el = (tag, props, ...kids) => {
    const n = document.createElement(tag);
    if (props) for (const k in props) {
      if (k === 'class') n.className = props[k];
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), props[k]);
      else if (props[k] !== undefined && props[k] !== null) n.setAttribute(k, props[k]);
    }
    for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) n.append(c instanceof Node ? c : String(c));
    return n;
  };
  // ---- i18n ------------------------------------------------------------------
  // Translations live in data/i18n/<code>.js (generated from locales/<code>.json). Values may contain {placeholders};
  // an object value holds plural forms keyed by Intl.PluralRules categories ("one", "other", ...), chosen by {count}.
  const i18n = { lang: 'en', intl: 'en', dict: {}, fallback: {}, plural: new Intl.PluralRules('en') };
  const fmtNum = (n, digits = 0) => Number(n).toLocaleString(i18n.intl, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  function t(key, vars) {
    let v = i18n.dict[key] ?? i18n.fallback[key] ?? key;
    if (v && typeof v === 'object') v = v[i18n.plural.select(vars && vars.count != null ? vars.count : 1)] ?? v.other ?? key;
    return String(v).replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? (typeof vars[k] === 'number' ? fmtNum(vars[k]) : vars[k]) : m));
  }
  function applyStatic() {
    document.documentElement.lang = i18n.lang;
    for (const n of document.querySelectorAll('[data-i18n]')) n.textContent = t(n.dataset.i18n);
    for (const attr of ['title', 'placeholder', 'aria-label']) {
      for (const n of document.querySelectorAll('[data-i18n-' + attr + ']')) n.setAttribute(attr, t(n.getAttribute('data-i18n-' + attr)));
    }
  }

  const fmtDate = (ms, long) => {
    if (ms == null) return '';
    const d = new Date(ms);
    return long
      ? d.toLocaleString(i18n.intl, { weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      : (Date.now() - ms < 86400000 && d.getDate() === new Date().getDate()
          ? d.toLocaleTimeString(i18n.intl, { hour: '2-digit', minute: '2-digit' })
          : d.toLocaleDateString(i18n.intl, { year: '2-digit', month: '2-digit', day: '2-digit' }));
  };
  const fmtSize = (n) => !n ? '' : n < 1024 ? fmtNum(n) + ' B' : n < 1048576 ? fmtNum(n / 1024) + ' KB' : n < 1073741824 ? fmtNum(n / 1048576, 1) + ' MB' : fmtNum(n / 1073741824, 2) + ' GB';
  const folderLabel = (f) => f.name || (f.parent === null ? t('tree.root') : t('tree.unnamed'));

  // ---- JSONP-style chunk loading (works with file://) -------------------
  const pending = new Map();
  function load(src, key) {
    if (pending.has(key)) return pending.get(key).promise;
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    pending.set(key, { promise, resolve });
    const s = document.createElement('script');
    s.src = src;
    s.onerror = () => { pending.delete(key); reject(new Error('Could not load ' + src)); };
    s.onload = () => s.remove();
    document.head.append(s);
    return promise;
  }
  const settle = (key, value) => { const p = pending.get(key); if (p) p.resolve(value); };

  const state = { meta: null, folder: null, rows: [], loadedChunks: 0, filtered: null, shown: 0, selected: null, bodies: new Map(), external: false,
    global: false, allRows: null, rowFolder: new Map(), byId: new Map() };

  window.OST = {
    tree(meta) { settle('tree', meta); },
    i18n(code, dict) { settle('i18n-' + code, dict); },
    cal(data) { settle('cal', data); },
    contacts(list) { settle('contacts', list); },
    tasks(list) { settle('tasks', list); },
    list(fid, k, rows) { settle('l' + fid + '-' + k, rows); },
    msgs(cid, items) { settle('m' + cid, items); },
  };

  function loadList(fid, k) {
    return load('data/l/' + fid + '-' + k + '.js', 'l' + fid + '-' + k).finally(() => pending.delete('l' + fid + '-' + k));
  }
  async function loadBodies(cid) {
    if (state.bodies.has(cid)) {
      const v = state.bodies.get(cid); state.bodies.delete(cid); state.bodies.set(cid, v); return v;
    }
    const items = await load('data/m/' + cid + '.js', 'm' + cid);
    pending.delete('m' + cid);
    state.bodies.set(cid, items);
    if (state.bodies.size > BODY_CACHE) state.bodies.delete(state.bodies.keys().next().value);
    return items;
  }

  // ---- Folder tree ---------------------------------------------------------
  function renderTree(meta) {
    const children = new Map();
    for (const f of meta.folders) {
      if (!children.has(f.parent)) children.set(f.parent, []);
      children.get(f.parent).push(f);
    }
    const total = (f) => f.count + (children.get(f.id) || []).reduce((s, c) => s + total(c), 0);
    const byId = new Map(meta.folders.map((f) => [f.id, f]));
    const parents = meta.folders.filter((f) => (children.get(f.id) || []).length);
    // Default: the path down to the inbox and the inbox itself are expanded, everything else collapsed
    if (!state.treeOpen) {
      const inbox = meta.folders.find((f) => /^(posteingang|inbox)$/i.test(f.name));
      state.treeOpen = new Set();
      if (inbox) for (let f = inbox; f; f = byId.get(f.parent)) state.treeOpen.add(f.id);
      else meta.folders.filter((f) => f.depth <= 1).forEach((f) => state.treeOpen.add(f.id));
    }
    const open = state.treeOpen;
    const toggle = (f) => { open.has(f.id) ? open.delete(f.id) : open.add(f.id); draw(); };
    const tree = $('tree');
    function draw() {
      const scroll = tree.scrollTop;
      tree.textContent = '';
      tree.append(el('div', { class: 'treeTools' },
        el('button', { title: t('tree.expandAllTitle'), onclick: () => { parents.forEach((f) => open.add(f.id)); draw(); } }, '⊞ ' + t('tree.expandAll')),
        el('button', { title: t('tree.collapseAllTitle'), onclick: () => { open.clear(); draw(); } }, '⊟ ' + t('tree.collapseAll'))));
      const add = (f) => {
        const kids = children.get(f.id) || [];
        const sub = total(f);
        const node = el('div', {
          class: 'node' + (state.folder && state.folder.id === f.id ? ' sel' : '') + (sub === 0 ? ' empty' : ''),
          style: 'padding-left:' + (6 + f.depth * 14) + 'px', title: folderLabel(f) + (f.cls ? ' (' + f.cls + ')' : ''),
          // no redraw on click, so a double click still hits the same element
          onclick: () => {
            for (const n of tree.querySelectorAll('.node.sel')) n.classList.remove('sel');
            node.classList.add('sel');
            if (!state.folder || state.folder.id !== f.id) openFolder(f);
          },
          ondblclick: () => { if (kids.length) toggle(f); },
        },
          el('span', { class: 'tw', onclick: (e) => { e.stopPropagation(); toggle(f); }, ondblclick: (e) => e.stopPropagation() },
            kids.length ? (open.has(f.id) ? '▼' : '▶') : ''),
          el('span', { class: 'nm' }, folderLabel(f)),
          f.unread ? el('span', { class: 'ct u' }, fmtNum(f.unread)) : f.count ? el('span', { class: 'ct' }, fmtNum(f.count)) : null);
        tree.append(node);
        if (open.has(f.id)) kids.forEach(add);
      };
      (children.get(null) || []).forEach(add);
      tree.scrollTop = scroll;
    }
    draw();
  }

  // ---- Message list --------------------------------------------------------
  async function openFolder(f) {
    state.folder = f; state.rows = []; state.loadedChunks = 0; state.filtered = null; state.shown = 0; state.global = false;
    searchRun++; // cancel a running search
    folderHeader();
    $('filter').value = '';
    $('list').textContent = '';
    $('list').scrollTop = 0;
    if (f.chunks === 0) { $('list').append(el('div', { class: 'more' }, t('list.empty'))); return; }
    await ensureRows(PAGE);
    renderMore();
  }
  function folderHeader() {
    const f = state.folder;
    if (!f) { $('folderName').textContent = t('list.chooseFolder'); $('folderCount').textContent = ''; return; }
    $('folderName').textContent = folderLabel(f);
    $('folderCount').textContent = t('list.count', { count: f.count }) + (f.unread ? ' · ' + t('list.unread', { count: f.unread }) : '');
  }

  async function ensureRows(n) {
    const f = state.folder;
    while (state.rows.length < n && state.loadedChunks < f.chunks) {
      const rows = await loadList(f.id, state.loadedChunks);
      if (state.folder !== f) return;
      state.rows.push(...rows);
      state.loadedChunks++;
    }
  }

  function current() { return state.filtered || state.rows; }

  function renderMore() {
    const list = $('list');
    const rows = current();
    const more = list.querySelector('.more');
    if (more) more.remove();
    const end = Math.min(rows.length, state.shown + PAGE);
    const frag = document.createDocumentFragment();
    for (let i = state.shown; i < end; i++) frag.append(rowEl(rows[i]));
    list.append(frag);
    state.shown = end;
    const remaining = state.filtered ? rows.length - end : state.folder.count - end;
    if (remaining > 0) list.append(el('div', { class: 'more' }, t('list.more', { count: remaining })));
    else if (!rows.length) list.append(el('div', { class: 'more' }, t('list.noResults')));
  }

  function rowEl(r) {
    const [key, , date, fromName, fromEmail, to, subject, flags, size, cls] = r;
    const node = el('div', {
      class: 'row' + (flags & 1 ? ' unread' : '') + (state.selected === key ? ' sel' : ''), 'data-key': key,
      onclick: () => { document.querySelectorAll('.row.sel').forEach((n) => n.classList.remove('sel')); node.classList.add('sel'); openMessage(r); },
    },
      el('div', { class: 'l1' },
        el('span', { class: 'from', title: fromEmail }, fromName || fromEmail || t('list.unknownSender')),
        el('span', { class: 'date' }, fmtDate(date))),
      el('div', { class: 'subj' },
        cls ? el('span', { class: 'cls' }, cls.replace(/^IPM\./, '')) : null,
        subject || t('list.noSubject'),
        el('span', { class: 'badges' }, (flags & 4 ? ' ❗' : '') + (flags & 2 ? ' 📎' : ''))),
      state.global && state.rowFolder.has(r) ? el('div', { class: 'path' }, '📁 ' + folderPath(state.rowFolder.get(r))) : null);
    return node;
  }

  // Folder path below the top of the mailbox (computed by the exporter, without levels like "IPM_SUBTREE")
  function folderPath(fid) {
    const f = state.byId.get(fid);
    if (!f) return '';
    return f.path && f.path.length ? f.path.map((n) => n || t('tree.unnamed')).join(' › ') : folderLabel(f);
  }

  // All list rows of all folders, loaded once on the first global search
  async function allRows(progress) {
    if (state.allRows) return state.allRows;
    const out = [];
    const folders = state.meta.folders.filter((f) => f.chunks > 0);
    for (let i = 0; i < folders.length; i++) {
      const f = folders[i];
      progress(i, folders.length);
      for (let k = 0; k < f.chunks; k++) for (const r of await loadList(f.id, k)) { out.push(r); state.rowFolder.set(r, f.id); }
    }
    out.sort((a, b) => (b[2] ?? 0) - (a[2] ?? 0));
    return (state.allRows = out);
  }

  $('list').addEventListener('scroll', async () => {
    const list = $('list');
    if (!state.folder || list.scrollTop + list.clientHeight < list.scrollHeight - 300) return;
    if (state._busy) return;
    state._busy = true;
    try {
      if (!state.filtered) await ensureRows(state.shown + PAGE);
      if (state.shown < current().length) renderMore();
    } finally { state._busy = false; }
  });

  const matches = (q) => {
    const terms = q.split(/\s+/);
    return (r) => {
      const hay = ((r[3] || '') + ' ' + (r[4] || '') + ' ' + (r[5] || '') + ' ' + (r[6] || '')).toLowerCase();
      return terms.every((t) => hay.includes(t));
    };
  };
  let searchRun = 0;
  async function runSearch() {
    const run = ++searchRun;
    const q = $('filter').value.trim().toLowerCase();
    const global = $('scope').value === 'all';
    const f = state.folder;
    const list = $('list');
    if (!q) {
      // back to the normal folder view
      if (state.global) { state.global = false; if (f) openFolder(f); else { list.textContent = ''; folderHeader(); } return; }
      if (!f) return;
      state.filtered = null;
      folderHeader();
    } else {
      list.textContent = '';
      const status = el('div', { class: 'more' }, t('search.running'));
      list.append(status);
      let pool;
      if (global) {
        pool = await allRows((i, n) => { status.textContent = t('search.progress', { current: i + 1, total: n }); });
      } else {
        if (!f) return;
        await ensureRows(Infinity); // search covers the whole folder
        if (state.folder !== f) return;
        pool = state.rows;
      }
      if (run !== searchRun) return; // a newer search started meanwhile
      state.global = global;
      state.filtered = pool.filter(matches(q));
      $('folderName').textContent = global ? t('search.allFolders') : folderLabel(f);
      $('folderCount').textContent = t('search.results', { count: state.filtered.length });
    }
    state.shown = 0;
    list.textContent = '';
    list.scrollTop = 0;
    renderMore();
  }
  let filterTimer;
  $('filter').addEventListener('input', () => { clearTimeout(filterTimer); filterTimer = setTimeout(runSearch, 250); });
  $('scope').addEventListener('change', () => {
    $('filter').setAttribute('data-i18n-placeholder', $('scope').value === 'all' ? 'search.placeholderAll' : 'search.placeholderFolder');
    $('filter').placeholder = t($('filter').getAttribute('data-i18n-placeholder'));
    $('filter').focus();
    runSearch();
  });

  // ---- Reading pane --------------------------------------------------------
  function sandboxDoc(html, allowExternal) {
    const csp = allowExternal
      ? "default-src 'none'; img-src * data:; style-src 'unsafe-inline' *; font-src * data:"
      : "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";
    const head = '<meta http-equiv="Content-Security-Policy" content="' + csp + '">' +
      '<base target="_blank"><style>html,body{margin:0;padding:12px;font-family:Segoe UI,system-ui,sans-serif;font-size:14px;color:#1d232b;background:#fff;word-wrap:break-word}img{max-width:100%;height:auto}</style>';
    if (!allowExternal) html = blockExternalImages(html).html;
    return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + head) : head + html;
  }

  // Replace external <img> sources by a visible placeholder (the CSP blocks them anyway, but then they just
  // look broken); returns the number of replaced images
  const EXT_IMG = /(<img\b[^>]*?\bsrc\s*=\s*)(["']?)(?:https?:)?\/\/[^"'\s>]*\2/gi;
  const xmlEsc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const placeholder = () => 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="40"><rect x=".5" y=".5" width="179" height="39" rx="4" fill="#f2f4f7" stroke="#98a2b3" stroke-dasharray="4 3"/>' +
    '<text x="90" y="25" font-family="sans-serif" font-size="12" fill="#667085" text-anchor="middle">' + xmlEsc(t('reader.placeholderImage')) + '</text></svg>');
  function blockExternalImages(html) {
    let count = 0;
    const src = placeholder();
    html = html.replace(EXT_IMG, (m, pre) => { count++; return pre + '"' + src + '"'; });
    return { html, count };
  }

  async function openMessage(r) {
    const [key, chunk, date, fromName, fromEmail, to, subject, , size, cls] = r;
    state.selected = key;
    state.selectedRow = r;
    const reader = $('reader');
    reader.textContent = '';
    reader.append(el('div', { class: 'placeholder' }, t('reader.loading')));
    let d;
    try { d = (await loadBodies(chunk))[key]; } catch (e) { d = null; }
    if (state.selected !== key) return;
    reader.textContent = '';
    if (!d) { reader.append(el('div', { class: 'placeholder' }, t('reader.loadError'))); return; }

    // recipient types: "to"/"cc"/"bcc" (older exports: "An"/"Cc"/"Bcc")
    const byType = (type) => d.r.filter((x) => x.t.toLowerCase() === type || (type === 'to' && x.t === 'An'))
      .map((x) => x.n && x.e && x.n !== x.e ? x.n + ' <' + x.e + '>' : x.n || x.e).join('; ');
    const rows = [
      [t('reader.from'), fromName ? fromName + (fromEmail ? ' <' + fromEmail + '>' : '') : fromEmail],
      [t('reader.to'), byType('to') || to],
      [t('reader.cc'), byType('cc') || d.cc],
      [t('reader.bcc'), byType('bcc')],
      [t('reader.date'), fmtDate(date, true)],
      [t('reader.sent'), d.sent && d.sent !== date ? fmtDate(d.sent, true) : ''],
      [t('reader.type'), cls || ''],
      [t('reader.size'), fmtSize(size)],
    ].filter((x) => x[1]);

    const visibleAtts = d.a.filter((a) => !a.h);
    const card = el('div', { class: 'card' },
      el('dl', { class: 'hdr' }, rows.flatMap(([k, v]) => [el('dt', null, k), el('dd', null, v)])),
      visibleAtts.length ? el('div', { class: 'atts' }, visibleAtts.map((a, i) => {
        const name = a.n || (a.e ? t('reader.messageUnnamed') : t('reader.attachmentUnnamed', { n: i + 1 }));
        const label = [(a.e ? '✉ ' : '📎 ') + name + ' ', el('span', null, a.e ? t('reader.embedded') : fmtSize(a.s))];
        if (!a.f) return el('div', { class: 'att', title: a.e ? t('reader.embeddedNotExported') : (a.m ? a.m + ' – ' : '') + t('reader.notExported') }, ...label);
        // file:// links: open in a new tab (browsers ignore "download" for local files)
        const href = 'data/' + a.f.split('/').map(encodeURIComponent).join('/');
        return el('a', { class: 'att', href, target: '_blank', rel: 'noopener', download: name, title: a.m || '' }, ...label);
      })) : null);

    const body = el('div', { class: 'card body' });
    const tools = el('div', { class: 'tools' });
    const mail = el('div', { class: 'mail' }, el('h2', null, subject || t('list.noSubject')), card, tools, body);
    reader.append(mail);

    const renderBody = () => {
      body.textContent = '';
      if (d.html) {
        // no allow-scripts: mail HTML can never execute code; same-origin is only used to measure the height
        const frame = el('iframe', { sandbox: 'allow-same-origin allow-popups allow-popups-to-escape-sandbox', referrerpolicy: 'no-referrer', title: t('reader.frameTitle') });
        frame.srcdoc = sandboxDoc(d.html, state.external);
        frame.addEventListener('load', () => {
          try { frame.style.height = Math.min(frame.contentDocument.documentElement.scrollHeight + 4, 20000) + 'px'; }
          catch { frame.style.height = '70vh'; } // sandboxed without same-origin: fall back to fixed height
        });
        frame.style.height = '70vh';
        body.append(frame);
      } else {
        body.append(el('pre', null, d.text || t('reader.noContent')));
      }
    };
    if (d.html) {
      tools.append(el('span', null, t('reader.htmlInfo')));
      const external = blockExternalImages(d.html).count;
      if (external) {
        const info = el('span');
        const btn = el('button', { onclick: () => { state.external = !state.external; update(); renderBody(); } });
        const update = () => {
          // the CSP then also allows external stylesheets and fonts, hence "content"; scripts stay blocked
          btn.textContent = state.external ? t('reader.blockExternal') : t('reader.loadExternal');
          info.textContent = t(state.external ? 'reader.externalLoaded' : 'reader.externalBlocked', { count: external });
        };
        update();
        tools.append(info, btn);
      }
    }
    if (d.hdr) {
      const raw = el('pre', { class: 'card raw', hidden: '' }, d.hdr);
      tools.append(el('button', { onclick: () => raw.toggleAttribute('hidden') }, t('reader.headers')));
      mail.insertBefore(raw, body);
    }
    if (d.trunc) tools.append(el('span', { class: 'notice' }, t('reader.truncated')));
    renderBody();
  }

  // ---- Tabs: mail / calendar / contacts / tasks (read-only previews) --------
  const VIEWS = ['mail', 'calendar', 'contacts', 'tasks'];
  const viewEl = (v) => $(v + 'View');
  function setupTabs(meta) {
    const p = meta.pim || {};
    const counts = { calendar: p.events, contacts: p.contacts, tasks: p.tasks };
    let any = false;
    for (const b of document.querySelectorAll('#tabs button')) {
      const v = b.dataset.view;
      if (v !== 'mail') {
        b.hidden = !counts[v];
        if (counts[v]) any = true;
        b.querySelector('.n').textContent = fmtNum(counts[v] || 0);
      }
      b.onclick = () => showView(v);
    }
    $('tabs').hidden = !any;
  }
  function showView(v) {
    state.view = v;
    for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('on', b.dataset.view === v);
    for (const x of VIEWS) viewEl(x).hidden = x !== v;
    if (v === 'calendar') renderCalendar();
    if (v === 'contacts') renderContacts();
    if (v === 'tasks') renderTasks();
  }
  const dl = (rows) => el('dl', { class: 'hdr' }, rows.filter((r) => r[1]).flatMap(([k, v]) => [el('dt', null, k), el('dd', null, v)]));
  const dayKey = (d) => d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  const parseDay = (s) => { const p = s.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); };
  const fmtTime = (d) => d.toLocaleTimeString(i18n.intl, { hour: '2-digit', minute: '2-digit' });
  const fmtDay = (d, opts) => d.toLocaleDateString(i18n.intl, opts || { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

  // ---- Calendar ------------------------------------------------------------
  const cal = { data: null, month: null, mode: 'month', selected: null };
  async function calData() {
    if (cal.data) return cal.data;
    const d = await load('data/cal.js', 'cal');
    const occ = d.occ.map((o, i) => {
      const ev = d.events[o[0]];
      const allDay = typeof o[1] === 'string';
      return { id: i, ev, allDay, start: allDay ? parseDay(o[1]) : new Date(o[1]), end: allDay ? parseDay(o[2]) : new Date(o[2]),
        title: o[3] != null ? o[3] : ev.t, changed: !!o[4] };
    });
    cal.data = { occ };
    // start at the current month when there is anything around today, else at the latest event
    const now = Date.now();
    const near = occ.some((o) => Math.abs(o.start - now) < 183 * 86400000);
    const past = occ.filter((o) => o.start <= now);
    const ref = near || !occ.length ? new Date() : (past.length ? past[past.length - 1] : occ[0]).start;
    cal.month = new Date(ref.getFullYear(), ref.getMonth(), 1);
    return cal.data;
  }
  // local days an occurrence covers (end exclusive for all-day, timed events ending at midnight do not spill over)
  function daysOf(o) {
    const out = [];
    const d = new Date(o.start.getFullYear(), o.start.getMonth(), o.start.getDate());
    const last = o.allDay ? new Date(o.end.getTime() - 1) : new Date(Math.max(o.start.getTime(), o.end.getTime() - 1));
    for (let i = 0; d <= last && i < 62; i++) { out.push(dayKey(d)); d.setDate(d.getDate() + 1); }
    return out.length ? out : [dayKey(o.start)];
  }
  const weekStart = () => Number(t('cal.weekStart')) || 0;
  async function renderCalendar() {
    const { occ } = await calData();
    const m = cal.month;
    $('calTitle').textContent = m.toLocaleDateString(i18n.intl, { month: 'long', year: 'numeric' });
    for (const b of document.querySelectorAll('#calendarView .seg button')) b.classList.toggle('on', b.dataset.mode === cal.mode);
    const from = new Date(m.getFullYear(), m.getMonth(), 1);
    const to = new Date(m.getFullYear(), m.getMonth() + 1, 1);
    const gridStart = new Date(from);
    gridStart.setDate(1 - ((from.getDay() - weekStart() + 7) % 7));
    const gridEnd = new Date(gridStart);
    gridEnd.setDate(gridStart.getDate() + 42);
    const rangeStart = cal.mode === 'month' ? gridStart : from;
    const rangeEnd = cal.mode === 'month' ? gridEnd : to;
    const byDay = new Map();
    for (const o of occ) {
      if (o.start >= rangeEnd || o.end < rangeStart) continue;
      for (const k of daysOf(o)) { if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(o); }
    }
    for (const list of byDay.values()) list.sort((a, b) => (b.allDay - a.allDay) || (a.start - b.start));
    const body = $('calBody');
    body.textContent = '';
    const dows = $('calDows');
    dows.textContent = '';
    dows.hidden = cal.mode !== 'month';
    const chip = (o) => {
      const b = el('button', { class: 'ev' + (o.allDay ? ' allday' : '') + (cal.selected === o.id ? ' sel' : ''), 'data-occ': o.id, title: o.title, onclick: () => showEvent(o) },
        o.allDay ? null : el('span', { class: 'tm' }, fmtTime(o.start)), (o.ev.r ? '↻ ' : '') + (o.title || t('list.noSubject')));
      return b;
    };
    if (cal.mode === 'month') {
      for (let i = 0; i < 7; i++) {
        const d = new Date(gridStart); d.setDate(gridStart.getDate() + i);
        dows.append(el('div', null, d.toLocaleDateString(i18n.intl, { weekday: 'short' })));
      }
      const grid = el('div', { class: 'month' });
      const today = dayKey(new Date());
      for (let i = 0; i < 42; i++) {
        const d = new Date(gridStart); d.setDate(gridStart.getDate() + i);
        const key = dayKey(d);
        const list = byDay.get(key) || [];
        const cell = el('div', { class: 'day' + (d.getMonth() !== m.getMonth() ? ' other' : '') + (key === today ? ' today' : '') },
          el('span', { class: 'dn', title: fmtDay(d), onclick: () => showDay(d, list) }, d.getDate()));
        list.slice(0, 4).forEach((o) => cell.append(chip(o)));
        if (list.length > 4) cell.append(el('button', { class: 'dmore', onclick: () => showDay(d, list) }, t('cal.more', { count: list.length - 4 })));
        grid.append(cell);
      }
      body.append(grid);
    } else {
      const days = [...byDay.keys()].map((k) => { const p = k.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); })
        .filter((d) => d >= from && d < to).sort((a, b) => a - b);
      if (!days.length) body.append(el('div', { class: 'more' }, t('cal.noEvents')));
      for (const d of days) {
        body.append(el('div', { class: 'agDay', 'data-time': d.getTime() }, fmtDay(d, { weekday: 'long', day: 'numeric', month: 'long' })));
        for (const o of byDay.get(dayKey(d))) {
          body.append(el('div', { class: 'agItem' + (cal.selected === o.id ? ' sel' : ''), 'data-occ': o.id, onclick: () => showEvent(o) },
            el('div', { class: 'tm' }, o.allDay ? t('cal.allDay') : fmtTime(o.start) + ' – ' + fmtTime(o.end)),
            el('div', null, el('div', null, (o.ev.r ? '↻ ' : '') + (o.title || t('list.noSubject'))), o.ev.l ? el('div', { class: 'loc' }, o.ev.l) : null)));
        }
      }
      // current month: scroll to today (or the next day with events)
      const today = new Date(); today.setHours(0, 0, 0, 0);
      body.scrollTop = 0;
      if (m.getFullYear() === today.getFullYear() && m.getMonth() === today.getMonth()) {
        const next = [...body.querySelectorAll('.agDay')].find((n) => Number(n.dataset.time) >= today.getTime());
        if (next) body.scrollTop = next.offsetTop - body.offsetTop;
      }
    }
  }
  function whenText(o) {
    if (o.allDay) {
      const last = new Date(o.end.getTime() - 86400000);
      return fmtDay(o.start, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) +
        (last > o.start ? ' – ' + fmtDay(last, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : '') + ' (' + t('cal.allDay') + ')';
    }
    const sameDay = dayKey(o.start) === dayKey(new Date(o.end.getTime() - 1)) || o.end <= o.start;
    return fmtDay(o.start, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) + ', ' + fmtTime(o.start) + ' – ' +
      (sameDay ? '' : fmtDay(o.end) + ', ') + fmtTime(o.end);
  }
  function showEvent(o) {
    cal.selected = o.id;
    for (const n of document.querySelectorAll('#calBody .sel')) n.classList.remove('sel');
    for (const n of document.querySelectorAll('#calBody [data-occ="' + o.id + '"]')) n.classList.add('sel');
    const ev = o.ev;
    const d = $('calDetail');
    d.textContent = '';
    d.append(el('h2', null, o.title || t('list.noSubject')));
    const pills = [];
    if (ev.r) pills.push(o.changed ? t('cal.changedOccurrence') : t('cal.partOfSeries'));
    if (ev.s === 2) pills.push(t('cal.private'));
    if (pills.length) d.append(el('div', null, pills.map((p) => el('span', { class: 'pill' }, p))));
    d.append(dl([
      [t('cal.when'), whenText(o)],
      [t('cal.location'), ev.l],
      [t('cal.organizer'), ev.o],
      [t('cal.attendees'), ev.p ? ev.p.join('; ') : ''],
      [t('cal.showAs'), ev.b != null ? t('cal.busy' + ev.b) : ''],
      [t('cal.reminder'), ev.rem != null ? t('cal.reminderMinutes', { count: ev.rem }) : ''],
      [t('cal.folder'), folderPath(ev.f)],
    ]));
    if (ev.d) d.append(el('pre', null, ev.d));
  }
  function showDay(day, list) {
    const d = $('calDetail');
    d.textContent = '';
    d.append(el('h2', null, fmtDay(day, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })));
    if (!list.length) d.append(el('div', { class: 'placeholder' }, t('cal.noEventsDay')));
    for (const o of list) {
      d.append(el('div', { class: 'agItem', onclick: () => showEvent(o) }, el('div', { class: 'tm' }, o.allDay ? t('cal.allDay') : fmtTime(o.start)),
        el('div', null, (o.ev.r ? '↻ ' : '') + (o.title || t('list.noSubject')))));
    }
  }
  $('calPrev').addEventListener('click', () => { cal.month = new Date(cal.month.getFullYear(), cal.month.getMonth() - 1, 1); renderCalendar(); });
  $('calNext').addEventListener('click', () => { cal.month = new Date(cal.month.getFullYear(), cal.month.getMonth() + 1, 1); renderCalendar(); });
  $('calToday').addEventListener('click', () => { const n = new Date(); cal.month = new Date(n.getFullYear(), n.getMonth(), 1); renderCalendar(); });
  for (const b of document.querySelectorAll('#calendarView .seg button')) b.addEventListener('click', () => { cal.mode = b.dataset.mode; renderCalendar(); });

  // ---- Contacts ------------------------------------------------------------
  const contacts = { list: null, selected: null };
  const initials = (c) => ((c.g || c.n || '?')[0] + ((c.sn || '')[0] || (c.n || '').split(/\s+/)[1]?.[0] || '')).toUpperCase();
  async function renderContacts() {
    if (!contacts.list) contacts.list = await load('data/contacts.js', 'contacts');
    const q = $('cFilter').value.trim().toLowerCase();
    const items = $('cItems');
    items.textContent = '';
    const hay = (c) => [c.n, c.co, c.ti, ...(c.e || []), ...(c.ph || []).map((p) => p.number)].join(' ').toLowerCase();
    const list = q ? contacts.list.filter((c) => q.split(/\s+/).every((w) => hay(c).includes(w))) : contacts.list;
    if (!list.length) items.append(el('div', { class: 'more' }, t('list.noResults')));
    let letter = null;
    for (const c of list) {
      const l = ((c.sn || c.n || '#')[0] || '#').toUpperCase();
      if (l !== letter) { letter = l; items.append(el('div', { class: 'letter' }, l)); }
      const row = el('div', { class: 'cRow' + (contacts.selected === c ? ' sel' : ''), onclick: () => {
        for (const n of items.querySelectorAll('.sel')) n.classList.remove('sel');
        row.classList.add('sel');
        showContact(c);
      } },
        el('div', { class: 'avatar' }, initials(c)),
        el('div', { class: 'txt' }, el('div', { class: 'nm2' }, c.n || t('list.unknownSender')),
          el('div', { class: 'meta2' }, [c.ti, c.co].filter(Boolean).join(' · ') || (c.e || [])[0] || '')));
      items.append(row);
    }
  }
  function showContact(c) {
    contacts.selected = c;
    const d = $('cDetail');
    d.textContent = '';
    d.append(el('div', { class: 'avatar big' }, initials(c)), el('h2', null, c.n || t('list.unknownSender')));
    const sub = [c.ti, [c.co, c.dp].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
    if (sub) d.append(el('div', { class: 'sub' }, sub));
    const adr = (a) => [a.street, [a.zip, a.city].filter(Boolean).join(' '), a.region, a.country, a.pobox].filter(Boolean).join(', ');
    d.append(dl([
      ...(c.e || []).map((e) => [t('contacts.email'), el('a', { href: 'mailto:' + e }, e)]),
      ...(c.ph || []).map((p) => [t('contacts.phone.' + p.type), p.number]),
      ...(c.ad || []).map((a) => [t('contacts.address.' + a.type), adr(a)]),
      ...(c.u || []).map((u) => [t('contacts.website'), el('a', { href: /^https?:/i.test(u) ? u : 'https://' + u, target: '_blank', rel: 'noopener noreferrer' }, u)]),
      [t('contacts.nickname'), c.nn],
      [t('contacts.birthday'), c.bd ? fmtDay(parseDay(c.bd), { day: 'numeric', month: 'long', year: 'numeric' }) : ''],
      [t('cal.folder'), folderPath(c.f)],
    ]));
    if (c.d) d.append(el('pre', null, c.d));
  }
  let cTimer;
  $('cFilter').addEventListener('input', () => { clearTimeout(cTimer); cTimer = setTimeout(renderContacts, 150); });

  // ---- Tasks ---------------------------------------------------------------
  const tasks = { list: null, selected: null };
  async function renderTasks() {
    if (!tasks.list) tasks.list = await load('data/tasks.js', 'tasks');
    const items = $('tItems');
    items.textContent = '';
    const today = new Date(); today.setHours(0, 0, 0, 0);
    for (const x of tasks.list) {
      const due = x.due ? parseDay(x.due) : null;
      const row = el('div', { class: 'tRow' + (x.done ? ' done' : '') + (tasks.selected === x ? ' sel' : ''), onclick: () => {
        for (const n of items.querySelectorAll('.sel')) n.classList.remove('sel');
        row.classList.add('sel');
        showTask(x);
      } },
        el('div', { class: 'chk' }, x.done ? '✓' : ''),
        el('div', { class: 'txt' }, el('div', { class: 'nm2' }, (x.i ? '❗ ' : '') + (x.t || t('list.noSubject'))),
          el('div', { class: 'meta2' + (due && !x.done && due < today ? ' over' : '') }, [due ? t('tasks.due') + ' ' + fmtDay(due) : '', t('tasks.status' + (x.s || 0))].filter(Boolean).join(' · '))),
        el('div', { class: 'progress', title: x.pc + ' %' }, el('i', { style: 'width:' + (x.pc || 0) + '%' })));
      items.append(row);
    }
  }
  function showTask(x) {
    tasks.selected = x;
    const d = $('tDetail');
    d.textContent = '';
    d.append(el('h2', null, x.t || t('list.noSubject')));
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const due = x.due ? parseDay(x.due) : null;
    d.append(dl([
      [t('tasks.status'), t('tasks.status' + (x.s || 0))],
      [t('tasks.progress'), (x.pc || 0) + ' %'],
      [t('tasks.start'), x.st ? fmtDay(parseDay(x.st)) : ''],
      [t('tasks.due'), due ? fmtDay(due) + (!x.done && due < today ? ' (' + t('tasks.overdue') + ')' : '') : ''],
      [t('tasks.completed'), x.c ? fmtDate(x.c, true) : ''],
      [t('tasks.importance'), x.i ? t('tasks.high') : ''],
      [t('cal.folder'), folderPath(x.f)],
    ]));
    if (x.d) d.append(el('pre', null, x.d));
  }

  // ---- Resizable columns ---------------------------------------------------
  (function columns() {
    const MIN = 160, READER_MIN = 280;
    const store = (k, v) => { try { v === undefined ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} };
    const stored = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
    // the variable lives on the split's container (main or a .view); hidden views use the window width
    const box = (split) => split.parentElement;
    const width = (split, name) => parseFloat(getComputedStyle(box(split)).getPropertyValue(name)) || 0;
    const set = (split, name, px) => {
      const c = box(split);
      const total = c.clientWidth || window.innerWidth;
      // keep the remaining flexible column (reading pane / list / calendar) at least READER_MIN wide
      const others = [...c.querySelectorAll(':scope > .split')].filter((s) => s !== split).reduce((sum, s) => sum + width(s, s.dataset.var), 0);
      const max = Math.max(MIN, total - others - 10 - READER_MIN);
      px = Math.round(Math.min(Math.max(px, MIN), max));
      // the detail width is shared by calendar, contacts and tasks
      const targets = name === '--w-detail' ? document.querySelectorAll('.view') : [c];
      for (const t of targets) t.style.setProperty(name, px + 'px');
      return px;
    };
    for (const split of document.querySelectorAll('.split')) {
      const name = split.dataset.var;
      const key = 'viewer' + name;
      const dir = split.dataset.side === 'right' ? -1 : 1; // a column right of the handle grows when dragging left
      const saved = Number(stored(key));
      if (saved) set(split, name, saved);
      split.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        split.setPointerCapture(e.pointerId);
        const startX = e.clientX, startW = width(split, name);
        split.classList.add('active');
        document.body.classList.add('resizing');
        const move = (ev) => set(split, name, startW + dir * (ev.clientX - startX));
        const up = () => {
          split.removeEventListener('pointermove', move);
          split.classList.remove('active');
          document.body.classList.remove('resizing');
          store(key, width(split, name));
        };
        split.addEventListener('pointermove', move);
        split.addEventListener('pointerup', up, { once: true });
        split.addEventListener('pointercancel', up, { once: true });
      });
      split.addEventListener('dblclick', () => { set(split, name, Number(split.dataset.default)); store(key); });
      split.addEventListener('keydown', (e) => {
        const step = e.shiftKey ? 50 : 10;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          store(key, set(split, name, width(split, name) + dir * (e.key === 'ArrowRight' ? step : -step)));
        }
      });
    }
  })();

  // ---- Boot ----------------------------------------------------------------
  const LANG_KEY = 'viewer-language';
  const storedLang = () => { try { return localStorage.getItem(LANG_KEY); } catch { return null; } };
  const loadLocale = (code) => load('data/i18n/' + code + '.js', 'i18n-' + code);

  async function setLanguage(code) {
    const dict = await loadLocale(code).catch(() => null);
    if (!dict) return false;
    const intl = (dict._meta && dict._meta.intl) || code;
    i18n.lang = code;
    i18n.dict = dict;
    i18n.intl = intl;
    try { i18n.plural = new Intl.PluralRules(intl); } catch { i18n.plural = new Intl.PluralRules('en'); }
    return true;
  }

  function renderHeader() {
    const meta = state.meta;
    document.title = (meta.store || meta.file) + ' – ' + t('app.title');
    $('title').textContent = meta.store || meta.file;
    const m = $('meta');
    m.textContent = '';
    m.append(el('span', null, meta.file + ' · ' + meta.kind + ' · ' + meta.format + ' · ' + fmtSize(meta.fileSize)),
      el('span', null, t('header.summary', { count: meta.total, folders: meta.folders.length })),
      el('span', null, t('header.created', { date: fmtDate(meta.generated, true) })));
    if (meta.errorCount) {
      m.append(el('span', { class: 'err', onclick: () => { $('errList').textContent = meta.errors.join('\n') + (meta.errorCount > meta.errors.length ? '\n…' : ''); $('errDlg').showModal(); } },
        '⚠ ' + t('header.errors', { count: meta.errorCount })));
    }
  }

  // Re-render everything that shows text after a language change; keeps folder, search and selection
  function rerender() {
    applyStatic();
    renderHeader();
    renderTree(state.meta);
    if ($('filter').value.trim()) runSearch();
    else if (state.folder) {
      folderHeader();
      state.shown = 0;
      const list = $('list');
      const scroll = list.scrollTop;
      list.textContent = '';
      if (state.folder.chunks === 0) list.append(el('div', { class: 'more' }, t('list.empty')));
      else { renderMore(); list.scrollTop = scroll; }
    } else folderHeader();
    if (state.selectedRow) openMessage(state.selectedRow);
    setupTabs(state.meta);
    if (state.view && state.view !== 'mail') {
      showView(state.view);
      if (state.view === 'contacts' && contacts.selected) showContact(contacts.selected);
      if (state.view === 'tasks' && tasks.selected) showTask(tasks.selected);
    }
  }

  load('data/tree.js', 'tree').then(async (meta) => {
    state.meta = meta;
    state.byId = new Map(meta.folders.map((f) => [f.id, f]));
    const languages = meta.languages || [];
    const has = (code) => languages.some((l) => l.code === code);
    if (has('en')) i18n.fallback = await loadLocale('en').catch(() => ({}));
    const wanted = storedLang();
    const lang = wanted && has(wanted) ? wanted : has('en') ? 'en' : languages.length ? languages[0].code : null;
    if (lang) await setLanguage(lang);

    // language selector (top right); only shown when there is a choice
    const select = $('lang');
    for (const l of languages) select.append(el('option', { value: l.code }, l.name));
    select.value = i18n.lang;
    select.closest('label').hidden = languages.length < 2;
    select.addEventListener('change', async () => {
      if (await setLanguage(select.value)) {
        try { localStorage.setItem(LANG_KEY, select.value); } catch {}
        rerender();
      }
    });

    applyStatic();
    renderHeader();
    renderTree(meta);
    setupTabs(meta);
    const first = meta.folders.find((f) => /^(posteingang|inbox)$/i.test(f.name)) || meta.folders.find((f) => f.count > 0);
    if (first) { openFolder(first); renderTree(meta); }
  }).catch((e) => { $('title').textContent = i18n.dict['app.dataMissing'] || 'Data not found (data/tree.js)'; });
})();
