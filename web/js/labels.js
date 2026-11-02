// Label sheet: 101.6 x 63.5 mm, same layout and fields as the original kit.
// The QR holds only the Box ID. 25.4 mm QR = 203 dots at 203 dpi, 7 dots per module for a 29-module code.
import { qrSvg } from './qr.js';

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function dmy(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  return m ? `${m[3]}.${m[2]}.${m[1]}` : esc(iso || '');
}

export function labelHtml(b) {
  const uc = `${esc(b.box_id)}/${dmy(b.label_date)}${b.lot ? '/' + esc(b.lot) : ''}`;
  return `<div class="lb">
<div class="h" style="grid-column:1/3">RADIANCE POLYMERS</div><div class="ac">ACCEPTED</div>
<div class="uc">Unique Code:- ${uc}</div>
<div>Part No:-</div><div class="v">${esc(b.part_no)}</div><div class="bid"><span>BOX ID</span><b>${esc(b.box_id)}</b></div>
<div>Part Name:-</div><div class="v">${esc(b.part_name)}</div><div>QTY :-</div><div class="v">${esc(b.qty)} NOS</div><div class="qr">${qrSvg(b.box_id, 2)}</div>
<div>Date:-</div><div class="v">${dmy(b.label_date)}</div><div>QA Sign:-</div><div class="v">${esc(b.qa_sign)}</div></div>`;
}

export const labelsHtml = (rows) => rows.map(labelHtml).join('');

// Measured fit: long part names, lots or QA names are shrunk (then wrapped onto two lines) until nothing is cut off.
// Must run while the labels are laid out (not display:none).
export function fitLabels(root) {
  const over = (d) => d.scrollWidth > d.clientWidth + 1 || d.scrollHeight > d.clientHeight + 1;
  root.querySelectorAll('.lb > .v, .lb > .uc').forEach((d) => {
    if (!over(d)) return;
    const base = parseFloat(getComputedStyle(d).fontSize) * 0.75;      // px -> pt
    let s = base;
    const set = () => { d.style.fontSize = s.toFixed(1) + 'pt'; };
    while (over(d) && s > 7.5) { s -= 0.5; set(); }                      // 1) one line, smaller
    if (over(d) && d.classList.contains('v')) {                          // 2) two lines
      d.style.whiteSpace = 'normal'; d.style.overflowWrap = 'anywhere'; d.style.lineHeight = '1.05';
      s = Math.min(base, 10.5); set();
      while (over(d) && s > 6) { s -= 0.5; set(); }
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
