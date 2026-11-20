// Offline queue for FG inward scans (Phase 6).
//
// A scan that cannot reach the server is kept on this phone and sent by itself when the connection is back. It is sent together with
// the time it was really scanned (receive_box has p_scanned_at), so stock-on-a-date and the ledger stay right.
//
// How it stays safe:
//  - The list lives in localStorage, one list per login, so it survives closing the app or restarting the phone.
//    (In a private tab the browser may refuse storage; then the queue works until the page is closed. persisted() says which.)
//  - Sending a box twice is harmless: the second answer is "already FG-RECEIVED", which counts as done.
//  - A box the server refuses (not in register, voided, already dispatched) stays in the list as "not accepted" until the person removes it.
//  - Only FG inward is queued. Printing labels and packing slips need numbers made by the server, so they stay online-only.
import * as api from './api.js';
import { CONFIG } from './config.js';
import { toast } from './ui.js';

const WAITING = ['queued', 'sending'];
const subs = new Set();
let uid = null, items = [], online = typeof navigator === 'undefined' || navigator.onLine !== false, flushing = false, wired = false, canStore = true;

const key = () => `rbt.queue.${uid}`;

function load() {
  items = [];
  try {
    const a = JSON.parse(localStorage.getItem(key()) || '[]');
    if (Array.isArray(a)) items = a.filter((i) => i && typeof i.box_id === 'string' && typeof i.at === 'string');
  } catch (_) { /* unreadable: start empty */ }
  items.forEach((i) => { if (i.status === 'sending') i.status = 'queued'; });   // the page was closed while sending: just send again
}

function save() {
  if (!uid) return;
  try { localStorage.setItem(key(), JSON.stringify(items)); } catch (_) { canStore = false; }
}

function emit(ev = {}) { subs.forEach((f) => { try { f(ev); } catch (_) { /* a screen that is gone */ } }); }
function setOnline(v) { if (online !== v) { online = v; emit(); } }

// No answer, or a server that is busy / restarting (HTTP 5xx, 429, 408): the scan is not lost, try again later.
// Any other answer (a refusal, a missing right) is final and is shown to the person.
const transient = (e) => e.code === 'network' || e.status >= 500 || e.status === 429 || e.status === 408;

export const isOnline = () => online;
export const persisted = () => canStore;
export const waiting = () => items.filter((i) => WAITING.includes(i.status));
export const problems = () => items.filter((i) => i.status === 'rejected');
export const all = () => items.slice();
export function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }

// Call once the person is signed in (safe to call on every page: it does nothing when the login is already loaded).
export function initQueue(userId) {
  if (!wired) {
    wired = true;
    try { localStorage.setItem('rbt.probe', '1'); localStorage.removeItem('rbt.probe'); } catch (_) { canStore = false; }
    window.addEventListener('online', () => { setOnline(true); flush(); });
    window.addEventListener('offline', () => setOnline(false));
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') flush(); });
    setInterval(() => { if (waiting().length) flush(); }, CONFIG.QUEUE_RETRY_MS);
  }
  if (uid !== userId) { uid = userId; load(); emit(); flush(); }
}

// Sign-out: forget the list in memory. What is stored on the phone stays there for the next sign-in of the same login.
export function stopQueue() { uid = null; items = []; emit(); }

function enqueue(boxId, rack, at) {
  const item = { n: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, box_id: boxId, rack: rack || '', at, status: 'queued', msg: '' };
  items.push(item); save(); emit();
  return item;
}

export function dismiss(n) { items = items.filter((i) => i.n !== n); save(); emit(); }

// Receive one box. Returns { r } when the server answered, or { queued: true, item, already? } when it was kept on the phone.
// Throws for real errors (for example a login that may not receive boxes).
export async function receiveOrQueue(boxId, rack) {
  const at = new Date().toISOString();   // the moment of the scan, kept even if the answer takes a while
  const have = items.find((i) => i.box_id === boxId && WAITING.includes(i.status));
  if (have) return { queued: true, already: true, item: have };
  if (online) {
    try {
      const r = await api.rpc('receive_box', { p_box_id: boxId, p_rack: rack || null, p_device: CONFIG.DEVICE }, { timeoutMs: CONFIG.SCAN_TIMEOUT_MS });
      setOnline(true);
      if (waiting().length) flush();
      return { r };
    } catch (e) {
      if (!transient(e)) throw e;
      setOnline(false);
    }
  }
  return { queued: true, item: enqueue(boxId, rack, at) };
}

// Send everything that is waiting, oldest first. Stops at the first sign that the connection is still down.
export async function flush() {
  if (flushing || !uid || !waiting().length) return;
  const mine = uid, out = { sent: 0, dup: 0, rejected: 0 };
  flushing = true;
  try {
    for (const it of items.filter((i) => i.status === 'queued')) {
      if (uid !== mine) break;
      it.status = 'sending'; emit();
      let r;
      try {
        r = await api.rpc('receive_box', { p_box_id: it.box_id, p_rack: it.rack || null, p_device: CONFIG.DEVICE, p_scanned_at: it.at }, { timeoutMs: CONFIG.SCAN_TIMEOUT_MS * 2 });
      } catch (e) {
        it.status = 'queued';
        if (transient(e)) { setOnline(false); it.msg = e.code === 'network' ? '' : 'Server busy, will try again'; }
        else if (e.code !== 'expired' && e.code !== 'no_session') { it.status = 'rejected'; it.msg = e.message || 'Not accepted'; out.rejected++; }
        save(); emit();
        if (it.status === 'rejected') continue;
        break;   // no connection, or the login has ended: try again later
      }
      setOnline(true);
      if (r && r.ok) { dismissQuiet(it); out.sent++; }
      else if (r && /: already FG-RECEIVED/.test(r.msg || '')) { dismissQuiet(it); out.dup++; }   // sent before (answer was lost) or scanned by someone else: nothing more to do
      else { it.status = 'rejected'; it.msg = (r && r.msg) || 'Not accepted'; out.rejected++; }
      save(); emit();
    }
  } finally {
    flushing = false;
    if (uid === mine) save();
    emit(out);
    if (uid === mine) report(out);
  }
}

function dismissQuiet(it) { items = items.filter((i) => i.n !== it.n); }

function report({ sent, dup, rejected }) {
  if (sent) toast(`${sent} saved scan${sent > 1 ? 's' : ''} sent to the server`);
  if (dup) toast(`${dup} box${dup > 1 ? 'es were' : ' was'} already received. Nothing more to do`);
  if (rejected) toast(`${rejected} scan${rejected > 1 ? 's were' : ' was'} not accepted. Open FG inward to see why`, true);
}
