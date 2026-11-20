// Label sheet: 101.6 x 63.5 mm, same layout and fields as the original kit.
// The QR holds only the Box ID. 25.4 mm QR = 203 dots at 203 dpi, 7 dots per module for a 29-module code.
import { qrSvg } from './qr.js';

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function dmy(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  return m ? `${m[3]}.${m[2]}.${m[1]}` : esc(iso || '');
}

// The lines of the label are REAL borders written straight into each label (not taken from the style sheet, and not a background colour).
// So they print whatever the browser's "Background graphics" option says, and even if an old copy of app.css is still cached.
// 3 px = 0.8 mm = about 6 dots on a 203 dpi label printer. (Chrome rounds border widths to whole pixels.)
const LINE = '3px solid #000';
const BOX = `box-sizing:border-box;gap:0;padding:0;background:#fff;border-top:${LINE};border-left:${LINE};-webkit-print-color-adjust:exact;print-color-adjust:exact`;
const CELL = `background:#fff;border-right:${LINE};border-bottom:${LINE};min-width:0`;
const cell = (cls, inner, extra = '') => `<div${cls ? ` class="${cls}"` : ''} style="${CELL}${extra}">${inner}</div>`;

export function labelHtml(b) {
  const uc = `${esc(b.box_id)}/${dmy(b.label_date)}${b.lot ? '/' + esc(b.lot) : ''}`;
  return `<div class="lb" style="${BOX}">
${cell('h', 'RADIANCE POLYMERS', ';grid-column:1/3')}${cell('ac', 'ACCEPTED')}
${cell('uc', `Unique Code:- ${uc}`)}
${cell('', 'Part No:-')}${cell('v', esc(b.part_no))}${cell('bid', `<span>BOX ID</span><b>${esc(b.box_id)}</b>`)}
${cell('', 'Part Name:-')}${cell('v', esc(b.part_name))}${cell('', 'QTY :-')}${cell('v', `${esc(b.qty)} NOS`)}${cell('qr', qrSvg(b.box_id, 2))}
${cell('', 'Date:-')}${cell('v', dmy(b.label_date))}${cell('', 'QA Sign:-')}${cell('v', esc(b.qa_sign))}</div>`;
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
