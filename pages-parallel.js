// Parallel run (admin): run the old way of working and this system side by side, then decide when to switch.
//   Go-live check          readiness list built from the live data + the cut-over steps
//   Compare with old list  upload the old stock register, compare it part by part with the stock in this app
//   Backup                 one Excel file with everything (boxes, history, slips, parts)
import * as api from './api.js';
import { CONFIG } from './config.js';
import { readAnyFile } from './sheet.js';
import { downloadXlsx } from './xlsx.js';
import { detectColumns, parseOldList, compareStock, evaluateReadiness, STATUS } from './reconcile.js';
import { $, $$, esc, toast, busy, todayIst, fmtNum, fmtDay, msg, table } from './ui.js';

const TABS = [{ id: 'golive', label: 'Go-live check' }, { id: 'compare', label: 'Compare with old list' }, { id: 'backup', label: 'Backup' }];
const colLetter = (i) => { let s = ''; for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };
const signed = (n) => (n > 0 ? '+' + fmtNum(n) : fmtNum(n));
const istDay = (ts) => new Date(ts).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const count = async (t, query) => (await api.selectPage(t, `select=${query.select}${query.q ? '&' + query.q : ''}`, 0, 0)).total;

export async function parallelPage(el, { isCurrent, params }) {
  const first = params.get('tab');
  let tab = TABS.some((x) => x.id === first) ? first : 'golive';
  const cmp = { fileName: '', sheets: [], sheet: 0, head: 0, map: null, on: todayIst(), wip: false, only: true, appRows: null, appOn: '', result: null, parsed: null };

  el.innerHTML = `
  <h1>Parallel run</h1>
  <p class="sub">Keep the old system running for a few weeks, with the same boxes, and check that this one agrees. Switch only when it does.</p>
  <div class="tabs" role="tablist">${TABS.map((x) => `<button type="button" role="tab" data-tab="${x.id}">${esc(x.label)}</button>`).join('')}</div>
  <div id="pane"></div>`;
  const pane = $(el, '#pane');

  const draw = () => {
    $$(el, '[data-tab]').forEach((b) => { const on = b.dataset.tab === tab; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); });
    ({ golive: goLive, compare, backup })[tab]().catch((e) => { if (isCurrent()) pane.innerHTML = msg('bad', esc(e.message || String(e))); });
  };
  $(el, '.tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b && b.dataset.tab !== tab) { tab = b.dataset.tab; draw(); } });

  // ================================================================ Go-live check
  async function goLive() {
    pane.innerHTML = '<p class="hint">Checking the data…</p>';
    const staleBefore = new Date(Date.now() - CONFIG.STALE_PACKED_HOURS * 3600000).toISOString();
    const [parts, packOpts, users, opening, labelBoxes, receivedBoxes, slips, packedStale, firstBox] = await Promise.all([
      count('parts', { select: 'part_no', q: 'active=eq.true' }),
      count('packing_options', { select: 'part_no' }),
      api.rpc('admin_list_users'),
      api.selectAll('settings', 'select=key,value&key=eq.opening_stock_done'),
      count('boxes', { select: 'box_id', q: 'source=eq.LABEL&status=in.(WIP-PACKED,FG-RECEIVED,DISPATCHED)' }),
      count('boxes', { select: 'box_id', q: 'source=eq.LABEL&status=in.(FG-RECEIVED,DISPATCHED)' }),
      count('slips', { select: 'slip_no', q: 'voided_at=is.null' }),
      count('boxes', { select: 'box_id', q: `status=eq.WIP-PACKED&created_at=lt.${encodeURIComponent(staleBefore)}` }),
      api.selectPage('boxes', 'select=created_at&source=eq.LABEL&order=created_at.asc', 0, 0),
    ]);
    if (!isCurrent() || tab !== 'golive') return;
    const roles = {};
    users.filter((u) => u.role && u.active).forEach((u) => { roles[u.role] = (roles[u.role] || 0) + 1; });
    const r = evaluateReadiness({
      parts, packOpts, roles, noRole: users.filter((u) => !u.role).length, openingDone: opening[0] ? opening[0].value : '',
      labelBoxes, receivedBoxes, slips, packedStale, staleHours: CONFIG.STALE_PACKED_HOURS,
      firstLabelDay: firstBox.rows[0] ? istDay(firstBox.rows[0].created_at) : '', today: todayIst(),
    });
    const LV = { ok: 'OK', warn: 'Check', bad: 'Fix' };
    pane.innerHTML = `
    ${msg(r.bad ? 'bad' : r.warn ? 'warn' : 'ok', `<b id="verdict">${esc(r.verdict)}</b>`)}
    <div class="card chk" id="checks">${r.items.map((i) => `
      <div class="chkrow" data-id="${esc(i.id)}"><span class="lvl ${i.level}">${LV[i.level]}</span>
        <div><b>${esc(i.title)}</b><span>${esc(i.detail)}${i.link ? ` <a href="${esc(i.link)}">Open</a>` : ''}</span></div></div>`).join('')}</div>
    <h2>Switching over, step by step</h2>
    <ol class="steps" id="steps">
      <li><b>Every working day:</b> label and scan every box in this system as well as the old way. Same boxes, same day.</li>
      <li><b>Every few days:</b> compare the stock here with the old stock list (tab <i>Compare with old list</i>). A difference means a box was missed, scanned twice, or written wrongly in the old list. Find out why.</li>
      <li><b>Every week:</b> do a <a href="#/stocktake">stock take</a> in the FG store. It checks the boxes on the shelf, not just the numbers.</li>
      <li><b>When the comparisons are clean for two weeks</b> and this page says Ready, choose the switch-over day.</li>
      <li><b>On that day:</b> do a final stock take and a final comparison, then stop writing in the old register. Keep it read-only for 30 days.</li>
      <li><b>Every month-end:</b> download the Backup (tab <i>Backup</i>) and keep it with your records.</li>
    </ol>`;
  }

  // ================================================================ Compare with old list
  function readHeaderRow() {
    const rows = cmp.sheets[cmp.sheet] ? cmp.sheets[cmp.sheet].rows : [];
    const d = detectColumns(rows);
    cmp.head = d ? d.header : 0;
    cmp.map = d ? { ...d } : { header: 0, part: 0, qty: Math.min(1, Math.max(0, (rows[0] || []).length - 1)), name: -1 };
    cmp.recognised = !!d;
  }
  const headerCells = () => { const rows = cmp.sheets[cmp.sheet] ? cmp.sheets[cmp.sheet].rows : []; return rows[cmp.map.header] || []; };

  async function fetchApp() {
    if (cmp.appRows && cmp.appOn === cmp.on) return;
    cmp.appRows = await api.rpc('stock_as_on', { p_day: cmp.on });
    cmp.appOn = cmp.on;
  }
  function run() {
    const rows = cmp.sheets[cmp.sheet].rows;
    cmp.parsed = parseOldList(rows, cmp.map);
    cmp.result = compareStock(cmp.parsed.items, cmp.appRows, { includeWip: cmp.wip });
  }

  async function compare() {
    const hasFile = cmp.sheets.length > 0;
    pane.innerHTML = `
    <p class="hint" style="margin:0 0 12px">Upload your old finished-goods stock list (Excel or CSV) with one line per part: part number and quantity in NOS. The app compares it with its own stock.</p>
    <div class="card" id="setup">
      <div class="row"><div><label for="file">Old stock list</label><input id="file" type="file" accept=".xlsx,.csv,.txt"></div></div>
      <div id="map"${hasFile ? '' : ' hidden'}></div>
      <div class="row" style="margin-top:10px">
        <div><label for="on">Stock as on (end of day)</label><input id="on" type="date" value="${esc(cmp.on)}" max="${esc(todayIst())}"></div>
      </div>
      <label class="chkl"><input id="wip" type="checkbox" ${cmp.wip ? 'checked' : ''}> Also count boxes that are printed but not yet scanned into FG</label>
      <div class="actions" style="margin-top:12px"><button class="btn" id="go" ${hasFile ? '' : 'disabled'}>Compare</button></div>
    </div>
    <div id="out"></div>`;
    if (hasFile) drawMap();
    if (cmp.result) drawResult();

    $(pane, '#file').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      try {
        const sheets = (await readAnyFile(f)).filter((s) => s.rows.some((r) => r.some((c) => String(c ?? '').trim() !== '')));
        if (!sheets.length) throw new Error('That file has no data.');
        cmp.fileName = f.name; cmp.sheets = sheets; cmp.result = null; cmp.parsed = null;
        cmp.sheet = Math.max(0, sheets.findIndex((s) => detectColumns(s.rows)));
        readHeaderRow();
        $(pane, '#map').hidden = false; $(pane, '#go').disabled = false; $(pane, '#out').innerHTML = '';
        drawMap();
      } catch (err) { $(pane, '#out').innerHTML = msg('bad', esc(err.message)); }
    });
    $(pane, '#on').addEventListener('change', (e) => { cmp.on = e.target.value; });
    $(pane, '#wip').addEventListener('change', (e) => { cmp.wip = e.target.checked; if (cmp.result) { run(); drawResult(); } });
    $(pane, '#go').addEventListener('click', (e) => busy(e.target, async () => {
      if (!cmp.sheets.length) throw new Error('Choose the old stock list first.');
      if (!cmp.on) throw new Error('Choose the date.');
      if (cmp.map.part === cmp.map.qty) throw new Error('Part no and Qty must be different columns.');
      await fetchApp();
      if (!isCurrent() || tab !== 'compare') return;
      run(); drawResult();
    }));
  }

  function drawMap() {
    const cells = headerCells();
    const opts = (sel, none) => (none ? `<option value="-1" ${sel < 0 ? 'selected' : ''}>— none —</option>` : '') + cells.map((c, i) => `<option value="${i}" ${i === sel ? 'selected' : ''}>${colLetter(i)}: ${esc(String(c ?? '').trim().slice(0, 28) || '(empty)')}</option>`).join('');
    const sh = cmp.sheets[cmp.sheet];
    $(pane, '#map').innerHTML = `
      <p class="hint" style="margin:8px 0">${esc(cmp.fileName)} · ${fmtNum(sh.rows.length)} lines. ${cmp.recognised ? 'Columns found. Check them:' : '<b>The headings were not recognised.</b> Choose the header line and the columns:'}</p>
      <div class="row">
        ${cmp.sheets.length > 1 ? `<div><label for="sheet">Sheet</label><select id="sheet">${cmp.sheets.map((s, i) => `<option value="${i}" ${i === cmp.sheet ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>` : ''}
        <div><label for="hdr">Header on line</label><input id="hdr" type="number" min="1" max="${sh.rows.length}" value="${cmp.map.header + 1}" style="width:90px"></div>
        <div><label for="c-part">Part no</label><select id="c-part">${opts(cmp.map.part)}</select></div>
        <div><label for="c-qty">Quantity (NOS)</label><select id="c-qty">${opts(cmp.map.qty)}</select></div>
        <div><label for="c-name">Part name (optional)</label><select id="c-name">${opts(cmp.map.name, true)}</select></div>
      </div>`;
    const sel = (id) => $(pane, id);
    if (sel('#sheet')) sel('#sheet').addEventListener('change', (e) => { cmp.sheet = Number(e.target.value); readHeaderRow(); cmp.result = null; $(pane, '#out').innerHTML = ''; drawMap(); });
    sel('#hdr').addEventListener('change', (e) => {
      const n = Math.max(1, Math.min(sh.rows.length, Number(e.target.value) || 1)) - 1;
      const d = detectColumns(sh.rows.slice(n));
      cmp.map = d && d.header === 0 ? { ...d, header: n } : { header: n, part: cmp.map.part, qty: cmp.map.qty, name: cmp.map.name };
      cmp.recognised = true; cmp.result = null; $(pane, '#out').innerHTML = ''; drawMap();
    });
    for (const [id, key] of [['#c-part', 'part'], ['#c-qty', 'qty'], ['#c-name', 'name']]) sel(id).addEventListener('change', (e) => { cmp.map[key] = Number(e.target.value); cmp.result = null; $(pane, '#out').innerHTML = ''; });
  }

  function drawResult() {
    const { rows, totals } = cmp.result, p = cmp.parsed;
    const shown = cmp.only ? rows.filter((r) => r.status !== STATUS.MATCH) : rows;
    const LIMIT = 500;
    const cols = [
      { label: 'Part no', cls: 'mono', html: (r) => esc(r.part_no) }, { label: 'Part name', html: (r) => esc(r.part_name) },
      { label: 'Old list NOS', n: true, html: (r) => esc(fmtNum(r.old_qty)) }, { label: 'App NOS', n: true, html: (r) => esc(fmtNum(r.app_qty)) },
      { label: 'Difference', n: true, html: (r) => `<b class="${r.diff ? 'dn' : ''}">${esc(signed(r.diff))}</b>` },
      { label: 'Result', html: (r) => `<span class="rs ${r.status === STATUS.MATCH ? 'ok' : 'bad'}">${esc(r.status)}</span>` },
    ];
    const notes = [];
    if (p.skipped.length) notes.push(`${fmtNum(p.skipped.length)} line${p.skipped.length > 1 ? 's' : ''} in the old list could not be read and ${p.skipped.length > 1 ? 'were' : 'was'} left out: ${p.skipped.slice(0, 5).map((s) => `line ${s.row} (${esc(s.why)})`).join('; ')}${p.skipped.length > 5 ? '; …' : ''}. The full list is in the Excel file.`);
    if (p.merged) notes.push(`${fmtNum(p.merged)} part number${p.merged > 1 ? 's' : ''} appeared on more than one line in the old list. Their quantities were added together.`);
    if (p.totalRows) notes.push('The old list\'s own TOTAL line was ignored.');
    $(pane, '#out').innerHTML = `
      ${msg(totals.differ ? 'warn' : 'ok', totals.differ
        ? `<b id="verdict">${fmtNum(totals.differ)} of ${fmtNum(totals.parts)} parts differ.</b> Stock as on ${esc(fmtDay(cmp.appOn))}${cmp.wip ? ', including boxes not yet scanned into FG' : ''}.`
        : `<b id="verdict">All ${fmtNum(totals.parts)} parts match.</b> Stock as on ${esc(fmtDay(cmp.appOn))}.`)}
      <div class="grid g4" style="margin:0 0 12px">
        <div class="stat"><b id="t-old">${fmtNum(totals.old)}</b><span>old list, NOS</span></div>
        <div class="stat"><b id="t-app">${fmtNum(totals.app)}</b><span>this app, NOS</span></div>
        <div class="stat"><b id="t-diff">${esc(signed(totals.diff))}</b><span>difference (app minus old)</span></div>
        <div class="stat"><b id="t-parts">${fmtNum(totals.match)} / ${fmtNum(totals.parts)}</b><span>parts matching</span></div>
      </div>
      ${notes.map((n) => `<p class="hint">${n}</p>`).join('')}
      <label class="chkl"><input id="only" type="checkbox" ${cmp.only ? 'checked' : ''}> Show only the parts that differ</label>
      <div id="cmp">${table(cols, shown.slice(0, LIMIT), cmp.only ? 'No differences.' : 'Nothing to show.')}</div>
      ${shown.length > LIMIT ? `<p class="hint">First ${LIMIT} of ${fmtNum(shown.length)} shown. The Excel file has all of them.</p>` : ''}
      <div class="actions" style="margin-top:12px"><button class="btn alt" id="xl">Download Excel</button></div>`;
    $(pane, '#only').addEventListener('change', (e) => { cmp.only = e.target.checked; drawResult(); });
    $(pane, '#xl').addEventListener('click', exportCompare);
  }

  function exportCompare() {
    const { rows, totals } = cmp.result, p = cmp.parsed;
    const sheets = [
      { name: 'Comparison', rows: [['Part no', 'Part name', 'Old list NOS', 'App NOS', 'Difference', 'Result'], ...rows.map((r) => [{ text: r.part_no }, r.part_name, r.old_qty, r.app_qty, r.diff, r.status]), ['TOTAL', '', totals.old, totals.app, totals.diff, '']], totalRow: true },
    ];
    if (p.skipped.length) sheets.push({ name: 'Lines not read', rows: [['Line in old list', 'Why'], ...p.skipped.map((s) => [s.row, s.why])] });
    sheets.push({ name: 'Info', rows: [['Item', 'Value'], ['Old list file', cmp.fileName], ['Stock as on (end of day)', { date: cmp.appOn }], ['Includes printed, not yet scanned into FG', cmp.wip ? 'Yes' : 'No'], ['Parts compared', totals.parts], ['Parts differing', totals.differ]] });
    downloadXlsx(`stock-compare-${cmp.appOn}.xlsx`, sheets);
  }

  // ================================================================ Backup
  async function backup() {
    pane.innerHTML = `
    <p class="hint" style="margin:0 0 12px">One Excel file with everything in the system: every box, the full history of every box (who and when), packing slips, parts, pack sizes and parties. Download it at every month-end and keep it with your records.</p>
    <div class="card"><div class="actions"><button class="btn" id="bk">Download full backup (Excel)</button></div><p class="hint" id="bkmsg" aria-live="polite"></p></div>`;
    $(pane, '#bk').addEventListener('click', (e) => busy(e.target, async () => {
      const say = (t) => { const m = $(pane, '#bkmsg'); if (m) m.textContent = t; };
      say('Reading boxes…');
      const boxes = await api.selectAll('boxes', 'select=*&order=seq.asc', 200000);
      say('Reading history…');
      const trace = await api.selectAll('box_trace', 'select=box_id,event,at,by_name,device,note,part_no,part_name,qty&order=at.asc,id.asc', 400000);
      say('Reading slips and parts…');
      const [slips, parts, packs, parties] = await Promise.all([
        api.selectAll('slips', 'select=*&order=created_at.asc'), api.selectAll('parts', 'select=*&order=part_no.asc'),
        api.selectAll('packing_options', 'select=*&order=part_no.asc'), api.selectAll('parties', 'select=*&order=name.asc'),
      ]);
      if (!isCurrent()) return;
      const at = (v) => (v ? { at: v } : '');
      const now = new Date().toISOString();
      const sheets = [
        { name: 'Info', rows: [['Item', 'Value'], ['Backup made', { at: now }], ['Boxes', boxes.length], ['Box history lines', trace.length], ['Packing slips', slips.length], ['Parts', parts.length], ['Pack sizes', packs.length], ['Parties', parties.length], ['Note', 'Times are India time.']] },
        { name: 'Boxes', rows: [['Box ID', 'Part no', 'Part name', 'Qty', 'Status', 'Source', 'Label date', 'Lot', 'Shift', 'QA sign', 'Rack', 'Slip no', 'Printed at', 'In FG at', 'Dispatched at'],
          ...boxes.map((b) => [b.box_id, { text: b.part_no }, b.part_name, b.qty, b.status, b.source, b.label_date ? { date: b.label_date } : '', b.lot, b.shift, b.qa_sign, b.rack, b.slip_no, at(b.created_at), at(b.fg_at), at(b.out_at)])] },
        { name: 'Box history', rows: [['Box ID', 'Event', 'Time', 'By', 'Device', 'Note', 'Part no', 'Part name', 'Qty'], ...trace.map((t) => [t.box_id, t.event, at(t.at), t.by_name, t.device, t.note, { text: t.part_no }, t.part_name, t.qty])] },
        { name: 'Packing slips', rows: [['Slip no', 'Party', 'Location', 'Transport', 'Vehicle', 'LR no', 'Invoice no', 'Dispatch exec', 'Driver', 'Driver mobile', 'Made at', 'Voided at', 'Void reason', 'Void boxes', 'Void qty'],
          ...slips.map((s) => [s.slip_no, s.party, s.location, s.transport, s.vehicle, s.lr_no, s.inv_no, s.disp_exe, s.driver_name, s.driver_mob, at(s.created_at), at(s.voided_at), s.void_reason, s.void_boxes, s.void_qty])] },
        { name: 'Parts', rows: [['Part no', 'Name', 'Std qty', 'Active'], ...parts.map((r) => [{ text: r.part_no }, r.name, r.std_qty, r.active ? 'Yes' : 'No'])] },
        { name: 'Pack sizes', rows: [['Part no', 'Std qty', 'PP box code', 'Tray no'], ...packs.map((r) => [{ text: r.part_no }, r.std_qty, r.pp_box_code, r.tray_no])] },
        { name: 'Parties', rows: [['Name', 'Location', 'Transport', 'Dispatch exec', 'Driver', 'Driver mobile'], ...parties.map((r) => [r.name, r.location, r.transport, r.disp_exe, r.driver_name, r.driver_mob])] },
      ];
      downloadXlsx(`radiance-backup-${todayIst()}.xlsx`, sheets);
      say(`Done: ${fmtNum(boxes.length)} boxes, ${fmtNum(trace.length)} history lines, ${fmtNum(slips.length)} slips.`);
      toast('Backup downloaded');
    }));
  }

  draw();
}
