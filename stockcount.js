// Stock take (Phase 7): pure functions that compare a physical count with the system. No network, no DOM.
//
// scanIds : Box IDs that were scanned in the store (each once)
// byId    : Map  Box ID -> box row from the database, or null when the database has no such box
// fgRows  : every box the system says is in FG right now (status FG-RECEIVED)
// rackStart: optional. Only count the part of the store whose rack starts with this text (a partial count must not report
//            the rest of the store as "missing")

export const NOT_IN_REGISTER = '(not in the register)';

// What the system says about a box that is NOT supposed to be in the FG store.
export function whyText(row) {
  if (!row) return 'Not in the register';
  if (row.status === 'WIP-PACKED') return 'Label printed, but never received into FG';
  if (row.status === 'DISPATCHED') return `Dispatched on slip ${row.slip_no || '?'}`;
  if (row.status === 'VOID') return 'Voided';
  return `Status ${row.status}`;
}

export const inScope = (row, rackStart) => !rackStart || String(row.rack || '').toUpperCase().startsWith(String(rackStart).trim().toUpperCase());

export function buildResult({ scanIds, byId, fgRows, rackStart = '' }) {
  const scanned = new Set(scanIds);
  const matched = [], unexpected = [];
  for (const id of scanIds) {
    const r = byId.get(id) || null;
    if (r && r.status === 'FG-RECEIVED') matched.push(r);
    else unexpected.push({ box_id: id, row: r, why: whyText(r), receivable: !!r && r.status === 'WIP-PACKED' });
  }
  const sys = fgRows.filter((r) => inScope(r, rackStart));
  const missing = sys.filter((r) => !scanned.has(r.box_id));

  const parts = new Map();
  const part = (no, name) => {
    if (!parts.has(no)) parts.set(no, { part_no: no, part_name: name || '', sys_boxes: 0, sys_qty: 0, cnt_boxes: 0, cnt_qty: 0 });
    const p = parts.get(no);
    if (!p.part_name && name) p.part_name = name;
    return p;
  };
  for (const r of sys) { const p = part(r.part_no, r.part_name); p.sys_boxes++; p.sys_qty += r.qty; }
  for (const r of matched) { const p = part(r.part_no, r.part_name); p.cnt_boxes++; p.cnt_qty += r.qty; }
  for (const u of unexpected) {
    const p = u.row ? part(u.row.part_no, u.row.part_name) : part(NOT_IN_REGISTER, '');
    p.cnt_boxes++; p.cnt_qty += u.row ? u.row.qty : 0;
  }
  const summary = [...parts.values()].map((p) => ({ ...p, diff_boxes: p.cnt_boxes - p.sys_boxes, diff_qty: p.cnt_qty - p.sys_qty }))
    .sort((a, b) => (Math.abs(b.diff_qty) - Math.abs(a.diff_qty)) || (Math.abs(b.diff_boxes) - Math.abs(a.diff_boxes)) || a.part_no.localeCompare(b.part_no));
  const sum = (arr, k) => arr.reduce((s, x) => s + (x[k] || 0), 0);
  const totals = {
    sys_boxes: sum(summary, 'sys_boxes'), sys_qty: sum(summary, 'sys_qty'), cnt_boxes: sum(summary, 'cnt_boxes'), cnt_qty: sum(summary, 'cnt_qty'),
    matched: matched.length, unexpected: unexpected.length, missing: missing.length, missing_qty: sum(missing, 'qty'),
  };
  totals.diff_boxes = totals.cnt_boxes - totals.sys_boxes; totals.diff_qty = totals.cnt_qty - totals.sys_qty;
  totals.clean = !unexpected.length && !missing.length;
  return { summary, matched, missing, unexpected, totals };
}

export function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
