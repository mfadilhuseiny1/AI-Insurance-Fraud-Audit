/**
 * Spark SQL functions that have no direct JavaScript equivalent, shared by the pipeline steps,
 * the Formula step and the SQL step (where they are registered as SQLite functions).
 * Pure: no dependencies on the pipeline model.
 */

// ---------------------------------------------------------------- text

/** SOUNDEX: American Soundex code (letter + 3 digits); text not starting with a letter is returned unchanged, as in Spark. */
export function soundex(s: string): string {
  if (!/^[A-Za-z]/.test(s)) return s;
  const codes: Record<string, string> = {};
  for (const [letters, d] of [["BFPV", "1"], ["CGJKQSXZ", "2"], ["DT", "3"], ["L", "4"], ["MN", "5"], ["R", "6"]] as const)
    for (const ch of letters) codes[ch] = d;
  const up = s.toUpperCase().replace(/[^A-Z]/g, "");
  let out = up[0];
  let prev = codes[up[0]] ?? "";
  for (const ch of up.slice(1)) {
    const d = codes[ch] ?? "";
    // H and W do not separate letters with the same code; vowels do
    if (ch === "H" || ch === "W") continue;
    if (d && d !== prev) out += d;
    prev = d;
    if (out.length === 4) break;
  }
  return out.padEnd(4, "0");
}

/** SUBSTRING_INDEX: text before the count-th delimiter (count > 0) or after the count-th from the end (count < 0). */
export function substringIndex(s: string, delim: string, count: number): string {
  if (!delim || count === 0) return "";
  const parts = s.split(delim);
  if (Math.abs(count) >= parts.length) return s;
  return count > 0 ? parts.slice(0, count).join(delim) : parts.slice(count).join(delim);
}

/** TRANSLATE: replaces each character of `from` by the one at the same place in `to`; characters without a partner are removed. */
export function translate(s: string, from: string, to: string): string {
  const src = [...from];
  const dst = [...to];
  const map = new Map<string, string>();
  src.forEach((ch, i) => {
    if (!map.has(ch)) map.set(ch, dst[i] ?? "");
  });
  return [...s].map((ch) => (map.has(ch) ? map.get(ch)! : ch)).join("");
}

/** Rounds half to even ("bankers' rounding") to `d` decimals; negative d rounds to tens, hundreds… */
export function roundHalfEven(n: number, d = 0): number {
  const f = 10 ** d;
  const x = n * f;
  const floor = Math.floor(x);
  // exactly halfway (allowing for binary noise): pick the even neighbour
  const r = Math.abs(x - floor - 0.5) < 1e-9 ? (floor % 2 === 0 ? floor : floor + 1) : Math.round(x);
  return r / f;
}

/** FORMAT_NUMBER: grouped with commas and rounded half-even to d decimals, e.g. 1234567.891, 2 → "1,234,567.89"; null for d < 0. */
export function formatNumber(n: number, d: number): string | null {
  if (!(d >= 0)) return null;
  if (d > 100) throw new Error("FORMAT_NUMBER takes at most 100 decimals");
  if (!Number.isFinite(n)) return null;
  const fixed = roundHalfEven(n, d).toFixed(d);
  const [int, frac] = fixed.split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac ? `${grouped}.${frac}` : grouped;
}

export const CHARSETS = ["UTF-8", "US-ASCII", "ISO-8859-1", "UTF-16BE", "UTF-16LE", "UTF-16"] as const;

/** ENCODE: text to bytes in a character set; characters the set cannot hold become "?". */
export function encodeText(s: string, charset: string): Uint8Array {
  const cs = charset.toUpperCase();
  if (cs === "UTF-8") return new TextEncoder().encode(s);
  if (cs === "US-ASCII" || cs === "ISO-8859-1") {
    const max = cs === "US-ASCII" ? 0x7f : 0xff;
    return Uint8Array.from([...s], (ch) => (ch.codePointAt(0)! <= max ? ch.codePointAt(0)! : 0x3f));
  }
  if (cs === "UTF-16BE" || cs === "UTF-16LE" || cs === "UTF-16") {
    const le = cs === "UTF-16LE";
    const bom = cs === "UTF-16" ? [0xfe, 0xff] : [];
    const out = [...bom];
    for (let i = 0; i < s.length; i++) {
      const u = s.charCodeAt(i);
      if (le) out.push(u & 0xff, u >> 8);
      else out.push(u >> 8, u & 0xff);
    }
    return Uint8Array.from(out);
  }
  throw new Error(`Unknown character set "${charset}" — use ${CHARSETS.join(", ")}`);
}

/** DECODE: bytes to text in a character set. */
export function decodeBytes(bytes: Uint8Array, charset: string): string {
  const cs = charset.toUpperCase();
  if (cs === "UTF-8") return new TextDecoder("utf-8").decode(bytes);
  if (cs === "US-ASCII" || cs === "ISO-8859-1") {
    // one character at a time: spreading a large byte array overflows the call stack
    let s = "";
    for (const b of bytes) s += String.fromCharCode(cs === "US-ASCII" && b > 0x7f ? 0xfffd : b);
    return s;
  }
  if (cs === "UTF-16BE" || cs === "UTF-16LE") return new TextDecoder(cs.toLowerCase()).decode(bytes);
  if (cs === "UTF-16") {
    // byte order mark decides; big-endian without one
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
    return new TextDecoder("utf-16be").decode(bytes);
  }
  throw new Error(`Unknown character set "${charset}" — use ${CHARSETS.join(", ")}`);
}

export const toHex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();

/** UNHEX: hex text to bytes; null when it is not hex. An odd length gets a leading 0, as in Spark. */
export function fromHex(text: string): Uint8Array | null {
  const t = text.length % 2 ? `0${text}` : text;
  if (!/^[0-9a-fA-F]*$/.test(t)) return null;
  return Uint8Array.from(t.match(/../g) ?? [], (h) => parseInt(h, 16));
}

/** CONV: a number written in one base (2–36) to another; negative bases give signed output, else negatives wrap as 64-bit unsigned. Null for invalid input. */
export function convBase(text: string, fromBase: number, toBase: number): string | null {
  const from = Math.abs(fromBase);
  const to = Math.abs(toBase);
  if (from < 2 || from > 36 || to < 2 || to > 36) return null;
  let s = text.trim().toLowerCase();
  const negative = s.startsWith("-");
  if (negative) s = s.slice(1);
  // Spark reads the longest valid prefix
  let value = 0n;
  let digits = 0;
  for (const ch of s) {
    const d = parseInt(ch, 36);
    if (Number.isNaN(d) || d >= from) break;
    value = value * BigInt(from) + BigInt(d);
    digits++;
  }
  if (!digits) return null;
  value = BigInt.asUintN(64, value);
  if (negative) value = BigInt.asUintN(64, -value);
  let out: bigint = value;
  let sign = "";
  if (toBase < 0) {
    const signed = BigInt.asIntN(64, value);
    if (signed < 0n) {
      sign = "-";
      out = -signed;
    }
  }
  return sign + out.toString(to).toUpperCase();
}

// ---------------------------------------------------------------- numbers

/** FACTORIAL for 0–20 (larger values overflow a bigint in Spark); null otherwise. */
export function factorial(n: number): number | null {
  if (!Number.isInteger(n) || n < 0 || n > 20) return null;
  let f = 1;
  for (let i = 2; i <= n; i++) f *= i;
  return f;
}

/** PMOD: remainder that is never negative for a positive divisor. */
export const pmod = (a: number, b: number) => (b === 0 ? NaN : ((a % b) + b) % b);

/** SHIFTLEFT / SHIFTRIGHT / SHIFTRIGHTUNSIGNED on 64-bit integers. */
export function shift(n: number, bits: number, kind: "left" | "right" | "unsigned"): number {
  if (!Number.isFinite(n) || !Number.isFinite(bits)) return NaN;
  const b = BigInt(Math.trunc(bits) & 63);
  const v = BigInt.asIntN(64, BigInt(Math.trunc(n)));
  const out = kind === "left" ? BigInt.asIntN(64, v << b) : kind === "right" ? v >> b : BigInt.asUintN(64, v) >> b;
  return Number(kind === "unsigned" ? out : BigInt.asIntN(64, out));
}

/** Population moments of numbers: mean, Σ(x−μ)^k / n for k = 2, 3, 4. */
function moments(xs: number[]) {
  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  let m2 = 0;
  let m3 = 0;
  let m4 = 0;
  for (const x of xs) {
    const d = x - mean;
    m2 += d * d;
    m3 += d * d * d;
    m4 += d * d * d * d;
  }
  return { n, mean, m2: m2 / n, m3: m3 / n, m4: m4 / n };
}

/** SKEWNESS (population, as Spark): m3 / m2^1.5; null for fewer than 1 value or no spread. */
export function skewness(xs: number[]): number | null {
  if (!xs.length) return null;
  const m = moments(xs);
  return m.m2 === 0 ? null : m.m3 / m.m2 ** 1.5;
}

/** KURTOSIS (excess, population, as Spark): m4 / m2² − 3. */
export function kurtosis(xs: number[]): number | null {
  if (!xs.length) return null;
  const m = moments(xs);
  return m.m2 === 0 ? null : m.m4 / (m.m2 * m.m2) - 3;
}

/** CORR, COVAR_POP and COVAR_SAMP over pairs where both values are numbers. */
export function pairStat(kind: "corr" | "covar_pop" | "covar_samp", pairs: [number, number][]): number | null {
  const n = pairs.length;
  if (!n || (kind !== "covar_pop" && n < 2)) return null;
  const mx = pairs.reduce((a, [x]) => a + x, 0) / n;
  const my = pairs.reduce((a, [, y]) => a + y, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const [x, y] of pairs) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
  }
  if (kind === "covar_pop") return sxy / n;
  if (kind === "covar_samp") return sxy / (n - 1);
  return sxx === 0 || syy === 0 ? null : sxy / Math.sqrt(sxx * syy);
}

// ---------------------------------------------------------------- hashing (synchronous, over UTF-8 or raw bytes)

const utf8 = (s: string) => new TextEncoder().encode(s);
const hex32 = (words: number[], littleEndian = false) =>
  words
    .map((w) => {
      const h = (w >>> 0).toString(16).padStart(8, "0");
      return littleEndian ? h.match(/../g)!.reverse().join("") : h;
    })
    .join("");

/** Pads a message to whole blocks with its bit length at the end (block 64 or 128 bytes). */
function padMessage(bytes: Uint8Array, littleEndianLength: boolean, block = 64): DataView {
  const len = bytes.length;
  const lengthBytes = block === 128 ? 16 : 8;
  const total = Math.ceil((len + 1 + lengthBytes) / block) * block;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[len] = 0x80;
  const view = new DataView(buf.buffer);
  const bits = len * 8;
  if (littleEndianLength) {
    view.setUint32(total - 8, bits >>> 0, true);
    view.setUint32(total - 4, Math.floor(bits / 2 ** 32), true);
  } else {
    view.setUint32(total - 8, Math.floor(bits / 2 ** 32));
    view.setUint32(total - 4, bits >>> 0);
  }
  return view;
}

const PRIMES = (() => {
  const out: number[] = [];
  for (let n = 2; out.length < 80; n++) if (out.every((p) => n % p)) out.push(n);
  return out;
})();

/** Integer k-th root (floor) of a bigint, by Newton's method. */
function iroot(x: bigint, k: bigint): bigint {
  if (x < 2n) return x;
  let r = 1n << (BigInt(x.toString(2).length) / k + 1n);
  for (;;) {
    const next = ((k - 1n) * r + x / r ** (k - 1n)) / k;
    if (next >= r) return r;
    r = next;
  }
}

/** First `bits` bits of the fractional part of the k-th root of p (SHA constants), exact. */
const fracRoot = (p: number, k: bigint, bits: bigint) => iroot(BigInt(p) << (bits * k), k) & ((1n << bits) - 1n);

const K256 = PRIMES.slice(0, 64).map((p) => Number(fracRoot(p, 3n, 32n)));
const K512 = PRIMES.map((p) => fracRoot(p, 3n, 64n));
const IV256 = PRIMES.slice(0, 8).map((p) => Number(fracRoot(p, 2n, 32n)));
const IV512 = PRIMES.slice(0, 8).map((p) => fracRoot(p, 2n, 64n));
const IV384 = PRIMES.slice(8, 16).map((p) => fracRoot(p, 2n, 64n));
// SHA-224 starts from the second 32 bits of the SHA-384 constants
const IV224 = IV384.map((v) => Number(v & 0xffffffffn));

function sha256Core(text: string | Uint8Array, iv: number[], words: number): string {
  const view = padMessage(typeof text === "string" ? utf8(text) : text, false);
  const H = [...iv];
  const W = new Array<number>(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < view.byteLength; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
      const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + W[i]) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    [a, b, c, d, e, f, g, h].forEach((v, i) => (H[i] = (H[i] + v) | 0));
  }
  return hex32(H.slice(0, words));
}

export const sha256 = (text: string | Uint8Array) => sha256Core(text, IV256, 8);
export const sha224 = (text: string | Uint8Array) => sha256Core(text, IV224, 7);

function sha512Core(text: string | Uint8Array, iv: bigint[], words: number): string {
  const view = padMessage(typeof text === "string" ? utf8(text) : text, false, 128);
  const M = (1n << 64n) - 1n;
  const H = [...iv];
  const W = new Array<bigint>(80);
  const rotr = (x: bigint, n: bigint) => ((x >> n) | (x << (64n - n))) & M;
  for (let off = 0; off < view.byteLength; off += 128) {
    for (let i = 0; i < 16; i++) W[i] = view.getBigUint64(off + i * 8);
    for (let i = 16; i < 80; i++) {
      const s0 = rotr(W[i - 15], 1n) ^ rotr(W[i - 15], 8n) ^ (W[i - 15] >> 7n);
      const s1 = rotr(W[i - 2], 19n) ^ rotr(W[i - 2], 61n) ^ (W[i - 2] >> 6n);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) & M;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 80; i++) {
      const t1 = (h + (rotr(e, 14n) ^ rotr(e, 18n) ^ rotr(e, 41n)) + ((e & f) ^ (~e & M & g)) + K512[i] + W[i]) & M;
      const t2 = ((rotr(a, 28n) ^ rotr(a, 34n) ^ rotr(a, 39n)) + ((a & b) ^ (a & c) ^ (b & c))) & M;
      h = g;
      g = f;
      f = e;
      e = (d + t1) & M;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) & M;
    }
    [a, b, c, d, e, f, g, h].forEach((v, i) => (H[i] = (H[i] + v) & M));
  }
  return H.slice(0, words)
    .map((w) => w.toString(16).padStart(16, "0"))
    .join("");
}

export const sha512 = (text: string | Uint8Array) => sha512Core(text, IV512, 8);
export const sha384 = (text: string | Uint8Array) => sha512Core(text, IV384, 6);

export function sha1(text: string | Uint8Array): string {
  const view = padMessage(typeof text === "string" ? utf8(text) : text, false);
  const H = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const W = new Array<number>(80);
  const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n));
  for (let off = 0; off < view.byteLength; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 80; i++) W[i] = rotl(W[i - 3] ^ W[i - 8] ^ W[i - 14] ^ W[i - 16], 1);
    let [a, b, c, d, e] = H;
    for (let i = 0; i < 80; i++) {
      const [f, k] =
        i < 20 ? [(b & c) | (~b & d), 0x5a827999] : i < 40 ? [b ^ c ^ d, 0x6ed9eba1] : i < 60 ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc] : [b ^ c ^ d, 0xca62c1d6];
      const t = (rotl(a, 5) + f + e + k + W[i]) | 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = t;
    }
    [a, b, c, d, e].forEach((v, i) => (H[i] = (H[i] + v) | 0));
  }
  return hex32(H);
}

const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

export function md5(text: string | Uint8Array): string {
  const view = padMessage(typeof text === "string" ? utf8(text) : text, true);
  let [a0, b0, c0, d0] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  for (let off = 0; off < view.byteLength; off += 64) {
    const M = Array.from({ length: 16 }, (_, i) => view.getUint32(off + i * 4, true));
    let [a, b, c, d] = [a0, b0, c0, d0];
    for (let i = 0; i < 64; i++) {
      const round = i >> 4;
      let f: number;
      let g: number;
      if (round === 0) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (round === 1) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (round === 2) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const shiftBy = MD5_S[round * 4 + (i % 4)];
      const sum = (a + f + MD5_K[i] + M[g]) | 0;
      a = d;
      d = c;
      c = b;
      b = (b + ((sum << shiftBy) | (sum >>> (32 - shiftBy)))) | 0;
    }
    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }
  return hex32([a0, b0, c0, d0], true);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/** CRC32 as an unsigned number (Spark returns a bigint). */
export function crc32(text: string | Uint8Array): number {
  const bytes = typeof text === "string" ? utf8(text) : text;
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Spark's HASH: Murmur3 x86 32-bit, seed 42, chained over the arguments (each result seeds the next; nulls are skipped)

const mixK1 = (k: number) => Math.imul(((k = Math.imul(k, 0xcc9e2d51)) << 15) | (k >>> 17), 0x1b873593);
const mixH1 = (h: number, k: number) => {
  h ^= k;
  h = (h << 13) | (h >>> 19);
  return (Math.imul(h, 5) + 0xe6546b64) | 0;
};
const fmix = (h: number, len: number) => {
  h ^= len;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h | 0;
};

export const murmurInt = (i: number, seed: number) => fmix(mixH1(seed, mixK1(i | 0)), 4);

export function murmurLong(l: bigint, seed: number): number {
  const low = Number(BigInt.asIntN(32, l));
  const high = Number(BigInt.asIntN(32, l >> 32n));
  return fmix(mixH1(mixH1(seed, mixK1(low)), mixK1(high)), 8);
}

/** Spark's hashUnsafeBytes: whole 4-byte little-endian words, then each remaining (signed) byte on its own. */
export function murmurBytes(bytes: Uint8Array, seed: number): number {
  const aligned = bytes.length - (bytes.length % 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let h = seed;
  for (let i = 0; i < aligned; i += 4) h = mixH1(h, mixK1(view.getInt32(i, true)));
  for (let i = aligned; i < bytes.length; i++) h = mixH1(h, mixK1(view.getInt8(i)));
  return fmix(h, bytes.length);
}

/** Bit pattern of a double as a 64-bit integer (Java doubleToLongBits, with −0 as 0). */
export function doubleBits(d: number): bigint {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, d === 0 ? 0 : d);
  return view.getBigInt64(0);
}

export function floatBits(f: number): number {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, f === 0 ? 0 : f);
  return view.getInt32(0);
}

// ---------------------------------------------------------------- durations

const DURATION_MS: Record<string, number> = {
  millisecond: 1,
  second: 1000,
  minute: 60000,
  hour: 3600000,
  day: 86400000,
  week: 7 * 86400000,
};

/** "10 minutes", "1 hour 30 minutes", "interval 2 days" → milliseconds; months and years are not fixed lengths and are rejected. */
export function parseDuration(text: string): number {
  const s = text.trim().toLowerCase().replace(/^interval\s+/, "");
  if (!s) throw new Error("Enter a duration, e.g. 10 minutes");
  let total = 0;
  let rest = s;
  const re = /^(-?\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|h|days?|d|weeks?|w)\b\s*/;
  while (rest) {
    const m = re.exec(rest);
    if (!m) {
      if (/month|year/.test(rest)) throw new Error("Months and years vary in length — use days or weeks");
      throw new Error(`"${text}" is not a duration — e.g. 10 minutes, 1 hour 30 minutes`);
    }
    const unit = m[2];
    const key =
      unit === "ms" || unit.startsWith("milli")
        ? "millisecond"
        : unit.startsWith("s")
          ? "second"
          : unit === "m" || unit.startsWith("min")
            ? "minute"
            : unit.startsWith("h")
              ? "hour"
              : unit.startsWith("d")
                ? "day"
                : "week";
    total += Number(m[1]) * DURATION_MS[key];
    rest = rest.slice(m[0].length);
  }
  return total;
}

// ---------------------------------------------------------------- Pipeline Builder expressions

/** Ratcliff/Obershelp similarity (Python's SequenceMatcher.ratio, no junk heuristic): 2·matches / total length. */
export function sequenceRatio(a: string, b: string): number {
  if (!a.length && !b.length) return 1;
  const matches = (x: string, y: string): number => {
    if (!x.length || !y.length) return 0;
    // longest common substring
    let best = 0;
    let bi = 0;
    let bj = 0;
    let prev = new Array(y.length + 1).fill(0);
    for (let i = 1; i <= x.length; i++) {
      const cur = new Array(y.length + 1).fill(0);
      for (let j = 1; j <= y.length; j++)
        if (x[i - 1] === y[j - 1]) {
          cur[j] = prev[j - 1] + 1;
          if (cur[j] > best) {
            best = cur[j];
            bi = i - best;
            bj = j - best;
          }
        }
      prev = cur;
    }
    if (!best) return 0;
    return best + matches(x.slice(0, bi), y.slice(0, bj)) + matches(x.slice(bi + best), y.slice(bj + best));
  };
  return (2 * matches(a, b)) / (a.length + b.length);
}

/** Token set ratio: how similar two strings are as sets of words, 0…1 (1 when one's words contain the other's). */
export function tokenSetRatio(left: string, right: string, ignoreCase = false): number {
  const tokens = (s: string) => new Set((ignoreCase ? s.toLowerCase() : s).split(/\s+/).filter(Boolean));
  const a = tokens(left);
  const b = tokens(right);
  if (!a.size && !b.size) return 1;
  const inter = [...a].filter((x) => b.has(x)).sort();
  const onlyA = [...a].filter((x) => !b.has(x)).sort();
  const onlyB = [...b].filter((x) => !a.has(x)).sort();
  const t1 = inter.join(" ");
  const t2 = [...inter, ...onlyA].join(" ");
  const t3 = [...inter, ...onlyB].join(" ");
  // an empty intersection would make 0-length comparisons; only compare the full sets then
  if (!inter.length) return sequenceRatio(t2, t3);
  return Math.max(sequenceRatio(t1, t2), sequenceRatio(t1, t3), sequenceRatio(t2, t3));
}

const hexBytes = (hex: string) => new Uint8Array((hex.match(/../g) ?? []).map((h) => parseInt(h, 16)));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isValidUuid = (s: string) => UUID_RE.test(s.trim()) && s.trim() === s;

/** RFC 4122 name-based UUID (SHA-1): the same namespace and name always give the same UUID. */
export function uuidV5(namespace: string, name: string): string | null {
  if (!isValidUuid(namespace)) return null;
  const ns = hexBytes(namespace.replace(/-/g, "").toLowerCase());
  const nm = new TextEncoder().encode(name);
  const all = new Uint8Array(ns.length + nm.length);
  all.set(ns);
  all.set(nm, ns.length);
  const h = hexBytes(sha1(all)).slice(0, 16);
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = [...h].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

export const isValidIpv4 = (s: string) =>
  /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(s);

/** The 8 groups of an IPv6 address (an embedded IPv4 tail allowed), or null if invalid. */
function ipv6Groups(s: string): number[] | null {
  if (!s || /[^0-9a-fA-F:.]/.test(s) || (s.match(/::/g) ?? []).length > 1) return null;
  let tail: number[] = [];
  let head = s;
  const v4 = /^(.*:)((?:\d{1,3}\.){3}\d{1,3})$/.exec(s);
  if (v4) {
    if (!isValidIpv4(v4[2])) return null;
    const p = v4[2].split(".").map(Number);
    tail = [(p[0] << 8) | p[1], (p[2] << 8) | p[3]];
    head = v4[1].endsWith("::") ? v4[1] : v4[1].slice(0, -1);
  }
  const parse = (part: string) => (part ? part.split(":") : []);
  const [l, r] = head.includes("::") ? head.split("::") : [head, null];
  const left = parse(l);
  const right = r === null ? [] : parse(r);
  if ([...left, ...right].some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) return null;
  const known = left.length + right.length + tail.length;
  if (r === null ? known !== 8 : known > 7) return null;
  const zeros = new Array(8 - known).fill(0);
  return [...left.map((g) => parseInt(g, 16)), ...(r === null ? [] : zeros), ...right.map((g) => parseInt(g, 16)), ...tail];
}
export const isValidIpv6 = (s: string) => ipv6Groups(s) !== null;

/** RFC 5952 canonical text: lower case, no leading zeros, the longest run of 2+ zero groups as ::. */
export function ipv6Canonical(s: string): string | null {
  const g = ipv6Groups(s);
  if (!g) return null;
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (g[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && g[j] === 0) j++;
    if (j - i > bestLen) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = g.map((x) => x.toString(16));
  if (bestLen < 2) return hex.join(":");
  return `${hex.slice(0, bestStart).join(":")}::${hex.slice(bestStart + bestLen).join(":")}`;
}

/** "0.987.0-16-gb3fb285" → {major, minor, patch, prerelease}; null when not a semantic version. */
export function parseSemver(s: string): { major: number; minor: number; patch: number; prerelease: string[] } | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(s.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease: m[4] ? [m[4]] : [] };
}

/** Country calling codes of common regions (ISO 3166 alpha-2). */
const CALLING_CODES: Record<string, string> = {
  US: "1", CA: "1", GB: "44", IE: "353", FR: "33", DE: "49", NL: "31", BE: "32", ES: "34", IT: "39", PT: "351", CH: "41", AT: "43",
  SE: "46", NO: "47", DK: "45", FI: "358", PL: "48", AU: "61", NZ: "64", JP: "81", KR: "82", CN: "86", HK: "852", SG: "65",
  MY: "60", ID: "62", TH: "66", VN: "84", PH: "63", IN: "91", PK: "92", AE: "971", SA: "966", TR: "90", IL: "972", ZA: "27",
  NG: "234", KE: "254", EG: "20", BR: "55", MX: "52", AR: "54", CL: "56", CO: "57", PE: "51", RU: "7",
};

/** A phone number in E.164 (+<country><number>): numbers starting with + keep their country, others use the region's. */
export function parsePhoneNumber(s: string, region = "US"): string | null {
  const t = s.trim();
  const plus = /^\+|@\+?\d/.test(t) || /^00\d/.test(t);
  let digits = t.replace(/^00/, "+").replace(/[^\d]/g, "");
  if (!digits) return null;
  if (!plus) {
    const code = CALLING_CODES[region.toUpperCase()];
    if (!code) return null;
    // the national trunk prefix (0 in most countries, 1 in North America when repeated) is dropped
    if (code === "1" && digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
    else if (code !== "1") digits = digits.replace(/^0+/, "");
    digits = code + digits;
  }
  // E.164 numbers have at most 15 digits; shorter than 8 is not a full number
  return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
}

/** printf-style formatting: %s, %d, %f, %.2f, %x, %% (as Spark's format_string for these). */
export function formatString(fmt: string, args: unknown[]): string {
  let i = 0;
  return fmt.replace(/%(-?\d*)(?:\.(\d+))?([sdfxX%])/g, (_m, width: string, prec: string | undefined, conv: string) => {
    if (conv === "%") return "%";
    const v = args[i++];
    let s: string;
    if (v === null || v === undefined) s = "null";
    else if (conv === "d") s = String(Math.trunc(Number(v)));
    else if (conv === "f") s = Number(v).toFixed(prec ? Number(prec) : 6);
    else if (conv === "x" || conv === "X") s = Math.trunc(Number(v)).toString(16)[conv === "X" ? "toUpperCase" : "toLowerCase"]();
    else s = prec ? String(v).slice(0, Number(prec)) : String(v);
    const w = Math.abs(Number(width || 0));
    return width.startsWith("-") ? s.padEnd(w) : s.padStart(w);
  });
}

/** application/x-www-form-urlencoded, like Java's URLEncoder (Spark's url_encode). */
export const urlEncode = (s: string) =>
  encodeURIComponent(s)
    .replace(/%20/g, "+")
    .replace(/[!'()~]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
export function urlDecode(s: string): string | null {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return null;
  }
}
