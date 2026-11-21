// Label: 100 x 50 mm stock, printed 1:1 on a 203 dpi thermal label printer.
// The QR holds only the Box ID. 25.4 mm QR = 203 dots at 203 dpi, 7 dots per module for a 29-module code.
//
// The whole label is laid out in printer DOTS (1 dot = 25.4 / 203 mm), so every line is exactly 6 dots (0.75 mm) thick and
// sits on a whole dot: sharp, even lines, outside and inside. The lines are drawn as one vector shape (not as CSS borders and not as
// background colours), so they print whatever the browser's "Background graphics" option says and even if an old app.css is cached.
// Everything is kept 1.5 mm away from the edge of the label, so the outer line is never cut off if the label feeds a little off.
import { qrSvg } from './qr.js';

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function dmy(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  return m ? `${m[3]}.${m[2]}.${m[1]}` : esc(iso || '');
}

// The page is the label: 100 x 50 mm, no margins, printed at 100% (the printer must not have to shrink it).
if (typeof document !== 'undefined' && !document.getElementById('label-page-size')) {
  const st = document.createElement('style');
  st.id = 'label-page-size';
  st.textContent = '@page{size:100mm 50mm;margin:0}';
  document.head.appendChild(st);
}

const DOT = 25.4 / 203;                       // one printer dot, in mm
const mm = (d) => (d * DOT).toFixed(3) + 'mm';
const T = 6;                                  // line thickness in dots (0.75 mm)
const X = [12, 218, 522, 782];                // left edge of each vertical line:   outer left | label | value | outer right
const Y = [12, 64, 106, 165, 219, 273, 327, 381];   // top edge of each horizontal line: top | under header | under Unique Code | under Part No | rows… | bottom
const BOTTOM = Y[7] + T, RIGHT = X[3] + T;

const R = (x, y, w, h) => `M${x} ${y}h${w}v${h}h${-w}z`;
const fullLine = (y) => R(X[0], y, RIGHT - X[0], T);                // across the whole label
const leftLine = (y) => R(X[0], y, X[2] + T - X[0], T);             // only across the label + value columns (the QR cell is one tall box)
const LINES = [
  fullLine(Y[0]), fullLine(Y[1]), fullLine(Y[2]), fullLine(Y[3]), leftLine(Y[4]), leftLine(Y[5]), leftLine(Y[6]), fullLine(Y[7]),
  R(X[0], Y[0], T, BOTTOM - Y[0]),            // outer left
  R(X[3], Y[0], T, BOTTOM - Y[0]),            // outer right
  R(X[1], Y[2], T, BOTTOM - Y[2]),            // label | value
  R(X[2], Y[0], T, Y[1] + T - Y[0]),          // RADIANCE POLYMERS | ACCEPTED
  R(X[2], Y[2], T, BOTTOM - Y[2]),            // value | Box ID + QR
].join('');
const FRAME = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${(100 / DOT).toFixed(4)} ${(50 / DOT).toFixed(4)}" style="position:absolute;left:0;top:0;width:100mm;height:50mm;display:block" shape-rendering="crispEdges"><path d="${LINES}" fill="#000"/></svg>`;

// Text boxes sit exactly between the lines. k = first row, k2 = last row (rows: 0 header, 1 Unique Code, 2 Part No, 3 Part Name, 4 Qty, 5 Date, 6 QA sign).
const COL = { all: [X[0] + T, X[3] - X[0] - T], head: [X[0] + T, X[2] - X[0] - T], lab: [X[0] + T, X[1] - X[0] - T], val: [X[1] + T, X[2] - X[1] - T], right: [X[2] + T, X[3] - X[2] - T] };
const cell = (cls, inner, col, k, extra = '', k2 = k) => {
  const [x, w] = COL[col], top = Y[k] + T, h = Y[k2 + 1] - top;
  return `<div${cls ? ` class="${cls}"` : ''} style="position:absolute;left:${mm(x)};top:${mm(top)};width:${mm(w)};height:${mm(h)};box-sizing:border-box;display:flex;align-items:center;overflow:hidden;white-space:nowrap;font-weight:700;padding:0 1mm;border:0;background:none;line-height:1.1;${extra}">${inner}</div>`;
};
const LAB = 'font-size:10pt';                 // "Part No:-", "QTY :-" …
const VAL = 'font-size:12.5pt';

export function labelHtml(b) {
  const uc = esc(b.lot || '');   // Unique Code = the Lot / batch code typed by the user when the labels were made (the Box ID is printed in its own place, with the QR)
  const qr = qrSvg(b.box_id, 2).replace('<svg ', '<svg style="width:25.4mm;height:25.4mm;display:block" ');
  return `<div class="lb" style="position:relative;display:block;box-sizing:border-box;width:100mm;height:49.9mm;margin:0;padding:0;border:0;background:#fff;overflow:hidden;font-family:Arial,Helvetica,sans-serif;color:#000;-webkit-print-color-adjust:exact;print-color-adjust:exact">${FRAME}
${cell('h', 'RADIANCE POLYMERS', 'head', 0, 'font-size:13pt')}${cell('ac', 'ACCEPTED', 'right', 0, 'font-size:13pt;letter-spacing:.3mm;justify-content:center;padding:0')}
${cell('uc', `Unique Code:- ${uc}`, 'all', 1, 'font-size:10pt')}
${cell('', 'Part No:-', 'lab', 2, LAB)}${cell('v', esc(b.part_no), 'val', 2, 'font-size:15pt')}${cell('bid', `<span style="font-size:7pt">BOX ID</span><b style="font-size:8.5pt">${esc(b.box_id)}</b>`, 'right', 2, 'flex-direction:column;justify-content:center;text-align:center;white-space:nowrap;padding:0')}
${cell('', 'Part Name:-', 'lab', 3, LAB)}${cell('v', esc(b.part_name), 'val', 3, VAL)}${cell('qr', qr, 'right', 3, 'justify-content:center;padding:0', 6)}
${cell('', 'QTY :-', 'lab', 4, LAB)}${cell('v', `${esc(b.qty)} NOS`, 'val', 4, VAL)}
${cell('', 'Date:-', 'lab', 5, LAB)}${cell('v', dmy(b.label_date), 'val', 5, VAL)}
${cell('', 'QA Sign:-', 'lab', 6, LAB)}${cell('v', esc(b.qa_sign), 'val', 6, VAL)}</div>`;
}

export const labelsHtml = (rows) => rows.map(labelHtml).join('');

// Measured fit: long part names, lots or QA names are shrunk (then wrapped onto two lines) until nothing is cut off.
// Must run while the labels are laid out (not display:none).
export function fitLabels(root) {
  const over = (d, room = 0) => d.scrollWidth > d.clientWidth + 1 || d.scrollHeight > d.clientHeight + 1 - room;   // room: px of free space wanted above/below wrapped text, so it never touches the lines
  root.querySelectorAll('.lb > .v, .lb > .uc').forEach((d) => {
    if (!over(d)) return;
    const base = parseFloat(getComputedStyle(d).fontSize) * 0.75;      // px -> pt
    let s = base;
    const set = () => { d.style.fontSize = s.toFixed(1) + 'pt'; };
    while (over(d) && s > 7.5) { s -= 0.5; set(); }                      // 1) one line, smaller
    if (over(d) && d.classList.contains('v')) {                          // 2) two lines
      d.style.whiteSpace = 'normal'; d.style.overflowWrap = 'anywhere'; d.style.lineHeight = '1.05';
      s = Math.min(base, 10.5); set();
      while (over(d, 5) && s > 6) { s -= 0.5; set(); }
    }
  });
}

// Puts the labels into #print-area and opens the print dialog (silent when Chrome runs with --kiosk-printing).
export function printLabels(rows) {
  const area = document.getElementById('print-area');
  area.innerHTML = labelsHtml(rows);
  area.style.cssText = 'display:block;position:absolute;left:-9999px;top:0';   // lay out off-screen so text can be measured
  fitLabels(area);
  area.style.cssText = '';
  const clear = () => { area.innerHTML = ''; window.removeEventListener('afterprint', clear); };
  window.addEventListener('afterprint', clear);
  requestAnimationFrame(() => window.print());
}
