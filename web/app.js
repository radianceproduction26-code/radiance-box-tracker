import * as api from './api.js';
import { toCsv, download } from './sheet.js';
import { printPage, registerPage } from './pages-labels.js';
import { partsPage, openingPage, usersPage } from './pages-data.js';
import { inwardPage } from './pages-scan.js';
import { outwardPage, slipsPage } from './pages-outward.js';
import { $, esc, toast, busy, todayIst, addDays, fmtTs, fmtNum, fmtDay, msg, table } from './ui.js';

const EXTRA_CSS = `
/* ---- Home: check a part ---- */
.pl{border-left:5px solid var(--amber);background:linear-gradient(135deg,#fff 0%,#f6fafa 100%)}
.pl h2{margin:0 0 10px}
.pl-name{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px;margin:14px 0 10px}
.pl-name b{font-size:20px}
.pl-name span{color:var(--mute);font-weight:600}
.pl-figs{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin-top:12px}
.pl-fig{background:#fff;border-radius:14px;padding:12px 14px;box-shadow:0 0 0 1px var(--line)}
.pl-fig b{display:block;font:700 26px/1.05 var(--display);font-variant-numeric:tabular-nums}
.pl-fig span{display:block;margin-top:5px;color:var(--mute);font-size:13px;line-height:1.25}
.pl-fig.main{background:var(--brand);box-shadow:none}
.pl-fig.main b{color:#fff;font-size:34px}
.pl-fig.main span{color:#cfe6e8}
.pl-list{display:grid;gap:6px;margin-top:12px}
.pl-row{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 12px;text-align:left;font:inherit;background:#fff;border:0;border-radius:12px;padding:10px 14px;cursor:pointer;box-shadow:0 0 0 1px var(--line);color:var(--ink)}
.pl-row:hover{box-shadow:0 0 0 2px var(--brand)}
.pl-row span{color:var(--mute);font-size:13.5px;flex:1 1 120px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pl-row em{font-style:normal;font-weight:650;font-variant-numeric:tabular-nums}

/* ---- Reports ---- */
.rpt{display:grid;gap:16px;grid-template-columns:minmax(0,1fr)}
.rpt>*,.rpt-two>*{min-width:0}
.rpt>*{animation:rptIn .35s ease-out both}
@keyframes rptIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.rpt-hero{position:relative;overflow:hidden;border-radius:22px;padding:24px 24px 20px;color:#fff;background:radial-gradient(120% 150% at 100% 0%,rgba(242,169,0,.26),transparent 55%),linear-gradient(135deg,#14202b 0%,#173a45 58%,#0d4a52 100%);box-shadow:0 22px 44px -26px rgba(20,32,43,.8)}
.rpt-hero::after{content:"";position:absolute;inset:0;pointer-events:none;background-image:linear-gradient(rgba(255,255,255,.055) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.055) 1px,transparent 1px);background-size:28px 28px;-webkit-mask-image:linear-gradient(115deg,transparent 30%,#000);mask-image:linear-gradient(115deg,transparent 30%,#000)}
.rpt-hero>*{position:relative;z-index:1}
.rpt-eyebrow{margin:0;font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--amber);font-weight:700}
.rpt-hero h1{color:#fff;margin:4px 0 6px;font-size:34px}
.rpt-sub{margin:0 0 18px;color:#b9c8d3;font-size:14.5px;max-width:62ch}
.rpt-tabs{display:flex;flex-wrap:wrap;gap:6px;background:rgba(255,255,255,.09);padding:5px;border-radius:15px;width:max-content;max-width:100%}
.rpt-tab{font:inherit;font-weight:650;font-size:14.5px;border:0;border-radius:11px;min-height:42px;padding:0 18px;background:transparent;color:#cfdbe4;cursor:pointer}
.rpt-tab:hover{background:rgba(255,255,255,.12);color:#fff}
.rpt-tab.on{background:#fff;color:var(--steel);box-shadow:0 6px 14px -6px rgba(0,0,0,.5)}
.rpt-filter,.rpt-card,.rpt-kpi{background:#fff;border-radius:18px;box-shadow:0 0 0 1px var(--line),0 12px 26px -20px rgba(20,32,43,.5)}
.rpt-filter{padding:16px 18px}
.rpt-pre{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 14px}
.rpt-pre button{font:inherit;font-size:13.5px;font-weight:650;min-height:34px;padding:0 14px;border-radius:999px;border:1.5px solid var(--line);background:#fff;color:var(--ink);cursor:pointer}
.rpt-pre button:hover{border-color:var(--brand);background:#e6f1f1;color:var(--brand)}
.rpt-dates{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));align-items:end}
.rpt-dates .actions{margin:0}
.rpt #out{display:grid;gap:16px;grid-template-columns:minmax(0,1fr)}
.rpt-note{margin:0;color:var(--mute);font-size:13.5px}
.rpt-kpis{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(180px,1fr))}
.rpt-kpi{position:relative;padding:16px 16px 14px 20px;overflow:hidden}
.rpt-kpi::before{content:"";position:absolute;left:0;top:14px;bottom:14px;width:4px;border-radius:0 4px 4px 0;background:linear-gradient(var(--amber),var(--brand))}
.rpt-kpi .k{display:block;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--mute);font-weight:700}
.rpt-kpi b{display:block;font:700 34px/1.05 var(--display);font-variant-numeric:tabular-nums;margin:7px 0 5px;letter-spacing:-.01em}
.rpt-kpi small{color:var(--mute);font-size:13px}
.rpt-two{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(min(300px,100%),1fr))}
.rpt-card{padding:18px}
.rpt-card h3{margin:0 0 14px;font:700 17px/1.2 var(--display);display:flex;align-items:baseline;justify-content:space-between;gap:10px}
.rpt-card h3 small{font:600 13px var(--font);color:var(--mute)}
.rpt-chart{position:relative}
.rpt-bars{display:flex;align-items:stretch;gap:4px;height:196px;overflow-x:auto;padding-bottom:2px;background:repeating-linear-gradient(to top,transparent 0,transparent 41px,var(--line-2) 41px,var(--line-2) 42px)}
.rpt-bar{flex:1 0 13px;max-width:46px;display:flex;flex-direction:column;align-items:center;gap:5px}
.rpt-bar .col{flex:1;width:100%;display:flex;align-items:flex-end}
.rpt-bar i{display:block;width:100%;min-height:3px;border-radius:7px 7px 2px 2px;background:linear-gradient(180deg,#23808c,var(--brand))}
.rpt-bar.zero i{background:var(--line)}
.rpt-bar.max i{background:linear-gradient(180deg,#ffc83d,var(--amber))}
.rpt-bar span{font-size:11px;line-height:14px;color:var(--mute);height:14px;white-space:nowrap}
.rpt-axis{display:flex;justify-content:space-between;gap:10px;margin-top:8px;color:var(--mute);font-size:12.5px}
.rpt-rk{margin:0 0 14px}
.rpt-rk:last-child{margin-bottom:0}
.rpt-rk-h{display:flex;align-items:baseline;gap:8px;min-width:0}
.rpt-rk-h .nm{font-weight:650;white-space:nowrap}
.rpt-rk-h em{font-style:normal;color:var(--mute);font-size:13px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rpt-rk-h b{margin-left:auto;font-variant-numeric:tabular-nums}
.rpt-trk{height:8px;border-radius:999px;background:var(--line-2);margin:6px 0 4px;overflow:hidden}
.rpt-trk i{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,var(--brand),#2a97a4)}
.rpt-rk small{color:var(--mute);font-size:12.5px}
.rpt .tw{border-radius:14px;box-shadow:0 0 0 1px var(--line);max-height:520px;overflow:auto}
.rpt th{background:#f1f5f7;text-transform:uppercase;letter-spacing:.06em;font-size:11.5px;color:var(--mute);z-index:1}
.rpt tbody tr:nth-child(even) td{background:#fafcfd}
.rpt tbody tr:hover td{background:#eef5f6}
.rpt-tot tbody tr:last-child td{font-weight:700;background:#e8f1f2;color:var(--brand-2);border-top:2px solid var(--brand)}
.rpt-empty{padding:34px 18px;text-align:center;color:var(--mute)}
.rpt-empty b{display:block;font:700 18px var(--display);color:var(--ink);margin-bottom:4px}
.rpt-skel{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(180px,1fr))}
.rpt-skel i{display:block;height:98px;border-radius:18px;background:linear-gradient(90deg,#e4e9ed 25%,#f2f5f7 37%,#e4e9ed 63%);background-size:400% 100%;animation:rptSh 1.3s ease-in-out infinite}
@keyframes rptSh{0%{background-position:100% 0}100%{background-position:0 0}}
@media (max-width:640px){
  .rpt-hero{padding:18px 16px 16px;border-radius:18px}
  .rpt-hero h1{font-size:28px}
  .rpt-tabs{width:100%}
  .rpt-tab{flex:1 1 auto;padding:0 10px}
  .rpt-kpi b{font-size:28px}
}
`;
if (!document.getElementById('rbt-css')) {
  const st = document.createElement('style');
  st.id = 'rbt-css';
  st.textContent = EXTRA_CSS;
  document.head.appendChild(st);
}

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
  <div class="card pl">
    <h2>Check a part</h2>
    <label for="pn">Enter part no</label>
    <input id="pn" list="pnl" autocomplete="off" placeholder="part no, to see its quantity and boxes"><datalist id="pnl">${stock.map((r) => `<option value="${esc(r.part_no)}">${esc(r.part_name || '')}</option>`).join('')}</datalist>
    <div id="pr"></div>
  </div>
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

  // Check a part: type a part no (or part of the name) and its quantity and boxes show straight away.
  const pr = $(el, '#pr');
  const fig = (n, label, main) => `<div class="pl-fig${main ? ' main' : ''}"><b>${fmtNum(n)}</b><span>${label}</span></div>`;
  const showPart = () => {
    const raw = $(el, '#pn').value.trim();
    if (!raw) { pr.innerHTML = '<p class="hint" style="margin:10px 0 0">Type a part no to see its quantity and boxes.</p>'; return; }
    const key = raw.toUpperCase().replace(/[.…]+$/, '').trim();
    let hit = stock.filter((r) => r.part_no.toUpperCase() === key);
    if (!hit.length) hit = stock.filter((r) => r.part_no.toUpperCase().includes(key) || (r.part_name || '').toUpperCase().includes(key));
    if (!hit.length) { pr.innerHTML = `<div style="margin-top:12px">${msg('warn', `No stock found for <b>${esc(raw)}</b>. Check the part no.`)}</div>`; return; }
    if (hit.length === 1) {
      const r = hit[0];
      pr.innerHTML = `<div class="pl-name"><b class="mono">${esc(r.part_no)}</b><span>${esc(r.part_name || '')}</span></div>
        <div class="pl-figs">${fig(r.fg_qty, 'Qty in FG stock (NOS)', true)}${fig(r.fg_boxes, 'Boxes in FG stock', true)}${fig(r.wip_qty, 'Packed, not yet in FG (NOS)')}${fig(r.wip_boxes, 'Packed boxes, not yet in FG')}</div>
        ${Number(r.fg_boxes) > 0 && r.oldest_days !== null && r.oldest_days !== undefined ? `<p class="hint">Oldest FG box has been in stock for ${fmtNum(r.oldest_days)} day(s).</p>` : ''}`;
      return;
    }
    pr.innerHTML = `<p class="hint" style="margin:12px 0 0"><b>${fmtNum(hit.length)} parts</b> match. Their total:</p>
      <div class="pl-figs">${fig(sum(hit, 'fg_qty'), 'Qty in FG stock (NOS)', true)}${fig(sum(hit, 'fg_boxes'), 'Boxes in FG stock', true)}${fig(sum(hit, 'wip_qty'), 'Packed, not yet in FG (NOS)')}${fig(sum(hit, 'wip_boxes'), 'Packed boxes, not yet in FG')}</div>
      <div class="pl-list">${hit.slice(0, 10).map((r) => `<button type="button" class="pl-row" data-p="${esc(r.part_no)}"><b class="mono">${esc(r.part_no)}</b><span>${esc(r.part_name || '')}</span><em>${fmtNum(r.fg_qty)} NOS · ${fmtNum(r.fg_boxes)} boxes</em></button>`).join('')}</div>
      ${hit.length > 10 ? `<p class="hint">Showing 10 of ${fmtNum(hit.length)}. Type more of the part no to narrow it down.</p>` : '<p class="hint">Tap a part to see only that one.</p>'}`;
  };
  $(el, '#pn').addEventListener('input', showPart);
  pr.addEventListener('click', (e) => { const b = e.target.closest('[data-p]'); if (b) { $(el, '#pn').value = b.dataset.p; showPart(); } });
  showPart();
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

const spanDays = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000) + 1;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const REPORT_TABS = { out: 'Assembly out', inw: 'FG inward', dis: 'Dispatch' };

// Ranked list with bars: the biggest parts (or parties) by quantity.
function rankHtml(rows, keyOf, nameOf, totalQty, mono = true, limit = 8) {
  const m = new Map();
  rows.forEach((r) => { const k = keyOf(r); const o = m.get(k) || { k, name: nameOf(r), qty: 0, boxes: 0 }; o.qty += Number(r.qty); o.boxes += Number(r.boxes); m.set(k, o); });
  const list = [...m.values()].sort((a, b) => b.qty - a.qty);
  const max = list.length ? list[0].qty : 0;
  const html = list.slice(0, limit).map((o) => `<div class="rpt-rk"><div class="rpt-rk-h"><span class="nm${mono ? ' mono' : ''}">${esc(o.k)}</span>${o.name ? `<em>${esc(o.name)}</em>` : ''}<b>${fmtNum(o.qty)}</b></div>
      <div class="rpt-trk"><i style="width:${max ? Math.max(2, Math.round((o.qty * 100) / max)) : 0}%"></i></div>
      <small>${totalQty ? ((o.qty * 100) / totalQty).toFixed(1) : '0.0'}% of qty · ${fmtNum(o.boxes)} box(es)</small></div>`).join('')
    + (list.length > limit ? `<p class="hint">+ ${fmtNum(list.length - limit)} more in the detail table below</p>` : '');
  return { count: list.length, html };
}

// Bars per day (or per month for long periods). The biggest bar is amber.
function trendHtml(byDay, from, to) {
  const n = spanDays(from, to);
  let items = [], title = 'Daily trend';
  if (n >= 1 && n <= 62) {
    for (let i = 0; i < n; i++) { const d = addDays(from, i), v = byDay.get(d); items.push({ label: d.slice(8), tip: fmtDay(d), qty: v ? v.qty : 0, boxes: v ? v.boxes : 0 }); }
  } else if (n > 62) {
    title = 'Monthly trend';
    const m = new Map();
    byDay.forEach((v, d) => { const k = d.slice(0, 7); const o = m.get(k) || { qty: 0, boxes: 0 }; o.qty += v.qty; o.boxes += v.boxes; m.set(k, o); });
    items = [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => ({ label: `${MON[Number(k.slice(5, 7)) - 1]} ${k.slice(2, 4)}`, tip: `${MON[Number(k.slice(5, 7)) - 1]} ${k.slice(0, 4)}`, qty: v.qty, boxes: v.boxes }));
  }
  const max = items.reduce((s, x) => Math.max(s, x.qty), 0);
  const bars = items.map((x) => `<div class="rpt-bar${x.qty === 0 ? ' zero' : x.qty === max ? ' max' : ''}" title="${esc(x.tip)}: ${fmtNum(x.qty)} NOS, ${fmtNum(x.boxes)} box(es)"><div class="col"><i style="height:${max ? Math.max(0, Math.round((x.qty * 100) / max)) : 0}%"></i></div><span>${esc(x.label)}</span></div>`).join('');
  return { title, html: `<div class="rpt-chart"><div class="rpt-bars">${bars}</div><div class="rpt-axis"><span>${fmtDay(from)} to ${fmtDay(to)}</span><span>Tallest bar: ${fmtNum(max)} NOS</span></div></div>` };
}

async function reportsPage(el, { isCurrent }) {
  const t = todayIst();
  const st = { r: 'out', from: addDays(t, -6), to: t };
  el.innerHTML = `
  <div class="rpt">
    <section class="rpt-hero">
      <p class="rpt-eyebrow">Radiance Polymers · Box tracker</p>
      <h1>Reports</h1>
      <p class="rpt-sub">Boxes and quantity per date: what assembly made, what the store received and what was dispatched.</p>
      <div class="rpt-tabs" role="tablist">${Object.entries(REPORT_TABS).map(([k, v]) => `<button type="button" role="tab" class="rpt-tab${k === st.r ? ' on' : ''}" data-r="${k}">${esc(v)}</button>`).join('')}</div>
    </section>
    <form class="rpt-filter" id="f">
      <input type="hidden" id="r" value="${st.r}">
      <div class="rpt-pre"><button type="button" data-d="0">Today</button><button type="button" data-d="6">Last 7 days</button><button type="button" data-d="29">Last 30 days</button><button type="button" data-d="m">This month</button></div>
      <div class="rpt-dates">
        <div><label for="from">From</label><input id="from" type="date" value="${st.from}" required></div>
        <div><label for="to">To</label><input id="to" type="date" value="${st.to}" required></div>
        <div class="actions"><button class="btn">Show</button><button type="button" class="btn alt" id="csv">Download CSV</button></div>
      </div>
    </form>
    <div id="out"></div>
  </div>`;
  let rows = [];
  async function load() {
    st.r = $(el, '#r').value; st.from = $(el, '#from').value; st.to = $(el, '#to').value;
    const R = REPORTS[st.r];
    $(el, '#out').innerHTML = '<div class="rpt-skel"><i></i><i></i><i></i><i></i></div>';
    rows = await api.selectAll(R.view, `select=*&day=gte.${st.from}&day=lte.${st.to}&order=day.desc,part_no`);
    if (!isCurrent()) return;
    const byDay = new Map();
    rows.forEach((r) => { const d = byDay.get(r.day) || { day: r.day, boxes: 0, qty: 0 }; d.boxes += Number(r.boxes); d.qty += Number(r.qty); byDay.set(r.day, d); });
    const days = [...byDay.values()];
    const totB = days.reduce((s, d) => s + d.boxes, 0), totQ = days.reduce((s, d) => s + d.qty, 0);
    if (!rows.length) {
      $(el, '#out').innerHTML = `<p class="rpt-note">${esc(R.note)}</p><div class="rpt-card"><div class="rpt-empty"><b>No records in this period</b>Try a longer period, or another report.</div></div>`;
      return;
    }
    const best = days.reduce((a, d) => (d.qty > a.qty ? d : a), days[0]);
    const parts = rankHtml(rows, (r) => r.part_no, (r) => r.part_name, totQ);
    const parties = st.r === 'dis' ? rankHtml(rows, (r) => r.party || '-', () => '', totQ, false) : null;
    const tr = trendHtml(byDay, st.from, st.to);
    const kpi = (k, v, sub) => `<div class="rpt-kpi"><span class="k">${esc(k)}</span><b>${v}</b><small>${sub}</small></div>`;
    $(el, '#out').innerHTML = `
      <p class="rpt-note">${esc(R.note)}</p>
      <div class="rpt-kpis">
        ${kpi('Quantity (NOS)', fmtNum(totQ), `${fmtNum(days.length)} day(s) with records`)}
        ${kpi('Boxes', fmtNum(totB), `about ${fmtNum(Math.round(totB / days.length))} per day with records`)}
        ${kpi('Busiest day', esc(fmtDay(best.day)), `${fmtNum(best.qty)} NOS · ${fmtNum(best.boxes)} box(es)`)}
        ${kpi(parties ? 'Parts · Parties' : 'Parts', parties ? `${fmtNum(parts.count)} · ${fmtNum(parties.count)}` : fmtNum(parts.count), parties ? 'different parts · different parties' : 'different parts')}
      </div>
      <div class="rpt-two">
        <div class="rpt-card"><h3>${tr.title}</h3>${tr.html}</div>
        <div class="rpt-card"><h3>Top parts <small>by quantity</small></h3>${parts.html}</div>
        ${parties ? `<div class="rpt-card"><h3>By party <small>by quantity</small></h3>${parties.html}</div>` : ''}
      </div>
      <div class="rpt-card"><h3>Per day</h3><div class="rpt-tot">${table([{ k: 'day', label: 'Date', fmt: fmtDay }, { k: 'boxes', label: 'Boxes', n: true, fmt: fmtNum }, { k: 'qty', label: 'Qty', n: true, fmt: fmtNum }],
        [...days, { day: '', boxes: totB, qty: totQ, total: true }].map((d) => (d.total ? { ...d, day: 'TOTAL' } : d)), 'No records in this period.')}</div></div>
      <div class="rpt-card"><h3>Detail <small>${fmtNum(rows.length)} row(s)</small></h3>${table(R.cols, rows, 'No records in this period.')}</div>`;
  }
  const go = () => busy(null, load);
  $(el, '#f').addEventListener('submit', (e) => { e.preventDefault(); go(); });
  el.addEventListener('click', (e) => {
    const tab = e.target.closest('.rpt-tab');
    if (tab) {
      $(el, '#r').value = tab.dataset.r;
      el.querySelectorAll('.rpt-tab').forEach((b) => b.classList.toggle('on', b === tab));
      return go();
    }
    const pre = e.target.closest('.rpt-pre button');
    if (pre) {
      const d = pre.dataset.d, now = todayIst();
      $(el, '#to').value = now;
      $(el, '#from').value = d === 'm' ? now.slice(0, 8) + '01' : addDays(now, -Number(d));
      go();
    }
  });
  $(el, '#csv').addEventListener('click', () => {
    const R = REPORTS[st.r];
    if (!rows.length) return toast('Show a report with records first.', true);
    download(`${R.view}-${st.from}-to-${st.to}.csv`, toCsv([R.cols.map((c) => c.label), ...rows.map((r) => R.cols.map((c) => (c.k === 'day' ? fmtDay(r[c.k]) : r[c.k])))]));
  });
  await load();
}

window.addEventListener('hashchange', render);
render();
