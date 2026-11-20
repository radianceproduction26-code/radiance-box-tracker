// Stock take (Phase 7): scan every box that is physically in the FG store, then compare with what the system says.
//
// The count is kept on this phone (localStorage, one count per login) and every scan is judged at once against a copy of the
// stock list, so counting works with no signal and survives closing the app. "Finish and compare" asks the database again, so a box
// that moved while you were counting is judged correctly. Nothing is changed in the database by counting.
import * as api from './api.js';
import { startScanner, beep, cameraSupported } from './scanner.js';
import { receiveOrQueue } from './offline.js';
import { downloadXlsx } from './xlsx.js';
import { buildResult, whyText, chunk, NOT_IN_REGISTER } from './stockcount.js';
import { $, $$, esc, toast, busy, fmtNum, fmtTs, fmtDay, todayIst, table, msg } from './ui.js';

const BOX_RE = /^RP-\d{6}-\d{5,}$/;
const COLS = 'box_id,part_no,part_name,qty,status,rack,slip_no,fg_at,out_at';
const SHOW_MAX = 300;
const KEY = (u) => `rbt.take.${u}`, SNAP = (u) => `rbt.take.snap.${u}`;
const read = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (_) { return null; } };
const write = (k, v) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (_) { /* full or private tab: the count still works until the page is closed */ } };
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
const sign = (n) => (n > 0 ? '+' + fmtNum(n) : n < 0 ? '−' + fmtNum(-n) : '0');
const histLink = (id) => `<a href="#/reports?tab=history&box=${encodeURIComponent(id)}">${esc(id)}</a>`;

export async function stocktakePage(el, { me, isCurrent }) {
  const uid = me.user_id;
  let scanner = null;
  const stopCam = () => { if (scanner) { scanner.stop(); scanner = null; } };
  let unlisten = () => {};   // the online/offline listeners of the counting screen: removed when that screen is left, so an old screen never redraws
  window.addEventListener('hashchange', stopCam, { once: true });

  // The stock list: every box the system says is in FG or packed. Fresh from the server when possible, else the copy kept on the phone.
  async function loadSnapshot() {
    const rows = await api.selectAll('boxes', `select=${COLS}&status=in.(FG-RECEIVED,WIP-PACKED)&order=box_id`);
    write(SNAP(uid), rows.map((r) => ({ box_id: r.box_id, part_no: r.part_no, part_name: r.part_name, qty: r.qty, status: r.status, rack: r.rack, slip_no: r.slip_no, fg_at: r.fg_at })));
    return rows;
  }
  const savedList = () => read(SNAP(uid));

  // ------------------------------------------------------------ start
  function startView() {
    stopCam(); unlisten();
    el.innerHTML = `
    <h1>Stock take</h1>
    <p class="sub">Count the FG store by scanning every box that is physically there. The app then shows which boxes match the system, which are missing, and which are not supposed to be there.</p>
    <div class="card" style="max-width:640px">
      <label for="name">Name of this count</label><input id="name" value="Stock take ${esc(fmtDay(todayIst()))}" maxlength="60" autocomplete="off">
      <ol class="hint" style="margin:12px 0 14px 18px;padding:0;line-height:1.55">
        <li>Stop movements in the store while you count (no inward, no dispatch).</li>
        <li>Scan every box on every rack. A box scanned twice is counted once. It works without signal.</li>
        <li>Press <b>Finish and compare</b>. Counting changes nothing in the database.</li>
      </ol>
      <div class="actions"><button class="btn" id="begin">Start counting</button></div>
    </div>`;
    $(el, '#begin').addEventListener('click', (e) => busy(e.target, async () => {
      const name = $(el, '#name').value.trim() || `Stock take ${fmtDay(todayIst())}`;
      try { await loadSnapshot(); }
      catch (err) {
        if (err.code !== 'network') throw err;
        if (!savedList()) throw new Error('No connection and no stock list on this phone yet. Connect once to load it, then you can count without signal.');
        toast('No signal: using the stock list saved earlier on this phone');
      }
      write(KEY(uid), { name, started: new Date().toISOString(), scans: [], rack: '' });
      countView();
    }));
  }

  // ------------------------------------------------------------ counting
  async function countView() {
    const snap = new Map(), known = new Map();   // snap: boxes packed / in FG. known: other boxes looked up while counting (null = not in the register)
    let rows;
    try { rows = await loadSnapshot(); } catch (_) { rows = savedList() || []; }
    if (!isCurrent()) return;
    rows.forEach((r) => snap.set(r.box_id, r));
    const t0 = read(KEY(uid));
    if (!t0) { startView(); return; }
    const counted = new Set(t0.scans.map((s) => s.id));
    let last = { id: '', at: 0, seen: 0 };

    el.innerHTML = `
    <h1>Stock take <span id="net" class="pill"></span></h1>
    <p class="sub"><b>${esc(t0.name)}</b> · started ${esc(fmtTs(t0.started))}. Scan every box in the FG store.</p>
    ${rows.length ? '' : msg('warn', 'No stock list on this phone yet (no signal). Scans are saved and judged when you press Finish.')}
    <div class="scanwrap">
      <div class="card">
        <div class="vid"><video id="vid" playsinline muted></video><div class="vidmsg" id="vidmsg">Camera is off</div></div>
        <div id="result" class="result idle" aria-live="assertive"><b>Ready</b><span>Scan a box label.</span></div>
        <div class="actions"><button class="btn" id="start">Start camera</button><button class="btn alt" id="torch" hidden>Torch</button><button class="btn alt" id="stop" hidden>Stop</button></div>
        <form id="manual" class="actions" style="margin-top:12px;flex-wrap:nowrap" autocomplete="off">
          <input id="typed" placeholder="Or type the Box ID, e.g. RP-261101-00012" style="flex:1" autocapitalize="characters" spellcheck="false"><button class="btn alt" id="typedgo">Count</button></form>
      </div>
      <div>
        <div class="grid g2" style="margin:0 0 12px">
          <div class="stat"><b id="s-cnt">0</b><span id="s-cnt-t">boxes counted</span></div>
          <div class="stat"><b id="s-sys">0</b><span id="s-sys-t">boxes the system has in FG</span></div>
          <div class="stat"><b id="s-left">0</b><span>not counted yet</span></div>
          <div class="stat"><b id="s-odd">0</b><span id="s-odd-t">counted, but not as the system expects</span></div>
        </div>
        <div class="card">
          <label for="rack">Counted only part of the store? Rack starts with (optional)</label>
          <input id="rack" value="${esc(t0.rack || '')}" maxlength="20" autocomplete="off" placeholder="empty = whole FG store" style="margin-bottom:6px">
          <p class="hint" style="margin:0 0 12px">With a rack, boxes in other racks are not reported as missing.</p>
          <div class="actions"><button class="btn" id="finish">Finish and compare</button><button class="btn alt" id="cancel">Cancel this count</button></div>
        </div>
      </div>
    </div>
    <h2>Last scans</h2><div id="recent"></div>`;

    const rowOf = (id) => (snap.has(id) ? snap.get(id) : known.has(id) ? known.get(id) : undefined);
    const sysFg = () => [...snap.values()].filter((r) => r.status === 'FG-RECEIVED');
    const checkText = (r) => (r === undefined ? 'Checking…' : r && r.status === 'FG-RECEIVED' ? '✓ in FG' : whyText(r));

    function draw() {
      const t = read(KEY(uid)) || t0;
      let nos = 0, ok = 0, odd = 0, open = 0;
      for (const s of t.scans) {
        const r = rowOf(s.id);
        if (r === undefined) { open++; continue; }
        if (r === null) { odd++; continue; }
        nos += r.qty;
        if (r.status === 'FG-RECEIVED') ok++; else odd++;
      }
      const sys = sysFg(), sysNos = sys.reduce((s, r) => s + r.qty, 0);
      $(el, '#s-cnt').textContent = fmtNum(t.scans.length);
      $(el, '#s-cnt-t').textContent = `boxes counted · ${fmtNum(nos)} NOS`;
      $(el, '#s-sys').textContent = fmtNum(sys.length);
      $(el, '#s-sys-t').textContent = `boxes the system has in FG · ${fmtNum(sysNos)} NOS`;
      $(el, '#s-left').textContent = fmtNum(Math.max(0, sys.length - ok));
      $(el, '#s-odd').textContent = fmtNum(odd);
      $(el, '#s-odd-t').textContent = open ? `counted, but not as the system expects (${fmtNum(open)} to be checked at the end)` : 'counted, but not as the system expects';
      $(el, '#recent').innerHTML = table([
        { label: 'Time', html: (s) => esc(fmtTs(s.at)) }, { label: 'Box ID', cls: 'mono', html: (s) => esc(s.id) },
        { label: 'Part no', html: (s) => esc((rowOf(s.id) || {}).part_no || '') }, { label: 'Qty', n: true, html: (s) => esc(fmtNum((rowOf(s.id) || {}).qty)) },
        { label: 'System says', html: (s) => esc(checkText(rowOf(s.id))) },
      ], t.scans.slice(-8).reverse(), 'Nothing counted yet.');
      const net = $(el, '#net'); net.className = 'pill ' + (navigator.onLine === false ? 'offline' : 'online'); net.textContent = navigator.onLine === false ? 'No signal' : 'Online';
    }
    draw();
    unlisten();
    const redraw = () => { if (isCurrent()) { draw(); if (navigator.onLine !== false) resolveOpen(); } };
    window.addEventListener('online', redraw); window.addEventListener('offline', redraw);
    unlisten = () => { window.removeEventListener('online', redraw); window.removeEventListener('offline', redraw); unlisten = () => {}; };

    const show = (kind, title, detail) => {   // true = green, false = red, 'warn' = amber
      const r = $(el, '#result');
      r.className = 'result ' + (kind === 'warn' ? 'warn' : kind ? 'ok' : 'bad');
      r.innerHTML = `<b>${esc(title)}</b><span>${esc(detail || '')}</span>`;
      beep(kind !== false);
    };
    async function lookup(id) {
      try { const rows = await withTimeout(api.selectAll('boxes', `select=${COLS}&box_id=eq.${id}`), 4000); const r = rows[0] || null; known.set(id, r); return r; }
      catch (_) { return undefined; }   // no signal: judged at the end
    }
    // Boxes counted while there was no signal (or before the page was reloaded) are checked now, as soon as the server can be reached.
    let resolving = false;
    async function resolveOpen() {
      if (resolving) return;
      resolving = true;
      try {
        const open = (read(KEY(uid)) || t0).scans.map((s) => s.id).filter((id) => rowOf(id) === undefined);
        for (const part of chunk(open, 60)) {
          let found;
          try { found = await withTimeout(api.selectAll('boxes', `select=${COLS}&box_id=in.(${part.join(',')})`), 5000); } catch (_) { return; }   // still no signal: try again later
          if (!isCurrent()) return;
          const got = new Map(found.map((r) => [r.box_id, r]));
          part.forEach((id) => known.set(id, got.get(id) || null));
          draw();
        }
      } finally { resolving = false; }
    }
    resolveOpen();
    function verdict(id, r) {
      if (r === undefined) return show('warn', 'Counted, check at the end', `${id} · no signal: it is judged when you press Finish`);
      if (r === null) return show(false, 'Not in the register', `${id} · counted as found`);
      if (r.status === 'FG-RECEIVED') return show(true, `${r.part_no}  ·  ${fmtNum(r.qty)} NOS`, `${r.part_name} · ${id}${r.rack ? ' · rack ' + r.rack : ''}`);
      if (r.status === 'WIP-PACKED') return show('warn', 'Printed, never received into FG', `${r.part_no} · ${id} · counted. You can receive it when you finish`);
      return show(false, 'System says: ' + whyText(r).toLowerCase(), `${r.part_no} · ${id} · counted as found`);
    }

    async function count(raw, source) {
      const id = String(raw || '').trim().toUpperCase();
      const now = Date.now();
      if (source === 'camera' && id === last.id && (now - last.at < 3000 || now - last.seen < 1500)) { last.seen = now; return; }
      last = { id, at: now, seen: now };
      if (!BOX_RE.test(id)) return show(false, 'Not a Radiance box label', id.slice(0, 60));
      if (counted.has(id)) return show('warn', 'Already counted', id);
      counted.add(id);
      const t = read(KEY(uid)) || t0;
      t.scans.push({ id, at: new Date().toISOString() });
      write(KEY(uid), t);
      draw();
      let r = rowOf(id);
      if (r === undefined) { r = await lookup(id); if (!isCurrent()) return; }
      verdict(id, r);
      draw();
    }
    $(el, '#manual').addEventListener('submit', async (e) => { e.preventDefault(); const v = $(el, '#typed').value; if (!v.trim()) return; await count(v, 'typed'); $(el, '#typed').value = ''; $(el, '#typed').focus(); });

    const setCam = (on, text) => { $(el, '#start').hidden = on; $(el, '#stop').hidden = !on; $(el, '#vidmsg').textContent = text || ''; $(el, '#vidmsg').hidden = on; };
    $(el, '#start').addEventListener('click', async (e) => {
      e.target.disabled = true;
      try { scanner = await startScanner($(el, '#vid'), (text) => count(text, 'camera')); setCam(true); $(el, '#torch').hidden = !scanner.hasTorch; }
      catch (err) { setCam(false, err.message); show(false, 'Camera not started', err.message); }
      e.target.disabled = false;
    });
    let torchOn = false;
    $(el, '#torch').addEventListener('click', async () => { try { torchOn = !torchOn; await scanner.setTorch(torchOn); } catch (_) { toast('Torch not available on this phone', true); } });
    $(el, '#stop').addEventListener('click', () => { stopCam(); setCam(false, 'Camera is off'); });
    if (!cameraSupported()) setCam(false, 'This browser has no camera access here. Type the Box ID below.');

    $(el, '#rack').addEventListener('change', () => { const t = read(KEY(uid)) || t0; t.rack = $(el, '#rack').value.trim(); write(KEY(uid), t); });
    $(el, '#cancel').addEventListener('click', () => {
      const n = (read(KEY(uid)) || t0).scans.length;
      if (!confirm(`Cancel this count and forget the ${n} box${n === 1 ? '' : 'es'} scanned so far?`)) return;
      write(KEY(uid), null); write(SNAP(uid), null); startView();
    });
    $(el, '#finish').addEventListener('click', (e) => busy(e.target, async () => {
      const t = read(KEY(uid)) || t0;
      t.rack = $(el, '#rack').value.trim(); write(KEY(uid), t);
      if (!t.scans.length && !confirm('Nothing was scanned. Every box in FG would be reported as missing. Continue?')) return;
      stopCam();
      await resultView();
    }));
  }

  // ------------------------------------------------------------ result
  async function judge() {
    const t = read(KEY(uid));
    const ids = t.scans.map((s) => s.id);
    const [fg, found] = await Promise.all([
      api.selectAll('boxes', `select=${COLS}&status=eq.FG-RECEIVED&order=box_id`),
      (async () => { const out = []; for (const part of chunk(ids, 60)) out.push(...await api.selectAll('boxes', `select=${COLS}&box_id=in.(${part.join(',')})`)); return out; })(),
    ]);
    const byId = new Map(ids.map((id) => [id, null]));
    found.forEach((r) => byId.set(r.box_id, r));
    return { t, res: buildResult({ scanIds: ids, byId, fgRows: fg, rackStart: t.rack || '' }), at: new Date().toISOString() };
  }

  async function resultView() {
    let j;
    try { j = await judge(); }
    catch (e) {
      if (e.code === 'network') throw new Error('No connection. Your count is saved on this phone. Connect to the internet and press Finish again.');
      throw e;
    }
    if (!isCurrent()) return;
    unlisten();
    const { t, res, at } = j, T = res.totals;
    const scope = t.rack ? ` (racks starting with “${t.rack}”)` : '';
    const receivable = res.unexpected.filter((u) => u.receivable);
    const headline = T.clean
      ? msg('ok', `<b>The count matches the system${esc(scope)}:</b> ${fmtNum(T.matched)} boxes, ${fmtNum(T.cnt_qty)} NOS.`)
      : msg('warn', `<b>Counted ${fmtNum(t.scans.length)} boxes${esc(scope)}.</b> ${fmtNum(T.matched)} match the system. `
        + `<b>${fmtNum(T.missing)}</b> box${T.missing === 1 ? '' : 'es'} (${fmtNum(T.missing_qty)} NOS) the system has in FG ${T.missing === 1 ? 'was' : 'were'} not found. `
        + `<b>${fmtNum(T.unexpected)}</b> counted box${T.unexpected === 1 ? ' is' : 'es are'} not supposed to be in FG.`);

    el.innerHTML = `
    <h1>Stock take result</h1>
    <p class="sub"><b>${esc(t.name)}</b> · started ${esc(fmtTs(t.started))} · compared ${esc(fmtTs(at))}</p>
    ${headline}
    <div class="grid g2" style="margin:0 0 14px">
      <div class="stat"><b>${fmtNum(T.sys_boxes)}</b><span>boxes the system has in FG${esc(scope)} · ${fmtNum(T.sys_qty)} NOS</span></div>
      <div class="stat"><b>${fmtNum(t.scans.length)}</b><span>boxes counted · ${fmtNum(T.cnt_qty)} NOS</span></div>
      <div class="stat"><b>${fmtNum(T.missing)}</b><span>missing: in the system, not found</span></div>
      <div class="stat"><b>${fmtNum(T.unexpected)}</b><span>found, but the system says otherwise</span></div>
    </div>
    <div class="tabs" id="tabs">
      <button data-tab="summary" class="on">By part</button><button data-tab="missing">Missing (${fmtNum(T.missing)})</button>
      <button data-tab="unexpected">Not as expected (${fmtNum(T.unexpected)})</button><button data-tab="matched">Counted OK (${fmtNum(T.matched)})</button></div>
    <div id="pane"></div>
    <div class="actions" style="margin-top:14px">
      <button class="btn" id="xl">Download Excel</button>
      ${receivable.length ? `<button class="btn alt" id="recv">Receive ${fmtNum(receivable.length)} packed box${receivable.length === 1 ? '' : 'es'} into FG</button>` : ''}
      <button class="btn alt" id="back">Back to counting</button><button class="btn alt" id="close">Close this stock take</button></div>
    <p class="hint">To correct a missing box, void it in the Box register with the reason “stock take”. To fix a dispatched box found in the store, check its slip first (Box history shows every step).</p>`;

    const note = (n) => (n > SHOW_MAX ? `<p class="hint">Showing the first ${SHOW_MAX} of ${fmtNum(n)}. The Excel file has all of them.</p>` : '');
    const panes = {
      summary: () => {
        const rows = [...res.summary, { __t: true, part_no: 'TOTAL', part_name: '', sys_boxes: T.sys_boxes, sys_qty: T.sys_qty, cnt_boxes: T.cnt_boxes, cnt_qty: T.cnt_qty, diff_boxes: T.diff_boxes, diff_qty: T.diff_qty }];
        const b = (r, v) => (r.__t ? `<b>${esc(v)}</b>` : esc(v));
        const d = (r, k) => `<span class="${r[k] ? 'qbad' : ''}">${r.__t ? '<b>' : ''}${sign(r[k])}${r.__t ? '</b>' : ''}</span>`;
        return table([
          { label: 'Part no', html: (r) => b(r, r.part_no) }, { label: 'Part name', html: (r) => esc(r.part_name) },
          { label: 'System boxes', n: true, html: (r) => b(r, fmtNum(r.sys_boxes)) }, { label: 'System NOS', n: true, html: (r) => b(r, fmtNum(r.sys_qty)) },
          { label: 'Counted boxes', n: true, html: (r) => b(r, fmtNum(r.cnt_boxes)) }, { label: 'Counted NOS', n: true, html: (r) => b(r, fmtNum(r.cnt_qty)) },
          { label: 'Difference NOS', n: true, html: (r) => d(r, 'diff_qty') },
        ], rows, 'Nothing to compare.');
      },
      missing: () => table([
        { label: 'Box ID', cls: 'mono', html: (r) => histLink(r.box_id) }, { k: 'part_no', label: 'Part no' }, { k: 'part_name', label: 'Part name' },
        { k: 'qty', label: 'Qty', n: true, fmt: fmtNum }, { k: 'rack', label: 'Rack' }, { k: 'fg_at', label: 'In FG since', fmt: fmtTs },
      ], res.missing.slice(0, SHOW_MAX), 'Nothing is missing.') + note(res.missing.length),
      unexpected: () => table([
        { label: 'Box ID', cls: 'mono', html: (u) => histLink(u.box_id) }, { label: 'Part no', html: (u) => esc(u.row ? u.row.part_no : NOT_IN_REGISTER) },
        { label: 'Part name', html: (u) => esc(u.row ? u.row.part_name : '') }, { label: 'Qty', n: true, html: (u) => esc(u.row ? fmtNum(u.row.qty) : '') },
        { label: 'System says', html: (u) => `<span class="qbad">${esc(u.why)}</span>` }, { label: 'What to do', html: (u) => esc(u.receivable ? 'Can be received now' : 'Check this box') },
      ], res.unexpected.slice(0, SHOW_MAX), 'Every counted box is where the system expects it.') + note(res.unexpected.length),
      matched: () => table([
        { label: 'Box ID', cls: 'mono', html: (r) => histLink(r.box_id) }, { k: 'part_no', label: 'Part no' }, { k: 'part_name', label: 'Part name' },
        { k: 'qty', label: 'Qty', n: true, fmt: fmtNum }, { k: 'rack', label: 'Rack' },
      ], res.matched.slice(0, SHOW_MAX), 'Nothing counted.') + note(res.matched.length),
    };
    const pick = (k) => { $$(el, '#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === k)); $(el, '#pane').innerHTML = panes[k](); };
    $(el, '#tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) pick(b.dataset.tab); });
    pick(T.clean ? 'summary' : (T.missing ? 'missing' : 'unexpected'));

    $(el, '#xl').addEventListener('click', () => {
      const num = (v) => (v === null || v === undefined ? '' : v);
      downloadXlsx(`stock-take-${(t.name || 'count').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 40)}-${todayIst()}.xlsx`, [
        { name: 'Summary', widths: [16, 30, 13, 13, 14, 14, 16, 16], totalRow: true, rows: [
          ['Part no', 'Part name', 'System boxes', 'System NOS', 'Counted boxes', 'Counted NOS', 'Difference boxes', 'Difference NOS'],
          ...res.summary.map((p) => [p.part_no, p.part_name, p.sys_boxes, p.sys_qty, p.cnt_boxes, p.cnt_qty, p.diff_boxes, p.diff_qty]),
          ['TOTAL', '', T.sys_boxes, T.sys_qty, T.cnt_boxes, T.cnt_qty, T.diff_boxes, T.diff_qty]] },
        { name: 'Missing', widths: [18, 14, 30, 10, 10, 18], rows: [['Box ID', 'Part no', 'Part name', 'Qty', 'Rack', 'In FG since'],
          ...res.missing.map((r) => [r.box_id, r.part_no, r.part_name, r.qty, r.rack || '', r.fg_at ? { at: r.fg_at } : ''])] },
        { name: 'Not as expected', widths: [18, 14, 30, 10, 44, 24], rows: [['Box ID', 'Part no', 'Part name', 'Qty', 'System says', 'What to do'],
          ...res.unexpected.map((u) => [u.box_id, u.row ? u.row.part_no : NOT_IN_REGISTER, u.row ? u.row.part_name : '', u.row ? u.row.qty : '', u.why, u.receivable ? 'Can be received now' : 'Check this box'])] },
        { name: 'Counted OK', widths: [18, 14, 30, 10, 10], rows: [['Box ID', 'Part no', 'Part name', 'Qty', 'Rack'], ...res.matched.map((r) => [r.box_id, r.part_no, r.part_name, r.qty, r.rack || ''])] },
        { name: 'Info', widths: [24, 40], rows: [['Item', 'Value'], ['Name', t.name], ['Started', { at: t.started }], ['Compared', { at }], ['Counted by', me.full_name],
          ['Part of the store', t.rack ? `Racks starting with ${t.rack}` : 'Whole FG store'], ['Boxes counted', t.scans.length], ['Boxes the system has in FG', T.sys_boxes],
          ['Missing boxes', T.missing], ['Not as expected', T.unexpected], ['Result', T.clean ? 'Matches the system' : 'Differences found']].map((r) => r.map(num)) },
      ]);
    });
    const recv = $(el, '#recv');
    if (recv) recv.addEventListener('click', (e) => busy(e.target, async () => {
      if (!confirm(`Receive ${receivable.length} box${receivable.length === 1 ? '' : 'es'} into FG now? Do this only for boxes you saw in the store. They are dated now.`)) return;
      let done = 0, saved = 0, bad = 0;
      for (const u of receivable) {
        const o = await receiveOrQueue(u.box_id, '');
        if (o.queued) saved++; else if (o.r && o.r.ok) done++; else bad++;
      }
      toast(`${done} received${saved ? `, ${saved} saved to send later` : ''}${bad ? `, ${bad} refused` : ''}`, !!bad);
      await resultView();
    }));
    $(el, '#back').addEventListener('click', () => countView());
    $(el, '#close').addEventListener('click', () => {
      if (!confirm('Close this stock take and forget the count? Download the Excel file first if you want to keep the result.')) return;
      write(KEY(uid), null); write(SNAP(uid), null); startView();
    });
  }

  if (read(KEY(uid))) await countView(); else startView();
}
