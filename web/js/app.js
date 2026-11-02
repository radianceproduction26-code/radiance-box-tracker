import * as api from './api.js';
import { toCsv, download } from './sheet.js';
import { printPage, registerPage } from './pages-labels.js';
import { partsPage, openingPage, usersPage } from './pages-data.js';
import { inwardPage } from './pages-scan.js';
import { outwardPage, slipsPage } from './pages-outward.js';
import { $, esc, toast, busy, todayIst, addDays, fmtTs, fmtNum, fmtDay, msg, table } from './ui.js';

const PAGES = [
  { id: '', label: 'Home', run: homePage },
  { id: 'inward', label: 'FG inward', roles: ['store', 'fg', 'admin'], run: inwardPage },
  { id: 'outward', label: 'FG outward', roles: ['dispatch', 'fg', 'admin'], run: outwardPage },
  { id: 'slips', label: 'Slips', run: slipsPage },
  { id: 'print', label: 'Print labels', roles: ['assembly', 'admin'], run: printPage },
  { id: 'register', label: 'Box register', run: registerPage },
  { id: 'reports', label: 'Reports', run: reportsPage },
  { id: 'parts', label: 'Parts', roles: ['assembly', 'admin'], run: partsPage },
  { id: 'opening', label: 'Opening stock', roles: ['admin'], run: openingPage },
  { id: 'users', label: 'Users', roles: ['admin'], run: usersPage },
];

const MARK = '<svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true"><rect x="0" y="0" width="11" height="11" rx="2.5" fill="#f2a900"/><rect x="15" y="0" width="11" height="11" rx="2.5" fill="#fff"/><rect x="0" y="15" width="11" height="11" rx="2.5" fill="#fff"/><rect x="15" y="15" width="5" height="5" rx="1.2" fill="#fff"/><rect x="21" y="21" width="5" height="5" rx="1.2" fill="#f2a900"/></svg>';
const brand = (tag = 'a') => `<${tag} class="brand" ${tag === 'a' ? 'href="#/"' : ''}>${MARK}<b>Radiance</b><i>Box tracker</i></${tag}>`;
const root = document.getElementById('app');
let me = null;
let token = 0;

// ---------------------------------------------------------------- shell
async function render() {
  const my = ++token;
  const isCurrent = () => my === token;
  if (!api.signedIn()) { me = null; return loginView(); }
  if (!me) {
    try {
      const rows = await api.selectAll('profiles', `select=user_id,full_name,role,active&user_id=eq.${api.user().id}`);
      me = rows[0] && rows[0].active ? rows[0] : null;
    } catch (e) {
      if (e.code === 'expired' || e.code === 'no_session') return loginView(e.message);
      return noAccess(e.message);
    }
    if (!me) return noAccess('Your login has no role yet. Ask the admin to give it one.');
  }
  if (!isCurrent()) return;
  const hashRest = location.hash.replace(/^#\/?/, '') || '';
  const id = hashRest.split('?')[0];
  const params = new URLSearchParams(hashRest.includes('?') ? hashRest.slice(hashRest.indexOf('?') + 1) : '');
  const page = PAGES.find((p) => p.id === id && (!p.roles || p.roles.includes(me.role))) || PAGES[0];
  root.innerHTML = `
    <header class="top"><div class="bar">${brand()}
      <span class="who"><span>${esc(me.full_name)} · ${esc(me.role)}</span><button id="signout">Sign out</button></span></div>
      <nav>${PAGES.filter((p) => !p.roles || p.roles.includes(me.role)).map((p) => `<a href="#/${p.id}" class="${p.id === page.id ? 'on' : ''}">${esc(p.label)}</a>`).join('')}</nav></header>
    <main id="main"><p class="hint">Loading…</p></main>`;
  $(root, '#signout').addEventListener('click', async () => { await api.signOut(); me = null; location.hash = '#/'; render(); });
  const main = $(root, '#main');
  try {
    main.innerHTML = '';
    await page.run(main, { me, isCurrent, params });
  } catch (e) {
    if (!isCurrent()) return;
    if (e.code === 'expired' || e.code === 'no_session') return loginView(e.message);
    main.innerHTML = msg('bad', esc(e.message || String(e))) + '<button class="btn alt" id="retry">Try again</button>';
    $(main, '#retry').addEventListener('click', render);
  }
}

function noAccess(text) {
  root.innerHTML = `<div class="login card">${brand('div')}<h1>No access</h1>${msg('warn', esc(text))}<button class="btn alt" id="signout">Sign out</button></div>`;
  $(root, '#signout').addEventListener('click', async () => { await api.signOut(); me = null; render(); });
}

function loginView(note = '') {
  root.innerHTML = `
  <form class="login card" id="lf">
    ${brand('div')}<h1>Sign in</h1>
    ${note ? msg('warn', esc(note)) : ''}<div id="err"></div>
    <div style="margin-bottom:12px"><label for="em">Email</label><input id="em" type="email" required autocomplete="username" autofocus></div>
    <div style="margin-bottom:14px"><label for="pw">Password</label><input id="pw" type="password" required autocomplete="current-password"></div>
    <button class="btn" id="go" style="width:100%">Sign in</button>
  </form>`;
  $(root, '#lf').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $(root, '#go');
    btn.disabled = true;
    try { await api.signIn($(root, '#em').value, $(root, '#pw').value); me = null; render(); }
    catch (err) { $(root, '#err').innerHTML = msg('bad', esc(err.message)); btn.disabled = false; }
  });
}

// ---------------------------------------------------------------- home
async function homePage(el, { me, isCurrent }) {
  const t = todayIst();
  const [stock, out, inw, disp, openDone] = await Promise.all([
    api.selectAll('fg_stock_by_part', 'select=*&order=part_no'),
    api.selectAll('assembly_out_by_date', `select=*&day=eq.${t}`),
    api.selectAll('inward_by_date', `select=*&day=eq.${t}`),
    api.selectAll('dispatch_by_date', `select=*&day=eq.${t}`),
    me.role === 'admin' ? api.selectAll('settings', 'select=key&key=eq.opening_stock_done') : Promise.resolve([{}]),
  ]);
  if (!isCurrent()) return;
  const sum = (rows, k) => rows.reduce((s, r) => s + Number(r[k] || 0), 0);
  const stat = (n, label) => `<div class="stat"><b>${fmtNum(n)}</b><span>${label}</span></div>`;
  const openBanner = me.role === 'admin' && !openDone.length
    ? `<div class="msg warn" style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between"><span><b>Opening stock not uploaded yet.</b> Add the finished goods already in the store (one time) so FG stock starts correct.</span><a class="btn" href="#/opening">Upload opening stock</a></div>` : '';
  el.innerHTML = `
  ${openBanner}
  <h1>Today · ${fmtDay(t)}</h1>
  <div class="grid g4" style="margin-bottom:16px">
    ${stat(sum(stock, 'fg_qty'), `FG stock NOS (${fmtNum(sum(stock, 'fg_boxes'))} boxes)`)}
    ${stat(sum(stock, 'wip_qty'), `Packed, not yet in FG NOS (${fmtNum(sum(stock, 'wip_boxes'))} boxes)`)}
    ${stat(sum(out, 'qty'), `Assembly out today NOS (${fmtNum(sum(out, 'boxes'))} boxes)`)}
    ${stat(sum(inw, 'qty'), `FG inward today NOS (${fmtNum(sum(inw, 'boxes'))} boxes)`)}
    ${stat(sum(disp, 'qty'), `Dispatched today NOS (${fmtNum(sum(disp, 'boxes'))} boxes)`)}
  </div>
  <div class="card"><div class="actions" style="margin:0 0 10px;justify-content:space-between"><h2 style="margin:0">FG stock by part</h2><button class="btn sm alt" id="csv">Download CSV</button></div>
  <div class="row"><div><label>Search</label><input id="s" placeholder="part no or name"></div></div><div id="tbl"></div></div>`;
  const draw = () => {
    const s = $(el, '#s').value.trim().toLowerCase();
    const rows = stock.filter((r) => !s || r.part_no.toLowerCase().includes(s) || (r.part_name || '').toLowerCase().includes(s));
    $(el, '#tbl').innerHTML = table([
      { k: 'part_no', label: 'Part no', cls: 'mono' }, { k: 'part_name', label: 'Part name' },
      { k: 'fg_qty', label: 'FG qty', n: true, fmt: fmtNum }, { k: 'fg_boxes', label: 'FG boxes', n: true, fmt: fmtNum },
      { k: 'wip_qty', label: 'Packed (not in FG)', n: true, fmt: fmtNum },
      { k: 'oldest_days', label: 'Oldest FG (days)', n: true, fmt: (v) => (v === null || v === undefined ? '' : v) },
    ], rows, 'No stock yet.');
  };
  draw();
  $(el, '#s').addEventListener('input', draw);
  $(el, '#csv').addEventListener('click', () => download(`fg-stock-${t}.csv`, toCsv([
    ['Part no', 'Part name', 'FG qty', 'FG boxes', 'Packed qty (not in FG)', 'Packed boxes', 'Oldest FG in', 'Oldest days'],
    ...stock.map((r) => [r.part_no, r.part_name, r.fg_qty, r.fg_boxes, r.wip_qty, r.wip_boxes, fmtTs(r.oldest_fg_at), r.oldest_days]),
  ])));
}

// ---------------------------------------------------------------- reports
const REPORTS = {
  out: { label: 'Assembly out per date', view: 'assembly_out_by_date', note: 'Counted on the day the label is printed. Voided boxes and opening stock are not counted.',
    cols: [{ k: 'day', label: 'Date', fmt: fmtDay }, { k: 'shift', label: 'Shift' }, { k: 'part_no', label: 'Part no', cls: 'mono' }, { k: 'part_name', label: 'Part name' }, { k: 'boxes', label: 'Boxes', n: true, fmt: fmtNum }, { k: 'qty', label: 'Qty', n: true, fmt: fmtNum }] },
  inw: { label: 'FG inward per date', view: 'inward_by_date', note: 'Counted on the day the box is scanned into the store. Opening stock is not counted.',
    cols: [{ k: 'day', label: 'Date', fmt: fmtDay }, { k: 'part_no', label: 'Part no', cls: 'mono' }, { k: 'part_name', label: 'Part name' }, { k: 'boxes', label: 'Boxes', n: true, fmt: fmtNum }, { k: 'qty', label: 'Qty', n: true, fmt: fmtNum }] },
  dis: { label: 'Dispatch per date', view: 'dispatch_by_date', note: 'Counted on the day the packing slip is created.',
    cols: [{ k: 'day', label: 'Date', fmt: fmtDay }, { k: 'party', label: 'Party' }, { k: 'part_no', label: 'Part no', cls: 'mono' }, { k: 'part_name', label: 'Part name' }, { k: 'boxes', label: 'Boxes', n: true, fmt: fmtNum }, { k: 'qty', label: 'Qty', n: true, fmt: fmtNum }] },
};

async function reportsPage(el, { isCurrent }) {
  const t = todayIst();
  const st = { r: 'out', from: addDays(t, -6), to: t };
  el.innerHTML = `
  <h1>Reports</h1>
  <form class="card" id="f"><div class="row">
    <div><label>Report</label><select id="r">${Object.entries(REPORTS).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('')}</select></div>
    <div><label>From</label><input id="from" type="date" value="${st.from}" required></div>
    <div><label>To</label><input id="to" type="date" value="${st.to}" required></div>
  </div><div class="actions"><button class="btn">Show</button><button type="button" class="btn alt" id="csv">Download CSV</button></div></form>
  <div id="out"></div>`;
  let rows = [];
  async function load() {
    st.r = $(el, '#r').value; st.from = $(el, '#from').value; st.to = $(el, '#to').value;
    const R = REPORTS[st.r];
    $(el, '#out').innerHTML = '<p class="hint">Loading…</p>';
    rows = await api.selectAll(R.view, `select=*&day=gte.${st.from}&day=lte.${st.to}&order=day.desc,part_no`);
    if (!isCurrent()) return;
    const byDay = new Map();
    rows.forEach((r) => { const d = byDay.get(r.day) || { day: r.day, boxes: 0, qty: 0 }; d.boxes += Number(r.boxes); d.qty += Number(r.qty); byDay.set(r.day, d); });
    const days = [...byDay.values()];
    const totB = days.reduce((s, d) => s + d.boxes, 0), totQ = days.reduce((s, d) => s + d.qty, 0);
    $(el, '#out').innerHTML = `
      <p class="hint" style="margin:0 0 10px">${esc(R.note)}</p>
      <div class="grid g2"><div><h2>Per day</h2>${table([{ k: 'day', label: 'Date', fmt: fmtDay }, { k: 'boxes', label: 'Boxes', n: true, fmt: fmtNum }, { k: 'qty', label: 'Qty', n: true, fmt: fmtNum }],
        [...days, { day: '', boxes: totB, qty: totQ, total: true }].map((d) => (d.total ? { ...d, day: 'TOTAL' } : d)), 'No records in this period.')}</div></div>
      <h2 style="margin-top:18px">Detail</h2>${table(R.cols, rows, 'No records in this period.')}`;
  }
  $(el, '#f').addEventListener('submit', (e) => { e.preventDefault(); busy(null, load); });
  $(el, '#csv').addEventListener('click', () => {
    const R = REPORTS[st.r];
    if (!rows.length) return toast('Show a report with records first.', true);
    download(`${R.view}-${st.from}-to-${st.to}.csv`, toCsv([R.cols.map((c) => c.label), ...rows.map((r) => R.cols.map((c) => (c.k === 'day' ? fmtDay(r[c.k]) : r[c.k])))]));
  });
  await load();
}

window.addEventListener('hashchange', render);
render();
