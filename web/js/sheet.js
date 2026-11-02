// Reads .xlsx (zip + XML) and .csv in the browser, with no outside library.
// Uses the browser's built-in DecompressionStream for the zip entries.

const td = new TextDecoder('utf-8');

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function unzip(buf) {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 66000); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('This is not a valid .xlsx file');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const entries = {};
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const off = dv.getUint32(p + 42, true);
    const name = td.decode(u8.subarray(p + 46, p + 46 + nameLen));
    entries[name] = { method, csize, off };
    p += 46 + nameLen + extraLen + commentLen;
  }
  const read = async (name) => {
    const e = entries[name];
    if (!e) return null;
    const lnLen = dv.getUint16(e.off + 26, true);
    const lxLen = dv.getUint16(e.off + 28, true);
    const start = e.off + 30 + lnLen + lxLen;
    const raw = u8.subarray(start, start + e.csize);
    const bytes = e.method === 0 ? raw : await inflateRaw(raw);
    return td.decode(bytes);
  };
  return { names: Object.keys(entries), read };
}

const xml = (s) => new DOMParser().parseFromString(s, 'application/xml');
const tags = (node, name) => Array.from(node.getElementsByTagNameNS('*', name));

function colIndex(ref) {
  const m = /^([A-Z]+)/.exec(ref);
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function siText(si) {
  let out = '';
  for (const ch of Array.from(si.children)) {
    const ln = ch.localName;
    if (ln === 't') out += ch.textContent;
    else if (ln === 'r') tags(ch, 't').forEach((t) => { out += t.textContent; });
  }
  return out;
}

function parseSheet(doc, shared) {
  const rows = [];
  for (const c of tags(doc, 'c')) {
    const ref = c.getAttribute('r');
    if (!ref) continue;
    const ri = Number(/(\d+)$/.exec(ref)[1]) - 1;
    const ci = colIndex(ref);
    const t = c.getAttribute('t');
    const vEl = Array.from(c.children).find((x) => x.localName === 'v');
    const v = vEl ? vEl.textContent : '';
    let val;
    if (t === 's') val = shared[Number(v)] ?? '';
    else if (t === 'inlineStr') val = tags(c, 't').map((x) => x.textContent).join('');
    else if (t === 'str') val = v;
    else if (t === 'b') val = v === '1';
    else if (t === 'e') val = '';
    else val = v === '' ? '' : Number(v);
    if (val === '' || val === undefined) continue;
    (rows[ri] ||= [])[ci] = val;
  }
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || [];
    out.push(Array.from({ length: r.length }, (_, k) => (r[k] === undefined ? '' : r[k])));
  }
  return out;
}

// Returns [{name, rows}] for every sheet. rows = array of arrays (numbers stay numbers).
export async function readXlsx(buf) {
  const z = await unzip(buf);
  const wb = z.names.includes('xl/workbook.xml') ? xml(await z.read('xl/workbook.xml')) : null;
  if (!wb) throw new Error('This is not an Excel (.xlsx) workbook');
  const rels = xml(await z.read('xl/_rels/workbook.xml.rels'));
  const target = {};
  tags(rels, 'Relationship').forEach((r) => { target[r.getAttribute('Id')] = r.getAttribute('Target'); });
  const shared = [];
  if (z.names.includes('xl/sharedStrings.xml')) {
    tags(xml(await z.read('xl/sharedStrings.xml')), 'si').forEach((si) => shared.push(siText(si)));
  }
  const sheets = [];
  for (const s of tags(wb, 'sheet')) {
    const rid = s.getAttribute('r:id');
    let path = target[rid] || '';
    path = path.startsWith('/') ? path.slice(1) : 'xl/' + path;
    const txt = await z.read(path);
    if (!txt) continue;
    sheets.push({ name: s.getAttribute('name'), rows: parseSheet(xml(txt), shared) });
  }
  return sheets;
}

export function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const first = text.split(/\r?\n/, 1)[0] || '';
  const delim = [',', ';', '\t'].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      rows.push(row); row = [];
    } else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== '')).map((r) => r.map((c) => {
    const s = String(c).trim();
    return s !== '' && /^-?\d+(\.\d+)?$/.test(s) && !/^0\d/.test(s) ? Number(s) : s;
  }));
}

// Reads a File chosen by the user -> [{name, rows}]
export async function readAnyFile(file) {
  const buf = await file.arrayBuffer();
  const head = new Uint8Array(buf, 0, 2);
  if (head[0] === 0x50 && head[1] === 0x4b) return readXlsx(buf);
  return [{ name: file.name, rows: parseCsv(td.decode(buf)) }];
}

export function toCsv(rows) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return '﻿' + rows.map((r) => r.map(esc).join(',')).join('\r\n');
}

export function download(filename, text, type = 'text/csv;charset=utf-8') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export function excelDateToIso(n) {
  const d = new Date(Date.UTC(1899, 11, 30) + Math.round(Number(n)) * 86400000);
  return d.toISOString().slice(0, 10);
}

// dd.mm.yyyy, dd/mm/yyyy, dd-mm-yyyy, yyyy-mm-dd, or an Excel serial -> yyyy-mm-dd ('' if not understood)
export function toIsoDate(v) {
  if (v === '' || v === null || v === undefined) return '';
  if (typeof v === 'number') return v > 20000 && v < 80000 ? excelDateToIso(v) : '';
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/.exec(s);
  if (m) {
    const y = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return '';
}
