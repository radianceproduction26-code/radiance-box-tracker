// Public settings. The publishable key is meant to sit in the browser: it only identifies the project.
// All access is controlled by login + the database rules (Row Level Security), not by hiding this key.
export const CONFIG = {
  SUPABASE_URL: 'https://ozrrmyrapsjngvrycnhl.supabase.co',
  SUPABASE_KEY: 'sb_publishable_un1bkzvfKQr2hCmu_psI1g_ia6UILPl',
  DEVICE: 'web',
  SCAN_TIMEOUT_MS: 6000,    // FG inward: a scan that gets no answer in this time is kept on the phone and sent later
  QUEUE_RETRY_MS: 15000,    // how often waiting scans are tried again
  STALE_PACKED_HOURS: 24,   // Home warns about boxes printed longer ago than this that are still not scanned into FG
};

// Printed on the packing slip (Delivery challan cum Packing Slip). Change here if they ever change.
export const COMPANY = {
  NAME: 'RADIANCE POLYMERS',
  ADDRESS: 'Plot No. 149/1, Sector No. 7, PCNTDA, Bhosari, Pune - 411 026. Email:moulding.radiance@gmail.com Ph No. 020-27120228, Mob No. 9225538612',
  INVOICE_CREATOR: 'MS. JAGSMITA',   // "Invoice creater name & sign" box
  TRAYS_PER_BOX: 2,                  // used for the TRAY QTY column when a tray number is known
};

// For testing only: ?api=http://127.0.0.1:PORT works when the page itself runs on localhost.
try {
  const h = location.hostname;
  const o = new URLSearchParams(location.search).get('api');
  if (o && (h === 'localhost' || h === '127.0.0.1')) CONFIG.SUPABASE_URL = o;
  const t = Number(new URLSearchParams(location.search).get('scanTimeout'));   // tests: shorter timeouts
  if (t > 0 && (h === 'localhost' || h === '127.0.0.1')) { CONFIG.SCAN_TIMEOUT_MS = t; CONFIG.QUEUE_RETRY_MS = Math.max(t, 1000); }
} catch (_) { /* ignore */ }
