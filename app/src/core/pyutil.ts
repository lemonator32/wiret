/** Helpers for the places where Python and JavaScript semantics differ, so that the port
 * gives the same text, numbers and bytes as the Python prototype. */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

// -- keys -----------------------------------------------------------------------------------
/** A stable string for a tuple of values, for Map keys and Set members where Python used a
 * tuple (JS compares arrays by identity). Numbers, bigints, strings, null and nested arrays. */
export function key(...parts: unknown[]): string {
  return enc(parts);
}

function enc(v: unknown): string {
  if (v === null || v === undefined) return "N";
  switch (typeof v) {
    case "string": return "s" + JSON.stringify(v);
    case "number": return Number.isNaN(v) ? "nNaN" : "n" + (Object.is(v, -0) ? "0" : String(v));
    case "bigint": return "b" + v.toString();
    case "boolean": return v ? "T" : "F";
  }
  if (Array.isArray(v)) return "[" + v.map(enc).join(",") + "]";
  return "o" + JSON.stringify(v);
}

// -- integers -------------------------------------------------------------------------------
export function floorDiv(a: number, b: number): number;
export function floorDiv(a: bigint, b: bigint): bigint;
export function floorDiv(a: any, b: any): any {
  if (typeof a === "bigint") {
    const q = a / b;
    return (a % b !== 0n && (a < 0n) !== (b < 0n)) ? q - 1n : q;
  }
  return Math.floor(a / b);
}

export function pyMod(a: number, b: number): number;
export function pyMod(a: bigint, b: bigint): bigint;
export function pyMod(a: any, b: any): any {
  if (typeof a === "bigint") {
    const r = a % b;
    return r !== 0n && (r < 0n) !== (b < 0n) ? r + b : r;
  }
  if (Number.isInteger(a) && Number.isInteger(b)) {
    const r = a % b;
    return r !== 0 && (r < 0) !== (b < 0) ? r + b : r;
  }
  // Python float %: the result has the sign of b
  const r = a % b;
  if (r !== 0 && (r < 0) !== (b < 0)) return r + b;
  return r === 0 ? Math.sign(b) * 0 : r;
}

/** Python's round(x) on a float: to the nearest integer, ties to even. */
export function pyRound(x: number): number {
  if (!Number.isFinite(x)) return x;
  if (Math.abs(x) >= 2 ** 52) return x;
  const f = Math.floor(x);
  const d = x - f;
  let r: number;
  if (d > 0.5) r = f + 1;
  else if (d < 0.5) r = f;
  else r = f % 2 === 0 ? f : f + 1;
  return r === 0 ? (x < 0 || Object.is(x, -0) ? -0 : 0) : r;
}

export function bitLength(n: bigint): number {
  if (n < 0n) n = -n;
  return n === 0n ? 0 : n.toString(2).length;
}

export function toBig(v: number | bigint): bigint {
  return typeof v === "bigint" ? v : BigInt(v);
}

// -- floats ---------------------------------------------------------------------------------
export const f32 = Math.fround;

const buf = new DataView(new ArrayBuffer(8));

export function f32Bits(x: number): number {           // as a signed i32, like struct '<i'
  buf.setFloat32(0, x, true);
  return buf.getInt32(0, true);
}

export function f32FromBits(b: number): number {
  buf.setInt32(0, b | 0, true);
  return buf.getFloat32(0, true);
}

export function f64Bits(x: number): bigint {           // as a signed i64, like struct '<q'
  buf.setFloat64(0, x, true);
  return buf.getBigInt64(0, true);
}

export function f64FromBits(b: bigint): number {
  buf.setBigInt64(0, BigInt.asIntN(64, b), true);
  return buf.getFloat64(0, true);
}

export function copysign(x: number, y: number): number {
  const neg = y < 0 || Object.is(y, -0) || (Number.isNaN(y) && f64Bits(y) < 0n);
  const ax = Math.abs(x);
  return neg ? -ax : ax;
}

/** The exact decimal value of a finite double: digits (no leading zeros, "0" for zero) and
 * the power of ten of the last digit, so value = digits * 10^exp. */
function exactDecimal(x: number): [string, number] {
  x = Math.abs(x);
  if (x === 0) return ["0", 0];
  buf.setFloat64(0, x, true);
  const bits = buf.getBigUint64(0, true);
  const expBits = Number((bits >> 52n) & 0x7FFn);
  let mant = bits & ((1n << 52n) - 1n);
  let e: number;
  if (expBits === 0) e = -1074;
  else { mant |= 1n << 52n; e = expBits - 1075; }
  if (e >= 0) return [(mant << BigInt(e)).toString(), 0];
  const digits = (mant * 5n ** BigInt(-e)).toString();
  return [digits, e];
}

/** The exact decimal value of a finite double, as a string decimal.js reads exactly (Python's
 * Decimal(float) is exact too). */
export function exactDecimalString(x: number): string {
  const sign = x < 0 || Object.is(x, -0) ? "-" : "";
  const [d, e] = exactDecimal(x);
  return e === 0 ? sign + d : `${sign}${d}e${e}`;
}

/** Python's float.hex(). */
export function floatHex(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";
  const sign = x < 0 || Object.is(x, -0) ? "-" : "";
  if (x === 0) return sign + "0x0.0p+0";
  buf.setFloat64(0, Math.abs(x), true);
  const bits = buf.getBigUint64(0, true);
  const expBits = Number((bits >> 52n) & 0x7FFn);
  const mant = (bits & ((1n << 52n) - 1n)).toString(16).padStart(13, "0");
  const lead = expBits === 0 ? "0" : "1";
  const e = expBits === 0 ? -1022 : expBits - 1023;
  return `${sign}0x${lead}.${mant}p${e >= 0 ? "+" : ""}${e}`;
}

/** Python's float.fromhex() for what floatHex writes. */
export function floatFromHex(s: string): number {
  if (s === "nan") return NaN;
  if (s === "inf") return Infinity;
  if (s === "-inf") return -Infinity;
  const m = /^(-?)0x([01])\.([0-9a-f]+)p([+-]?\d+)$/.exec(s);
  if (!m) throw new ValueError(`invalid hexadecimal floating-point string: ${s}`);
  const mant = BigInt("0x" + m[3]) + (m[2] === "1" ? 1n << BigInt(m[3].length * 4) : 0n);
  const v = Number(mant) * 2 ** (parseInt(m[4], 10) - m[3].length * 4);
  return m[1] ? -v : v;
}

/** Round the exact value of |x| to `sig` significant digits, ties to even. Returns the digit
 * string (exactly `sig` digits) and the decimal exponent of the first digit. */
function roundSig(x: number, sig: number): [string, number] {
  const [d, e] = exactDecimal(x);
  if (d === "0") return ["0".repeat(sig), 0];
  let point = d.length + e - 1;                     // exponent of the first digit
  if (d.length <= sig) return [d + "0".repeat(sig - d.length), point];
  let head = BigInt(d.slice(0, sig));
  const rest = d.slice(sig);
  const first = rest.charCodeAt(0) - 48;
  const tail = /[1-9]/.test(rest.slice(1));
  if (first > 5 || (first === 5 && (tail || (head & 1n) === 1n))) head += 1n;
  let s = head.toString();
  if (s.length > sig) { s = s.slice(0, sig); point += 1; }
  return [s, point];
}

/** The shortest digits that read back as x, and the exponent of the first digit. */
function shortest(x: number): [string, number] {
  const s = Math.abs(x).toExponential();          // shortest round-trip, as the spec requires
  const [m, ex] = s.split("e");
  return [m.replace(".", ""), parseInt(ex, 10)];
}

function expText(e: number): string {
  const sign = e < 0 ? "-" : "+";
  const a = Math.abs(e);
  return sign + (a < 10 ? "0" + a : String(a));
}

/** Python's repr(x) for a float. */
export function floatRepr(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";
  const sign = x < 0 || Object.is(x, -0) ? "-" : "";
  if (x === 0) return sign + "0.0";
  const [digits, point] = shortest(x);
  if (point < -4 || point >= 16) {
    const mant = digits.length > 1 ? digits[0] + "." + digits.slice(1) : digits;
    return sign + mant + "e" + expText(point);
  }
  return sign + fixed(digits, point, true);
}

/** digits with the first digit at 10^point, as fixed notation; `dotZero` adds ".0" to a
 * whole number. */
function fixed(digits: string, point: number, dotZero: boolean): string {
  let s: string;
  if (point < 0) s = "0." + "0".repeat(-point - 1) + digits;
  else if (digits.length <= point + 1) {
    s = digits + "0".repeat(point + 1 - digits.length);
    if (dotZero) s += ".0";
  } else s = digits.slice(0, point + 1) + "." + digits.slice(point + 1);
  return s;
}

/** Python's format(x, f".{p}g"). */
export function formatG(x: number, p: number): string {
  if (Number.isNaN(x)) return "nan";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";
  if (p === 0) p = 1;
  const sign = x < 0 || Object.is(x, -0) ? "-" : "";
  if (x === 0) return sign + "0";
  let [digits, point] = roundSig(x, p);
  digits = digits.replace(/0+$/, "") || "0";
  if (point < -4 || point >= p) {
    const mant = digits.length > 1 ? digits[0] + "." + digits.slice(1) : digits;
    return sign + mant + "e" + expText(point);
  }
  return sign + fixed(digits, point, false);
}

/** Python's float(s) for the decimal forms the prototype produces and parses. */
export function parseFloatPy(s: string): number {
  const t = s.trim().toLowerCase().replace(/_/g, "");
  if (t === "nan" || t === "+nan" || t === "-nan") return NaN;
  if (t === "inf" || t === "+inf" || t === "infinity" || t === "+infinity") return Infinity;
  if (t === "-inf" || t === "-infinity") return -Infinity;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/.test(t)) throw new ValueError(`could not convert string to float: '${s}'`);
  return Number(t);
}

export class ValueError extends Error {}

// -- strings --------------------------------------------------------------------------------
const encoder = new TextEncoder();
const strict = new TextDecoder("utf-8", { fatal: true });
const lenient = new TextDecoder("utf-8");

export function utf8(s: string): Uint8Array {
  return encoder.encode(s);
}

export function fromUtf8(b: Uint8Array, replace = false): string {
  return (replace ? lenient : strict).decode(b);
}

export function utf8Len(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

export function cpLen(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** Compare strings by code point, as Python does. */
export function cmp(a: string, b: string): number {
  if (a === b) return 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.codePointAt(i)!, y = b.codePointAt(i)!;
    if (x !== y) return x < y ? -1 : 1;
    if (x > 0xFFFF) i++;
  }
  return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
}

/** Compare values the way Python's sorting does for the shapes used here: numbers, bigints,
 * strings, null (as smallest, used for None keys guarded by the caller) and arrays (tuples). */
export function cmpAny(a: any, b: any): number {
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const c = cmpAny(a[i], b[i]);
      if (c) return c;
    }
    return a.length - b.length;
  }
  if (typeof a === "string" && typeof b === "string") return cmp(a, b);
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === "boolean") a = a ? 1 : 0;
  if (typeof b === "boolean") b = b ? 1 : 0;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** sorted(xs, key=fn): stable, Python ordering. */
export function sortedBy<T>(xs: Iterable<T>, fn: (x: T) => any = (x) => x): T[] {
  const arr = Array.from(xs).map((x, i) => [fn(x), i, x] as [any, number, T]);
  arr.sort((p, q) => cmpAny(p[0], q[0]) || p[1] - q[1]);
  return arr.map((p) => p[2]);
}

export function isIdentifierChar(c: string): boolean {
  return /[\p{L}\p{N}_\p{Mn}\p{Mc}\p{Pc}]/u.test(c);
}

/** Python's str.isidentifier, for the ASCII-and-letters cases the prototype uses. */
export function isIdentifier(s: string): boolean {
  return /^[\p{L}_][\p{L}\p{N}_\p{Mn}\p{Mc}\p{Pc}]*$/u.test(s);
}

/** Python's str.capitalize. */
export function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s;
}

/** Python's repr() for the values that appear in messages: str, int, float, None, bool and
 * tuples/lists of them. */
export function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") return Number.isInteger(v) && !Object.is(v, -0) ? String(v) : floatRepr(v);
  if (typeof v === "string") {
    const q = v.includes("'") && !v.includes('"') ? '"' : "'";
    let r = q;
    for (const ch of v) {
      const c = ch.codePointAt(0)!;
      if (ch === "\\") r += "\\\\";
      else if (ch === q) r += "\\" + q;
      else if (ch === "\n") r += "\\n";
      else if (ch === "\r") r += "\\r";
      else if (ch === "\t") r += "\\t";
      else if (c < 0x20 || c === 0x7F) r += "\\x" + c.toString(16).padStart(2, "0");
      else r += ch;
    }
    return r + q;
  }
  if (Array.isArray(v)) {
    const inner = v.map(pyRepr).join(", ");
    return v.length === 1 ? `(${inner},)` : `(${inner})`;
  }
  return String(v);
}

// -- JSON -----------------------------------------------------------------------------------
/** Python's json.dumps(v) with its default separators and ensure_ascii, optionally sorting
 * keys. bigints are written as integers, Maps as objects. */
export function jsonDumps(v: unknown, sortKeys = false): string {
  const out: string[] = [];
  const w = (x: any): void => {
    if (x === null || x === undefined) { out.push("null"); return; }
    if (typeof x === "boolean") { out.push(x ? "true" : "false"); return; }
    if (typeof x === "bigint") { out.push(x.toString()); return; }
    if (typeof x === "number") {
      if (Number.isNaN(x)) out.push("NaN");
      else if (x === Infinity) out.push("Infinity");
      else if (x === -Infinity) out.push("-Infinity");
      else out.push(Number.isInteger(x) && !Object.is(x, -0) && Math.abs(x) < 1e16 ? String(x) : floatRepr(x));
      return;
    }
    if (typeof x === "string") { out.push(jsonString(x)); return; }
    if (Array.isArray(x)) {
      out.push("[");
      x.forEach((y, i) => { if (i) out.push(", "); w(y); });
      out.push("]");
      return;
    }
    let entries: [string, any][] = x instanceof Map ? [...x.entries()].map(([k, y]) => [String(k), y])
      : Object.entries(x).filter(([, y]) => y !== undefined);
    if (sortKeys) entries = sortedBy(entries, (e) => e[0]);
    out.push("{");
    entries.forEach(([k, y], i) => {
      if (i) out.push(", ");
      out.push(jsonString(k), ": ");
      w(y);
    });
    out.push("}");
  };
  w(v);
  return out.join("");
}

export function jsonString(s: string): string {
  let r = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const ch = s[i];
    if (ch === '"') r += '\\"';
    else if (ch === "\\") r += "\\\\";
    else if (ch === "\n") r += "\\n";
    else if (ch === "\r") r += "\\r";
    else if (ch === "\t") r += "\\t";
    else if (ch === "\b") r += "\\b";
    else if (ch === "\f") r += "\\f";
    else if (c < 0x20 || c > 0x7E) r += "\\u" + c.toString(16).padStart(4, "0");
    else r += ch;
  }
  return r + '"';
}

// -- hashing --------------------------------------------------------------------------------
export function sha256Hex(data: string | Uint8Array): string {
  return bytesToHex(sha256(typeof data === "string" ? utf8(data) : data));
}

// -- collections ----------------------------------------------------------------------------
/** collections.Counter, as far as the prototype uses it. */
export class Counter<K> extends Map<K, number> {
  constructor(items?: Iterable<K>) {
    super();
    if (items) for (const k of items) this.add(k);
  }
  add(k: K, n = 1): void { this.set(k, (super.get(k) ?? 0) + n); }
  count(k: K): number { return super.get(k) ?? 0; }
}

export function zip<A, B>(a: readonly A[], b: readonly B[]): [A, B][] {
  const n = Math.min(a.length, b.length);
  const out: [A, B][] = [];
  for (let i = 0; i < n; i++) out.push([a[i], b[i]]);
  return out;
}

export function range(a: number, b?: number, step = 1): number[] {
  const [lo, hi] = b === undefined ? [0, a] : [a, b];
  const out: number[] = [];
  if (step > 0) for (let i = lo; i < hi; i += step) out.push(i);
  else for (let i = lo; i > hi; i += step) out.push(i);
  return out;
}

export function setdefault<K, V>(m: Map<K, V>, k: K, d: V): V {
  if (!m.has(k)) m.set(k, d);
  return m.get(k)!;
}

/** A structural deep copy (copy.deepcopy) of model objects: class instances keep their
 * prototype, arrays/Maps/Sets are copied, shared references stay shared. */
export function deepcopy<T>(v: T, memo = new Map<any, any>()): T {
  if (v === null || typeof v !== "object") return v;
  if (memo.has(v)) return memo.get(v);
  if (Array.isArray(v)) {
    const out: any[] = [];
    memo.set(v, out);
    for (const x of v) out.push(deepcopy(x, memo));
    return out as any;
  }
  if (v instanceof Map) {
    const out = new Map();
    memo.set(v, out);
    for (const [k, x] of v) out.set(deepcopy(k, memo), deepcopy(x, memo));
    return out as any;
  }
  if (v instanceof Set) {
    const out = new Set();
    memo.set(v, out);
    for (const x of v) out.add(deepcopy(x, memo));
    return out as any;
  }
  if (v instanceof Uint8Array) return v.slice() as any;
  const out = Object.create(Object.getPrototypeOf(v));
  memo.set(v, out);
  for (const k of Object.keys(v)) out[k] = deepcopy((v as any)[k], memo);
  return out;
}

/** Structural equality of model objects, like a dataclass's ==. */
export function deepEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a === "number") return a === b;
  if (a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (a instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [k, x] of a) if (!b.has(k) || !deepEqual(x, b.get(k))) return false;
    return true;
  }
  if (a instanceof Set) {
    if (a.size !== b.size) return false;
    for (const x of a) if (!b.has(x)) return false;
    return true;
  }
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual(a[k], b[k]));
}
