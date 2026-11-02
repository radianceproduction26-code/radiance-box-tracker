// Public settings. The publishable key is meant to sit in the browser: it only identifies the project.
// All access is controlled by login + the database rules (Row Level Security), not by hiding this key.
export const CONFIG = {
  SUPABASE_URL: 'https://ozrrmyrapsjngvrycnhl.supabase.co',
  SUPABASE_KEY: 'sb_publishable_un1bkzvfKQr2hCmu_psI1g_ia6UILPl',
  DEVICE: 'web',
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
} catch (_) { /* ignore */ }
