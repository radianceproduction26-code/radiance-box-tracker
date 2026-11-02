// QR code reader for camera frames (byte-mode codes, versions 1-10, all error-correction levels).
// Self-contained so iPhones (no built-in barcode detector) can scan without any outside library.
// decodeQR({data: RGBA bytes, width, height}) -> string | null
import { rawModules, MASKS, functionMask } from './qr.js';

const ECC_LEN = { L: [7, 10, 15, 20, 26, 18, 20, 24, 30, 18], M: [10, 16, 26, 18, 24, 16, 18, 22, 22, 26], Q: [13, 22, 18, 26, 18, 24, 18, 22, 20, 24], H: [17, 28, 22, 16, 22, 28, 26, 26, 24, 28] };
const NBLK = { L: [1, 1, 1, 1, 1, 2, 2, 2, 2, 4], M: [1, 1, 1, 2, 2, 4, 4, 4, 5, 5], Q: [1, 1, 2, 2, 4, 4, 6, 6, 8, 8], H: [1, 1, 2, 4, 4, 4, 5, 6, 8, 8] };
const FMT_ECL = ['M', 'L', 'H', 'Q'];   // 2-bit value in the format word

// ---------------------------------------------------------------- Reed-Solomon over GF(256)
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
{ let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; }
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
const div = (a, b) => (a ? EXP[(LOG[a] + 255 - LOG[b]) % 255] : 0);

function syndromes(block, nsym) {
  const out = new Array(nsym); let any = false;
  for (let i = 0; i < nsym; i++) { let s = 0; for (let k = 0; k < block.length; k++) s = mul(s, EXP[i]) ^ block[k]; out[i] = s; if (s) any = true; }
  return { out, any };
}

// Corrects `block` (data + ecc, highest degree first) in place. Returns false when it cannot.
function rsCorrect(block, nsym) {
  const n = block.length;
  const { out: synd, any } = syndromes(block, nsym);
  if (!any) return true;
  let C = [1], B = [1], L = 0, m = 1, b = 1;
  for (let i = 0; i < nsym; i++) {
    let d = synd[i];
    for (let j = 1; j <= L; j++) d ^= mul(C[j] || 0, synd[i - j]);
    if (d === 0) { m++; continue; }
    const T = C.slice(), coef = div(d, b);
    while (C.length < B.length + m) C.push(0);
    for (let j = 0; j < B.length; j++) C[j + m] ^= mul(coef, B[j]);
    if (2 * L <= i) { L = i + 1 - L; B = T; b = d; m = 1; } else m++;
  }
  if (L * 2 > nsym) return false;
  const pos = [];
  for (let deg = 0; deg < n; deg++) {
    let s = 0;
    for (let j = 0; j <= L; j++) if (C[j]) s ^= mul(C[j], EXP[((255 - deg) * j) % 255]);
    if (s === 0) pos.push(deg);
  }
  if (pos.length !== L) return false;
  const omega = new Array(nsym).fill(0);
  for (let i = 0; i < nsym; i++) for (let j = 0; j <= i && j <= L; j++) omega[i] ^= mul(C[j] || 0, synd[i - j]);
  for (const deg of pos) {
    let om = 0, xp = 1; const xinv = EXP[(255 - deg) % 255];
    for (let i = 0; i < nsym; i++) { om ^= mul(omega[i], xp); xp = mul(xp, xinv); }
    let der = 0;
    for (let j = 1; j <= L; j += 2) der ^= mul(C[j] || 0, EXP[((255 - deg) * (j - 1)) % 255]);
    if (!der) return false;
    block[n - 1 - deg] ^= mul(EXP[deg % 255], div(om, der));
  }
  return !syndromes(block, nsym).any;
}

// ---------------------------------------------------------------- grid -> text
const FORMATS = (() => {
  const list = [];
  for (let data = 0; data < 32; data++) {
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    list.push({ bits: ((data << 10) | rem) ^ 0x5412, ecl: FMT_ECL[data >> 3], mask: data & 7 });
  }
  return list;
})();
const pop = (x) => { let c = 0; while (x) { c += x & 1; x >>>= 1; } return c; };

function readFormat(g, size) {
  const copy1 = [], copy2 = [];
  for (let i = 0; i <= 5; i++) copy1[i] = g[i][8];
  copy1[6] = g[7][8]; copy1[7] = g[8][8]; copy1[8] = g[8][7];
  for (let i = 9; i < 15; i++) copy1[i] = g[8][14 - i];
  for (let i = 0; i < 8; i++) copy2[i] = g[8][size - 1 - i];
  for (let i = 8; i < 15; i++) copy2[i] = g[size - 15 + i][8];
  const out = [];
  for (const c of [copy1, copy2]) {
    let v = 0; c.forEach((bit, i) => { if (bit) v |= 1 << i; });
    let best = null, bd = 99;
    for (const f of FORMATS) { const d = pop(v ^ f.bits); if (d < bd) { bd = d; best = f; } }
    if (bd <= 3) out.push(best);
  }
  return out;
}

function gridToText(g, v) {
  const size = v * 4 + 17;
  for (const fmt of readFormat(g, size)) {
    const fn = functionMask(v);
    const bits = [];
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
        const x = right - j, upward = ((right + 1) & 2) === 0, y = upward ? size - 1 - vert : vert;
        if (!fn[y][x]) bits.push(g[y][x] ^ (MASKS[fmt.mask](x, y) ? 1 : 0));
      }
    }
    const total = Math.floor(rawModules(v) / 8);
    const cw = [];
    for (let i = 0; i < total; i++) { let b = 0; for (let k = 0; k < 8; k++) b = (b << 1) | bits[i * 8 + k]; cw.push(b); }
    const nb = NBLK[fmt.ecl][v - 1], el = ECC_LEN[fmt.ecl][v - 1];
    const nShort = nb - (total % nb), shortLen = Math.floor(total / nb);
    const dataLen = (j) => shortLen - el + (j < nShort ? 0 : 1);
    const blocks = Array.from({ length: nb }, () => []);
    let p = 0;
    for (let i = 0; i <= shortLen - el; i++) for (let j = 0; j < nb; j++) if (i < dataLen(j)) blocks[j].push(cw[p++]);
    for (let i = 0; i < el; i++) for (let j = 0; j < nb; j++) blocks[j].push(cw[p++]);
    let ok = true;
    const data = [];
    for (let j = 0; j < nb && ok; j++) {
      if (!rsCorrect(blocks[j], el)) { ok = false; break; }
      data.push(...blocks[j].slice(0, dataLen(j)));
    }
    if (!ok) continue;
    const t = parseSegments(data, v);
    if (t !== null) return t;
  }
  return null;
}

function parseSegments(data, v) {
  let pos = 0;
  const read = (n) => { let r = 0; for (let i = 0; i < n; i++) { const byte = data[pos >> 3]; if (byte === undefined) return null; r = (r << 1) | ((byte >> (7 - (pos & 7))) & 1); pos++; } return r; };
  const bytes = [];
  for (;;) {
    const mode = read(4);
    if (mode === null || mode === 0) break;
    if (mode !== 4) return null;                       // only byte mode is used on our labels
    const n = read(v >= 10 ? 16 : 8);
    if (n === null) return null;
    for (let i = 0; i < n; i++) { const b = read(8); if (b === null) return null; bytes.push(b); }
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes)); } catch (_) { return null; }
}

// ---------------------------------------------------------------- image -> binary
function toGray(rgba, W, H) {
  const g = new Uint8Array(W * H);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
  return g;
}

function binLocal(gray, W, H) {
  const win = Math.max(10, (Math.min(W, H) / 8) | 0), half = win >> 1;
  const I = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) { let row = 0; for (let x = 0; x < W; x++) { row += gray[y * W + x]; I[(y + 1) * (W + 1) + x + 1] = I[y * (W + 1) + x + 1] + row; } }
  const bin = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - half), y1 = Math.min(H, y + half + 1);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - half), x1 = Math.min(W, x + half + 1);
      const sum = I[y1 * (W + 1) + x1] - I[y0 * (W + 1) + x1] - I[y1 * (W + 1) + x0] + I[y0 * (W + 1) + x0];
      const mean = sum / ((x1 - x0) * (y1 - y0));
      const gv = gray[y * W + x];
      bin[y * W + x] = gv < mean * 0.9 && mean - gv > 6 ? 1 : 0;
    }
  }
  return bin;
}

function binOtsu(gray, W, H) {
  const hist = new Array(256).fill(0);
  gray.forEach((v) => hist[v]++);
  const total = gray.length; let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sb = 0, wb = 0, best = 0, th = 128;
  for (let t = 0; t < 256; t++) { wb += hist[t]; if (!wb) continue; const wf = total - wb; if (!wf) break; sb += t * hist[t]; const mb = sb / wb, mf = (sum - sb) / wf, between = wb * wf * (mb - mf) ** 2; if (between > best) { best = between; th = t; } }
  const bin = new Uint8Array(W * H);
  for (let i = 0; i < bin.length; i++) bin[i] = gray[i] <= th ? 1 : 0;
  return bin;
}

// ---------------------------------------------------------------- finder patterns
const ratioOk = (c, tol) => {
  const total = c[0] + c[1] + c[2] + c[3] + c[4];
  if (total < 7 || c.some((x) => x === 0)) return 0;
  const u = total / 7, t = u * tol;
  return Math.abs(c[0] - u) < t && Math.abs(c[1] - u) < t && Math.abs(c[2] - 3 * u) < 3 * t && Math.abs(c[3] - u) < t && Math.abs(c[4] - u) < t ? u : 0;
};

// walks outward from (x,y) along (dx,dy); returns {center (offset along axis), unit} or null
function cross(bin, W, H, x, y, dx, dy, unit) {
  const get = (t) => { const xx = Math.round(x + dx * t), yy = Math.round(y + dy * t); return xx < 0 || yy < 0 || xx >= W || yy >= H ? -1 : bin[yy * W + xx]; };
  const c = [0, 0, 0, 0, 0], lim = unit * 4;
  let t = 0;
  while (get(t) === 1 && c[2] < lim) { c[2]++; t--; }
  const negEnd = t;
  while (get(t) === 0 && c[1] < lim) { c[1]++; t--; }
  while (get(t) === 1 && c[0] < lim) { c[0]++; t--; }
  t = 1;
  while (get(t) === 1 && c[2] < lim) { c[2]++; t++; }
  const posEnd = t;
  while (get(t) === 0 && c[3] < lim) { c[3]++; t++; }
  while (get(t) === 1 && c[4] < lim) { c[4]++; t++; }
  const u = ratioOk(c, 0.75);
  if (!u) return null;
  return { center: (negEnd + posEnd) / 2, unit: u };
}

function findFinders(bin, W, H) {
  const cands = [];
  const add = (x, y, u) => {
    for (const c of cands) if (Math.hypot(c.x - x, c.y - y) < Math.max(u, c.u) * 1.2) { const n = c.n; c.x = (c.x * n + x) / (n + 1); c.y = (c.y * n + y) / (n + 1); c.u = (c.u * n + u) / (n + 1); c.n++; return; }
    cands.push({ x, y, u, n: 1 });
  };
  for (let y = 0; y < H; y++) {
    const runs = [];
    let start = 0, color = bin[y * W];
    for (let x = 1; x <= W; x++) {
      const v = x < W ? bin[y * W + x] : -1;
      if (v !== color) { runs.push({ s: start, l: x - start, c: color }); start = x; color = v; }
    }
    for (let i = 0; i + 4 < runs.length; i++) {
      if (runs[i].c !== 1) continue;
      const c = [runs[i].l, runs[i + 1].l, runs[i + 2].l, runs[i + 3].l, runs[i + 4].l];
      const u = ratioOk(c, 0.7);
      if (!u) continue;
      const cx = runs[i + 2].s + runs[i + 2].l / 2;
      const v = cross(bin, W, H, cx, y, 0, 1, u);
      if (!v) continue;
      const cy = y + v.center;
      const h = cross(bin, W, H, cx, cy, 1, 0, u);
      if (!h) continue;
      add(cx + h.center, cy, (u + v.unit + h.unit) / 3);
    }
  }
  return cands.filter((c) => c.n >= 2).sort((a, b) => b.n - a.n).slice(0, 10);
}

// ---------------------------------------------------------------- geometry
function solve8(A, b) {
  const n = 8;
  for (let i = 0; i < n; i++) {
    let p = i; for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    if (Math.abs(A[p][i]) < 1e-12) return null;
    [A[i], A[p]] = [A[p], A[i]]; [b[i], b[p]] = [b[p], b[i]];
    for (let r = i + 1; r < n; r++) { const f = A[r][i] / A[i][i]; for (let k = i; k < n; k++) A[r][k] -= f * A[i][k]; b[r] -= f * b[i]; }
  }
  const x = new Array(n);
  for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let k = i + 1; k < n; k++) s -= A[i][k] * x[k]; x[i] = s / A[i][i]; }
  return x;
}
function homography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [u, v] = src[i], [x, y] = dst[i];
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); b.push(x);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); b.push(y);
  }
  return solve8(A, b);
}
const warp = (h, u, v) => { const w = h[6] * u + h[7] * v + 1; return [(h[0] * u + h[1] * v + h[2]) / w, (h[3] * u + h[4] * v + h[5]) / w]; };

function buildGrid(bin, W, H, A, B, C, v) {
    const dim = v * 4 + 17;
    const src = [[3.5, 3.5], [dim - 3.5, 3.5], [3.5, dim - 3.5], [dim - 3.5, dim - 3.5]];
    let H0 = homography(src, [[A.x, A.y], [B.x, B.y], [C.x, C.y], [B.x + C.x - A.x, B.y + C.y - A.y]]);
    if (!H0) return null;
    if (v >= 2) {                                                   // refine with the alignment pattern
      // dark centre, light ring, dark outer ring; points fall on module centres through the current transform
      const probe = (cu, cv) => {
        let center = 0, ring = 0, outer = 0;
        for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) {
          const [px, py] = warp(H0, cu + i, cv + j), xx = Math.round(px), yy = Math.round(py);
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const d = Math.max(Math.abs(i), Math.abs(j)), black = bin[yy * W + xx];
          if (d === 0) center += black; else if (d === 1) ring += 1 - black; else outer += black;
        }
        return { center, ring, outer, w: center * 3 + ring * 1.5 + outer };
      };
      const c0 = dim - 6.5, coarse = [];
      for (let dv = -5; dv <= 5; dv++) for (let du = -5; du <= 5; du++) coarse.push([probe(c0 + du, c0 + dv).w, c0 + du, c0 + dv]);
      coarse.sort((x, y) => y[0] - x[0]);
      let best = null;
      for (const [, cu, cv] of coarse.slice(0, 4)) {
        for (let dv = -0.75; dv <= 0.75; dv += 0.25) for (let du = -0.75; du <= 0.75; du += 0.25) {
          const pr = probe(cu + du, cv + dv);
          if (pr.center !== 1 || pr.ring < 7 || pr.outer < 13) continue;           // must really look like the pattern
          const val = pr.w - 0.4 * Math.hypot(cu + du - c0, cv + dv - c0);
          if (!best || val > best.val) best = { val, u: cu + du, v: cv + dv };
        }
      }
      if (best) {
        const q = warp(H0, best.u, best.v);
        const H1 = homography([src[0], src[1], src[2], [dim - 6.5, dim - 6.5]], [[A.x, A.y], [B.x, B.y], [C.x, C.y], q]);
        if (H1) H0 = H1;
      }
    }
    const g = [];
    for (let r = 0; r < dim; r++) {
      const row = [];
      for (let c = 0; c < dim; c++) {
        let votes = 0;
        for (const [du, dv] of [[0, 0], [0.22, 0], [-0.22, 0], [0, 0.22], [0, -0.22]]) {
          const [px, py] = warp(H0, c + 0.5 + du, r + 0.5 + dv), xx = Math.round(px), yy = Math.round(py);
          if (xx >= 0 && yy >= 0 && xx < W && yy < H && bin[yy * W + xx]) votes++;
        }
        row.push(votes >= 3 ? 1 : 0);
      }
      g.push(row);
    }
    return g;
}

function tryTriple(bin, W, H, A, B, C) {
  const ms = (A.u + B.u + C.u) / 3;
  const span = (Math.hypot(B.x - A.x, B.y - A.y) + Math.hypot(C.x - A.x, C.y - A.y)) / 2;
  const v0 = Math.round((span / ms + 7 - 17) / 4);
  for (const v of [v0, v0 + 1, v0 - 1]) {
    if (v < 1 || v > 10) continue;
    const g = buildGrid(bin, W, H, A, B, C, v);
    if (!g) continue;
    const t = gridToText(g, v);
    if (t !== null) return t;
  }
  return null;
}

function decodeBinary(bin, W, H) {
  const f = findFinders(bin, W, H);
  if (f.length < 3) return null;
  const triples = [];
  for (let i = 0; i < f.length; i++) for (let j = i + 1; j < f.length; j++) for (let k = j + 1; k < f.length; k++) {
    const P = [f[i], f[j], f[k]];
    const us = P.map((p) => p.u); if (Math.max(...us) / Math.min(...us) > 1.8) continue;
    const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const sides = [[d(P[1], P[2]), 0], [d(P[0], P[2]), 1], [d(P[0], P[1]), 2]].sort((a, b) => b[0] - a[0]);   // longest first = opposite the corner
    const hyp = sides[0][0], l1 = sides[1][0], l2 = sides[2][0], a = P[sides[0][1]];
    const others = P.filter((p) => p !== a);
    if (Math.abs(l1 - l2) / Math.max(l1, l2) > 0.35 || hyp / Math.max(l1, l2) < 1.15 || hyp / Math.max(l1, l2) > 1.75) continue;
    const cosA = ((others[0].x - a.x) * (others[1].x - a.x) + (others[0].y - a.y) * (others[1].y - a.y)) / (l1 * l2);
    if (Math.abs(cosA) > 0.4) continue;
    triples.push({ score: Math.abs(l1 - l2) / Math.max(l1, l2) + Math.abs(hyp / Math.max(l1, l2) - 1.414), a, others });
  }
  triples.sort((x, y) => x.score - y.score);
  for (const t of triples.slice(0, 4)) {
    let [B, C] = t.others;
    const cr = (B.x - t.a.x) * (C.y - t.a.y) - (B.y - t.a.y) * (C.x - t.a.x);
    if (cr < 0) [B, C] = [C, B];
    const text = tryTriple(bin, W, H, t.a, B, C);
    if (text !== null) return text;
  }
  return null;
}

export function decodeQR(img) {
  const { width: W, height: H, data } = img;
  const gray = toGray(data, W, H);
  return decodeBinary(binLocal(gray, W, H), W, H) ?? decodeBinary(binOtsu(gray, W, H), W, H);
}

// exposed for tests only
export const _t = { toGray, binLocal, binOtsu, findFinders, decodeBinary, buildGrid, gridToText, readFormat };
