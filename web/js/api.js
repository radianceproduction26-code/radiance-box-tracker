// Small Supabase client using plain fetch (Auth + PostgREST). No library needed.
import { CONFIG } from './config.js';

const KEY = 'rbt.session';
let session = null;
try { session = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (_) { session = null; }

function save(s) {
  session = s;
  try { s ? localStorage.setItem(KEY, JSON.stringify(s)) : localStorage.removeItem(KEY); } catch (_) { /* private mode */ }
}

export class ApiError extends Error {
  constructor(message, status = 0, code = '') { super(message); this.status = status; this.code = code; }
}

const base = () => CONFIG.SUPABASE_URL.replace(/\/$/, '');
const now = () => Math.floor(Date.now() / 1000);

async function raw(url, opts) {
  let res;
  try { res = await fetch(url, opts); }
  catch (e) { throw new ApiError('Cannot reach the server. Check the internet connection and try again.', 0, 'network'); }
  return res;
}

async function errorFrom(res) {
  let j = null;
  try { j = await res.json(); } catch (_) { /* not json */ }
  const msg = (j && (j.message || j.msg || j.error_description || j.error)) || `Server error ${res.status}`;
  return new ApiError(msg, res.status, (j && (j.code || j.error_code)) || '');
}

const authHeaders = (extra = {}) => ({ apikey: CONFIG.SUPABASE_KEY, 'Content-Type': 'application/json', ...extra });

export const user = () => (session ? session.user : null);
export const signedIn = () => !!session;

export async function signIn(email, password) {
  const res = await raw(`${base()}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: authHeaders(), body: JSON.stringify({ email: email.trim(), password }),
  });
  if (!res.ok) {
    const e = await errorFrom(res);
    if (e.status === 400) e.message = 'Wrong email or password.';
    throw e;
  }
  const j = await res.json();
  save({ access_token: j.access_token, refresh_token: j.refresh_token, expires_at: j.expires_at || now() + (j.expires_in || 3600), user: j.user });
}

let refreshing = null;
async function refresh() {
  if (!session) throw new ApiError('Please sign in again.', 401, 'no_session');
  if (!refreshing) {
    refreshing = (async () => {
      const res = await raw(`${base()}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST', headers: authHeaders(), body: JSON.stringify({ refresh_token: session.refresh_token }),
      });
      if (!res.ok) { save(null); throw new ApiError('Your session ended. Please sign in again.', 401, 'expired'); }
      const j = await res.json();
      save({ access_token: j.access_token, refresh_token: j.refresh_token, expires_at: j.expires_at || now() + (j.expires_in || 3600), user: j.user || session.user });
    })().finally(() => { refreshing = null; });
  }
  return refreshing;
}

export async function signOut() {
  const s = session;
  save(null);
  if (s) { try { await fetch(`${base()}/auth/v1/logout`, { method: 'POST', headers: authHeaders({ Authorization: `Bearer ${s.access_token}` }) }); } catch (_) { /* ignore */ } }
}

async function call(path, { method = 'GET', body, headers = {} } = {}, again = true) {
  if (!session) throw new ApiError('Please sign in.', 401, 'no_session');
  if (session.expires_at - now() < 60) await refresh();
  const res = await raw(`${base()}/rest/v1/${path}`, {
    method, headers: authHeaders({ Authorization: `Bearer ${session.access_token}`, ...headers }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && again) { await refresh(); return call(path, { method, body, headers }, false); }
  if (!res.ok) throw await errorFrom(res);
  return res;
}

export async function rpc(fn, args = {}) {
  const res = await call(`rpc/${fn}`, { method: 'POST', body: args });
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}

// Reads all rows (pages of 1000). query like "select=*&status=eq.FG-RECEIVED&order=seq.desc"
export async function selectAll(table, query = 'select=*', max = 20000) {
  const out = [];
  for (let from = 0; from < max; from += 1000) {
    let res;
    try { res = await call(`${table}?${query}`, { headers: { Range: `${from}-${from + 999}`, 'Range-Unit': 'items' } }); }
    catch (e) { if (e.status === 416) break; throw e; }   // asked past the last row (exactly 1000, 2000… rows)
    const rows = await res.json();
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

// One page + total count, for the register.
export async function selectPage(table, query, from, to) {
  let res;
  try { res = await call(`${table}?${query}`, { headers: { Range: `${from}-${to}`, 'Range-Unit': 'items', Prefer: 'count=exact' } }); }
  catch (e) { if (e.status === 416) return { rows: [], total: 0 }; throw e; }
  const rows = await res.json();
  const m = /\/(\d+|\*)$/.exec(res.headers.get('Content-Range') || '');
  return { rows, total: m && m[1] !== '*' ? Number(m[1]) : rows.length };
}

export async function upsert(table, rows, onConflict, { ignoreDuplicates = false } = {}) {
  if (!rows.length) return;
  for (let i = 0; i < rows.length; i += 500) {
    await call(`${table}?on_conflict=${onConflict}`, {
      method: 'POST', body: rows.slice(i, i + 500),
      headers: { Prefer: `resolution=${ignoreDuplicates ? 'ignore' : 'merge'}-duplicates,return=minimal` },
    });
  }
}

export async function update(table, match, patch) {
  await call(`${table}?${match}`, { method: 'PATCH', body: patch, headers: { Prefer: 'return=minimal' } });
}
