/** Standard-library and host natives (spec sections 3.4 and 6.6).
 *
 * `std.*` natives are always available. Host natives (`host.*`) must be declared with
 * `extern func` in the module; the runtime supplies their implementations.
 *
 * VM values: i32/bool are numbers, i64 are bigints, f32/f64 numbers, strings strings; an
 * array is a CArray, a map or set a CMap, a struct or lane value a plain array. */
import * as L from "./lanes.js";
import { copysign, f32, floatRepr, formatG, fromUtf8, key, utf8, utf8Len } from "./pyutil.js";

/** An array value (section 4.9): a list plus the copy-on-write `shared` flag. */
export class CArray<T = any> extends Array<T> {
  shared = false;
  static from2<T>(items: Iterable<T>, shared = false): CArray<T> {
    const a = new CArray<T>();
    for (const x of items) a.push(x);
    a.shared = shared;
    return a;
  }
  static override get [Symbol.species]() { return Array; }
}

/** A map key as stored: every NaN is one key, and -0 is 0, also inside struct keys. */
export function mapKey(k: unknown): string {
  return key(k);
}

/** A map, or a set (its values are null): insertion-ordered, plus `shared`. Keys are VM
 * values; they are matched by value, as Python's dict does for the types the VM keeps. */
export class CMap {
  shared = false;
  private m = new Map<string, [any, any]>();

  constructor(items: Iterable<[any, any]> = [], shared = false) {
    for (const [k, v] of items) this.set(k, v);
    this.shared = shared;
  }

  get size(): number { return this.m.size; }
  has(k: any): boolean { return this.m.has(mapKey(k)); }
  get(k: any): any { return this.m.get(mapKey(k))?.[1]; }
  set(k: any, v: any): void {
    const s = mapKey(k);
    const e = this.m.get(s);
    if (e) e[1] = v;              // the first key written stays, as in a dict
    else this.m.set(s, [k, v]);
  }
  delete(k: any): boolean { return this.m.delete(mapKey(k)); }
  keys(): any[] { return [...this.m.values()].map((e) => e[0]); }
  values(): any[] { return [...this.m.values()].map((e) => e[1]); }
  entries(): [any, any][] { return [...this.m.values()].map((e) => [e[0], e[1]]); }
  copy(): CMap { return new CMap(this.entries()); }
}

/** Raised by a native to report a fault to the VM. -6 means an error from a native. */
export class NativeFault extends Error {
  constructor(message: string, public code = -6) {
    super(message);
  }
}

/** A value of type `std.Signal` (section 4.5). Equality is identity. */
export class Signal {
  waiters: any[] = [];
}

function _signalFire(vm: any, s: Signal | null): [] {
  if (s === null) throw new NativeFault("Fire on a null signal", -3);
  vm.fire(s);
  return [];
}

/** A value of type `fault` (section 4.6). */
export class FaultValue {
  constructor(readonly message: string, readonly code: number) {}
}

export const NO_FAULT = new FaultValue("", 0);

export type NativeFn = (vm: any, ...args: any[]) => any[];

export class NativeSpec {
  constructor(
    public params: [string, string][],
    public results: [string, string][],
    public purity: string,
    public fn: NativeFn | null,
    public doc = "",
    public cost: ((...args: any[]) => number) | null = null,
    public capability: string | null = null,
    /** WR_NATIVE_DETERMINISTIC (section 6.6) */
    public deterministic = true,
  ) {}
}

export const _f32 = f32;

/** Culture-independent, shortest round-tripping text (section 3.2). */
export function floatToText(x: number, single = false): string {
  if (Number.isNaN(x)) return "NaN";
  if (!Number.isFinite(x)) return x > 0 ? "Infinity" : "-Infinity";
  let s = "";
  if (single) {
    for (let p = 1; p < 10; p++) {
      s = formatG(x, p);
      if (f32(Number(s)) === x) break;
    }
  } else s = floatRepr(x);
  if (s.includes("e")) {
    const [mant, exp] = s.split("e");
    s = `${mant}e${parseInt(exp, 10)}`;
  } else if (!s.includes(".") && !s.includes("inf")) s += ".0";
  return s;
}

function _roundHalfAway(x: number): number {
  if (!Number.isFinite(x)) return x;
  return copysign(Math.floor(Math.abs(x) + 0.5), x);
}

function _substring(_vm: any, s: string, start: number, length: number): [string] {
  const b = utf8(s);
  if (start < 0 || length < 0 || start + length > b.length)
    throw new NativeFault(`Substring(${start}, ${length}) out of range for length ${b.length}`);
  return [fromUtf8(b.subarray(start, start + length), true)];
}

function bytesFind(hay: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/** Python's math functions return a float or raise ValueError/OverflowError; the natives
 * turn either into NaN. These give NaN where Python raises. */
const PY = {
  sqrt: (x: number) => (x < 0 ? NaN : Math.sqrt(x)),
  sin: (x: number) => Math.sin(x),
  cos: (x: number) => Math.cos(x),
  tan: (x: number) => Math.tan(x),
  exp: (x: number) => { const r = Math.exp(x); return r === Infinity && x !== Infinity ? NaN : r; },
  log: (x: number) => (x <= 0 ? NaN : Math.log(x)),
  // math.floor/ceil return an int: no -0, and an infinity or NaN raises
  floor: (x: number) => (!Number.isFinite(x) ? NaN : Math.floor(x) + 0),
  ceil: (x: number) => (!Number.isFinite(x) ? NaN : Math.ceil(x) + 0),
  acos: (x: number) => Math.acos(x),
};

function isInt(y: number): boolean {
  return Number.isFinite(y) && y === Math.floor(y);
}

/** Python's math.pow, with ValueError giving NaN and OverflowError +inf for a positive base
 * (else NaN), as the prototype's `_pow` does. */
export function pyPow(a: number, b: number): number {
  if (b === 0) return 1.0;
  if (a === 1) return 1.0;
  if (Number.isNaN(a) || Number.isNaN(b)) return NaN;
  if (a === 0 && b < 0 && Number.isFinite(b)) return NaN;          // ValueError
  if (a < 0 && Number.isFinite(a) && Number.isFinite(b) && !isInt(b)) return NaN;
  if (a === -1 && !Number.isFinite(b)) return 1.0;
  const r = Math.pow(a, b);
  if (!Number.isFinite(r) && Number.isFinite(a) && Number.isFinite(b)) return a > 0 ? Infinity : NaN;
  return r;
}

const f64u = (fn: (x: number) => number): NativeFn => (_vm, x) => [fn(x)];

/** `Eq` on two values of one type, as the VM stores them (section 4.9). */
export function valuesEqual(a: any, b: any): boolean {
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((x, i) => valuesEqual(x, b[i]));
  }
  if (a instanceof CMap) {
    if (!(b instanceof CMap) || a.size !== b.size) return false;
    for (const [k, v] of a.entries()) if (!b.has(k) || !valuesEqual(v, b.get(k))) return false;
    return true;
  }
  if (a instanceof FaultValue && b instanceof FaultValue) return a.message === b.message && a.code === b.code;
  return a === b;
}

/** How many elements, entries and fields `valuesEqual` may visit. */
export function valueSize(v: any): number {
  if (Array.isArray(v)) {
    let n = v.length;
    for (const x of v) if (Array.isArray(x) || x instanceof CMap) n += valueSize(x);
    return n;
  }
  if (v instanceof CMap) {
    let n = v.size;
    for (const x of v.values()) if (Array.isArray(x) || x instanceof CMap) n += valueSize(x);
    return n;
  }
  return 0;
}

const lenOf = (x: any): number => (x instanceof CMap ? x.size : x.length);

function _equals(_vm: any, a: any, b: any): [number] {
  return [valuesEqual(a, b) ? 1 : 0];
}

/** 1 fuel per 8 elements visited, like allocation; nothing when the lengths differ. */
function _equalsCost(a: any, b: any): number {
  return lenOf(a) !== lenOf(b) ? 0 : Math.min(valueSize(a), valueSize(b)) >> 3;
}

function _log(vm: any, message: string): [] {
  vm.output(message);
  return [];
}

const F = "f64";
const N = (params: [string, string][], results: [string, string][], purity: string, fn: NativeFn | null,
           doc = "", cost: NativeSpec["cost"] = null, capability: string | null = null) =>
  new NativeSpec(params, results, purity, fn, doc, cost, capability);

export const STD: Record<string, NativeSpec> = {
  "std.math.Sqrt": N([["x", F]], [["result", F]], "pure", f64u(PY.sqrt)),
  "std.math.Sin": N([["x", F]], [["result", F]], "pure", f64u(PY.sin)),
  "std.math.Cos": N([["x", F]], [["result", F]], "pure", f64u(PY.cos)),
  "std.math.Tan": N([["x", F]], [["result", F]], "pure", f64u(PY.tan)),
  "std.math.Exp": N([["x", F]], [["result", F]], "pure", f64u(PY.exp)),
  "std.math.Log": N([["x", F]], [["result", F]], "pure", f64u(PY.log)),
  "std.math.Floor": N([["x", F]], [["result", F]], "pure", f64u(PY.floor)),
  "std.math.Ceil": N([["x", F]], [["result", F]], "pure", f64u(PY.ceil)),
  "std.math.Round": N([["x", F]], [["result", F]], "pure", (_vm, x) => [_roundHalfAway(x)]),
  "std.math.Pow": N([["a", F], ["b", F]], [["result", F]], "pure", (_vm, a, b) => [pyPow(a, b)]),
  "std.math.Atan2": N([["y", F], ["x", F]], [["result", F]], "pure", (_vm, y, x) => [Math.atan2(y, x)]),
  "std.math.Lerp": N([["a", F], ["b", F], ["t", F]], [["result", F]], "pure", (_vm, a, b, t) => [a + (b - a) * t]),
  "std.math.Pi": N([], [["result", F]], "pure", () => [Math.PI]),
  "std.string.Concat": N([["a", "string"], ["b", "string"]], [["result", "string"]], "pure", (_vm, a, b) => [a + b]),
  "std.string.Length": N([["s", "string"]], [["result", "i32"]], "pure", (_vm, s) => [utf8Len(s)]),
  "std.string.Substring": N([["s", "string"], ["start", "i32"], ["length", "i32"]], [["result", "string"]], "pure", _substring),
  "std.string.Find": N([["s", "string"], ["sub", "string"]], [["result", "i32"]], "pure",
                       (_vm, s, sub) => [bytesFind(utf8(s), utf8(sub))]),
  "std.string.ToUpper": N([["s", "string"]], [["result", "string"]], "pure", (_vm, s) => [s.toUpperCase()]),
  "std.string.ToLower": N([["s", "string"]], [["result", "string"]], "pure", (_vm, s) => [s.toLowerCase()]),
  "std.string.Repeat": N([["s", "string"], ["count", "i32"]], [["result", "string"]], "pure",
                         (_vm, s, n) => [s.repeat(Math.max(0, n))]),
  "std.signal.New": N([], [["signal", "std.Signal"]], "impure", () => [new Signal()],
                      "Make a new signal that fibers can Await."),
  "std.signal.Fire": N([["signal", "std.Signal"]], [], "impure", _signalFire,
                       "Wake every fiber waiting on the signal. They run on the next advance of time."),
};

STD["std.math.Acos"] = N([["x", F]], [["result", F]], "pure", f64u(PY.acos));

/** The lane types' library (section 3.1.1). */
function laneNatives(sin: (x: number) => number, cos: (x: number) => number, acos: (x: number) => number): Record<string, NativeSpec> {
  const out: Record<string, NativeSpec> = {};
  const nat = (name: string, params: [string, string][], results: [string, string][], fn: (...a: any[]) => any, doc = "") => {
    out[name] = N(params, results, "pure", (_vm, ...a) => [fn(...a)], doc);
  };
  for (const t of L.VECTORS) {
    nat(`std.vec.Dot#<${t}>`, [["a", t], ["b", t]], [["result", "f32"]], L.dot);
    nat(`std.vec.Length#<${t}>`, [["v", t]], [["result", "f32"]], L.length);
    nat(`std.vec.LengthSquared#<${t}>`, [["v", t]], [["result", "f32"]], L.lensq);
    nat(`std.vec.Distance#<${t}>`, [["a", t], ["b", t]], [["result", "f32"]], L.distance);
    nat(`std.vec.Normalize#<${t}>`, [["v", t]], [["result", t]], L.normalize,
        "The vector scaled to length 1; the zero vector when it has no direction.");
    nat(`std.vec.Lerp#<${t}>`, [["a", t], ["b", t], ["t", "f32"]], [["result", t]], L.lerp);
    nat(`std.vec.Reflect#<${t}>`, [["v", t], ["n", t]], [["result", t]], L.reflect);
  }
  nat("std.vec.Cross", [["a", "vec3"], ["b", "vec3"]], [["result", "vec3"]], L.cross);
  nat("std.vec.PerpDot", [["a", "vec2"], ["b", "vec2"]], [["result", "f32"]], L.perpdot);
  nat("std.quat.Rotate", [["q", "quat"], ["v", "vec3"]], [["result", "vec3"]], L.rotate,
      "Rotate a vector by a unit quaternion.");
  nat("std.quat.Conjugate", [["q", "quat"]], [["result", "quat"]], L.conj);
  nat("std.quat.Inverse", [["q", "quat"]], [["result", "quat"]], L.qinverse);
  nat("std.quat.Normalize", [["q", "quat"]], [["result", "quat"]], L.qnormalize);
  const [axisAngle, slerp, angle] = L.quatNatives(sin, cos, acos);
  nat("std.quat.FromAxisAngle", [["axis", "vec3"], ["angle", "f32"]], [["result", "quat"]], axisAngle,
      "The rotation by `angle` radians about `axis`.");
  nat("std.quat.Slerp", [["a", "quat"], ["b", "quat"], ["t", "f32"]], [["result", "quat"]], slerp,
      "Interpolate between two rotations along the shorter arc.");
  nat("std.quat.Angle", [["a", "quat"], ["b", "quat"]], [["result", "f32"]], angle,
      "The angle in radians between two rotations.");
  nat("std.transform.Apply", [["t", "transform"], ["p", "vec3"]], [["result", "vec3"]], L.apply,
      "Transform a point: scale, rotate, then translate.");
  nat("std.transform.ApplyVector", [["t", "transform"], ["v", "vec3"]], [["result", "vec3"]], L.applyVector,
      "Transform a direction: no translation.");
  nat("std.transform.Inverse", [["t", "transform"]], [["result", "transform"]], L.tinverse);
  return out;
}
export { laneNatives as _laneNatives };

Object.assign(STD, laneNatives(Math.sin, Math.cos, Math.acos));
/** The natives that deterministic mode replaces with ones built on the bundled math (4.10). */
export const LANE_TRIG = ["std.quat.FromAxisAngle", "std.quat.Slerp", "std.quat.Angle"];

const single = (x: number) => floatToText(x, true);

/** Natives the compiler calls on its own to lower `Convert<X, string>` and float `Rem`. */
export const INTERNAL: Record<string, NativeSpec> = {
  "std.convert.FromBool": N([["v", "i32"]], [["r", "string"]], "pure", (_vm, v) => [v ? "true" : "false"]),
  "std.convert.FromI32": N([["v", "i32"]], [["r", "string"]], "pure", (_vm, v) => [String(v)]),
  "std.convert.FromU32": N([["v", "i32"]], [["r", "string"]], "pure", (_vm, v) => [String(v >>> 0)]),
  "std.convert.FromI64": N([["v", "i64"]], [["r", "string"]], "pure", (_vm, v) => [BigInt(v).toString()]),
  "std.convert.FromU64": N([["v", "i64"]], [["r", "string"]], "pure", (_vm, v) => [BigInt.asUintN(64, BigInt(v)).toString()]),
  "std.convert.FromF32": N([["v", "f32"]], [["r", "string"]], "pure", (_vm, v) => [floatToText(v, true)]),
  "std.convert.FromF64": N([["v", "f64"]], [["r", "string"]], "pure", (_vm, v) => [floatToText(v)]),
  "std.math.FRem32": N([["a", "f32"], ["b", "f32"]], [["r", "f32"]], "pure", (_vm, a, b) => [b ? f32(a % b) : NaN]),
  "std.math.FRem64": N([["a", "f64"], ["b", "f64"]], [["r", "f64"]], "pure", (_vm, a, b) => [b ? a % b : NaN]),
};
for (const t of ["vec2", "vec3", "quat", "transform"])
  INTERNAL[`std.convert.From${t[0].toUpperCase()}${t.slice(1)}`] =
    N([["v", t]], [["r", "string"]], "pure", (_vm, v) => [L.toText(v, single)]);

INTERNAL["std.fault.Make"] = N([["message", "string"], ["code", "i32"]], [["fault", "fault"]], "pure",
                               (_vm, m, c) => [new FaultValue(m, c)]);
INTERNAL["std.fault.Message"] = N([["fault", "fault"]], [["message", "string"]], "pure", (_vm, f) => [f.message]);
INTERNAL["std.fault.Code"] = N([["fault", "fault"]], [["code", "i32"]], "pure", (_vm, f) => [f.code]);

for (const kind of ["array", "set", "map"])
  INTERNAL[`std.${kind}.Equals`] = N([["a", "anyref"], ["b", "anyref"]], [["r", "bool"]], "pure", _equals,
                                     `True when two ${kind}s are equal.`, _equalsCost);

/** Host natives the reference runtime registers. */
export const HOST: Record<string, NativeSpec> = {
  "host.Log": N([["message", "string"]], [], "impure", _log, "Write a line to the console.", null, "console.write"),
};

export function allNatives(): Record<string, NativeSpec> {
  return { ...STD, ...INTERNAL, ...HOST };
}
