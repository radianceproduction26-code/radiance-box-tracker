// FG outward (fg, dispatch, admin): scan boxes -> create packing slip -> PDF. And the Slips list / detail.
import * as api from './api.js';
import { CONFIG } from './config.js';
import { startScanner, beep, cameraSupported } from './scanner.js';
import { slipPdf, sharePdf, downloadPdf, groupBoxes } from './slip.js';
import { $, $$, esc, toast, busy, fmtNum, fmtTs, fmtDay, table, msg, q } from './ui.js';

const BOX_RE = /^RP-\d{6}-\d{5,}$/;
const DRAFT_KEY = 'rbt.slipdraft';
const FIELDS = [
  ['party', 'Party name *', 'party', 'e.g. FFPL'], ['location', 'Location', 'location', ''], ['transport', 'Transport', 'transport', ''],
  ['vehicle', 'Vehicle no', 'vehicle', 'MH12AB1234'], ['lr_no', 'LR no', 'lr_no', ''], ['inv_no', 'Invoice no', 'inv_no', ''],
  ['disp_exe', 'Disp. exe', 'disp_exe', ''], ['driver_name', 'Driver name', 'driver_name', ''], ['driver_mob', 'Driver mobile', 'driver_mob', ''],
];
const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (_) { return null; } };
const lsSet = (k, v) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* ignore */ } };
const emptyHead = () => Object.fromEntries(FIELDS.map((f) => [f[0], '']));

const fetchSlip = async (no) => {
  const [s, b] = await Promise.all([
    api.selectAll('slips', `select=*&slip_no=eq.${q(no)}`),
    api.selectAll('boxes', `select=box_id,part_no,part_name,qty,pp_box_code,tray_no,fg_at&slip_no=eq.${q(no)}&order=part_no,box_id`),
  ]);
  return { slip: s[0], boxes: b };
};

// ---------------------------------------------------------------- outward
export async function outwardPage(el, { isCurrent }) {
  const parties = await api.selectAll('parties', 'select=*&order=name');
  if (!isCurrent()) return;
  const saved = lsGet(DRAFT_KEY) || {};
  let head = Object.assign(emptyHead(), saved.head || {});
  let boxes = Array.isArray(saved.boxes) ? saved.boxes : [];
  let scanner = null, last = { id: '', at: 0, seen: 0 }, busyScan = false, done = null;
  const save = () => lsSet(DRAFT_KEY, { head, boxes });

  el.innerHTML = `
  <h1>FG outward</h1>
  <p class="sub">Fill the slip details, scan every box going on the truck, then create the packing slip.</p>
  <div id="doneBox"></div>
  <div id="work">
  <div class="card"><div class="step"><span class="no">1</span><h2>Slip details</h2></div>
    <div class="row">${FIELDS.map(([k, label, , ph]) => `<div${k === 'party' ? ' class="wide"' : ''}><label for="f_${k}">${label}</label><input id="f_${k}" data-k="${k}" placeholder="${esc(ph)}" autocomplete="off" ${k === 'party' ? 'list="parties"' : ''} ${k === 'driver_mob' ? 'inputmode="tel"' : ''}></div>`).join('')}</div>
    <datalist id="parties">${parties.map((p) => `<option value="${esc(p.name)}">`).join('')}</datalist>
    <p class="hint">A party you have shipped to before fills location, transport, disp. exe and driver for you.</p></div>
  <div class="scanwrap">
    <div class="card"><div class="step"><span class="no">2</span><h2>Scan boxes</h2></div>
      <div class="vid"><video id="vid" playsinline muted></video><div class="vidmsg" id="vidmsg">Camera is off</div></div>
      <div id="result" class="result idle" aria-live="assertive"><b>Ready</b><span>Scan a box label.</span></div>
      <div class="actions"><button class="btn" id="start">Start camera</button><button class="btn alt" id="torch" hidden>Torch</button><button class="btn alt" id="stop" hidden>Stop</button></div>
      <form id="manual" class="actions" style="margin-top:12px;flex-wrap:nowrap" autocomplete="off">
        <input id="typed" placeholder="Or type the Box ID" style="flex:1" autocapitalize="characters" spellcheck="false"><button class="btn alt" id="typedgo">Add</button></form></div>
    <div><div class="grid g2" style="margin:0 0 12px"><div class="stat"><b id="n-boxes">0</b><span>boxes on this slip</span></div><div class="stat"><b id="n-qty">0</b><span>NOS in total</span></div></div></div>
  </div>
  <div class="card"><div class="step"><span class="no">3</span><h2>Review and create</h2></div>
    <div id="list"></div><div id="problem"></div>
    <div class="actions"><button class="btn big" id="create" disabled>Create packing slip</button><button class="btn alt" id="clear" hidden>Clear this slip</button></div></div>
  </div>`;

  const setHeadInputs = () => FIELDS.forEach(([k]) => { $(el, `#f_${k}`).value = head[k] || ''; });
  setHeadInputs();
  $$(el, 'input[data-k]').forEach((i) => i.addEventListener('input', () => { head[i.dataset.k] = i.value; save(); refresh(); }));
  $(el, '#f_party').addEventListener('change', (e) => {
    const p = parties.find((x) => x.name.toLowerCase() === e.target.value.trim().toLowerCase());
    if (!p) return;
    head.party = p.name;
    ['location', 'transport', 'disp_exe', 'driver_name', 'driver_mob'].forEach((k) => { if (!head[k]) head[k] = p[k] || ''; });
    setHeadInputs(); save(); refresh();
  });

  const show = (kind, title, detail) => {
    const r = $(el, '#result');
    r.className = 'result ' + kind;
    r.innerHTML = `<b>${esc(title)}</b><span>${esc(detail || '')}</span>`;
    if (kind !== 'idle') beep(kind === 'ok' || kind === 'warn');
  };
  const refresh = () => {
    const qty = boxes.reduce((s, b) => s + b.qty, 0);
    $(el, '#n-boxes').textContent = fmtNum(boxes.length); $(el, '#n-qty').textContent = fmtNum(qty);
    const g = groupBoxes(boxes);
    $(el, '#list').innerHTML = boxes.length ? `
      <div class="tw"><table><thead><tr><th>Part no</th><th class="n">Qty / box</th><th class="n">Boxes</th><th class="n">Total</th></tr></thead><tbody>
      ${g.map((x) => `<tr><td class="mono">${esc(x.part)}</td><td class="n">${fmtNum(x.per)}</td><td class="n">${fmtNum(x.n)}</td><td class="n"><b>${fmtNum(x.per * x.n)}</b></td></tr>`).join('')}
      <tr class="tot"><td>Total</td><td></td><td class="n">${fmtNum(boxes.length)}</td><td class="n">${fmtNum(qty)}</td></tr></tbody></table></div>
      <details class="boxlist"><summary>Show the ${fmtNum(boxes.length)} scanned boxes</summary>
      <div class="tw"><table><tbody>${[...boxes].reverse().map((b) => `<tr><td class="mono">${esc(b.box_id)}</td><td>${esc(b.part_no)}</td><td class="n">${fmtNum(b.qty)}</td><td class="n"><button class="btn sm danger" data-rm="${esc(b.box_id)}" aria-label="Remove ${esc(b.box_id)}">Remove</button></td></tr>`).join('')}</tbody></table></div></details>`
      : '<div class="empty">No boxes scanned yet.</div>';
    $$(el, '[data-rm]').forEach((b) => b.addEventListener('click', () => { boxes = boxes.filter((x) => x.box_id !== b.dataset.rm); save(); refresh(); }));
    $(el, '#create').disabled = !boxes.length || !head.party.trim();
    $(el, '#create').textContent = boxes.length ? `Create packing slip · ${fmtNum(boxes.length)} boxes · ${fmtNum(qty)} NOS` : 'Create packing slip';
    $(el, '#clear').hidden = !boxes.length && !Object.values(head).some(Boolean);
  };
  refresh();

  async function add(raw, source) {
    const id = String(raw || '').trim().toUpperCase();
    const t = Date.now();
    if (source === 'camera' && id === last.id && (t - last.at < 3000 || t - last.seen < 1500)) { last.seen = t; return; }
    if (busyScan) return;
    last = { id, at: t, seen: t };
    if (!BOX_RE.test(id)) { show('bad', 'Not a Radiance box label', id.slice(0, 60)); return; }
    if (boxes.some((b) => b.box_id === id)) { show('bad', 'Already on this slip', id); return; }
    busyScan = true;
    try {
      const r = await api.rpc('check_box_for_slip', { p_box_id: id, p_scanned: boxes.map((b) => b.box_id) });
      if (!isCurrent()) return;
      if (r.ok) {
        boxes.push({ box_id: r.box.box_id, part_no: r.box.part_no, part_name: r.box.part_name, qty: r.box.qty });
        save(); refresh();
        show(r.warn ? 'warn' : 'ok', `${r.box.part_no}  ·  ${fmtNum(r.box.qty)} NOS`, r.warn ? r.msg.split(' · FIFO note: ')[1] ? 'FIFO: ' + r.msg.split(' · FIFO note: ')[1] : r.msg : `${r.box.part_name} · ${id}`);
      } else show('bad', 'Not added', r.msg);
    } catch (e) {
      if (e.code === 'expired' || e.code === 'no_session') { location.hash = '#/'; location.reload(); return; }
      show('bad', 'Not added', e.code === 'network' ? 'No connection. This box was NOT added. Scan it again when the connection is back.' : e.message);
    } finally { busyScan = false; }
  }
  $(el, '#manual').addEventListener('submit', async (e) => { e.preventDefault(); const v = $(el, '#typed').value; if (!v.trim()) return; await add(v, 'typed'); $(el, '#typed').value = ''; $(el, '#typed').focus(); });
  const setCam = (on, text) => { $(el, '#start').hidden = on; $(el, '#stop').hidden = !on; $(el, '#vidmsg').textContent = text || ''; $(el, '#vidmsg').hidden = on; };
  $(el, '#start').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try { scanner = await startScanner($(el, '#vid'), (t) => add(t, 'camera')); setCam(true); $(el, '#torch').hidden = !scanner.hasTorch; }
    catch (err) { setCam(false, err.message); show('bad', 'Camera not started', err.message); }
    e.target.disabled = false;
  });
  let torchOn = false;
  $(el, '#torch').addEventListener('click', async () => { try { torchOn = !torchOn; await scanner.setTorch(torchOn); } catch (_) { toast('Torch not available on this phone', true); } });
  $(el, '#stop').addEventListener('click', () => { if (scanner) scanner.stop(); scanner = null; setCam(false, 'Camera is off'); });
  window.addEventListener('hashchange', () => { if (scanner) { scanner.stop(); scanner = null; } }, { once: true });
  if (!cameraSupported()) setCam(false, 'This browser has no camera access here. Type the Box ID below.');

  $(el, '#clear').addEventListener('click', () => {
    if (!confirm('Clear the slip details and all scanned boxes? Nothing has been dispatched yet.')) return;
    head = emptyHead(); boxes = []; save(); setHeadInputs(); refresh(); $(el, '#problem').innerHTML = '';
    show('idle', 'Ready', 'Scan a box label.');
  });

  $(el, '#create').addEventListener('click', async (ev) => {
    const btn = ev.currentTarget, qty = boxes.reduce((s, b) => s + b.qty, 0);
    if (!confirm(`Dispatch ${boxes.length} boxes (${fmtNum(qty)} NOS) to ${head.party.trim()}?\nThe boxes will be marked DISPATCHED.`)) return;
    $(el, '#problem').innerHTML = '';
    if (scanner) { scanner.stop(); scanner = null; setCam(false, 'Camera is off'); }
    btn.disabled = true;
    try {
      const r = await api.rpc('create_slip', {
        p_box_ids: boxes.map((b) => b.box_id), p_party: head.party.trim(), p_location: head.location, p_transport: head.transport, p_vehicle: head.vehicle,
        p_lr_no: head.lr_no, p_inv_no: head.inv_no, p_disp_exe: head.disp_exe, p_driver_name: head.driver_name, p_driver_mob: head.driver_mob, p_device: CONFIG.DEVICE,
      });
      if (!isCurrent()) return;
      if (!r.ok) {
        if (Array.isArray(r.bad) && r.bad.length) {
          boxes = boxes.filter((b) => !r.bad.includes(b.box_id)); save(); refresh();
          $(el, '#problem').innerHTML = msg('bad', `${esc(r.msg)}<br>These boxes were taken off the slip. Check the rest and press Create again.`);
        } else $(el, '#problem').innerHTML = msg('bad', esc(r.msg));
        return;
      }
      const { slip, boxes: rows } = await fetchSlip(r.slip_no);
      const bytes = slipPdf(slip, rows);
      done = { no: r.slip_no, boxes: r.boxes, qty: r.qty, bytes };
      lsSet(DRAFT_KEY, null);
      $(el, '#work').hidden = true;
      $(el, '#doneBox').innerHTML = `<div class="card donecard"><div class="tick">✓</div><h2>Packing slip ${esc(r.slip_no)} created</h2>
        <p>${fmtNum(r.boxes)} boxes · ${fmtNum(r.qty)} NOS dispatched to <b>${esc(slip.party)}</b>.</p>
        <div class="actions"><button class="btn big" id="share">Share / print PDF</button><button class="btn alt" id="dl">Download PDF</button><button class="btn alt" id="again">New slip</button></div>
        <p class="hint">The PDF is also available later under Slips.</p></div>`;
      $(el, '#share').addEventListener('click', () => sharePdf(`${done.no}.pdf`, done.bytes));
      $(el, '#dl').addEventListener('click', () => downloadPdf(`${done.no}.pdf`, done.bytes));
      $(el, '#again').addEventListener('click', () => { head = emptyHead(); boxes = []; done = null; $(el, '#doneBox').innerHTML = ''; $(el, '#work').hidden = false; setHeadInputs(); refresh(); show('idle', 'Ready', 'Scan a box label.'); });
    } catch (e) {
      if (e.code === 'expired' || e.code === 'no_session') { location.hash = '#/'; location.reload(); return; }
      $(el, '#problem').innerHTML = msg('bad', e.code === 'network'
        ? 'No connection. If the slip was created before the connection dropped, it will be under <a href="#/slips">Slips</a>. Look there before you press Create again.'
        : esc(e.message));
    } finally { btn.disabled = !boxes.length; }
  });
}

// ---------------------------------------------------------------- slips list + detail
export async function slipsPage(el, { me, isCurrent, params }) {
  const no = params.get('slip');
  if (no) return slipDetail(el, { me, isCurrent, no });
  const PAGE = 50;
  const st = { page: 0, text: '', status: '' };
  el.innerHTML = `<h1>Packing slips</h1>
  <div class="card"><div class="row"><div><label>Search</label><input id="s" placeholder="slip, party, invoice or vehicle"></div>
  <div><label>Status</label><select id="st"><option value="">All</option><option value="live">Active</option><option value="void">Voided</option></select></div></div></div>
  <div id="tbl"></div><div class="actions" id="pager"></div>`;
  const load = async () => {
    let query = `select=*&order=created_at.desc`;
    if (st.text) { const t = q(st.text); query += `&or=(slip_no.ilike.*${t}*,party.ilike.*${t}*,inv_no.ilike.*${t}*,vehicle.ilike.*${t}*)`; }
    if (st.status === 'void') query += '&voided_at=not.is.null'; else if (st.status === 'live') query += '&voided_at=is.null';
    const { rows, total } = await api.selectPage('slip_summary', query, st.page * PAGE, st.page * PAGE + PAGE - 1);
    if (!isCurrent()) return;
    $(el, '#tbl').innerHTML = table([
      { label: 'Slip', html: (r) => `<a href="#/slips?slip=${encodeURIComponent(r.slip_no)}"><b>${esc(r.slip_no)}</b></a>` },
      { k: 'created_at', label: 'Date', fmt: fmtTs }, { k: 'party', label: 'Party' }, { k: 'inv_no', label: 'Invoice' }, { k: 'vehicle', label: 'Vehicle' },
      { k: 'boxes', label: 'Boxes', n: true, fmt: fmtNum }, { k: 'qty', label: 'Qty', n: true, fmt: fmtNum },
      { label: 'Status', html: (r) => (r.voided_at ? '<span class="pill VOID">VOIDED</span>' : '<span class="pill DISPATCHED">DISPATCHED</span>') },
    ], rows, 'No slips yet.');
    const pages = Math.max(1, Math.ceil(total / PAGE));
    $(el, '#pager').innerHTML = total > PAGE ? `<button class="btn alt sm" id="pv" ${st.page ? '' : 'disabled'}>Previous</button><span class="hint">Page ${st.page + 1} of ${pages} · ${fmtNum(total)} slips</span><button class="btn alt sm" id="nx" ${st.page + 1 >= pages ? 'disabled' : ''}>Next</button>` : '';
    const pv = $(el, '#pv'), nx = $(el, '#nx');
    if (pv) pv.addEventListener('click', () => { st.page--; load(); });
    if (nx) nx.addEventListener('click', () => { st.page++; load(); });
  };
  let tm = null;
  $(el, '#s').addEventListener('input', (e) => { clearTimeout(tm); tm = setTimeout(() => { st.text = e.target.value; st.page = 0; load(); }, 300); });
  $(el, '#st').addEventListener('change', (e) => { st.status = e.target.value; st.page = 0; load(); });
  await load();
}

async function slipDetail(el, { me, isCurrent, no }) {
  const [sum, det] = await Promise.all([api.selectAll('slip_summary', `select=*&slip_no=eq.${q(no)}`), fetchSlip(no)]);
  if (!isCurrent()) return;
  const s = sum[0];
  if (!s) { el.innerHTML = `<p><a href="#/slips">← All slips</a></p>${msg('bad', 'Slip not found: ' + esc(no))}`; return; }
  const g = groupBoxes(det.boxes);
  const f = (label, v) => `<div><label>${label}</label><div class="val">${esc(v || '—')}</div></div>`;
  el.innerHTML = `
  <p><a href="#/slips">← All slips</a></p>
  <div class="slipHead"><h1>${esc(s.slip_no)} ${s.voided_at ? '<span class="pill VOID">VOIDED</span>' : '<span class="pill DISPATCHED">DISPATCHED</span>'}</h1></div>
  ${s.voided_at ? msg('warn', `Voided on ${esc(fmtTs(s.voided_at))}: ${esc(s.void_reason)}. Its ${fmtNum(s.boxes)} boxes went back to FG stock.`) : ''}
  <div class="card"><div class="row">${f('Date', fmtTs(s.created_at))}${f('Party', s.party)}${f('Location', s.location)}${f('Transport', s.transport)}${f('Vehicle', s.vehicle)}${f('LR no', s.lr_no)}${f('Invoice', s.inv_no)}${f('Disp. exe', s.disp_exe)}${f('Driver', [s.driver_name, s.driver_mob].filter(Boolean).join(' · '))}</div>
  <div class="grid g2"><div class="stat"><b>${fmtNum(s.boxes)}</b><span>boxes</span></div><div class="stat"><b>${fmtNum(s.qty)}</b><span>NOS</span></div></div>
  <div class="actions" style="margin-top:14px">${s.voided_at ? '' : '<button class="btn big" id="share">Share / print PDF</button><button class="btn alt" id="dl">Download PDF</button>'}${me.role === 'admin' && !s.voided_at ? '<button class="btn danger" id="void">Void this slip</button>' : ''}</div></div>
  ${s.voided_at ? '' : `<h2>Parts on this slip</h2>${table([{ k: 'part', label: 'Part no', cls: 'mono' }, { k: 'per', label: 'Qty / box', n: true, fmt: fmtNum }, { k: 'n', label: 'Boxes', n: true, fmt: fmtNum }, { label: 'Total', n: true, html: (x) => `<b>${fmtNum(x.per * x.n)}</b>` }], g)}
  <h2 style="margin-top:18px">Boxes</h2>${table([{ k: 'box_id', label: 'Box ID', cls: 'mono' }, { k: 'part_no', label: 'Part no' }, { k: 'part_name', label: 'Part name' }, { k: 'qty', label: 'Qty', n: true, fmt: fmtNum }], det.boxes)}`}`;
  if (!s.voided_at) {
    const pdf = () => slipPdf(det.slip, det.boxes);
    $(el, '#share').addEventListener('click', () => sharePdf(`${s.slip_no}.pdf`, pdf()));
    $(el, '#dl').addEventListener('click', () => downloadPdf(`${s.slip_no}.pdf`, pdf()));
  }
  const v = $(el, '#void');
  if (v) v.addEventListener('click', () => busy(v, async () => {
    const reason = prompt(`Why is ${s.slip_no} being voided? (needed)\nIts boxes go back to FG stock.`);
    if (reason === null) return;
    const r = await api.rpc('void_slip', { p_slip_no: s.slip_no, p_reason: reason, p_device: CONFIG.DEVICE });
    if (!r.ok) { toast(r.msg, true); return; }
    toast(r.msg); slipDetail(el, { me, isCurrent, no });
  }));
}
