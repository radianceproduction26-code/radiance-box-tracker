import { esc } from './labels.js';
export { esc };

export const $ = (root, sel) => root.querySelector(sel);
export const $$ = (root, sel) => Array.from(root.querySelectorAll(sel));

export function toast(text, bad = false) {
  const box = document.getElementById('toast');
  const d = document.createElement('div');
  if (bad) d.className = 'bad';
  d.textContent = text;
  box.appendChild(d);
  setTimeout(() => d.remove(), bad ? 6000 : 3000);
}

// Disables a button while an async job runs; shows errors as toasts.
export async function busy(btn, fn) {
  const label = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Please wait…'; }
  try { return await fn(); }
  catch (e) { toast(e.message || String(e), true); }
  finally { if (btn) { btn.disabled = false; btn.textContent = label; } }
}

export const todayIst = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
export function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export const fmtTs = (ts) => (ts ? new Date(ts).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', dateStyle: 'short', timeStyle: 'short' }) : '');
export const fmtNum = (n) => Number(n || 0).toLocaleString('en-IN');
export const fmtDay = (iso) => (iso ? iso.split('-').reverse().join('.') : '');

export const msg = (kind, html) => `<div class="msg ${kind}">${html}</div>`;
export const pill = (s) => `<span class="pill ${esc(s)}">${esc(s)}</span>`;

// cols: [{k, label, n (right-align), html (render fn returning trusted html), fmt (fn returning text)}]
export function table(cols, rows, emptyText = 'Nothing to show.') {
  if (!rows.length) return `<div class="tw"><div class="empty">${esc(emptyText)}</div></div>`;
  const head = cols.map((c) => `<th class="${c.n ? 'n' : ''}">${esc(c.label)}</th>`).join('');
  const body = rows.map((r) => `<tr>${cols.map((c) => {
    const v = c.html ? c.html(r) : esc(c.fmt ? c.fmt(r[c.k], r) : r[c.k]);
    return `<td class="${c.n ? 'n' : ''}${c.cls ? ' ' + c.cls : ''}">${v}</td>`;
  }).join('')}</tr>`).join('');
  return `<div class="tw"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

// PostgREST filter values: strip characters that have meaning in the query syntax.
export const q = (s) => String(s).replace(/[(),*%\\]/g, '').trim();
