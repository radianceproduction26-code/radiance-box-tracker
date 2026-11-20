// Parallel run (Phase 7): pure functions. No network, no DOM.
//  - read an OLD stock list (Excel / CSV) and compare it with the stock in this app, part by part
//  - judge whether the system is ready to replace the old way of working
import { cleanPart } from './partmaster.js';

const txt = (v) => (v === null || v === undefined ? '' : String(v).trim());
const norm = (v) => txt(v).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Finds the header row and the Part no / Qty / Name columns. rows = [[cell,…],…]. Returns {header, part, qty, name} or null.
export function detectColumns(rows) {
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const head = (rows[i] || []).map(norm);
    const part = head.findIndex((h) => /^(part|item|material|product)( no| number| code| id)?$|part no|part number|part code|item code/.test(h));
    if (part < 0) continue;
    let qty = -1, best = 0;
    head.forEach((h, j) => {
      if (j === part || /per box|std|pack|opening|name|desc/.test(h)) return;
      const s = /closing|balance|stock/.test(h) ? 3 : /qty|quantity/.test(h) ? 2 : /nos|pcs|total/.test(h) ? 1 : 0;
      if (s > best) { best = s; qty = j; }
    });
    if (qty < 0) continue;
    return { header: i, part, qty, name: head.findIndex((h, j) => j !== part && j !== qty && /name|desc/.test(h)) };
  }
  return null;
}

// Reads the list. map = {header, part, qty, name}. Same part twice -> added together. Returns {items: Map, skipped: [{row, why}], merged, totalRows}
export function parseOldList(rows, map) {
  const items = new Map(), skipped = [];
  let merged = 0, totalRows = 0;
  for (let i = map.header + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    if (r.every((c) => txt(c) === '')) continue;
    const line = i + 1;
    const part = cleanPart(r[map.part]);
    if (!part) { if (txt(r[map.qty]) !== '') skipped.push({ row: line, why: `Part no is empty (qty ${txt(r[map.qty])})` }); continue; }   // a line with only a serial number is just a blank line
    if (/^(grand |sub )?total\b/i.test(part)) { totalRows++; continue; }   // the sheet's own total line
    const raw = txt(r[map.qty]);
    if (raw === '') { skipped.push({ row: line, why: `${part}: qty is empty` }); continue; }
    const qty = Number(raw.replace(/[,\s]/g, ''));
    if (!Number.isFinite(qty)) { skipped.push({ row: line, why: `${part}: qty "${raw}" is not a number` }); continue; }
    const name = map.name >= 0 ? txt(r[map.name]) : '';
    const have = items.get(part);
    if (have) { have.qty += qty; merged++; if (!have.name && name) have.name = name; } else items.set(part, { part_no: part, name, qty });
  }
  return { items, skipped, merged, totalRows };
}

export const STATUS = { MATCH: 'Match', MORE: 'App has more', LESS: 'App has less', ONLY_OLD: 'Only in old list', ONLY_APP: 'Only in app' };

// oldItems: Map part -> {part_no, name, qty}. appRows: result of stock_as_on(). includeWip: also count boxes printed but not yet scanned into FG.
export function compareStock(oldItems, appRows, { includeWip = false } = {}) {
  const app = new Map();
  for (const a of appRows) app.set(cleanPart(a.part_no), { name: a.part_name || '', qty: Number(a.fg_qty || 0) + (includeWip ? Number(a.wip_qty || 0) : 0) });
  const keys = new Set([...oldItems.keys(), ...app.keys()]);
  const rows = [];
  for (const k of keys) {
    const o = oldItems.get(k), a = app.get(k);
    const oldQ = o ? o.qty : 0, appQ = a ? a.qty : 0, diff = appQ - oldQ;
    const status = diff === 0 ? STATUS.MATCH : !o ? STATUS.ONLY_APP : !a || appQ === 0 ? STATUS.ONLY_OLD : diff > 0 ? STATUS.MORE : STATUS.LESS;
    if (diff === 0 && oldQ === 0) continue;   // zero on both sides: nothing to report
    rows.push({ part_no: k, part_name: (a && a.name) || (o && o.name) || '', old_qty: oldQ, app_qty: appQ, diff, status });
  }
  rows.sort((x, y) => ((x.diff === 0) - (y.diff === 0)) || (Math.abs(y.diff) - Math.abs(x.diff)) || x.part_no.localeCompare(y.part_no));
  const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
  const count = (s) => rows.filter((r) => r.status === s).length;
  return {
    rows,
    totals: { old: sum('old_qty'), app: sum('app_qty'), diff: sum('app_qty') - sum('old_qty'), parts: rows.length, match: count(STATUS.MATCH), differ: rows.length - count(STATUS.MATCH) },
  };
}

// facts: {parts, packOpts, roles: {assembly: n, …} (active logins), noRole, openingDone (text or ''), labelBoxes, receivedBoxes, slips, packedStale, staleHours, firstLabelDay ('YYYY-MM-DD' | ''), today}
// Returns {items: [{id, level: 'ok'|'warn'|'bad', title, detail, link}], bad, warn, ok, verdict}
export function evaluateReadiness(f) {
  const items = [];
  const add = (id, level, title, detail, link = '') => items.push({ id, level, title, detail, link });
  const n = (v) => Number(v || 0);

  if (n(f.parts) > 0 && n(f.packOpts) > 0) add('parts', 'ok', 'Parts and pack sizes loaded', `${n(f.parts)} parts, ${n(f.packOpts)} pack sizes.`, '#/parts');
  else add('parts', 'bad', 'Parts and pack sizes not loaded', `${n(f.parts)} parts, ${n(f.packOpts)} pack sizes. Import the CHECKLIST on the Parts page, so labels use the right quantity per box.`, '#/parts');

  const r = f.roles || {};
  const hasAssembly = n(r.assembly) > 0, hasFg = n(r.fg) > 0 || (n(r.store) > 0 && n(r.dispatch) > 0);
  const roleText = Object.entries(r).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
  if (hasAssembly && hasFg) add('users', 'ok', 'Logins for the label PC and the FG store', `Active logins: ${roleText}.`, '#/users');
  else add('users', 'bad', 'Logins missing', `Active logins: ${roleText}. Make one login with role assembly (label PC) and one with role fg (FG store phone) on the Users page, so each person works under their own name.`, '#/users');
  if (n(f.noRole) > 0) add('norole', 'warn', 'Logins without a role', `${n(f.noRole)} login(s) have no role yet and cannot see anything. Give them a role on the Users page.`, '#/users');

  if (f.openingDone) add('opening', 'ok', 'Opening stock uploaded', `Uploaded on ${f.openingDone}.`, '#/opening');
  else add('opening', 'warn', 'Opening stock not uploaded', 'If the store already holds finished goods, upload them on the Opening stock page (once). Otherwise the first stock take reports them as not in the register.', '#/opening');

  if (n(f.labelBoxes) > 0) add('labels', 'ok', 'Labels printed', `${n(f.labelBoxes)} box labels made so far.`, '#/print');
  else add('labels', 'bad', 'No label printed yet', 'Print a test label on the real label printer and check the size and that the QR scans.', '#/print');

  if (n(f.receivedBoxes) > 0) add('inward', 'ok', 'FG inward scanning used', `${n(f.receivedBoxes)} box(es) received by scanning.`, '#/inward');
  else add('inward', 'bad', 'No box scanned into FG yet', 'Scan a printed label with the FG phone on the FG inward page.', '#/inward');

  if (n(f.slips) > 0) add('slips', 'ok', 'Packing slip made', `${n(f.slips)} packing slip(s) on record.`, '#/slips');
  else add('slips', 'bad', 'No packing slip made yet', 'Make one slip on the FG outward page. Check the PDF against your old slip.', '#/outward');

  if (n(f.packedStale) === 0) add('stale', 'ok', 'Every printed label was scanned into FG', `No box has been waiting more than ${n(f.staleHours) || 24} hours.`, '#/reports?tab=aging');
  else add('stale', 'warn', 'Boxes printed but never scanned into FG', `${n(f.packedStale)} box(es) were printed more than ${n(f.staleHours) || 24} hours ago and are still not in FG. See Reports > Ageing.`, '#/reports?tab=aging');

  if (!f.firstLabelDay) add('days', 'warn', 'Parallel run has not started', 'No label has been printed yet. Run the old system and this one side by side, with the same boxes.', '');
  else {
    const days = Math.round((Date.parse(f.today + 'T00:00:00Z') - Date.parse(f.firstLabelDay + 'T00:00:00Z')) / 86400000) + 1;
    if (days >= 14) add('days', 'ok', `Parallel run: day ${days}`, 'Long enough to have seen a full cycle. Compare at month-end before you decide.', '');
    else add('days', 'warn', `Parallel run: day ${days}`, `Keep both systems running for at least 14 days (you are on day ${days}).`, '');
  }

  const bad = items.filter((i) => i.level === 'bad').length, warn = items.filter((i) => i.level === 'warn').length, ok = items.filter((i) => i.level === 'ok').length;
  const verdict = bad ? `Not ready: ${bad} item${bad > 1 ? 's' : ''} need${bad > 1 ? '' : 's'} work.`
    : warn ? `Almost ready: ${warn} item${warn > 1 ? 's' : ''} to check.`
      : 'Ready. All checks pass. Do a final stock take and a stock comparison, then switch.';
  return { items, bad, warn, ok, verdict };
}
