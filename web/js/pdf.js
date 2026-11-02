// Minimal PDF writer for the packing slip: A4 pages, Helvetica / Helvetica-Bold, lines, boxes and text.
// No outside library (the app must work without npm or a CDN). Coordinates are in millimetres from the top-left corner.

const PT = 72 / 25.4;
const PAGE_W = 210, PAGE_H = 297;
// Helvetica glyph widths (per 1000 em) for WinAnsi codes 32..255
const W_REG = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584,761,556,278,222,556,333,1000,556,556,333,1000,667,333,1000,278,611,278,278,222,222,333,333,350,556,1000,333,1000,500,333,944,278,500,667,278,333,556,556,556,556,260,556,333,737,370,556,584,333,737,333,400,584,333,333,333,556,537,278,333,333,365,556,834,834,834,611,667,667,667,667,667,667,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,500,556,556,556,556,278,278,278,278,556,556,556,556,556,556,556,584,611,556,556,556,556,500,556,500];
const W_BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584,761,556,278,278,556,500,1000,556,556,333,1000,667,333,1000,278,611,278,278,278,278,500,500,350,556,1000,333,1000,556,333,944,278,500,667,278,333,556,556,556,556,280,556,333,737,370,556,584,333,737,333,400,584,333,333,333,611,556,278,333,333,365,556,834,834,834,611,722,722,722,722,722,722,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,556,556,556,556,556,556,889,556,556,556,556,556,278,278,278,278,611,611,611,611,611,611,611,584,611,611,611,611,611,556,611,556];
const CP1252_80 = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ';

// Unicode text -> one WinAnsi byte per character ('?' when there is no such character)
export function winAnsi(s) {
  let out = '';
  for (const ch of String(s ?? '')) {
    const c = ch.codePointAt(0);
    if (c >= 32 && c <= 126) out += ch;
    else if (c >= 160 && c <= 255) out += ch;
    else if (CP1252_80.includes(ch)) out += String.fromCharCode(128 + CP1252_80.indexOf(ch));
    else if (c === 9 || c === 10 || c === 13) out += ' ';
    else out += '?';
  }
  return out;
}

export function textWidth(s, size, bold = false) {          // in mm
  const t = bold ? W_BOLD : W_REG;
  let w = 0;
  for (const ch of winAnsi(s)) w += t[ch.charCodeAt(0) - 32] ?? 556;
  return (w * size / 1000) / PT;
}

const esc = (s) => winAnsi(s).replace(/[\\()]/g, (c) => '\\' + c);
const n = (v) => (Math.round(v * 1000) / 1000).toString();
const colour = (c) => (Array.isArray(c) ? c : [c, c, c]).map(n).join(' ');

export class Pdf {
  constructor({ title = '', author = '', subject = '' } = {}) { this.meta = { title, author, subject }; this.pages = []; this.cur = null; }
  addPage() { this.cur = []; this.pages.push(this.cur); return this; }
  _y(y) { return n((PAGE_H - y) * PT); }
  _x(x) { return n(x * PT); }
  line(x1, y1, x2, y2, w = 0.3, c = 0) {
    this.cur.push(`${colour(c)} RG ${n(w * PT)} w ${this._x(x1)} ${this._y(y1)} m ${this._x(x2)} ${this._y(y2)} l S`);
  }
  rect(x, y, w, h, { stroke = 0.3, fill = null, strokeColor = 0 } = {}) {
    const ops = [];
    if (fill !== null) ops.push(`${colour(fill)} rg`);
    if (stroke) ops.push(`${colour(strokeColor)} RG ${n(stroke * PT)} w`);
    ops.push(`${this._x(x)} ${this._y(y + h)} ${n(w * PT)} ${n(h * PT)} re ${fill !== null && stroke ? 'B' : fill !== null ? 'f' : stroke ? 'S' : 'n'}`);
    this.cur.push(ops.join(' '));
  }
  // text with its baseline at y
  text(str, x, y, { size = 9, bold = false, align = 'l', color = 0 } = {}) {
    const w = textWidth(str, size, bold);
    const x0 = align === 'c' ? x - w / 2 : align === 'r' ? x - w : x;
    this.cur.push(`BT ${colour(color)} rg /${bold ? 'F2' : 'F1'} ${n(size)} Tf ${this._x(x0)} ${this._y(y)} Td (${esc(str)}) Tj ET`);
  }
  // text centred vertically in a box; shrinks (down to minSize) until it fits the width
  cell(str, x, y, w, h, { size = 9, bold = false, align = 'l', pad = 1.4, minSize = 4.5, color = 0 } = {}) {
    str = String(str ?? '');
    if (!str) return;
    let s = size;
    while (s > minSize && textWidth(str, s, bold) > w - 2 * pad) s -= 0.25;
    const baseline = y + h / 2 + (s / PT) * 0.35;
    const tx = align === 'c' ? x + w / 2 : align === 'r' ? x + w - pad : x + pad;
    this.text(str, tx, baseline, { size: s, bold, align, color });
  }
  finish() {
    const objs = [];
    const add = (body) => { objs.push(body); return objs.length; };
    add('<< /Type /Catalog /Pages 2 0 R >>');                                        // 1
    add('');                                                                         // 2 (pages, filled below)
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');       // 3
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');  // 4
    const stamp = new Date();
    const d = `D:${stamp.getUTCFullYear()}${String(stamp.getUTCMonth() + 1).padStart(2, '0')}${String(stamp.getUTCDate()).padStart(2, '0')}${String(stamp.getUTCHours()).padStart(2, '0')}${String(stamp.getUTCMinutes()).padStart(2, '0')}${String(stamp.getUTCSeconds()).padStart(2, '0')}Z`;
    add(`<< /Title (${esc(this.meta.title)}) /Author (${esc(this.meta.author)}) /Subject (${esc(this.meta.subject)}) /Creator (Radiance Box Tracker) /Producer (Radiance Box Tracker) /CreationDate (${d}) >>`); // 5
    const kids = [];
    for (const ops of this.pages) {
      const stream = ops.join('\n');
      const c = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
      const p = add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(PAGE_W * PT)} ${n(PAGE_H * PT)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${c} 0 R >>`);
      kids.push(`${p} 0 R`);
    }
    objs[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`;
    let out = '%PDF-1.4\n%âãÏÓ\n';
    const offs = [];
    objs.forEach((b, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${b}\nendobj\n`; });
    const xref = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
    out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const bytes = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 255;
    return bytes;
  }
}
