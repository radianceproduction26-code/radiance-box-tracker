// Writes a real Excel workbook (.xlsx) in the browser. No library: an .xlsx is a zip of small XML files.
//
//   makeXlsx([{ name: 'Stock', rows: [[...header], [...], ...], widths: [12, 30, ...], totalRow: true }])  ->  Uint8Array
//   downloadXlsx('stock.xlsx', sheets)
//
// Cell values: string -> text, number -> number (thousands separator), null/'' -> empty,
//              { date: 'YYYY-MM-DD' } -> a real Excel date (dd.mm.yyyy),
//              { at: ISO timestamp }  -> a real Excel date-time in India time (dd.mm.yyyy hh:mm),
//              { text: '5015855' }    -> forced text (same as a string, kept for clarity).
// The first row of every sheet is the header: bold, filled, frozen, with filter buttons.
// totalRow: true makes the last row bold (used for TOTAL rows).

const enc = new TextEncoder();

// ---------------------------------------------------------------- zip (stored, no compression)
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(files) {   // files: [{name, data(Uint8Array)}]
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((Math.max(now.getFullYear(), 1980) - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, size, true); lh.setUint32(22, size, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), name, f.data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true);
    ch.setUint32(20, size, true); ch.setUint32(24, size, true); ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + size;
  }
  const cdSize = central.reduce((s, p) => s + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of all) { out.set(p, o); o += p.length; }
  return out;
}

// ---------------------------------------------------------------- xml helpers
const BAD_XML = /[^\u0009\u000A\u000D -퟿-�]/g;
const x = (s) => String(s).replace(BAD_XML, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function colName(i) {   // 0 -> A, 25 -> Z, 26 -> AA
  let s = '';
  for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}

const serialOfDate = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  return m ? Math.round((Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(1899, 11, 30)) / 86400000) : null;
};
const serialOfInstant = (ts) => {   // India time = UTC + 5:30, stored as a plain (zone-less) Excel date-time
  const t = new Date(ts).getTime();
  return Number.isNaN(t) ? null : (t + 19800000) / 86400000 + 25569;
};

// cellXfs index: 0 plain, 1 header, 2 number, 3 date, 4 date-time, 5 bold text (total), 6 bold number (total)
const S = { plain: 0, head: 1, num: 2, date: 3, dt: 4, boldText: 5, boldNum: 6 };

function cell(v, r, c, head, bold) {
  const ref = colName(c) + (r + 1);
  if (v === null || v === undefined || v === '') return '';
  if (head) return `<c r="${ref}" s="${S.head}" t="inlineStr"><is><t xml:space="preserve">${x(v)}</t></is></c>`;
  if (typeof v === 'object') {
    if (v.date !== undefined) { const n = serialOfDate(v.date); return n === null ? '' : `<c r="${ref}" s="${S.date}"><v>${n}</v></c>`; }
    if (v.at !== undefined) { const n = serialOfInstant(v.at); return n === null ? '' : `<c r="${ref}" s="${S.dt}"><v>${n}</v></c>`; }
    v = v.text !== undefined ? v.text : '';
  }
  if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}" s="${bold ? S.boldNum : S.num}"><v>${v}</v></c>`;
  return `<c r="${ref}" s="${bold ? S.boldText : S.plain}" t="inlineStr"><is><t xml:space="preserve">${x(v)}</t></is></c>`;
}

function sheetXml(sh) {
  const rows = sh.rows.length ? sh.rows : [['']];
  const ncol = Math.max(1, ...rows.map((r) => r.length));
  const widths = sh.widths || Array.from({ length: ncol }, (_, c) => {
    const longest = Math.max(...rows.slice(0, 200).map((r) => {
      const v = r[c];
      if (v === null || v === undefined) return 0;
      if (typeof v === 'object') return v.date !== undefined ? 11 : v.at !== undefined ? 17 : String(v.text || '').length;
      return typeof v === 'number' ? String(Math.abs(v)).length + 3 : String(v).length;
    }));
    return Math.min(60, Math.max(8, longest + 2));
  });
  const last = rows.length - 1;
  const data = rows.map((r, ri) => {
    const bold = !!sh.totalRow && ri === last && ri > 0;
    const cells = Array.from({ length: ncol }, (_, ci) => cell(r[ci], ri, ci, ri === 0, bold)).join('');
    return `<row r="${ri + 1}">${cells}</row>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>
<sheetData>${data}</sheetData>
${rows.length > 1 ? `<autoFilter ref="A1:${colName(ncol - 1)}${sh.totalRow && rows.length > 2 ? rows.length - 1 : rows.length}"/>` : ''}
</worksheet>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="dd\\.mm\\.yyyy"/><numFmt numFmtId="165" formatCode="dd\\.mm\\.yyyy\\ hh:mm"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE3E9EE"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="7">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="3" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

// Excel sheet names: max 31 characters, none of  [ ] : * ? / \  , unique.
function safeNames(sheets) {
  const used = new Set();
  return sheets.map((s, i) => {
    let n = String(s.name || 'Sheet' + (i + 1)).replace(/[\[\]:*?/\\]/g, ' ').replace(/^'+|'+$/g, '').trim().slice(0, 31).trim() || 'Sheet' + (i + 1);
    let k = 2, base = n;
    while (used.has(n.toLowerCase())) { const suf = ' ' + k++; n = base.slice(0, 31 - suf.length) + suf; }
    used.add(n.toLowerCase());
    return n;
  });
}

export function makeXlsx(sheets) {
  if (!sheets.length) throw new Error('Nothing to export');
  const names = safeNames(sheets);
  const files = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${names.map((n, i) => `<sheet name="${x(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', STYLES],
    ...sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)]),
  ];
  return zip(files.map(([name, text]) => ({ name, data: enc.encode(text) })));
}

export function downloadXlsx(filename, sheets) {
  const bytes = makeXlsx(sheets);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
