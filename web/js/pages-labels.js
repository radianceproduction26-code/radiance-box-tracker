// Print labels + Box register
import * as api from './api.js';
import { CONFIG } from './config.js';
import { cleanPart } from './partmaster.js';
import { labelsHtml, printLabels, fitLabels, dmy } from './labels.js';
import { toCsv, download } from './sheet.js';
import { $, $$, esc, toast, busy, todayIst, addDays, fmtTs, fmtNum, msg, pill, table, q } from './ui.js';

const canPrint = (me) => ['assembly', 'admin'].includes(me.role);

// ---------------------------------------------------------------- Print labels
export async function printPage(el, { me, isCurrent }) {
  const [parts, packs] = await Promise.all([
    api.selectAll('parts', 'select=part_no,name,std_qty&active=eq.true&order=part_no'),
    api.selectAll('packing_options', 'select=part_no,std_qty,pp_box_code,tray_no&order=part_no,std_qty'),
  ]);
  if (!isCurrent()) return;
  const partMap = new Map(parts.map((p) => [p.part_no, p]));
  const packMap = new Map();
  packs.forEach((p) => { (packMap.get(p.part_no) || packMap.set(p.part_no, []).get(p.part_no)).push(p); });
  let last = null;

  el.innerHTML = `
  <h1>Print labels</h1>
  <p class="sub">Each label gets its own Box ID and QR. Labels are saved in the database the moment they print.</p>
  <form id="f" class="card" autocomplete="off">
    <div class="row">
      <div><label for="part">Part no</label><input id="part" required list="parts" inputmode="text" autofocus><datalist id="parts">${parts.map((p) => `<option value="${esc(p.part_no)}">${esc(p.name)}</option>`).join('')}</datalist></div>
      <div style="grid-column:span 2"><label for="name">Part name</label><input id="name" required></div>
    </div>
    <div class="row">
      <div><label for="std">Qty per box (NOS)</label><input id="std" type="number" min="1" step="1" required inputmode="numeric"><div class="chips" id="packs"></div></div>
      <div><label for="n">Number of boxes (1–200)</label><input id="n" type="number" min="1" max="200" step="1" value="1" required inputmode="numeric"></div>
      <div><label for="last">Last box qty <small>(optional)</small></label><input id="last" type="number" min="1" step="1" inputmode="numeric" placeholder="same as above"></div>
    </div>
    <div class="row">
      <div><label for="lot">Lot / batch</label><input id="lot"></div>
      <div><label for="date">Date</label><input id="date" type="date" required value="${todayIst()}"></div>
      <div><label for="qa">QA sign</label><input id="qa" value="${esc(me.full_name)}"></div>
    </div>
    <p class="hint" id="sum"></p>
    <div class="actions"><button class="btn" id="go">Create and print labels</button></div>
  </form>
  <div id="done"></div>`;

  const f = (id) => $(el, '#' + id);
  const sum = () => {
    const std = +f('std').value, n = +f('n').value, lastq = +f('last').value;
    if (!std || !n) { f('sum').textContent = ''; return; }
    const total = lastq && n >= 1 ? std * (n - 1) + lastq : std * n;
    const pk = (packMap.get(cleanPart(f('part').value)) || []).find((p) => p.std_qty === std);
    f('sum').textContent = `${n} label(s), total ${fmtNum(total)} NOS` + (pk && (pk.pp_box_code || pk.tray_no) ? ` · PP box ${pk.pp_box_code || '-'} · tray ${pk.tray_no || '-'}` : '');
  };
  let autoName = '', shown = '';
  const onPart = () => {
    const key = cleanPart(f('part').value);
    const p = partMap.get(key);
    if (p && (f('name').value === '' || f('name').value === autoName)) { f('name').value = p.name; autoName = p.name; }
    const list = packMap.get(key) || [];
    // Re-draw the chips only when they changed: a "change" event fires when the input loses focus on
    // mouse-down, and replacing the chip under the cursor at that moment would swallow the click.
    const sig = key + '|' + list.map((x) => x.std_qty).join(',');
    if (sig !== shown) {
      shown = sig;
      f('packs').innerHTML = list.map((x) => `<span class="chip" data-std="${x.std_qty}">${fmtNum(x.std_qty)}</span>`).join('');
    }
    if (list.length === 1 && !f('std').value) f('std').value = list[0].std_qty;
    else if (p && p.std_qty && !f('std').value) f('std').value = p.std_qty;
    sum();
  };
  f('part').addEventListener('change', onPart);
  f('part').addEventListener('input', () => { if (partMap.has(cleanPart(f('part').value))) onPart(); });
  el.addEventListener('click', (e) => { const c = e.target.closest('.chip[data-std]'); if (c) { f('std').value = c.dataset.std; sum(); } });
  ['std', 'n', 'last'].forEach((id) => f(id).addEventListener('input', sum));

  $(el, '#f').addEventListener('submit', (ev) => {
    ev.preventDefault();
    busy(f('go'), async () => {
      const n = +f('n').value;
      if (n > 20 && !confirm(`Create ${n} labels?`)) return;
      const rows = await api.rpc('create_boxes', {
        p_part_no: f('part').value, p_part_name: f('name').value, p_std_qty: +f('std').value, p_n: n,
        p_last_qty: f('last').value ? +f('last').value : null, p_lot: f('lot').value, p_label_date: f('date').value,
        p_qa_sign: f('qa').value, p_device: CONFIG.DEVICE,
      });
      last = rows;
      partMap.set(rows[0].part_no, { part_no: rows[0].part_no, name: rows[0].part_name, std_qty: +f('std').value });
      showDone();
      printLabels(rows);
    });
  });

  function showDone() {
    const first = last[0].box_id, lastId = last[last.length - 1].box_id;
    const total = last.reduce((s, b) => s + b.qty, 0);
    $(el, '#done').innerHTML = `<div class="card">
      ${msg('ok', `<b>${last.length} label(s) created</b> for ${esc(last[0].part_no)} — ${fmtNum(total)} NOS · ${esc(first)}${last.length > 1 ? ' to ' + esc(lastId) : ''}`)}
      <div class="actions"><button class="btn alt" id="again">Print these again</button>
      <span class="hint">If the printer jammed or labels came out wrong, use Print again. The same Box IDs are printed, no new ones are made.</span></div>
      <div class="preview">${labelsHtml(last.slice(0, 2))}</div></div>`;
    fitLabels($(el, '#done'));
    $(el, '#again').addEventListener('click', () => printLabels(last));
  }
}

// ---------------------------------------------------------------- Box register
export async function registerPage(el, { me, isCurrent }) {
  const st = { status: '', part: '', box: '', from: '', to: '', page: 0 };
  const PAGE = 50;
  const selected = new Set();
  const acts = canPrint(me);

  el.innerHTML = `
  <h1>Box register</h1>
  <form id="f" class="card"><div class="row">
    <div><label>Status</label><select id="status"><option value="">All</option><option>WIP-PACKED</option><option>FG-RECEIVED</option><option>DISPATCHED</option><option>VOID</option></select></div>
    <div><label>Part no contains</label><input id="part"></div>
    <div><label>Box ID contains</label><input id="box" placeholder="e.g. 00012"></div>
    <div><label>Label date from</label><input id="from" type="date"></div>
    <div><label>to</label><input id="to" type="date"></div>
  </div><div class="actions"><button class="btn">Search</button><button type="button" class="btn alt" id="csv">Download CSV</button></div></form>
  <div id="out"></div>`;

  const COLS = 'box_id,part_no,part_name,qty,status,source,lot,label_date,rack,slip_no,created_at,fg_at,out_at,seq';
  const query = () => {
    const p = ['select=' + COLS, 'order=seq.desc'];
    if (st.status) p.push('status=eq.' + encodeURIComponent(st.status));
    if (st.part) p.push('part_no=ilike.' + encodeURIComponent('*' + q(st.part) + '*'));
    if (st.box) p.push('box_id=ilike.' + encodeURIComponent('*' + q(st.box) + '*'));
    if (st.from) p.push('label_date=gte.' + st.from);
    if (st.to) p.push('label_date=lte.' + st.to);
    return p.join('&');
  };

  async function load() {
    const out = $(el, '#out');
    out.innerHTML = '<p class="hint">Loading…</p>';
    const { rows, total } = await api.selectPage('boxes', query(), st.page * PAGE, st.page * PAGE + PAGE - 1);
    if (!isCurrent()) return;
    const pages = Math.max(1, Math.ceil(total / PAGE));
    const cols = [
      ...(acts ? [{ label: '', html: (r) => (r.status === 'VOID' ? '' : `<input type="checkbox" class="sel" data-id="${esc(r.box_id)}" ${selected.has(r.box_id) ? 'checked' : ''} style="width:auto">`) }] : []),
      { k: 'box_id', label: 'Box ID', cls: 'mono' }, { k: 'part_no', label: 'Part no' }, { k: 'part_name', label: 'Part name' },
      { k: 'qty', label: 'Qty', n: true, fmt: fmtNum }, { label: 'Status', html: (r) => pill(r.status) + (r.source === 'OPENING' ? ' <small>opening</small>' : '') },
      { k: 'label_date', label: 'Label date', fmt: dmy }, { k: 'lot', label: 'Lot' }, { k: 'rack', label: 'Rack' },
      { k: 'fg_at', label: 'FG in', fmt: fmtTs }, { k: 'slip_no', label: 'Slip' }, { k: 'out_at', label: 'Out', fmt: fmtTs },
      ...(acts ? [{ label: '', html: (r) => (r.status === 'VOID' || r.status === 'DISPATCHED' ? '' : `<button class="btn sm danger" data-void="${esc(r.box_id)}">Void</button>`) }] : []),
    ];
    out.innerHTML = `
      <div class="actions" style="margin:0 0 8px"><b>${fmtNum(total)}</b> box(es)
        ${acts ? '<button class="btn sm alt" id="reprint">Reprint ticked labels</button>' : ''}
        <span style="flex:1"></span>
        <button class="btn sm alt" id="prev" ${st.page === 0 ? 'disabled' : ''}>Previous</button><span>Page ${st.page + 1} of ${pages}</span>
        <button class="btn sm alt" id="next" ${st.page + 1 >= pages ? 'disabled' : ''}>Next</button></div>
      ${table(cols, rows, 'No boxes match these filters.')}`;
  }

  $(el, '#f').addEventListener('submit', (e) => {
    e.preventDefault();
    Object.assign(st, { status: $(el, '#status').value, part: $(el, '#part').value, box: $(el, '#box').value, from: $(el, '#from').value, to: $(el, '#to').value, page: 0 });
    busy(null, load);
  });
  $(el, '#csv').addEventListener('click', (e) => busy(e.target, async () => {
    const rows = await api.selectAll('boxes', query());
    const head = ['Box ID', 'Part no', 'Part name', 'Qty', 'Status', 'Source', 'Lot', 'Label date', 'Rack', 'FG in', 'Slip', 'Out'];
    download(`box-register-${todayIst()}.csv`, toCsv([head, ...rows.map((r) => [r.box_id, r.part_no, r.part_name, r.qty, r.status, r.source, r.lot, dmy(r.label_date), r.rack, fmtTs(r.fg_at), r.slip_no, fmtTs(r.out_at)])]));
  }));

  el.addEventListener('click', (e) => {
    const t = e.target;
    if (t.id === 'prev') { st.page--; busy(null, load); }
    else if (t.id === 'next') { st.page++; busy(null, load); }
    else if (t.classList.contains('sel')) { t.checked ? selected.add(t.dataset.id) : selected.delete(t.dataset.id); }
    else if (t.id === 'reprint') {
      if (!selected.size) return toast('Tick the boxes to reprint first.', true);
      if (selected.size > 200) return toast('Reprint up to 200 labels at a time.', true);
      busy(t, async () => { const rows = await api.rpc('reprint_boxes', { p_box_ids: [...selected], p_device: CONFIG.DEVICE }); printLabels(rows); toast(`${rows.length} label(s) sent to printer`); });
    } else if (t.dataset.void) {
      const reason = prompt(`Void box ${t.dataset.void}? Enter the reason (required):`);
      if (!reason || !reason.trim()) return;
      busy(t, async () => {
        const r = await api.rpc('void_box', { p_box_id: t.dataset.void, p_reason: reason.trim(), p_device: CONFIG.DEVICE });
        if (r && r.ok === false) throw new Error(r.msg || 'Could not void this box');
        toast('Box voided'); selected.delete(t.dataset.void); await load();
      });
    }
  });
  await load();
}
