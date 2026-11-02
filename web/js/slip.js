// Packing slip PDF: "Delivery challan cum Packing Slip" (same layout as the old kit) + Box ID list pages.
import { Pdf } from './pdf.js';
import { COMPANY } from './config.js';

const COLS = [9, 32, 24, 22, 15, 21, 21, 20, 26];            // mm, total 190
const X0 = 10, TOP = 8, ROW = 6.2, MAX_ROWS = 32, MIN_ROWS = 20;
const HEAD = ['Sr no.', 'PART NO', 'PP BOX NO.', 'TRAY NO.', 'TRAY QTY.', 'PER BOX QTY', 'BOX DISP QTY', 'TOTAL QTY', 'Remark'];
const GREY = 0.9;

// "30-10-2026 09:22" in India time
export function istStamp(iso) {
  if (!iso) return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.day}-${p.month}-${p.year} ${p.hour}:${p.minute}`;
}

// One line per (part, qty per box): boxes of the same part and size are counted together
export function groupBoxes(boxes) {
  const m = new Map();
  for (const b of [...boxes].sort((a, c) => (a.part_no < c.part_no ? -1 : a.part_no > c.part_no ? 1 : c.qty - a.qty || (a.box_id < c.box_id ? -1 : 1)))) {
    const k = b.part_no + '|' + b.qty;
    const g = m.get(k) || { part: b.part_no, box: '', tray: '', per: b.qty, n: 0 };
    g.n++; g.box = g.box || b.pp_box_code || ''; g.tray = g.tray || b.tray_no || '';
    m.set(k, g);
  }
  return [...m.values()];
}

function pageFrame(pdf, s, y) {          // the header block; returns y below it
  const xs = [X0]; COLS.forEach((w) => xs.push(xs[xs.length - 1] + w));
  const cellAt = (a, b, yy, h, text, o = {}, fill = null) => {
    pdf.rect(xs[a], yy, xs[b + 1] - xs[a], h, { stroke: 0.4, fill });
    pdf.cell(text, xs[a], yy, xs[b + 1] - xs[a], h, o);
  };
  const when = istStamp(s.created_at);
  cellAt(0, 8, y, 10, COMPANY.NAME, { size: 20, bold: true, align: 'c' }); y += 10;
  cellAt(0, 8, y, 9, COMPANY.ADDRESS, { size: 7.5, align: 'c' }); y += 9;
  cellAt(0, 6, y, 7, 'Delivery challan cum Packing Slip', { size: 11, bold: true }); cellAt(7, 7, y, 7, 'DATE:', { size: 8.5, align: 'c' }); cellAt(8, 8, y, 7, when, { size: 7.2, align: 'c' }); y += 7;
  const B = { size: 7.2, bold: true };
  cellAt(0, 2, y, 7, 'PARTY NAME - ' + s.party, B); cellAt(3, 4, y, 7, 'Inv. No. ' + (s.inv_no || ''), B); cellAt(5, 6, y, 7, 'LOCATION : ' + (s.location || ''), B);
  cellAt(7, 7, y, 7, 'VEHICLE NO', B); cellAt(8, 8, y, 7, s.vehicle || '', B); y += 7;
  cellAt(0, 2, y, 7, 'DISP.EXE - ' + (s.disp_exe || ''), B); cellAt(3, 4, y, 7, 'Slip No. ' + s.slip_no, B); cellAt(5, 6, y, 7, 'TRANSPORT - ' + (s.transport || ''), B);
  cellAt(7, 7, y, 7, 'LR NO.', B); cellAt(8, 8, y, 7, s.lr_no || '', B); y += 7;
  HEAD.forEach((h, i) => cellAt(i, i, y, 9, h, { size: 6.8, bold: true, align: 'c' }, GREY)); y += 9;
  return { y, xs, cellAt };
}

export function slipPdf(slip, boxes) {
  const s = slip, items = groupBoxes(boxes);
  const pdf = new Pdf({ title: s.slip_no, author: COMPANY.NAME, subject: 'Delivery challan cum Packing Slip ' + s.slip_no });
  const pages = Math.max(1, Math.ceil(items.length / MAX_ROWS));
  const tpb = COMPANY.TRAYS_PER_BOX;
  const totals = {
    trays: items.reduce((a, x) => a + (x.tray ? x.n * tpb : 0), 0),
    boxes: items.reduce((a, x) => a + x.n, 0),
    qty: items.reduce((a, x) => a + x.per * x.n, 0),
  };
  for (let pg = 0; pg < pages; pg++) {
    pdf.addPage();
    const { y: y0, xs, cellAt } = pageFrame(pdf, s, TOP);
    let y = y0;
    const slice = items.slice(pg * MAX_ROWS, (pg + 1) * MAX_ROWS);
    const last = pg === pages - 1;
    const rows = last ? Math.max(slice.length, MIN_ROWS) : MAX_ROWS;
    for (let i = 0; i < rows; i++) {
      const x = slice[i];
      const base = { size: 8.5, align: 'c' };
      const sr = pg * MAX_ROWS + i + 1;
      cellAt(0, 0, y, ROW, String(sr), base);
      cellAt(1, 1, y, ROW, x ? x.part : '', { size: 8.5, align: 'l' });
      cellAt(2, 2, y, ROW, x ? x.box : '', base);
      cellAt(3, 3, y, ROW, x ? x.tray : '', base);
      cellAt(4, 4, y, ROW, x && x.tray ? String(x.n * tpb) : '', base);
      cellAt(5, 5, y, ROW, x ? String(x.per) : '', base);
      cellAt(6, 6, y, ROW, x ? String(x.n) : '', base);
      cellAt(7, 7, y, ROW, x ? String(x.per * x.n) : '', base);
      cellAt(8, 8, y, ROW, '', base);
      y += ROW;
    }
    if (last) {
      const T = { size: 9, bold: true, align: 'c' };
      cellAt(0, 3, y, 7, 'TOTAL', T); cellAt(4, 4, y, 7, totals.trays || '', T); cellAt(5, 5, y, 7, '', T);
      cellAt(6, 6, y, 7, String(totals.boxes), T); cellAt(7, 7, y, 7, String(totals.qty), T); cellAt(8, 8, y, 7, '', T); y += 7;
      const F = { size: 8, bold: true, align: 'c' };
      cellAt(0, 3, y, 8, 'INVOICE CREATER NAME & SIGN.', F); cellAt(4, 6, y, 24, 'STAMP', F); cellAt(7, 8, y, 8, 'DRIVER NAME : ' + (s.driver_name || ''), F);
      cellAt(0, 3, y + 8, 8, COMPANY.INVOICE_CREATOR, F); cellAt(7, 8, y + 8, 8, 'DRIVER MOB : ' + (s.driver_mob || ''), F);
      cellAt(0, 3, y + 16, 8, '', F); cellAt(7, 8, y + 16, 8, 'Sign', F);
    }
    if (pages > 1) pdf.text(`Sheet ${pg + 1} of ${pages}`, X0 + 190, 292.5, { size: 7, align: 'r', color: 0.4 });
  }

  // Box ID list (so the store can tick the physical boxes)
  const sorted = [...boxes].sort((a, c) => (a.part_no < c.part_no ? -1 : a.part_no > c.part_no ? 1 : a.box_id < c.box_id ? -1 : 1));
  if (sorted.length) {
    const W = [12, 50, 45, 24, 50], per = 40, n = Math.ceil(sorted.length / per);
    for (let pg = 0; pg < n; pg++) {
      pdf.addPage();
      pdf.text(`Box ID list for ${s.slip_no} (${sorted.length} boxes)${n > 1 ? ` · page ${pg + 1} of ${n}` : ''}`, X0, 18, { size: 12, bold: true });
      let y = 24; const xs = [X0]; W.forEach((w) => xs.push(xs[xs.length - 1] + w));
      ['Sr', 'Box ID', 'Part No', 'Qty', 'FG inward at'].forEach((h, i) => { pdf.rect(xs[i], y, W[i], 7, { stroke: 0.3, fill: GREY }); pdf.cell(h, xs[i], y, W[i], 7, { size: 8.5, bold: true }); });
      y += 7;
      sorted.slice(pg * per, (pg + 1) * per).forEach((b, i) => {
        [String(pg * per + i + 1), b.box_id, b.part_no, String(b.qty), istStamp(b.fg_at)].forEach((t, j) => { pdf.rect(xs[j], y, W[j], 6, { stroke: 0.25 }); pdf.cell(t, xs[j], y, W[j], 6, { size: 8.5 }); });
        y += 6;
      });
    }
  }
  return pdf.finish();
}

// ---- delivering the PDF (works on iPhone Safari and desktop)
export function downloadPdf(name, bytes) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
// Opens the phone's share sheet (Print, WhatsApp, Save to Files...) when the browser can share files; otherwise downloads.
export async function sharePdf(name, bytes) {
  try {
    const file = new File([bytes], name, { type: 'application/pdf' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return 'shared'; }
  } catch (e) { if (e && e.name === 'AbortError') return 'cancelled'; }
  downloadPdf(name, bytes);
  return 'downloaded';
}
