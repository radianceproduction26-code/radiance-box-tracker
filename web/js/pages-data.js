// Parts (master import), Opening stock, Users
import * as api from './api.js';
import { CONFIG } from './config.js';
import { readAnyFile, toCsv, download } from './sheet.js';
import { parseChecklist, mergeWithExisting, parseOpening, OPENING_HEADERS, cleanPart } from './partmaster.js';
import { $, esc, toast, busy, fmtNum, fmtTs, msg, table } from './ui.js';

// ---------------------------------------------------------------- Parts
export async function partsPage(el, { me, isCurrent }) {
  let parts = await api.selectAll('parts', 'select=part_no,name,std_qty,active&order=part_no');
  let packs = await api.selectAll('packing_options', 'select=part_no,std_qty,pp_box_code,tray_no&order=part_no,std_qty');
  if (!isCurrent()) return;
  let pending = null;

  el.innerHTML = `
  <h1>Parts</h1>
  <div class="card"><h2>Import the packing checklist</h2>
    <p class="hint" style="margin:0 0 10px">Choose CHECKLIST_….xlsx (sheet <b>MB</b>: Part no., STD.Packing, BOX NO, TRAY NO). Part numbers are cleaned (dots, spaces), repeated rows are merged, and existing box/tray codes are never blanked. If the workbook also has a <b>MASTER SHEET</b> sheet, part names are imported too.</p>
    <input type="file" id="file" accept=".xlsx,.csv" style="max-width:420px">
    <div id="prev" style="margin-top:12px"></div></div>
  <div class="card"><h2>Part list</h2>
    <div class="row"><div><label>Search part no or name</label><input id="s" placeholder="type to filter"></div></div>
    <div id="list"></div></div>`;

  function drawList() {
    const s = cleanPart($(el, '#s').value);
    const sl = $(el, '#s').value.trim().toLowerCase();
    const byPart = new Map();
    packs.forEach((p) => { (byPart.get(p.part_no) || byPart.set(p.part_no, []).get(p.part_no)).push(p); });
    let rows = parts.filter((p) => !s && !sl ? true : p.part_no.includes(s) || p.name.toLowerCase().includes(sl));
    const noName = parts.filter((p) => !p.name).length;
    const shown = rows.slice(0, 200);
    $(el, '#list').innerHTML = `
      <p class="hint" style="margin:0 0 8px">${fmtNum(parts.length)} parts · ${fmtNum(packs.length)} pack sizes${noName ? ` · <b>${fmtNum(noName)} without a name</b> (a name is saved when its first label is printed)` : ''}${rows.length > 200 ? ` · showing first 200 of ${fmtNum(rows.length)}` : ''}</p>
      ${table([
        { k: 'part_no', label: 'Part no', cls: 'mono' },
        { label: 'Name', html: (r) => esc(r.name) || '<i style="color:var(--mute)">—</i>' },
        { label: 'Pack sizes (qty · PP box · tray)', html: (r) => (byPart.get(r.part_no) || []).map((x) => `${fmtNum(x.std_qty)}${x.pp_box_code ? ' · ' + esc(x.pp_box_code) : ''}${x.tray_no ? ' · ' + esc(x.tray_no) : ''}`).join(' &nbsp;|&nbsp; ') },
        { label: '', html: (r) => `<button class="btn sm alt" data-edit="${esc(r.part_no)}">Edit name</button>` },
      ], shown, 'No parts yet. Import the checklist above.')}`;
  }
  drawList();
  $(el, '#s').addEventListener('input', drawList);
  el.addEventListener('click', (e) => {
    const pn = e.target.dataset && e.target.dataset.edit;
    if (!pn) return;
    const cur = parts.find((p) => p.part_no === pn);
    const nn = prompt(`Part name for ${pn}:`, cur ? cur.name : '');
    if (nn === null) return;
    busy(e.target, async () => {
      await api.update('parts', 'part_no=eq.' + encodeURIComponent(pn), { name: nn.trim().toUpperCase() });
      cur.name = nn.trim().toUpperCase(); drawList(); toast('Name saved');
    });
  });

  $(el, '#file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';   // so choosing the same file again (after fixing it) still fires "change"
    const prev = $(el, '#prev');
    pending = null;
    if (!f) { prev.innerHTML = ''; return; }
    try {
      const pm = parseChecklist(await readAnyFile(f));
      pending = pm;
      const s = pm.stats;
      prev.innerHTML = `
        ${msg('ok', `Read sheet <b>${esc(s.sheet)}</b>: ${fmtNum(s.rows)} rows → <b>${fmtNum(s.parts)} parts</b>, <b>${fmtNum(s.pairs)} pack sizes</b>
          (${fmtNum(s.multiPack)} parts have more than one pack size · ${fmtNum(s.withBox)} with PP box code · ${fmtNum(s.withTray)} with tray code · ${fmtNum(s.duplicates)} repeated rows merged${s.names ? ` · ${fmtNum(s.names)} part names` : ''})`)}
        ${s.skipped.length ? msg('warn', `<b>${s.skipped.length} row(s) skipped</b><ul>${s.skipped.slice(0, 15).map((x) => `<li>Row ${x.row}${x.part ? ' (' + esc(x.part) + ')' : ''}: ${esc(x.why)}</li>`).join('')}</ul>`) : ''}
        ${pm.notes.length ? msg('warn', `<b>Please check</b><ul>${pm.notes.slice(0, 15).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`) : ''}
        <button class="btn" id="imp">Import into database</button>`;
      $(el, '#imp').addEventListener('click', (ev) => busy(ev.target, async () => {
        // Re-read what is in the database right now, so a code saved meanwhile is never blanked.
        const current = await api.selectAll('packing_options', 'select=part_no,std_qty,pp_box_code,tray_no');
        const merged = mergeWithExisting(pending.packs, current);
        const partRows = [...new Set(merged.map((p) => p.part_no))].map((part_no) => ({ part_no, name: '' }));
        await api.upsert('parts', partRows, 'part_no', { ignoreDuplicates: true });
        if (pending.names.length) await api.upsert('parts', pending.names.map((n) => ({ part_no: n.part_no, name: n.name })), 'part_no');
        await api.upsert('packing_options', merged, 'part_no,std_qty');
        parts = await api.selectAll('parts', 'select=part_no,name,std_qty,active&order=part_no');
        packs = await api.selectAll('packing_options', 'select=part_no,std_qty,pp_box_code,tray_no&order=part_no,std_qty');
        prev.innerHTML = msg('ok', `Imported ${fmtNum(merged.length)} pack sizes for ${fmtNum(partRows.length)} parts.`);
        drawList(); toast('Part master imported');
      }));
    } catch (err) { prev.innerHTML = msg('bad', esc(err.message)); }
  });
}

// ---------------------------------------------------------------- Opening stock
export async function openingPage(el, { isCurrent }) {
  const done = await api.selectAll('settings', 'select=key,value&key=eq.opening_stock_done');
  if (!isCurrent()) return;
  if (done.length) {
    el.innerHTML = `<h1>Opening stock</h1>${msg('ok', `Opening stock was uploaded on <b>${esc(done[0].value)}</b>. It can only be done once. To correct a box, void it in the Box register.`)}`;
    return;
  }
  let parsed = null;
  el.innerHTML = `
  <h1>Opening stock</h1>
  <p class="sub">One-time upload of finished goods already in the store. Each box gets a Box ID and is counted as FG stock. It is not counted as assembly out.</p>
  <div class="card">
    <p class="hint" style="margin:0 0 10px">Columns: ${OPENING_HEADERS.map((h) => `<b>${h}</b>`).join(', ')}. A row with <i>NO OF BOXES</i> = 2 and <i>QTY PER BOX</i> = 200 makes two boxes of 200; <i>LOOSE BOX QTY</i> adds one more box of that qty.</p>
    <div class="actions" style="margin:0 0 12px"><a class="btn alt" href="templates/opening-stock-template.xlsx" download>Download Excel template</a><button class="btn alt" id="tpl">Download CSV template</button></div>
    <input type="file" id="file" accept=".xlsx,.csv" style="max-width:420px"><div id="prev" style="margin-top:12px"></div></div>`;

  $(el, '#tpl').addEventListener('click', () => download('opening-stock-template.csv', toCsv([OPENING_HEADERS, ['5017886', 'COVER', 200, 2, 50, 'L1', '16.10.2026']])));
  $(el, '#file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    const prev = $(el, '#prev');
    parsed = null;
    if (!f) { prev.innerHTML = ''; return; }
    try {
      const sheets = await readAnyFile(f);
      const sh = sheets.find((s) => /opening/i.test(s.name)) || sheets[0];
      parsed = parseOpening(sh.rows);
      if (!parsed.rows.length && !parsed.errors.length) { prev.innerHTML = msg('warn', `No data rows found in sheet <b>${esc(sh.name)}</b>. Fill the OPENING_STOCK sheet and choose the file again.`); return; }
      prev.innerHTML = `
        ${parsed.errors.length ? msg('bad', `<b>${parsed.errors.length} problem(s). Fix the file and choose it again.</b><ul>${parsed.errors.slice(0, 20).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`) : ''}
        ${parsed.rows.length ? msg(parsed.errors.length ? 'warn' : 'ok', `${fmtNum(parsed.rows.length)} rows → <b>${fmtNum(parsed.boxes)} boxes</b>, <b>${fmtNum(parsed.qty)} NOS</b>`) : ''}
        ${parsed.rows.length && !parsed.errors.length ? '<button class="btn" id="up">Upload opening stock (cannot be repeated)</button>' : ''}`;
      const up = $(el, '#up');
      if (up) up.addEventListener('click', (ev) => busy(ev.target, async () => {
        if (!confirm(`Create ${parsed.boxes} FG boxes (${parsed.qty} NOS) as opening stock? This can be done only once.`)) return;
        const r = await api.rpc('add_opening_stock', { p_rows: parsed.rows, p_device: CONFIG.DEVICE });
        el.innerHTML = `<h1>Opening stock</h1>${msg('ok', `Done: <b>${fmtNum(r.boxes)} boxes</b>, ${fmtNum(r.qty)} NOS added to FG stock.`)}`;
      }));
    } catch (err) { prev.innerHTML = msg('bad', esc(err.message)); }
  });
}

// ---------------------------------------------------------------- Users
const ROLES = ['assembly', 'store', 'dispatch', 'fg', 'viewer', 'admin'];
const ROLE_HELP = { assembly: 'prints / reprints / voids labels', store: 'scans FG inward', dispatch: 'scans outward, makes packing slips', fg: 'FG store: inward AND outward on one login', viewer: 'read only', admin: 'everything, users, opening stock' };

export async function usersPage(el, { me, isCurrent }) {
  const users = await api.rpc('admin_list_users');
  if (!isCurrent()) return;
  el.innerHTML = `
  <h1>Users</h1>
  <p class="sub">Create the login first in Supabase → Authentication → Users → Add user (tick auto-confirm). It appears here; give it a name and role. A login with no role can see nothing.</p>
  ${table([
    { k: 'email', label: 'Email' },
    { label: 'Name', html: (u) => `<input data-f="name" data-id="${esc(u.user_id)}" value="${esc(u.full_name || '')}" style="min-width:150px">` },
    { label: 'Role', html: (u) => `<select data-f="role" data-id="${esc(u.user_id)}">${u.role ? '' : '<option value="">— none —</option>'}${ROLES.map((r) => `<option ${u.role === r ? 'selected' : ''}>${r}</option>`).join('')}</select>` },
    { label: 'Active', html: (u) => `<input type="checkbox" data-f="active" data-id="${esc(u.user_id)}" style="width:auto" ${u.active === false ? '' : 'checked'}>` },
    { k: 'last_sign_in_at', label: 'Last sign-in', fmt: fmtTs },
    { label: '', html: (u) => `<button class="btn sm" data-save="${esc(u.user_id)}">Save</button>` },
  ], users, 'No users found.')}
  <p class="hint">${ROLES.map((r) => `<b>${r}</b>: ${ROLE_HELP[r]}`).join(' · ')}</p>`;

  el.addEventListener('click', (e) => {
    const id = e.target.dataset && e.target.dataset.save;
    if (!id) return;
    const g = (f) => el.querySelector(`[data-f="${f}"][data-id="${id}"]`);
    const name = g('name').value.trim(), role = g('role').value, active = g('active').checked;
    if (!name) return toast('Enter the person\'s name.', true);
    if (!role) return toast('Choose a role.', true);
    if (id === me.user_id && (role !== 'admin' || !active)) return toast('You cannot remove your own admin access.', true);
    busy(e.target, async () => { await api.upsert('profiles', [{ user_id: id, full_name: name, role, active }], 'user_id'); toast('Saved'); });
  });
}
