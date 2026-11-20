// Reports (Phase 5): day summary, stock ledger, stock on a date, ageing, voids, box history, and the per-date lists.
// Each report is built by a function that returns { html, sheets, file }:
//   html   what is shown on screen
//   sheets what goes to Excel (every sheet) and CSV (first sheet). Cells may be { date } / { at } objects, see xlsx.js.
import * as api from './api.js';
import { toCsv, download } from './sheet.js';
import { downloadXlsx } from './xlsx.js';
import { $, esc, toast, busy, todayIst, addDays, fmtTs, fmtNum, fmtDay, msg, table, pill, q } from './ui.js';

const MAX_DAYS = 366;
const SHOW_LIMIT = 300;   // longest box list drawn on screen (Excel / CSV always get every row)

const sum = (rows, k) => rows.reduce((s, r) => s + Number(r[k] || 0), 0);
const dayList = (from, to) => { const out = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push(d); return out; };
const spanDays = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
const weekday = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
const monthStart = (iso) => iso.slice(0, 8) + '01';
const plain = (v) => (v && typeof v === 'object' ? (v.date !== undefined ? fmtDay(v.date) : v.at !== undefined ? fmtTs(v.at) : v.text ?? '') : v);

function ageHours(ts, now) { return Math.max(0, Math.floor((now - Date.parse(ts)) / 3600000)); }
function ageText(ts, now) { const h = ageHours(ts, now), d = Math.floor(h / 24); return d ? `${d} d ${h % 24} h` : `${h} h`; }

function checkPeriod(st) {
  if (!st.from || !st.to) throw new Error('Choose both dates.');
  if (st.from > st.to) throw new Error('"From" is after "To".');
  if (spanDays(st.from, st.to) + 1 > MAX_DAYS) throw new Error(`Choose at most ${MAX_DAYS} days at a time.`);
}

// A numeric column that turns bold on the TOTAL row.
const numCol = (k, label, f = fmtNum) => ({ label, n: true, html: (r) => (r[k] === '' || r[k] === undefined ? '' : r.total ? `<b>${esc(f(r[k]))}</b>` : esc(f(r[k]))) });
const dayCol = { label: 'Date', html: (r) => (r.total ? '<b>TOTAL</b>' : `${esc(fmtDay(r.day))} <small style="color:var(--mute)">${weekday(r.day)}</small>`) };

// ---------------------------------------------------------------- Day summary
async function buildSummary(st) {
  checkPeriod(st);
  const [rows, base, voided] = await Promise.all([
    api.rpc('stock_ledger', { p_from: st.from, p_to: st.to }),
    api.rpc('stock_as_on', { p_day: addDays(st.from, -1) }),
    api.selectAll('box_trace', `select=day,qty&event=eq.VOIDED&day=gte.${st.from}&day=lte.${st.to}`),
  ]);
  const vq = new Map();   // NOS voided on each day (box in any state), counted on the day of the void
  voided.forEach((v) => { vq.set(v.day, (vq.get(v.day) || 0) + Number(v.qty)); });
  // Stock at the end of each day, all parts together: start from the stock before the period and carry each part forward.
  const fg = new Map(base.map((r) => [r.part_no, Number(r.fg_qty)]));
  const wip = new Map(base.map((r) => [r.part_no, Number(r.wip_qty)]));
  const by = new Map();
  rows.forEach((r) => { (by.get(r.day) || by.set(r.day, []).get(r.day)).push(r); });
  const add = (m) => [...m.values()].reduce((s, v) => s + v, 0);
  const days = dayList(st.from, st.to).map((day) => {
    const rs = by.get(day) || [];
    rs.forEach((r) => { fg.set(r.part_no, Number(r.fg_close)); wip.set(r.part_no, Number(r.wip_close)); });
    return {
      day, out_b: sum(rs, 'out_boxes'), out_q: sum(rs, 'out_qty'), in_b: sum(rs, 'in_boxes'), in_q: sum(rs, 'in_qty'),
      disp_b: sum(rs, 'disp_boxes'), disp_q: sum(rs, 'disp_qty'), void_q: vq.get(day) || 0, fg: add(fg), wip: add(wip),
    };
  });
  const tot = { total: true, out_b: sum(days, 'out_b'), out_q: sum(days, 'out_q'), in_b: sum(days, 'in_b'), in_q: sum(days, 'in_q'), disp_b: sum(days, 'disp_b'), disp_q: sum(days, 'disp_q'), void_q: sum(days, 'void_q'), fg: '', wip: '' };
  // Short headings on screen so the stock columns stay visible; Excel / CSV carry the long headings below.
  const cols = [dayCol, numCol('out_b', 'Out boxes'), numCol('out_q', 'Out NOS'), numCol('in_b', 'FG in boxes'), numCol('in_q', 'FG in NOS'),
    numCol('disp_b', 'Disp. boxes'), numCol('disp_q', 'Disp. NOS'), numCol('void_q', 'Voided NOS'), numCol('fg', 'FG stock'), numCol('wip', 'Packed, not in FG')];
  const head = ['Date', 'Assembly out boxes', 'Assembly out NOS', 'FG inward boxes', 'FG inward NOS', 'Dispatched boxes', 'Dispatched NOS', 'Voided NOS', 'FG stock at day end (NOS)', 'Packed, not in FG at day end (NOS)'];
  const xl = (d) => [{ date: d.day }, d.out_b, d.out_q, d.in_b, d.in_q, d.disp_b, d.disp_q, d.void_q, d.fg, d.wip];
  return {
    file: `day-summary-${st.from}-to-${st.to}`,
    html: `<p class="hint" style="margin:0 0 10px">This shows what was recorded on each day (quantities in NOS). <b>Out</b> (assembly out) = labels printed (a box voided later is still counted on the day it was printed, and shows under <b>Voided</b> on the day it was cancelled). <b>FG in</b> (inward) = boxes scanned into the store. <b>Disp.</b> (dispatched) = boxes put on a packing slip (a dispatch cancelled later by voiding the slip stays on its own day; the boxes return to FG on the day of the void). <b>FG stock</b> and <b>Packed, not in FG</b> are rebuilt from each box's history, so they are what the stock was at the end of that day. The “Per-date lists” tab leaves voided boxes out, so its totals can be smaller.</p>
      <div id="rep">${table(cols, [...days, tot], 'No records in this period.')}</div>`,
    sheets: [{ name: 'Day summary', rows: [head, ...days.map(xl), ['TOTAL', tot.out_b, tot.out_q, tot.in_b, tot.in_q, tot.disp_b, tot.disp_q, tot.void_q, '', '']], totalRow: true }],
  };
}

// ---------------------------------------------------------------- Stock ledger
async function buildLedger(st) {
  checkPeriod(st);
  let rows = await api.rpc('stock_ledger', { p_from: st.from, p_to: st.to });
  const f = (st.part || '').trim().toLowerCase();
  if (f) rows = rows.filter((r) => r.part_no.toLowerCase().includes(f) || (r.part_name || '').toLowerCase().includes(f));
  const tot = { total: true, day: '', part_no: '', part_name: '', fg_open: '', out_qty: sum(rows, 'out_qty'), in_qty: sum(rows, 'in_qty'), disp_qty: sum(rows, 'disp_qty'), other_qty: sum(rows, 'other_qty'), fg_close: '', wip_close: '' };
  const signed = (n) => (n > 0 ? '+' + fmtNum(n) : fmtNum(n));
  const cols = [
    dayCol, { label: 'Part no', cls: 'mono', html: (r) => esc(r.part_no) }, { label: 'Part name', html: (r) => esc(r.part_name) },
    numCol('fg_open', 'FG opening'), numCol('out_qty', 'Assembly out'), numCol('in_qty', 'FG inward'), numCol('disp_qty', 'Dispatched'),
    numCol('other_qty', 'Other (+/−)', signed), numCol('fg_close', 'FG closing'), numCol('wip_close', 'Packed, not in FG'),
  ];
  const head = ['Date', 'Part no', 'Part name', 'FG opening', 'Assembly out', 'FG inward', 'Dispatched', 'Other (+/-)', 'FG closing', 'Packed, not in FG (closing)'];
  const xl = (r) => [{ date: r.day }, { text: r.part_no }, r.part_name, r.fg_open, r.out_qty, r.in_qty, r.disp_qty, r.other_qty, r.fg_close, r.wip_close];
  return {
    file: `stock-ledger-${st.from}-to-${st.to}`,
    html: `<p class="hint" style="margin:0 0 10px">One line for every part that moved on a day (quantities in NOS). <b>FG opening + FG inward + Other − Dispatched = FG closing.</b>
      <b>Other</b> = opening stock added, boxes put back in FG when a slip is voided, boxes voided while in FG. “Packed, not in FG” = labels printed but not yet scanned into the store.</p>
      <div id="rep">${table(cols, rows.length ? [...rows, tot] : [], 'No stock movement in this period.')}</div>`,
    sheets: [{ name: 'Stock ledger', rows: [head, ...rows.map(xl), ['TOTAL', '', '', '', tot.out_qty, tot.in_qty, tot.disp_qty, tot.other_qty, '', '']], totalRow: true }],
  };
}

// ---------------------------------------------------------------- Stock on a date
async function buildAsOn(st) {
  if (!st.on) throw new Error('Choose the date.');
  const rows = await api.rpc('stock_as_on', { p_day: st.on });
  const tot = { total: true, part_no: 'TOTAL', part_name: '', fg_qty: sum(rows, 'fg_qty'), fg_boxes: sum(rows, 'fg_boxes'), wip_qty: sum(rows, 'wip_qty'), wip_boxes: sum(rows, 'wip_boxes') };
  const cols = [
    { label: 'Part no', cls: 'mono', html: (r) => (r.total ? '<b>TOTAL</b>' : esc(r.part_no)) }, { label: 'Part name', html: (r) => esc(r.part_name) },
    numCol('fg_qty', 'FG stock NOS'), numCol('fg_boxes', 'FG boxes'), numCol('wip_qty', 'Packed, not in FG NOS'), numCol('wip_boxes', 'Packed boxes'),
  ];
  const head = ['Part no', 'Part name', 'FG stock NOS', 'FG boxes', 'Packed, not in FG NOS', 'Packed boxes'];
  return {
    file: `stock-on-${st.on}`,
    html: `<p class="hint" style="margin:0 0 10px">Stock at the <b>end of ${esc(fmtDay(st.on))}</b> (India time), rebuilt from every box's history. Use it for month-end counts and audits.</p>
      <div id="rep">${table(cols, rows.length ? [...rows, tot] : [], 'No stock on this date.')}</div>`,
    sheets: [{ name: `Stock on ${fmtDay(st.on)}`, rows: [head, ...rows.map((r) => [{ text: r.part_no }, r.part_name, r.fg_qty, r.fg_boxes, r.wip_qty, r.wip_boxes]), ['TOTAL', '', tot.fg_qty, tot.fg_boxes, tot.wip_qty, tot.wip_boxes]], totalRow: true }],
  };
}

// ---------------------------------------------------------------- Ageing
function agingBlock(title, note, boxes, tsKey, now, extra) {
  const byPart = new Map();
  boxes.forEach((b) => {
    const p = byPart.get(b.part_no) || { part_no: b.part_no, part_name: b.part_name, boxes: 0, qty: 0, oldest: b[tsKey] };
    p.boxes += 1; p.qty += Number(b.qty);
    if (Date.parse(b[tsKey]) < Date.parse(p.oldest)) p.oldest = b[tsKey];
    byPart.set(b.part_no, p);
  });
  const parts = [...byPart.values()].sort((a, c) => Date.parse(a.oldest) - Date.parse(c.oldest));
  const sumCols = [
    { label: 'Part no', cls: 'mono', html: (r) => esc(r.part_no) }, { label: 'Part name', html: (r) => esc(r.part_name) },
    { label: 'Boxes', n: true, html: (r) => esc(fmtNum(r.boxes)) }, { label: 'NOS', n: true, html: (r) => esc(fmtNum(r.qty)) },
    { label: 'Oldest', html: (r) => esc(fmtTs(r.oldest)) }, { label: 'Waiting', html: (r) => esc(ageText(r.oldest, now)) },
  ];
  const boxCols = [
    { label: 'Box ID', cls: 'mono', html: (r) => `<a href="#/reports?tab=history&box=${encodeURIComponent(r.box_id)}">${esc(r.box_id)}</a>` },
    { label: 'Part no', html: (r) => esc(r.part_no) }, { label: 'Part name', html: (r) => esc(r.part_name) }, { label: 'Qty', n: true, html: (r) => esc(fmtNum(r.qty)) },
    { label: extra.tsLabel, html: (r) => esc(fmtTs(r[tsKey])) }, { label: 'Waiting', html: (r) => esc(ageText(r[tsKey], now)) },
    { label: extra.extraLabel, html: (r) => esc(r[extra.extraKey] || '') },
  ];
  const head = ['Box ID', 'Part no', 'Part name', 'Qty', extra.tsLabel, 'Waiting (days)', extra.extraLabel];
  const sheet = {
    name: title,
    rows: [head, ...boxes.map((b) => [b.box_id, { text: b.part_no }, b.part_name, Number(b.qty), { at: b[tsKey] }, Math.round((ageHours(b[tsKey], now) / 24) * 10) / 10, b[extra.extraKey] || ''])],
  };
  const html = `<div class="card"><h2 style="margin-top:0">${esc(title)}: ${fmtNum(boxes.length)} box(es), ${fmtNum(sum(boxes, 'qty'))} NOS</h2>
    <p class="hint" style="margin:0 0 10px">${esc(note)}</p>
    ${boxes.length ? `<h3 style="margin:12px 0 6px;font-size:15px">By part</h3>${table(sumCols, parts)}
      <h3 style="margin:16px 0 6px;font-size:15px">Boxes, oldest first${boxes.length > SHOW_LIMIT ? ` (first ${SHOW_LIMIT} of ${fmtNum(boxes.length)}; Excel has all)` : ''}</h3>${table(boxCols, boxes.slice(0, SHOW_LIMIT))}` : msg('ok', 'Nothing waiting. All good.')}</div>`;
  return { html, sheet };
}

async function buildAging(st) {
  const now = Date.now();
  const hrs = Number(st.hrs), days = Number(st.days);
  const packedCut = new Date(now - hrs * 3600000).toISOString(), fgCut = new Date(now - days * 86400000).toISOString();
  const [packed, fg] = await Promise.all([
    api.selectAll('boxes', `select=box_id,part_no,part_name,qty,created_at,lot&status=eq.WIP-PACKED&created_at=lt.${encodeURIComponent(packedCut)}&order=created_at`),
    api.selectAll('boxes', `select=box_id,part_no,part_name,qty,fg_at,rack&status=eq.FG-RECEIVED&fg_at=lt.${encodeURIComponent(fgCut)}&order=fg_at`),
  ]);
  const hl = hrs >= 48 && hrs % 24 === 0 ? `${hrs / 24} days` : `${hrs} hours`;
  const a = agingBlock('Packed, not received in FG', `Label printed more than ${hl} ago, but the box has not been scanned into the store. It may be lost, still on the shop floor, or forgotten at FG inward.`, packed, 'created_at', now, { tsLabel: 'Label printed', extraLabel: 'Lot', extraKey: 'lot' });
  const b = agingBlock('In FG for a long time', `In the store for more than ${days} days. The oldest boxes should leave first (FIFO).`, fg, 'fg_at', now, { tsLabel: 'In FG since', extraLabel: 'Rack', extraKey: 'rack' });
  return { file: `ageing-${todayIst()}`, html: `<div id="rep">${a.html}${b.html}</div>`, sheets: [a.sheet, b.sheet] };
}

// ---------------------------------------------------------------- Voids
const EVENT_TEXT = { CREATED: 'Label printed', OPENING: 'Opening stock', RECEIVED: 'Received in FG', DISPATCHED: 'Dispatched', VOIDED: 'Box voided', REPRINTED: 'Label reprinted', SLIP_VOIDED: 'Slip voided, box back in FG' };

async function buildVoids(st) {
  checkPeriod(st);
  const rows = await api.selectAll('box_trace', `select=*&event=in.(VOIDED,SLIP_VOIDED)&day=gte.${st.from}&day=lte.${st.to}&order=at.desc,id.desc`);
  const v = rows.filter((r) => r.event === 'VOIDED'), s = rows.filter((r) => r.event === 'SLIP_VOIDED');
  const cols = [
    { label: 'When', html: (r) => esc(fmtTs(r.at)) }, { label: 'What', html: (r) => esc(EVENT_TEXT[r.event] || r.event) },
    { label: 'Box ID', cls: 'mono', html: (r) => `<a href="#/reports?tab=history&box=${encodeURIComponent(r.box_id)}">${esc(r.box_id)}</a>` },
    { label: 'Part no', html: (r) => esc(r.part_no) }, { label: 'Part name', html: (r) => esc(r.part_name) }, { label: 'Qty', n: true, html: (r) => esc(fmtNum(r.qty)) },
    { label: 'Reason / slip', html: (r) => esc(r.note || '') }, { label: 'By', html: (r) => esc(r.by_name || '') }, { label: 'From', html: (r) => esc(r.device || '') },
  ];
  const head = ['When', 'What', 'Box ID', 'Part no', 'Part name', 'Qty', 'Reason / slip', 'By', 'From'];
  return {
    file: `voids-${st.from}-to-${st.to}`,
    html: `<p class="hint" style="margin:0 0 10px">Every box voided and every packing slip voided in the period. Who did it is shown to the admin only.</p>
      <div class="grid g2" style="margin-bottom:12px"><div class="stat"><b>${fmtNum(v.length)}</b><span>boxes voided (${fmtNum(sum(v, 'qty'))} NOS)</span></div>
      <div class="stat"><b>${fmtNum(s.length)}</b><span>boxes put back in FG by voiding a slip (${fmtNum(sum(s, 'qty'))} NOS)</span></div></div>
      <div id="rep">${table(cols, rows, 'No voids in this period.')}</div>`,
    sheets: [{ name: 'Voids', rows: [head, ...rows.map((r) => [{ at: r.at }, EVENT_TEXT[r.event] || r.event, r.box_id, { text: r.part_no }, r.part_name, r.qty, r.note || '', r.by_name || '', r.device || ''])] }],
  };
}

// ---------------------------------------------------------------- Box history
async function buildHistory(st) {
  const raw = (st.box || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!raw) return { html: msg('warn', 'Type or paste a Box ID (like RP-261116-00012), or only its last digits (like 12), then press Show.'), sheets: [] };
  const filter = /^\d{1,5}$/.test(raw) ? 'box_id=ilike.' + encodeURIComponent('*-' + raw.padStart(5, '0')) : 'box_id=eq.' + encodeURIComponent(q(raw));
  const boxes = await api.selectAll('boxes', `select=box_id,part_no,part_name,qty,status,source,lot,label_date,rack,slip_no,created_at&${filter}&order=seq&limit=1`);
  if (!boxes.length) return { html: msg('bad', `No box <b>${esc(raw)}</b> in the register. Check the Box ID printed on the label.`), sheets: [] };
  const b = boxes[0];
  const ev = await api.selectAll('box_trace', `select=*&box_id=eq.${encodeURIComponent(b.box_id)}&order=at,id`);
  const f = (label, html) => `<div><label>${label}</label><div>${html || '<span style="color:var(--mute)">—</span>'}</div></div>`;
  const cols = [
    { label: 'When', html: (r) => esc(fmtTs(r.at)) }, { label: 'What happened', html: (r) => esc(EVENT_TEXT[r.event] || r.event) },
    { label: 'By', html: (r) => esc(r.by_name || '') }, { label: 'From', html: (r) => esc(r.device || '') }, { label: 'Note', html: (r) => esc(r.note || '') },
  ];
  return {
    file: `box-history-${b.box_id}`,
    html: `<div class="card"><h2 style="margin-top:0"><span class="mono">${esc(b.box_id)}</span> ${pill(b.status)}${b.source === 'OPENING' ? ' <small>opening stock</small>' : ''}</h2>
      <div class="row" style="margin-bottom:0">${f('Part', esc(b.part_no) + ' ' + esc(b.part_name))}${f('Qty', esc(fmtNum(b.qty)) + ' NOS')}${f('Lot', esc(b.lot))}${f('Rack', esc(b.rack))}
      ${f('Packing slip', b.slip_no ? `<a href="#/slips?slip=${encodeURIComponent(b.slip_no)}">${esc(b.slip_no)}</a>` : '')}</div></div>
      <div id="rep">${table(cols, ev, 'No history recorded.')}</div>`,
    sheets: [{ name: 'Box history', rows: [['When', 'What happened', 'By', 'From', 'Note'], ...ev.map((r) => [{ at: r.at }, EVENT_TEXT[r.event] || r.event, r.by_name || '', r.device || '', r.note || ''])] }],
  };
}

// ---------------------------------------------------------------- Per-date lists (the original three reports)
const LISTS = {
  out: { label: 'Assembly out per date', view: 'assembly_out_by_date', note: 'Counted on the day the label is printed. Voided boxes and opening stock are not counted.',
    cols: [{ k: 'day', label: 'Date', fmt: fmtDay }, { k: 'shift', label: 'Shift' }, { k: 'part_no', label: 'Part no', cls: 'mono' }, { k: 'part_name', label: 'Part name' }, { k: 'boxes', label: 'Boxes', n: true, fmt: fmtNum }, { k: 'qty', label: 'Qty', n: true, fmt: fmtNum }] },
  inw: { label: 'FG inward per date', view: 'inward_by_date', note: 'Counted on the day the box is scanned into the store. Opening stock is not counted.',
    cols: [{ k: 'day', label: 'Date', fmt: fmtDay }, { k: 'part_no', label: 'Part no', cls: 'mono' }, { k: 'part_name', label: 'Part name' }, { k: 'boxes', label: 'Boxes', n: true, fmt: fmtNum }, { k: 'qty', label: 'Qty', n: true, fmt: fmtNum }] },
  dis: { label: 'Dispatch per date', view: 'dispatch_by_date', note: 'Counted on the day the packing slip is created.',
    cols: [{ k: 'day', label: 'Date', fmt: fmtDay }, { k: 'party', label: 'Party' }, { k: 'part_no', label: 'Part no', cls: 'mono' }, { k: 'part_name', label: 'Part name' }, { k: 'boxes', label: 'Boxes', n: true, fmt: fmtNum }, { k: 'qty', label: 'Qty', n: true, fmt: fmtNum }] },
};

async function buildList(st, key = st.r) {
  checkPeriod(st);
  const R = LISTS[key] || LISTS.out;
  const rows = await api.selectAll(R.view, `select=*&day=gte.${st.from}&day=lte.${st.to}&order=day.desc,part_no`);
  const byDay = new Map();
  rows.forEach((r) => { const d = byDay.get(r.day) || { day: r.day, boxes: 0, qty: 0 }; d.boxes += Number(r.boxes); d.qty += Number(r.qty); byDay.set(r.day, d); });
  const days = [...byDay.values()];
  const totB = days.reduce((s, d) => s + d.boxes, 0), totQ = days.reduce((s, d) => s + d.qty, 0);
  return {
    file: `${R.view}-${st.from}-to-${st.to}`,
    html: `<p class="hint" style="margin:0 0 10px">${esc(R.note)}</p>
      <div class="grid g2"><div><h2>Per day</h2><div id="rep">${table([{ k: 'day', label: 'Date', fmt: fmtDay }, { k: 'boxes', label: 'Boxes', n: true, fmt: fmtNum }, { k: 'qty', label: 'Qty', n: true, fmt: fmtNum }],
        [...days, { day: '', boxes: totB, qty: totQ }].map((d, i, a) => (i === a.length - 1 ? { ...d, day: 'TOTAL' } : d)), 'No records in this period.')}</div></div></div>
      <h2 style="margin-top:18px">Detail</h2>${table(R.cols, rows, 'No records in this period.')}`,
    sheets: [{ name: R.label, rows: [R.cols.map((c) => c.label), ...rows.map((r) => R.cols.map((c) => (c.k === 'day' ? { date: r.day } : c.k === 'part_no' ? { text: r.part_no } : r[c.k])))] }],
  };
}

// ---------------------------------------------------------------- The page
const TABS = [
  { id: 'summary', label: 'Day summary', build: buildSummary },
  { id: 'ledger', label: 'Stock ledger', build: buildLedger },
  { id: 'ason', label: 'Stock on a date', build: buildAsOn },
  { id: 'aging', label: 'Ageing', build: buildAging },
  { id: 'voids', label: 'Voids', build: buildVoids },
  { id: 'history', label: 'Box history', build: buildHistory },
  { id: 'detail', label: 'Per-date lists', build: (st) => buildList(st) },
];
const FOR = { from: 'summary ledger voids detail', to: 'summary ledger voids detail', quick: 'summary ledger voids detail', part: 'ledger', on: 'ason', hrs: 'aging', days: 'aging', box: 'history', r: 'detail' };
const HOURS = [[6, '6 hours'], [12, '12 hours'], [24, '1 day'], [48, '2 days'], [72, '3 days'], [168, '7 days']];
const FG_DAYS = [[7, '7 days'], [15, '15 days'], [30, '30 days'], [60, '60 days'], [90, '90 days']];

export async function reportsPage(el, { isCurrent, params }) {
  const t = todayIst();
  const first = params.get('tab');
  const st = { tab: TABS.some((x) => x.id === first) ? first : 'summary', from: addDays(t, -6), to: t, on: t, part: '', hrs: 24, days: 30, box: params.get('box') || '', r: 'out' };
  let cur = null;

  const opt = (list, sel) => list.map(([v, l]) => `<option value="${v}" ${v === sel ? 'selected' : ''}>${l}</option>`).join('');
  el.innerHTML = `
  <h1>Reports</h1>
  <div class="tabs" role="tablist">${TABS.map((x) => `<button type="button" role="tab" data-tab="${x.id}">${esc(x.label)}</button>`).join('')}</div>
  <form class="card" id="f">
    <div class="row">
      <div data-for="${FOR.from}"><label for="from">From</label><input id="from" type="date" value="${st.from}"></div>
      <div data-for="${FOR.to}"><label for="to">To</label><input id="to" type="date" value="${st.to}"></div>
      <div data-for="${FOR.part}"><label for="part">Part (optional)</label><input id="part" placeholder="part no or name"></div>
      <div data-for="${FOR.on}"><label for="on">Stock at the end of</label><input id="on" type="date" value="${st.on}"></div>
      <div data-for="${FOR.hrs}"><label for="hrs">Packed, not in FG for more than</label><select id="hrs">${opt(HOURS, st.hrs)}</select></div>
      <div data-for="${FOR.days}"><label for="days">In FG for more than</label><select id="days">${opt(FG_DAYS, st.days)}</select></div>
      <div data-for="${FOR.box}"><label for="box">Box ID</label><input id="box" value="${esc(st.box)}" placeholder="RP-261116-00012 or 12" autocomplete="off"></div>
      <div data-for="${FOR.r}"><label for="r">List</label><select id="r">${Object.entries(LISTS).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('')}</select></div>
    </div>
    <div class="actions">
      <button class="btn" id="show">Show</button>
      <span data-for="${FOR.quick}" class="actions" style="margin:0;gap:6px">
        <button type="button" class="btn sm alt" data-q="today">Today</button><button type="button" class="btn sm alt" data-q="yest">Yesterday</button>
        <button type="button" class="btn sm alt" data-q="7">Last 7 days</button><button type="button" class="btn sm alt" data-q="month">This month</button><button type="button" class="btn sm alt" data-q="last">Last month</button>
      </span>
      <span style="flex:1"></span>
      <button type="button" class="btn alt" id="csv">Download CSV</button>
      <button type="button" class="btn alt" id="xlsx">Download Excel</button>
      <button type="button" class="btn alt" id="book" title="One Excel file with all reports for the dates chosen">Month-end workbook</button>
    </div>
  </form>
  <div id="out"></div>`;

  const showGroups = () => {
    el.querySelectorAll('[data-for]').forEach((n) => { n.hidden = !n.dataset.for.split(' ').includes(st.tab); });
    el.querySelectorAll('[data-tab]').forEach((b) => { const on = b.dataset.tab === st.tab; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); });
    $(el, '#book').hidden = !['summary', 'ledger', 'voids', 'detail'].includes(st.tab);
  };
  const readForm = () => {
    st.from = $(el, '#from').value; st.to = $(el, '#to').value; st.on = $(el, '#on').value; st.part = $(el, '#part').value;
    st.hrs = $(el, '#hrs').value; st.days = $(el, '#days').value; st.box = $(el, '#box').value; st.r = $(el, '#r').value;
  };

  async function run() {
    readForm();
    const out = $(el, '#out');
    out.innerHTML = '<p class="hint">Loading…</p>';
    cur = null;
    try { cur = await TABS.find((x) => x.id === st.tab).build(st); }
    catch (e) { if (!isCurrent()) return; out.innerHTML = msg('bad', esc(e.message || String(e))); return; }
    if (!isCurrent()) return;
    out.innerHTML = cur.html;
  }

  el.addEventListener('click', (e) => {
    const t2 = e.target.closest('button');
    if (!t2) return;
    if (t2.dataset.tab) { st.tab = t2.dataset.tab; showGroups(); busy(null, run); return; }
    if (t2.dataset.q) {
      const k = t2.dataset.q, today = todayIst();
      let from = today, to = today;
      if (k === 'yest') from = to = addDays(today, -1);
      else if (k === '7') from = addDays(today, -6);
      else if (k === 'month') from = monthStart(today);
      else if (k === 'last') { to = addDays(monthStart(today), -1); from = monthStart(to); }
      $(el, '#from').value = from; $(el, '#to').value = to; busy(null, run);
    }
  });
  $(el, '#f').addEventListener('submit', (e) => { e.preventDefault(); busy(null, run); });

  $(el, '#csv').addEventListener('click', () => {
    const sh = cur && cur.sheets[0];
    if (!sh || sh.rows.length < 2) return toast('Show a report with records first.', true);
    download(`${cur.file}.csv`, toCsv(sh.rows.map((r) => r.map(plain))));
  });
  $(el, '#xlsx').addEventListener('click', () => {
    if (!cur || !cur.sheets.length || cur.sheets.every((s) => s.rows.length < 2)) return toast('Show a report with records first.', true);
    downloadXlsx(`${cur.file}.xlsx`, cur.sheets);
  });
  $(el, '#book').addEventListener('click', (e) => busy(e.target, async () => {
    readForm();
    checkPeriod(st);
    const sub = { ...st, on: st.to, hrs: 0, days: 0 };
    const parts = [await buildSummary(sub), await buildLedger({ ...sub, part: '' }), await buildAsOn(sub), await buildList(sub, 'out'), await buildList(sub, 'inw'), await buildList(sub, 'dis'), await buildVoids(sub), await buildAging(sub)];
    const sheets = parts.flatMap((p) => p.sheets);
    downloadXlsx(`radiance-reports-${st.from}-to-${st.to}.xlsx`, sheets);
    toast('Excel workbook downloaded');
  }));

  showGroups();
  await run();
}
