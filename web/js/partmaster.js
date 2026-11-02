// Pure functions: part master (CHECKLIST) and opening-stock sheet reading. No network, no DOM.
import { toIsoDate } from './sheet.js';

// Same rule as the database function private.clean_part(): trim, UPPER, drop trailing dots / ellipsis.
export function cleanPart(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim().toUpperCase().replace(/[.…]+$/, '').trim();
}

const txt = (v) => (v === null || v === undefined ? '' : String(v).trim());
const code = (v) => {
  const s = txt(v);
  return s === '0' || s === '-' ? '' : s;   // customer sheets use 0 for "no code"
};
const norm = (v) => txt(v).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// sheets: [{name, rows}] from readAnyFile(). Reads sheet "MB" (packing) and, when present, "MASTER SHEET" (names).
export function parseChecklist(sheets) {
  const out = { packs: [], names: [], notes: [], stats: {} };
  const find = (re) => sheets.find((s) => re.test(s.name.trim()));
  const mb = find(/^mb$/i) || sheets.find((s) => s.rows.slice(0, 5).some((r) => r.some((c) => /^part\s*no/i.test(txt(c)))));
  if (!mb) throw new Error('No packing sheet found. Expected a sheet named "MB" with Part no., STD.Packing, BOX NO, TRAY NO.');

  let h = mb.rows.findIndex((r) => r.some((c) => /^part\s*no/i.test(txt(c))));
  if (h < 0) h = 0;
  const head = mb.rows[h].map(norm);
  const at = (re, dflt) => { const i = head.findIndex((x) => re.test(x)); return i >= 0 ? i : dflt; };
  const cPart = at(/^part no/, 0), cStd = at(/std|packing qty|qty/, 1), cBox = at(/box/, 2), cTray = at(/tray/, 3);

  const map = new Map();
  let rows = 0, dups = 0;
  const skipped = [];
  for (let i = h + 1; i < mb.rows.length; i++) {
    const r = mb.rows[i] || [];
    const part = cleanPart(r[cPart]);
    if (!part && r.every((c) => txt(c) === '')) continue;
    rows++;
    const std = Number(r[cStd]);
    if (!part) { skipped.push({ row: i + 1, why: 'part no is empty' }); continue; }
    if (!Number.isInteger(std) || std <= 0) { skipped.push({ row: i + 1, part, why: `pack qty "${txt(r[cStd])}" is not a whole number above 0` }); continue; }
    const key = part + '|' + std;
    const box = code(r[cBox]), tray = code(r[cTray]);
    const cur = map.get(key);
    if (!cur) { map.set(key, { part_no: part, std_qty: std, pp_box_code: box, tray_no: tray }); continue; }
    dups++;
    // Merge rule: a non-empty value is never replaced by an empty one.
    if (box) { if (cur.pp_box_code && cur.pp_box_code !== box) out.notes.push(`${part} / ${std}: two box codes (${cur.pp_box_code}, ${box}); kept ${cur.pp_box_code}`); else cur.pp_box_code = box; }
    if (tray) { if (cur.tray_no && cur.tray_no !== tray) out.notes.push(`${part} / ${std}: two tray codes (${cur.tray_no}, ${tray}); kept ${cur.tray_no}`); else cur.tray_no = tray; }
  }
  out.packs = [...map.values()];

  const ms = find(/^master\s*sheet$/i);
  if (ms) {
    const seen = new Set();
    ms.rows.forEach((r) => {
      const p = cleanPart(r[1]), n = txt(r[2]);
      if (p && n && /\d/.test(p) && !seen.has(p)) { seen.add(p); out.names.push({ part_no: p, name: n.toUpperCase() }); }
    });
  }
  out.stats = {
    sheet: mb.name, rows, skipped, duplicates: dups,
    pairs: out.packs.length,
    parts: new Set(out.packs.map((p) => p.part_no)).size,
    multiPack: (() => { const c = {}; out.packs.forEach((p) => { c[p.part_no] = (c[p.part_no] || 0) + 1; }); return Object.values(c).filter((n) => n > 1).length; })(),
    withBox: out.packs.filter((p) => p.pp_box_code).length,
    withTray: out.packs.filter((p) => p.tray_no).length,
    names: out.names.length,
  };
  return out;
}

// Merge freshly read packs with rows already in the database so a blank never wipes a saved code.
export function mergeWithExisting(packs, existing) {
  const ex = new Map(existing.map((e) => [e.part_no + '|' + e.std_qty, e]));
  return packs.map((p) => {
    const e = ex.get(p.part_no + '|' + p.std_qty);
    return e ? { ...p, pp_box_code: p.pp_box_code || e.pp_box_code || '', tray_no: p.tray_no || e.tray_no || '' } : p;
  });
}

export const OPENING_HEADERS = ['PART NO', 'PART NAME', 'QTY PER BOX', 'NO OF BOXES', 'LOOSE BOX QTY', 'LOT', 'DATE'];

// rows: first non-empty row is the header. Returns {rows:[{part_no,part_name,std_qty,n_boxes,loose_qty,lot,date}], errors:[], boxes, qty}
export function parseOpening(rows) {
  const res = { rows: [], errors: [], boxes: 0, qty: 0 };
  const hi = rows.findIndex((r) => r.some((c) => /part/i.test(txt(c))));
  if (hi < 0) { res.errors.push('Header row not found. First row must be: ' + OPENING_HEADERS.join(', ')); return res; }
  const head = rows[hi].map(norm);
  const col = (re) => head.findIndex((x) => re.test(x));
  const c = {
    part: col(/^part no|^part$|^part number/), name: col(/name|desc/), std: col(/per box|std|pack/),
    n: col(/no of box|boxes|full box|^box/), loose: col(/loose|balance|odd|last/), lot: col(/lot|batch/), date: col(/date/),
  };
  if (c.part < 0) { res.errors.push('Column "PART NO" not found'); return res; }
  if (c.std < 0 || c.n < 0) { res.errors.push('Columns "QTY PER BOX" and "NO OF BOXES" are needed'); return res; }
  const num = (v) => (txt(v) === '' ? 0 : Number(v));
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    if (r.every((x) => txt(x) === '')) continue;
    const line = i + 1;
    const part = cleanPart(r[c.part]);
    const std = num(r[c.std]), n = num(r[c.n]), loose = c.loose >= 0 ? num(r[c.loose]) : 0;
    if (!part) { res.errors.push(`Row ${line}: part no is empty`); continue; }
    if (![std, n, loose].every((x) => Number.isInteger(x) && x >= 0)) { res.errors.push(`Row ${line} (${part}): quantities must be whole numbers, 0 or more`); continue; }
    if (n === 0 && loose === 0) { res.errors.push(`Row ${line} (${part}): no boxes and no loose qty`); continue; }
    if (n > 0 && std <= 0) { res.errors.push(`Row ${line} (${part}): qty per box is needed when boxes > 0`); continue; }
    let date = '';
    if (c.date >= 0 && txt(r[c.date]) !== '') {
      date = toIsoDate(r[c.date]);
      if (!date) { res.errors.push(`Row ${line} (${part}): date "${txt(r[c.date])}" not understood (use dd.mm.yyyy)`); continue; }
    }
    res.rows.push({ part_no: part, part_name: c.name >= 0 ? txt(r[c.name]) : '', std_qty: std || null, n_boxes: n, loose_qty: loose, lot: c.lot >= 0 ? txt(r[c.lot]) : '', date });
    res.boxes += n + (loose > 0 ? 1 : 0);
    res.qty += n * std + loose;
  }
  return res;
}
