// FG inward scan (store, admin): camera or typed Box ID -> receive_box.
// No signal? The scan is kept on the phone and sent when the connection is back (offline.js).
import * as api from './api.js';
import { startScanner, beep, cameraSupported } from './scanner.js';
import { receiveOrQueue, subscribe, waiting, problems, all as queueAll, dismiss, flush, isOnline, persisted } from './offline.js';
import { $, esc, toast, fmtNum, fmtTs, table } from './ui.js';

const BOX_RE = /^RP-\d{6}-\d{5,}$/;
const lsGet = (k) => { try { return localStorage.getItem(k) || ''; } catch (_) { return ''; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* ignore */ } };

export async function inwardPage(el, { me, isCurrent }) {
  const COLS = 'box_id,part_no,part_name,qty,rack,fg_at';
  const loadLists = () => Promise.all([
    api.selectPage('boxes', `select=${COLS}&fg_by=eq.${me.user_id}&source=eq.LABEL&order=fg_at.desc`, 0, 19),
    api.selectPage('boxes', 'select=box_id&status=eq.WIP-PACKED', 0, 0),
  ]);
  let mine, transit;
  try { [mine, transit] = await loadLists(); }
  catch (e) {
    if (e.code !== 'network') throw e;
    mine = { rows: [] }; transit = { total: 0 };   // opened with no signal: scanning still works, the lists fill in later
  }
  if (!isCurrent()) return;
  let scans = mine.rows, inTransit = transit.total, scanner = null, last = { id: '', at: 0, seen: 0 };
  const inflight = new Set();   // boxes being sent right now. A slow connection must not make the NEXT box wait (or be missed): only the same box is held back

  el.innerHTML = `
  <h1>FG inward <span id="net" class="pill"></span></h1>
  <p class="sub">Scan the QR on each box as it arrives in the store. Green = received. Red = read the reason. Amber = no signal, saved on this phone and sent later.</p>
  <div class="scanwrap">
    <div class="card">
      <div class="row" style="margin-bottom:8px"><div><label for="rack">Rack / location (optional, kept for the next scans)</label><input id="rack" value="${esc(lsGet('rbt.rack'))}" maxlength="20" autocomplete="off"></div></div>
      <div class="vid"><video id="vid" playsinline muted></video><div class="vidmsg" id="vidmsg">Camera is off</div></div>
      <div id="result" class="result idle" aria-live="assertive"><b>Ready</b><span>Scan a box label.</span></div>
      <div class="actions"><button class="btn" id="start">Start camera</button><button class="btn alt" id="torch" hidden>Torch</button><button class="btn alt" id="stop" hidden>Stop</button></div>
      <form id="manual" class="actions" style="margin-top:12px;flex-wrap:nowrap" autocomplete="off">
        <input id="typed" placeholder="Or type the Box ID, e.g. RP-261101-00012" style="flex:1" autocapitalize="characters" spellcheck="false"><button class="btn alt" id="typedgo">Receive</button></form>
    </div>
    <div>
      <div class="grid g2" style="margin:0 0 12px"><div class="stat"><b id="n-transit">${fmtNum(inTransit)}</b><span>boxes packed, not yet received (in transit)</span></div>
        <div class="stat"><b id="n-mine">${fmtNum(scans.length)}</b><span>shown below: your last scans</span></div></div>
      <div class="card" id="qcard" hidden>
        <h2 style="margin:0 0 4px">Saved on this phone <span id="qn"></span></h2>
        <p class="hint" id="qhint" style="margin:0 0 10px"></p>
        <div id="qlist"></div>
        <div class="actions" style="margin-top:10px"><button class="btn alt" id="sendnow">Send now</button></div>
      </div>
    </div>
  </div>
  <h2>Your last 20 scans</h2><div id="list"></div>`;

  const drawList = () => { $(el, '#list').innerHTML = table([
    { k: 'fg_at', label: 'Time', fmt: fmtTs }, { k: 'box_id', label: 'Box ID', cls: 'mono' }, { k: 'part_no', label: 'Part no' },
    { k: 'part_name', label: 'Part name' }, { k: 'qty', label: 'Qty', n: true, fmt: fmtNum }, { k: 'rack', label: 'Rack' },
  ], scans, 'No scans yet.'); $(el, '#n-mine').textContent = fmtNum(scans.length); };
  drawList();

  const show = (kind, title, detail) => {   // kind: true = green, false = red, 'warn' = amber (saved on the phone)
    const r = $(el, '#result');
    r.className = 'result ' + (kind === 'warn' ? 'warn' : kind ? 'ok' : 'bad');
    r.innerHTML = `<b>${esc(title)}</b><span>${esc(detail || '')}</span>`;
    beep(kind !== false);
  };

  // ---- scans waiting on this phone
  const statusText = (i) => (i.status === 'rejected' ? i.msg : i.status === 'sending' ? 'Sending…' : i.msg || 'Waiting for signal');
  function drawQueue() {
    const q = queueAll(), w = waiting().length, bad = problems().length;
    const net = $(el, '#net');
    net.className = 'pill ' + (isOnline() ? 'online' : 'offline');
    net.textContent = isOnline() ? 'Online' : 'No signal';
    $(el, '#qcard').hidden = !q.length;
    $(el, '#qn').textContent = q.length ? `(${fmtNum(q.length)})` : '';
    $(el, '#qhint').textContent = (w ? 'These scans are kept on this phone and are sent by themselves when the connection is back, with the time you scanned them. ' : '')
      + (bad ? 'Boxes marked "not accepted" were refused by the server: check the box, then remove the line. ' : '')
      + (!persisted() ? 'This browser tab cannot store them: do not close the page until they are sent.' : '');
    $(el, '#sendnow').hidden = !w;
    $(el, '#qlist').innerHTML = table([
      { label: 'Scanned', html: (i) => esc(fmtTs(i.at)) },
      { label: 'Box ID', cls: 'mono', html: (i) => esc(i.box_id) },
      { label: 'Status', html: (i) => `<span class="${i.status === 'rejected' ? 'qbad' : ''}">${esc(statusText(i))}</span>` },
      { label: '', html: (i) => (i.status === 'rejected' ? `<button class="btn alt" data-rm="${esc(i.n)}">Remove</button>` : '') },
    ], q, 'Nothing is waiting.');
  }
  $(el, '#qlist').addEventListener('click', (e) => { const b = e.target.closest('[data-rm]'); if (b) dismiss(b.dataset.rm); });
  $(el, '#sendnow').addEventListener('click', () => { flush(); toast('Trying to send…'); });
  const unsub = subscribe(async (ev) => {
    if (!isCurrent()) { unsub(); return; }
    drawQueue();
    if (ev && (ev.sent || ev.dup)) {   // saved scans reached the server: show them in the list
      try { const [m, t] = await loadLists(); if (!isCurrent()) return; scans = m.rows; inTransit = t.total; $(el, '#n-transit').textContent = fmtNum(inTransit); drawList(); } catch (_) { /* next time */ }
    }
  });
  drawQueue();

  async function receive(raw, source) {
    const id = String(raw || '').trim().toUpperCase();
    const t = Date.now();
    if (source === 'camera' && id === last.id && (t - last.at < 3000 || t - last.seen < 1500)) { last.seen = t; return; }   // same box still in front of the camera
    if (inflight.has(id)) return;
    last = { id, at: t, seen: t };
    if (!BOX_RE.test(id)) { show(false, 'Not a Radiance box label', id.slice(0, 60)); return; }
    inflight.add(id);
    lsSet('rbt.rack', $(el, '#rack').value.trim());
    try {
      const out = await receiveOrQueue(id, $(el, '#rack').value.trim());
      if (!isCurrent()) return;
      if (out.queued) {
        show('warn', out.already ? 'Already saved on this phone' : 'Saved on this phone', `${id} · ${out.already ? 'waiting to be sent' : 'no signal: it will be sent when the connection is back'}`);
        drawQueue();
        return;
      }
      const r = out.r;
      if (r.ok) {
        const b = r.box;
        show(true, `${b.part_no}  ·  ${fmtNum(b.qty)} NOS`, `${b.part_name} · ${id}${b.rack ? ' · rack ' + b.rack : ''}`);
        scans = [{ box_id: id, part_no: b.part_no, part_name: b.part_name, qty: b.qty, rack: b.rack, fg_at: b.fg_at }, ...scans].slice(0, 20);
        inTransit = Math.max(0, inTransit - 1); $(el, '#n-transit').textContent = fmtNum(inTransit);
        drawList();
      } else show(false, 'Not received', r.msg);
    } catch (e) {
      if (e.code === 'expired' || e.code === 'no_session') { location.hash = '#/'; location.reload(); return; }
      show(false, 'Not received', e.message);
    } finally { inflight.delete(id); }
  }

  $(el, '#manual').addEventListener('submit', async (e) => { e.preventDefault(); const v = $(el, '#typed').value; if (!v.trim()) return; await receive(v, 'typed'); $(el, '#typed').value = ''; $(el, '#typed').focus(); });

  const setCam = (on, msg) => { $(el, '#start').hidden = on; $(el, '#stop').hidden = !on; $(el, '#vidmsg').textContent = msg || ''; $(el, '#vidmsg').hidden = on; };
  $(el, '#start').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      scanner = await startScanner($(el, '#vid'), (text) => receive(text, 'camera'));
      setCam(true); $(el, '#torch').hidden = !scanner.hasTorch;
    } catch (err) { setCam(false, err.message); show(false, 'Camera not started', err.message); }
    e.target.disabled = false;
  });
  let torchOn = false;
  $(el, '#torch').addEventListener('click', async () => { try { torchOn = !torchOn; await scanner.setTorch(torchOn); } catch (_) { toast('Torch not available on this phone', true); } });
  $(el, '#stop').addEventListener('click', () => { if (scanner) scanner.stop(); scanner = null; setCam(false, 'Camera is off'); });
  window.addEventListener('hashchange', () => { if (scanner) { scanner.stop(); scanner = null; } }, { once: true });
  if (!cameraSupported()) setCam(false, 'This browser has no camera access here. Type the Box ID below.');
}
