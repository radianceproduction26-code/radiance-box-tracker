// FG inward scan (store, admin): camera or typed Box ID -> receive_box
import * as api from './api.js';
import { CONFIG } from './config.js';
import { startScanner, beep, cameraSupported } from './scanner.js';
import { $, esc, toast, fmtNum, fmtTs, table } from './ui.js';

const BOX_RE = /^RP-\d{6}-\d{5,}$/;
const lsGet = (k) => { try { return localStorage.getItem(k) || ''; } catch (_) { return ''; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* ignore */ } };

export async function inwardPage(el, { me, isCurrent }) {
  const COLS = 'box_id,part_no,part_name,qty,rack,fg_at';
  const [mine, transit] = await Promise.all([
    api.selectPage('boxes', `select=${COLS}&fg_by=eq.${me.user_id}&source=eq.LABEL&order=fg_at.desc`, 0, 19),
    api.selectPage('boxes', 'select=box_id&status=eq.WIP-PACKED', 0, 0),
  ]);
  if (!isCurrent()) return;
  let scans = mine.rows, inTransit = transit.total, scanner = null, last = { id: '', at: 0, seen: 0 }, busy = false;

  el.innerHTML = `
  <h1>FG inward</h1>
  <p class="sub">Scan the QR on each box as it arrives in the store. Green = received. Red = read the reason.</p>
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
    </div>
  </div>
  <h2>Your last 20 scans</h2><div id="list"></div>`;

  const drawList = () => { $(el, '#list').innerHTML = table([
    { k: 'fg_at', label: 'Time', fmt: fmtTs }, { k: 'box_id', label: 'Box ID', cls: 'mono' }, { k: 'part_no', label: 'Part no' },
    { k: 'part_name', label: 'Part name' }, { k: 'qty', label: 'Qty', n: true, fmt: fmtNum }, { k: 'rack', label: 'Rack' },
  ], scans, 'No scans yet.'); $(el, '#n-mine').textContent = fmtNum(scans.length); };
  drawList();

  const show = (ok, title, detail) => {
    const r = $(el, '#result');
    r.className = 'result ' + (ok ? 'ok' : 'bad');
    r.innerHTML = `<b>${esc(title)}</b><span>${esc(detail || '')}</span>`;
    beep(ok);
  };

  async function receive(raw, source) {
    const id = String(raw || '').trim().toUpperCase();
    const t = Date.now();
    if (source === 'camera' && id === last.id && (t - last.at < 3000 || t - last.seen < 1500)) { last.seen = t; return; }   // same box still in front of the camera
    if (busy) return;
    last = { id, at: t, seen: t };
    if (!BOX_RE.test(id)) { show(false, 'Not a Radiance box label', id.slice(0, 60)); return; }
    busy = true;
    lsSet('rbt.rack', $(el, '#rack').value.trim());
    try {
      const r = await api.rpc('receive_box', { p_box_id: id, p_rack: $(el, '#rack').value.trim() || null, p_device: CONFIG.DEVICE });
      if (!isCurrent()) return;
      if (r.ok) {
        const b = r.box;
        show(true, `${b.part_no}  ·  ${fmtNum(b.qty)} NOS`, `${b.part_name} · ${id}${b.rack ? ' · rack ' + b.rack : ''}`);
        scans = [{ box_id: id, part_no: b.part_no, part_name: b.part_name, qty: b.qty, rack: b.rack, fg_at: b.fg_at }, ...scans].slice(0, 20);
        inTransit = Math.max(0, inTransit - 1); $(el, '#n-transit').textContent = fmtNum(inTransit);
        drawList();
      } else show(false, 'Not received', r.msg);
    } catch (e) {
      if (e.code === 'expired' || e.code === 'no_session') { location.hash = '#/'; location.reload(); return; }
      show(false, 'Not received', e.code === 'network' ? 'No connection. This box was NOT saved. Scan it again when the connection is back.' : e.message);
    } finally { busy = false; }
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
