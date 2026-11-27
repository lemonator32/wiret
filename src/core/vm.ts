/** Reference VM: loads, verifies, links and interprets WBC modules (spec sections 5 and 6).
 *
 * This is the stand-in for `libwiret`. It follows the C API's model loosely: `VM.load` is
 * `wr_load` (decode, verify, link), `VM.call` is `wr_push_func` + `wr_call`, faults carry a
 * node-level traceback (section 6.9) and execution is bounded by fuel (5.7).
 *
 * Values: i32 (and bool) are numbers, i64 are bigints, f32/f64 numbers, strings strings; an
 * array is a CArray, a map or set a CMap, a struct or lane value a plain array, an object an
 * Obj, a delegate a Delegate, null is null. */
import * as lanes from "./lanes.js";
import * as wbc from "./wbc.js";
import {
  allNatives, CArray, CMap, FaultValue, LANE_TRIG, NativeFault, NativeSpec, NO_FAULT, Signal, _laneNatives,
} from "./natives.js";
import { verify, VerifyError } from "./verifier.js";
import {
  ArrayType, ClassType, DelegateType, DispatcherType, F32, F64, FAULT, FuncType, I32, I64, InterfaceType, MapType,
  OPS, Ref, SetType, SIGNAL, STRING, StructType, TypeEntry, VT, WbcError, WbcModule,
} from "./wbc.js";
import { BUNDLED, BUNDLED2, acos as detAcos, cos as detCos, sin as detSin } from "./detmath.js";
import {
  bitLength, copysign, f32, f32Bits, f32FromBits, f64Bits, f64FromBits, floatFromHex, floatHex, pyRepr, pyRound,
  sha256Hex, sortedBy, utf8Len, cmp,
} from "./pyutil.js";

export const STATUS_OK = "WR_OK";
export const STATUS_FAULT = "WR_ERR_FAULT";
export const STATUS_FUEL = "WR_ERR_FUEL";
export const STATUS_LOAD = "WR_ERR_LOAD";
export const STATUS_VERIFY = "WR_ERR_VERIFY";
export const STATUS_LINK = "WR_ERR_LINK";
export const STATUS_API = "WR_ERR_API";
export const STATUS_INTERRUPT = "WR_ERR_INTERRUPT";
export const STATUS_YIELD = "WR_YIELD";

export const FIBER_READY = "READY", FIBER_RUNNING = "RUNNING", FIBER_SUSPENDED = "SUSPENDED",
  FIBER_DONE = "DONE", FIBER_FAULTED = "FAULTED";

export const VT_OF: Record<string, VT> = {
  bool: I32, i8: I32, u8: I32, i16: I32, u16: I32, i32: I32, u32: I32, i64: I64, u64: I64,
  f32: F32, f64: F64, string: STRING, anyref: wbc.ANYREF, fault: FAULT, "std.Signal": SIGNAL,
};
for (const [vt, name] of wbc.LANE_VTS) VT_OF[name] = vt;

export const MAX_FRAMES = 2000;
export const MAX_CONT = 10000;

export const FAULT_DIVIDE = -1, FAULT_RANGE = -2, FAULT_NULL = -3, FAULT_CAST = -4, FAULT_STACK = -5,
  FAULT_NATIVE = -6, FAULT_UNREACHABLE = -7;

/** A runtime fault raised inside Wiret code. Catchable by `Try` (section 4.6). */
export class Fault extends Error {
  constructor(message: string, public code = FAULT_NATIVE) {
    super(message);
  }
}

export class WiretError extends Error {
  constructor(public status: string, message: string, public traceback: [string, string | null][] = [],
              public code = 0) {
    super(message);
  }

  override toString(): string {
    let s = `${this.status}: ${this.message}`;
    for (const [fn, node] of this.traceback) s += `\n  at ${fn}` + (node ? ` node ${node}` : "");
    return s;
  }
}

// -- integer and float helpers ---------------------------------------------------------
export const i32 = (x: number) => x | 0;
export const u32 = (x: number) => x >>> 0;
export const i64 = (x: any): bigint => BigInt.asIntN(64, x);
export const u64 = (x: bigint) => BigInt.asUintN(64, x);
const I32_MIN = -(2 ** 31);
const I64_MIN = -(1n << 63n);

function keepSign(fn: (x: number) => number) {
  return (x: number) => {
    if (!Number.isFinite(x)) return x;
    const r = fn(x);
    return r === 0 ? copysign(0, x) : r;
  };
}

function fmin(a: number, b: number): number {
  if (Number.isNaN(a) || Number.isNaN(b)) return NaN;
  if (a === 0 && b === 0) return copysign(1, a) < 0 || copysign(1, b) < 0 ? -0.0 : 0.0;
  return Math.min(a, b);
}

function fmax(a: number, b: number): number {
  if (Number.isNaN(a) || Number.isNaN(b)) return NaN;
  if (a === 0 && b === 0) return copysign(1, a) > 0 || copysign(1, b) > 0 ? 0.0 : -0.0;
  return Math.max(a, b);
}

const sqrt = (x: number) => (Number.isNaN(x) || x < 0 ? (x !== 0 ? NaN : x) : Math.sqrt(x));

/** An integer rounded once to the nearest binary32, ties to even (section 4.10). */
export function intToF32(n: number | bigint): number {
  const b = BigInt(n);
  const a = b < 0n ? -b : b;
  if (a < 1n << 24n) return Number(b);
  const shift = bitLength(a) - 24;
  let q = a >> BigInt(shift);
  const r = a & ((1n << BigInt(shift)) - 1n);
  const half = 1n << BigInt(shift - 1);
  if (r > half || (r === half && (q & 1n))) q += 1n;
  const v = Number(q << BigInt(shift));
  return f32(b < 0n ? -v : v);
}

export const CANONICAL_NAN32 = 0x7FC00000;

function truncSat32(lo: number, hi: number) {
  return (x: number) => {
    if (Number.isNaN(x)) return 0;
    if (x <= lo) return lo | 0;
    if (x >= hi) return hi | 0;
    return Math.trunc(x) | 0;
  };
}

function truncSat64(lo: bigint, hi: bigint) {
  return (x: number) => {
    if (Number.isNaN(x)) return 0n;
    if (x <= Number(lo)) return i64(lo);
    if (x >= Number(hi)) return i64(hi);
    return i64(BigInt(Math.trunc(x)));
  };
}

type NumFn = [number, (...a: any[]) => any];

function buildNumeric(): Map<number, NumFn> {
  const t = new Map<number, NumFn>();
  const put = (name: string, v: NumFn) => { if (name in OPS) t.set(OPS[name][0], v); };
  const b = (x: boolean) => (x ? 1 : 0);
  // i32
  const i: Record<string, NumFn> = {
    eqz: [1, (a) => b(a === 0)], eq: [2, (a, c) => b(a === c)], ne: [2, (a, c) => b(a !== c)],
    lt_s: [2, (a, c) => b(a < c)], lt_u: [2, (a, c) => b(a >>> 0 < c >>> 0)],
    gt_s: [2, (a, c) => b(a > c)], gt_u: [2, (a, c) => b(a >>> 0 > c >>> 0)],
    le_s: [2, (a, c) => b(a <= c)], le_u: [2, (a, c) => b(a >>> 0 <= c >>> 0)],
    ge_s: [2, (a, c) => b(a >= c)], ge_u: [2, (a, c) => b(a >>> 0 >= c >>> 0)],
    add: [2, (a, c) => (a + c) | 0], sub: [2, (a, c) => (a - c) | 0], mul: [2, (a, c) => Math.imul(a, c)],
    div_s: [2, (a, c) => {
      if (c === 0) throw new Fault("integer divide by zero", FAULT_DIVIDE);
      if (a === I32_MIN && c === -1) return I32_MIN;
      return (a / c) | 0;
    }],
    div_u: [2, (a, c) => {
      if (c === 0) throw new Fault("integer divide by zero", FAULT_DIVIDE);
      return Math.floor((a >>> 0) / (c >>> 0)) | 0;
    }],
    rem_s: [2, (a, c) => {
      if (c === 0) throw new Fault("integer remainder by zero", FAULT_DIVIDE);
      if (a === I32_MIN && c === -1) return 0;
      return (a % c) | 0;
    }],
    rem_u: [2, (a, c) => {
      if (c === 0) throw new Fault("integer remainder by zero", FAULT_DIVIDE);
      return ((a >>> 0) % (c >>> 0)) | 0;
    }],
    and: [2, (a, c) => a & c], or: [2, (a, c) => a | c], xor: [2, (a, c) => a ^ c],
    shl: [2, (a, c) => a << (c & 31)], shr_s: [2, (a, c) => a >> (c & 31)], shr_u: [2, (a, c) => (a >>> (c & 31)) | 0],
    neg: [1, (a) => (-a) | 0], not: [1, (a) => ~a],
    extend8_s: [1, (a) => (a << 24) >> 24], extend16_s: [1, (a) => (a << 16) >> 16],
  };
  for (const [name, v] of Object.entries(i)) put(`i32.${name}`, v);
  // i64, on bigints
  const ub = (x: any) => u64(x);
  const l: Record<string, [number, (...a: any[]) => any]> = {
    eqz: [1, (a) => b(a === 0n)], eq: [2, (a, c) => b(a === c)], ne: [2, (a, c) => b(a !== c)],
    lt_s: [2, (a, c) => b(a < c)], lt_u: [2, (a, c) => b(ub(a) < ub(c))],
    gt_s: [2, (a, c) => b(a > c)], gt_u: [2, (a, c) => b(ub(a) > ub(c))],
    le_s: [2, (a, c) => b(a <= c)], le_u: [2, (a, c) => b(ub(a) <= ub(c))],
    ge_s: [2, (a, c) => b(a >= c)], ge_u: [2, (a, c) => b(ub(a) >= ub(c))],
    add: [2, (a, c) => i64(a + c)], sub: [2, (a, c) => i64(a - c)], mul: [2, (a, c) => i64(a * c)],
    div_s: [2, (a, c) => {
      if (c === 0n) throw new Fault("integer divide by zero", FAULT_DIVIDE);
      if (a === I64_MIN && c === -1n) return I64_MIN;
      return i64(a / c);
    }],
    div_u: [2, (a, c) => {
      if (c === 0n) throw new Fault("integer divide by zero", FAULT_DIVIDE);
      return i64(ub(a) / ub(c));
    }],
    rem_s: [2, (a, c) => {
      if (c === 0n) throw new Fault("integer remainder by zero", FAULT_DIVIDE);
      if (a === I64_MIN && c === -1n) return 0n;
      return i64(a % c);
    }],
    rem_u: [2, (a, c) => {
      if (c === 0n) throw new Fault("integer remainder by zero", FAULT_DIVIDE);
      return i64(ub(a) % ub(c));
    }],
    and: [2, (a, c) => a & c], or: [2, (a, c) => a | c], xor: [2, (a, c) => a ^ c],
    shl: [2, (a, c) => i64(a << (c & 63n))], shr_s: [2, (a, c) => a >> (c & 63n)], shr_u: [2, (a, c) => i64(ub(a) >> (c & 63n))],
    neg: [1, (a) => i64(-a)], not: [1, (a) => i64(~a)],
    extend8_s: [1, (a) => BigInt.asIntN(8, a)], extend16_s: [1, (a) => BigInt.asIntN(16, a)],
    extend32_s: [1, (a) => BigInt.asIntN(32, a)],
  };
  for (const [name, v] of Object.entries(l)) put(`i64.${name}`, v);
  for (const [prefix, r] of [["f32", f32], ["f64", (x: number) => x]] as [string, (x: number) => number][]) {
    const fl: Record<string, NumFn> = {
      eq: [2, (a, c) => b(a === c)], ne: [2, (a, c) => b(a !== c)], lt: [2, (a, c) => b(a < c)],
      gt: [2, (a, c) => b(a > c)], le: [2, (a, c) => b(a <= c)], ge: [2, (a, c) => b(a >= c)],
      add: [2, (a, c) => r(a + c)], sub: [2, (a, c) => r(a - c)], mul: [2, (a, c) => r(a * c)],
      div: [2, (a, c) => r(a / c)], min: [2, fmin], max: [2, fmax], neg: [1, (a) => -a], abs: [1, (a) => Math.abs(a)],
      sqrt: [1, (a) => r(sqrt(a))], ceil: [1, keepSign(Math.ceil)], floor: [1, keepSign(Math.floor)],
      trunc: [1, keepSign(Math.trunc)], nearest: [1, keepSign(pyRound)], copysign: [2, copysign],
    };
    for (const [name, v] of Object.entries(fl)) put(`${prefix}.${name}`, v);
  }
  const conv: Record<string, (a: any) => any> = {
    "i32.wrap_i64": (a: bigint) => Number(BigInt.asIntN(32, a)), "i64.extend_i32_s": (a: number) => BigInt(a),
    "i64.extend_i32_u": (a: number) => BigInt(a >>> 0),
    "i32.trunc_f32_s": truncSat32(-(2 ** 31), 2 ** 31 - 1), "i32.trunc_f32_u": truncSat32(0, 2 ** 32 - 1),
    "i32.trunc_f64_s": truncSat32(-(2 ** 31), 2 ** 31 - 1), "i32.trunc_f64_u": truncSat32(0, 2 ** 32 - 1),
    "i64.trunc_f32_s": truncSat64(-(1n << 63n), (1n << 63n) - 1n), "i64.trunc_f32_u": truncSat64(0n, (1n << 64n) - 1n),
    "i64.trunc_f64_s": truncSat64(-(1n << 63n), (1n << 63n) - 1n), "i64.trunc_f64_u": truncSat64(0n, (1n << 64n) - 1n),
    "f32.convert_i32_s": intToF32, "f32.convert_i32_u": (a: number) => intToF32(a >>> 0),
    "f32.convert_i64_s": intToF32, "f32.convert_i64_u": (a: bigint) => intToF32(ub(a)),
    "f64.convert_i32_s": (a: number) => a, "f64.convert_i32_u": (a: number) => a >>> 0,
    "f64.convert_i64_s": (a: bigint) => Number(a), "f64.convert_i64_u": (a: bigint) => Number(ub(a)),
    "f32.demote_f64": f32, "f64.promote_f32": (a: number) => a,
    "i32.reinterpret_f32": (a: number) => (a !== a ? CANONICAL_NAN32 : f32Bits(a)),
    "i64.reinterpret_f64": (a: number) => (a !== a ? 0x7FF8000000000000n : f64Bits(a)),
    "f32.reinterpret_i32": f32FromBits, "f64.reinterpret_i64": f64FromBits,
  };
  for (const [name, fn] of Object.entries(conv)) t.set(OPS[name][0], [1, fn]);
  t.set(OPS["string.concat"][0], [2, (a, c) => a + c]);
  t.set(OPS["string.len"][0], [1, (a) => utf8Len(a)]);
  t.set(OPS["string.eq"][0], [2, (a, c) => b(a === c)]);
  t.set(OPS["string.cmp"][0], [2, (a, c) => cmp(a, c)]);
  return t;
}

export const NUMERIC = buildNumeric();

const OP_UNREACHABLE = 0x00, OP_NOP = 0x01, OP_BR = 0x02, OP_BR_IF = 0x03, OP_RETURN = 0x05, OP_CALL = 0x06,
  OP_CONT_PUSH = 0x0A, OP_CONT_POP = 0x0B, OP_DROP = 0x10, OP_SELECT = 0x11, OP_LGET = 0x12, OP_LSET = 0x13,
  OP_LTEE = 0x14, OP_GGET = 0x15, OP_GSET = 0x16;
const OP_TRY_PUSH = 0x0C, OP_SUSPEND = 0x0D, OP_THROW = 0x0E;
const OP_CONT_DEPTH = 0x17, OP_CONT_TRUNC = 0x18;
const OP_CALL_VIRTUAL = 0x07, OP_CALL_INTERFACE = 0x08, OP_CALL_DELEGATE = 0x09;
const OP_DELEGATE_NEW = 0xF4, OP_BIND = 0xF5, OP_UNBIND = 0xF6, OP_BROADCAST = 0xF7;
const OP_REF_NULL = 0x25, OP_REF_IS_NULL = 0x26, OP_REF_EQ = 0x27, OP_REF_CAST = 0x28, OP_REF_TEST = 0x29, OP_REF_VALID = 0x2A;
const OP_CLASS_NEW = 0xD3, OP_CLASS_GET = 0xD4, OP_CLASS_SET = 0xD5;
const OP_REF_SHARE = 0x2B;
const CONST_OPS = new Set([0x20, 0x21, 0x22, 0x23]);

/** A loaded class type: its name, field layout and defaults, vtable and ancestors. */
export class ClassInfo {
  constructor(public index: number, public name: string, public field_names: string[], public defaults: any[],
              public vtable: number[], public ancestors: Set<number>, public itables = new Map<number, number[]>(),
              public dispatchers: number[] = [], public overrides = new Map<number, number>()) {}
}

/** A function plus, when `bound`, its receiver (section 3.1). */
export class Delegate {
  constructor(public func: number, public recv: Obj | null = null, public bound = false) {}
  equals(o: unknown): boolean {
    return o instanceof Delegate && this.func === o.func && this.bound === o.bound && this.recv === o.recv;
  }
  toString(): string { return `<delegate func ${this.func}${this.bound ? " bound" : ""}>`; }
}

/** A dispatcher member of one object: its handlers in bind order. */
export class DispatcherObj {
  handlers: Delegate[] = [];
  toString(): string { return `<dispatcher, ${this.handlers.length} bound>`; }
}

let objCounter = 0;

/** A class instance (section 3.1): a reference with identity, so `Eq` is `===`. */
export class Obj {
  fields: any[];
  readonly serial = ++objCounter;
  constructor(public cls: ClassInfo) {
    this.fields = [...cls.defaults];
    for (const i of cls.dispatchers) this.fields[i] = new DispatcherObj();
  }
  get(name: string): any { return this.fields[this.cls.field_names.indexOf(name)]; }
  set(name: string, value: any): void { this.fields[this.cls.field_names.indexOf(name)] = value; }
  toString(): string { return `<${this.cls.name} ${this.serial.toString(16)}>`; }
}

const isHandleObj = (v: unknown) => v instanceof Obj || v instanceof Delegate;

/** A host value as the VM holds it, for a value type. */
export function normalise(vt: VT, v: any, types: TypeEntry[] | null = null): any {
  if (vt instanceof Ref) {
    const entry = types !== null ? types[vt.type] : null;
    if (entry instanceof ClassType || entry instanceof InterfaceType || entry instanceof DelegateType ||
        entry instanceof DispatcherType || isHandleObj(v) || v === null || v === undefined) return v ?? null;
    if (entry instanceof StructType) return entry.fields.map(([fvt], i) => normalise(fvt, v[i], types));
    if (entry instanceof MapType) {
      const src: [any, any][] = v instanceof CMap ? v.entries() : v instanceof Map ? [...v] : Object.entries(v);
      return new CMap(src.map(([k, x]) => [normalise(entry.key, k, types), normalise(entry.value, x, types)]));
    }
    if (entry instanceof SetType) {
      const src: any[] = v instanceof CMap ? v.keys() : v instanceof Map ? [...v.keys()] : v instanceof Set ? [...v] : [...v];
      return new CMap(src.map((k) => [normalise(entry.elem, k, types), null]));
    }
    if (entry === null && (v instanceof Map || v instanceof CMap)) return new CMap(v instanceof CMap ? v.entries() : [...v]);
    const elem = entry instanceof ArrayType ? entry.elem : null;
    return CArray.from2(elem !== null ? [...v].map((x) => normalise(elem, x, types)) : v);
  }
  if (vt === I32) return typeof v === "bigint" ? Number(BigInt.asIntN(32, v)) : Number(v) | 0;
  if (vt === I64) return i64(BigInt(typeof v === "number" ? Math.trunc(v) : v));
  if (vt === F32) return f32(Number(v));
  if (vt === F64) return Number(v);
  if (vt === FAULT || vt === SIGNAL) return v;
  if (wbc.LANE_VTS.has(vt as number)) return lanes.normalise(wbc.LANE_VTS.get(vt as number)!, v);
  return String(v);
}

export const ZERO = new Map<VT, any>([[I32, 0], [I64, 0n], [F32, 0.0], [F64, 0.0], [STRING, ""], [FAULT, NO_FAULT],
  [SIGNAL, null], [wbc.ANYREF, null]]);
for (const [vt, name] of wbc.LANE_VTS) ZERO.set(vt, lanes.DEFAULTS[name]);

/** A value as the host sees it: arrays as plain arrays, maps and sets as JS Maps, at any
 * depth (inside structs too). Objects, delegates and signals stay what they are. */
export function exportValue(v: any): any {
  if (v instanceof CArray) return Array.from(v, exportValue);
  if (v instanceof CMap) return new Map(v.entries().map(([k, x]) => [exportValue(k), exportValue(x)]));
  if (Array.isArray(v)) return v.map(exportValue);
  return v;
}

/** Zero value of a value type. */
export function zero(vt: VT): any {
  return vt instanceof Ref ? CArray.from2([], true) : ZERO.get(vt);
}

type Alloc = [number];

/** Copy-on-write (section 4.9): the container itself when unshared, else a fresh copy. */
function own<T extends CArray | CMap>(c: T, alloc: Alloc): T {
  if (!c.shared) return c;
  if (c instanceof CMap) {
    alloc[0] += c.size;
    return c.copy() as T;
  }
  alloc[0] += (c as CArray).length;
  return CArray.from2(c as CArray) as T;
}

type CFn = [(...a: any[]) => any[], number];

/** Map and set instructions (section 5.6) as [function, operand count]. */
function containerOps(def: (vt: VT) => any, alloc: Alloc): (entry: MapType | SetType, name: string) => CFn {
  const at = (c: CMap, i: number) => {
    if (!(0 <= i && i < c.size)) throw new Fault(`index ${i} is out of range (length ${c.size})`, FAULT_RANGE);
    return i;
  };
  const mapOps = (entry: MapType): Record<string, CFn> => {
    const zeroV = def(entry.value);
    return {
      "map.new": [() => [new CMap()], 0],
      "map.find": [(m: CMap, k) => (m.has(k) ? [m.get(k), 1] : [zeroV, 0]), 2],
      "map.set": [(m: CMap, k, v) => {
        const n = own(m, alloc);
        n.set(k, v);
        return [n];
      }, 3],
      "map.remove": [(m: CMap, k) => {
        if (!m.has(k)) return [m, 0];
        const n = own(m, alloc);
        n.delete(k);
        return [n, 1];
      }, 2],
      "map.has": [(m: CMap, k) => [m.has(k) ? 1 : 0], 2],
      "map.len": [(m: CMap) => [m.size], 1],
      "map.key_at": [(m: CMap, i) => [m.keys()[at(m, i)]], 2],
      "map.value_at": [(m: CMap, i) => [m.values()[at(m, i)]], 2],
      "map.clear": [() => [new CMap()], 1],
    };
  };
  const setOps = (): Record<string, CFn> => ({
    "set.new": [() => [new CMap()], 0],
    "set.add": [(st: CMap, v) => {
      if (st.has(v)) return [st, 0];
      const n = own(st, alloc);
      n.set(v, null);
      return [n, 1];
    }, 2],
    "set.remove": [(st: CMap, v) => {
      if (!st.has(v)) return [st, 0];
      const n = own(st, alloc);
      n.delete(v);
      return [n, 1];
    }, 2],
    "set.has": [(st: CMap, v) => [st.has(v) ? 1 : 0], 2],
    "set.len": [(st: CMap) => [st.size], 1],
    "set.at": [(st: CMap, i) => [st.keys()[at(st, i)]], 2],
    "set.clear": [() => [new CMap()], 1],
  });
  const cache = new Map<object, Record<string, CFn>>();
  return (entry, name) => {
    if (!cache.has(entry)) cache.set(entry, entry instanceof MapType ? mapOps(entry) : setOps());
    return cache.get(entry)![name];
  };
}

/** The default value of each value type, for locals, globals and new array elements. */
export function defaultValues(types: TypeEntry[], data: string[]): (vt: VT) => any {
  const cache = new Map<number, any>();
  const def = (vt: VT): any => {
    if (!(vt instanceof Ref)) return ZERO.get(vt);
    const entry = types[vt.type];
    if (entry instanceof ClassType || entry instanceof InterfaceType || entry instanceof DelegateType || entry instanceof DispatcherType)
      return null;
    if (entry instanceof MapType || entry instanceof SetType) return new CMap([], true);
    if (!(entry instanceof StructType)) return CArray.from2([], true);
    if (!cache.has(vt.type))
      cache.set(vt.type, entry.fields.map(([fvt, d]) => (d === null ? def(fvt) : fvt === STRING ? data[d] : d)));
    return cache.get(vt.type);
  };
  return def;
}

function arrayOps(def: (vt: VT) => any, alloc: Alloc) {
  const check = (a: CArray, i: number, extra = 0) => {
    if (!(0 <= i && i < a.length + extra)) throw new Fault(`array index ${i} is out of range (length ${a.length})`, FAULT_RANGE);
  };
  return {
    new: (elemVt: VT) => {
      const z = def(elemVt);
      return (n: number) => {
        if (n < 0) throw new Fault(`array length ${n} is negative`, FAULT_RANGE);
        alloc[0] += n;
        const a = new CArray();
        for (let i = 0; i < n; i++) a.push(z);
        return a;
      };
    },
    get: (a: CArray, i: number) => {
      check(a, i);
      return a[i];
    },
    set: (a: CArray, i: number, v: any) => {
      check(a, i);
      a = own(a, alloc);
      a[i] = v;
      return a;
    },
    push: (a: CArray, v: any) => {
      a = own(a, alloc);
      a.push(v);
      return a;
    },
    insert: (a: CArray, i: number, v: any) => {
      check(a, i, 1);
      a = own(a, alloc);
      a.splice(i, 0, v);
      return a;
    },
    remove: (a: CArray, i: number) => {
      check(a, i);
      a = own(a, alloc);
      a.splice(i, 1);
      return a;
    },
    clear: (_a: CArray) => new CArray(),
    clone: (a: CArray) => {
      alloc[0] += a.length;
      return CArray.from2(a);
    },
  } as Record<string, any>;
}

const ARRAY_ARITY = new Map([[0xD6, 1], [0xD7, 1], [0xD8, 2], [0xD9, 3], [0xDA, 2], [0xDB, 3], [0xDC, 2], [0xDD, 1], [0xDE, 1]]);

export class Func {
  locals: VT[] = [];
  zeros: any[] = [];
  ops: number[] = [];
  args: any[] = [];
  pcs: number[] = [];
  node_at: (string | null)[] = [];
  fault_at: (string | null)[] = [];
  starts = new Map<number, string[]>();
  local_names = new Map<number, string>();
  pins: [number, string, string][] = [];
  steps = new Map<number, string>();
  constructor(public index: number, public name: string, public params: VT[], public results: VT[], public flags: number,
              public native: ((vm: VM, ...a: any[]) => any[]) | null = null, public native_name = "",
              public cost: ((...a: any[]) => number) | null = null) {}
}

export class FrameView {
  constructor(public func: Func, public node: string | null, public locals: any[]) {}

  /** "node\0pin" -> value for every pin kept in a local (wr.pins). */
  pinValues(): Map<string, [string, string, any]> {
    const out = new Map<string, [string, string, any]>();
    for (const [li, node, pin] of this.func.pins) out.set(`${node}\0${pin}`, [node, pin, this.locals[li]]);
    return out;
  }

  namedLocals(): Map<string, any> {
    const out = new Map<string, any>();
    for (const [li, name] of this.func.local_names) if (li < this.locals.length) out.set(name, this.locals[li]);
    return out;
  }
}

type Handler = { h: number; slot: number; node: string | null };
type ContEntry = number | Handler;
type Frame = [Func, number, any[], any[], ContEntry[]];

/** One thread of execution with its own frames (section 4.5). */
export class Fiber {
  status = FIBER_READY;
  results: any[] | null = null;
  error: WiretError | null = null;
  waiting: string | null = null;
  signal: Signal | null = null;
  ip = 0;
  stack: any[] = [];
  cont: ContEntry[] = [];
  frames: Frame[] = [];
  constructor(public id: number, public mod: LoadedModule, public name: string, public f: Func, public locs: any[],
              public wake = 0.0) {}
}

export class LoadedModule {
  constructor(public wbc: WbcModule, public name: string, public funcs: Func[], public exports: Map<string, number>,
              public globals: any[], public data: string[], public meta: Map<string, string>,
              public local_names: Map<number, Map<number, string>>, public global_names = new Map<string, number>(),
              public classes = new Map<string, ClassInfo>(), public capabilities: string[] = [],
              public declared = new Set<string>()) {}
}

type DebugTable = Map<number, [string | null, [number, string][], string[]]>;

/** wr.pins: function index -> [local, node id, pin name][]. */
export function parsePins(m: WbcModule, debug: DebugTable): Map<number, [number, string, string][]> {
  const out = new Map<number, [number, string, string][]>();
  const p = m.custom("wr.pins");
  if (!p) return out;
  const r = new wbc.Reader(p);
  for (let n = r.u32(); n > 0; n--) {
    const fi = r.u32();
    const table = debug.get(fi)?.[2] ?? [];
    const entries: [number, string, string][] = [];
    for (let k = r.u32(); k > 0; k--) {
      const li = r.u32(), ni = r.u32(), pi = r.u32();
      if (ni >= table.length || pi >= table.length) throw new WbcError("wr.pins index out of range");
      entries.push([li, table[ni], table[pi]]);
    }
    out.set(fi, entries);
  }
  return out;
}

/** wr.steps (and wr.pure, same layout): function index -> [pc, node id][]. */
export function parseSteps(m: WbcModule, debug: DebugTable, section = "wr.steps"): Map<number, [number, string][]> {
  const out = new Map<number, [number, string][]>();
  const p = m.custom(section);
  if (!p) return out;
  const r = new wbc.Reader(p);
  for (let n = r.u32(); n > 0; n--) {
    const fi = r.u32();
    const table = debug.get(fi)?.[2] ?? [];
    const entries: [number, string][] = [];
    let pc = 0;
    for (let k = r.u32(); k > 0; k--) {
      pc += r.u32();
      const ni = r.u32();
      if (ni >= table.length) throw new WbcError(`${section} index out of range`);
      entries.push([pc, table[ni]]);
    }
    out.set(fi, entries);
  }
  return out;
}

export function parseGlobalNames(m: WbcModule): Map<string, number> {
  const p = m.custom("name");
  const out = new Map<string, number>();
  if (!p) return out;
  try {
    const r = new wbc.Reader(p);
    for (let n = r.u32(); n > 0; n--) { r.u32(); r.name(); }
    for (let n = r.u32(); n > 0; n--) {
      r.u32();
      for (let k = r.u32(); k > 0; k--) { r.u32(); r.name(); }
    }
    for (let n = r.u32(); n > 0; n--) {
      const gi = r.u32();
      out.set(r.name(), gi);
    }
  } catch (e) {
    if (e instanceof WbcError) return new Map();
    throw e;
  }
  return out;
}

/** wr.caps: the capabilities the module declares it needs. */
export function parseCaps(m: WbcModule): string[] {
  const p = m.custom("wr.caps");
  if (!p) return [];
  const r = new wbc.Reader(p);
  const out: string[] = [];
  for (let n = r.u32(); n > 0; n--) out.push(r.name());
  return out;
}

/** wr_module_each_capability before loading. */
export function moduleCapabilities(data: Uint8Array): string[] {
  try {
    return parseCaps(wbc.decodeModule(data));
  } catch (e) {
    if (e instanceof WbcError || e instanceof RangeError) throw new WiretError(STATUS_LOAD, e.message);
    throw e;
  }
}

export type Customs = [Map<number, string>, Map<number, Map<number, string>>, DebugTable, Map<string, any>];

export function parseCustoms(m: WbcModule): Customs {
  const names = new Map<number, string>(), localNames = new Map<number, Map<number, string>>();
  const debug: DebugTable = new Map(), meta = new Map<string, any>();
  let p = m.custom("name");
  if (p) {
    const r = new wbc.Reader(p);
    for (let n = r.u32(); n > 0; n--) {
      const i = r.u32();
      names.set(i, r.name());
    }
    for (let n = r.u32(); n > 0; n--) {
      const fi = r.u32();
      const ln = new Map<number, string>();
      localNames.set(fi, ln);
      for (let k = r.u32(); k > 0; k--) {
        const li = r.u32();
        ln.set(li, r.name());
      }
    }
    for (let n = r.u32(); n > 0; n--) { r.u32(); r.name(); }
    if (!r.eof()) {
      for (let n = r.u32(); n > 0; n--) {
        const ti = r.u32();
        const cname = r.name();
        const fields: string[] = [];
        for (let k = r.u32(); k > 0; k--) fields.push(r.name());
        meta.set(`class\0${ti}`, [cname, fields]);
      }
    }
  }
  p = m.custom("wr.debug");
  if (p) {
    const r = new wbc.Reader(p);
    for (let n = r.u32(); n > 0; n--) {
      const fi = r.u32();
      const graph = r.name();
      const table: string[] = [];
      for (let k = r.u32(); k > 0; k--) table.push(r.name());
      const entries: [number, string][] = [];
      let pc = 0;
      for (let k = r.u32(); k > 0; k--) {
        pc += r.u32();
        const ni = r.u32();
        if (ni >= table.length) throw new WbcError("wr.debug node index out of range");
        entries.push([pc, table[ni]]);
      }
      debug.set(fi, [graph, entries, table]);
    }
  }
  p = m.custom("wr.meta");
  if (p) {
    const r = new wbc.Reader(p);
    for (const k of ["module", "id", "compiler", "registry", "semantic_hash", "layout_hash", "source_hash", "exports"]) {
      if (r.eof()) break;
      meta.set(k, r.name());
    }
  }
  return [names, localNames, debug, meta];
}

const withFn = (spec: NativeSpec, fn: NativeSpec["fn"]) =>
  new NativeSpec(spec.params, spec.results, spec.purity, fn, spec.doc, spec.cost, spec.capability, spec.deterministic);

export type Hook = (fname: string, node: string, pending: string[], depth: number, snapshot: () => FrameView[], phase: string) => void;

export interface VMOptions {
  output?: (line: string) => void;
  fuel?: number;
  hook?: Hook | null;
  capabilities?: Iterable<string> | null;
  deterministic?: boolean;
}

export class VM {
  deterministic: boolean;
  sink: (line: string) => void;
  input_log: any[] = [];
  _depth = 0;
  _printed: string[] = [];
  _handles = new Map<object, number>();
  _handle_objs: any[] = [];
  fuel_limit: number;
  fuel: number;
  hook: Hook | null;
  natives: Record<string, NativeSpec>;
  granted: Set<string>;
  interrupted = false;
  stats = { instructions: 0, calls: 0, replayable: true };
  alloc: Alloc = [0];
  time = 0.0;
  fibers: Fiber[] = [];
  next_fiber = 1;
  on_fault: ((fb: Fiber) => void) | null = null;
  handler_faults: WiretError[] = [];
  on_handler_fault: ((e: WiretError) => void) | null = null;

  constructor(opts: VMOptions = {}) {
    this.deterministic = opts.deterministic ?? false;
    this.sink = opts.output ?? ((line) => console.log(line));
    this.fuel_limit = this.fuel = opts.fuel ?? 50_000_000;
    this.hook = opts.hook ?? null;
    this.natives = { ...allNatives() };
    if (this.deterministic) {
      for (const [q, fn] of Object.entries(BUNDLED)) this.natives[q] = withFn(this.natives[q], (_vm, x) => [fn(x)]);
      for (const [q, fn] of Object.entries(BUNDLED2)) this.natives[q] = withFn(this.natives[q], (_vm, a, b) => [fn(a, b)]);
      const bundled = _laneNatives(detSin, detCos, detAcos);
      for (const q of LANE_TRIG) this.natives[q] = bundled[q];
      this.natives = Object.fromEntries(Object.entries(this.natives).filter(([, s]) => s.deterministic));
    }
    const caps = opts.capabilities ?? Object.values(this.natives).map((s) => s.capability).filter((c): c is string => !!c);
    this.granted = new Set(caps);
  }

  /** The output function natives call: logged lines also go to the input log entry. */
  output(line: string): void {
    if (this._depth) this._printed.push(line);
    this.sink(line);
  }

  /** wr_register. A deterministic VM refuses a native not marked deterministic. */
  register(qname: string, spec: NativeSpec): void {
    if (this.deterministic && !spec.deterministic)
      throw new WiretError(STATUS_LINK, `${qname} is not deterministic, so a deterministic VM cannot use it`);
    this.natives[qname] = spec;
  }

  interrupt(): void {
    this.interrupted = true;
    if (this.deterministic) this.stats.replayable = false;
  }

  // -- logged API (section 4.10) ------------------------------------------------
  private logged<T>(name: string, args: any[], fn: () => T): T {
    if (!this.deterministic) return fn();
    if (this._depth) {
      this._depth += 1;
      try {
        return fn();
      } finally {
        this._depth -= 1;
      }
    }
    const encArgs = name === "load" ? [sha256Hex(args[0])] : args.map((a) => encode(this, a, false));
    const before = this.stats.instructions;
    this._depth = 1;
    this._printed = [];
    const entry: any = { op: name, args: encArgs, kw: {} };
    try {
      const result = fn();
      entry.out = encode(this, result, true);
      entry.error = null;
      return result;
    } catch (e) {
      if (e instanceof WiretError) {
        entry.out = null;
        entry.error = [e.status, e.message, e.code];
      }
      throw e;
    } finally {
      this._depth = 0;
      entry.instructions = this.stats.instructions - before;
      entry.fuel = this.fuel;
      entry.output = [...this._printed];
      this.input_log.push(entry);
    }
  }

  signal(): Signal {
    return this.logged("signal", [], () => new Signal());
  }

  grant(capability: string): void {
    this.logged("grant", [capability], () => { this.granted.add(capability); });
  }

  // -- loading ------------------------------------------------------------------
  load(data: Uint8Array): LoadedModule {
    return this.logged("load", [data], () => this._load(data));
  }

  private _load(data: Uint8Array): LoadedModule {
    let m: WbcModule;
    try {
      m = wbc.decodeModule(data);
    } catch (e) {
      if (e instanceof WbcError || e instanceof RangeError) throw new WiretError(STATUS_LOAD, e.message);
      throw e;
    }
    let verified: ReturnType<typeof verify>;
    try {
      verified = verify(m);
    } catch (e) {
      if (e instanceof VerifyError) throw new WiretError(STATUS_VERIFY, e.message);
      throw e;
    }
    let caps: string[];
    try {
      caps = parseCaps(m);
    } catch (e) {
      if (e instanceof WbcError) throw new WiretError(STATUS_LOAD, `bad custom section: ${e.message}`);
      throw e;
    }
    for (const cap of caps)
      if (!this.granted.has(cap)) throw new WiretError(STATUS_LINK, `the module needs capability '${cap}', which the host has not granted`);
    let names: Customs[0], localNames: Customs[1], debug: Customs[2], meta: Customs[3];
    let pins: Map<number, [number, string, string][]>, steps: Map<number, [number, string][]>, pure: Map<number, [number, string][]>;
    try {
      [names, localNames, debug, meta] = parseCustoms(m);
      pins = parsePins(m, debug);
      steps = parseSteps(m, debug);
      pure = parseSteps(m, debug, "wr.pure");
    } catch (e) {
      if (e instanceof WbcError) throw new WiretError(STATUS_LOAD, `bad custom section: ${e.message}`);
      throw e;
    }
    const funcs: Func[] = [];
    const defaults = defaultValues(m.types, m.data);
    const classes = new Map<number, ClassInfo>();
    m.types.forEach((entry, ti) => {
      if (!(entry instanceof ClassType)) return;
      const chain: number[] = [];
      let t: number | null = ti;
      while (t !== null) {
        chain.push(t);
        t = (m.types[t] as ClassType).super_;
      }
      const layout: [VT, any][] = [];
      for (const c of [...chain].reverse()) layout.push(...(m.types[c] as ClassType).fields);
      const k = `class\0${ti}`;
      let [cname, fnames]: [string, string[]] = meta.get(k) ?? [`class${ti}`, []];
      meta.delete(k);
      if (fnames.length !== layout.length) fnames = layout.map((_, i) => `field${i}`);
      const vals = layout.map(([vt, d]) => (d === null ? defaults(vt) : vt === STRING ? m.data[d] : d));
      const itables = new Map(entry.interfaces.map(([i, impl]) => [i, [...impl]]));
      const slots = layout.map(([vt], i) => [vt, i] as [VT, number])
        .filter(([vt]) => vt instanceof Ref && m.types[vt.type] instanceof DispatcherType).map(([, i]) => i);
      const overrides = new Map<number, number>();
      for (const a of chain.slice(1))
        (m.types[a] as ClassType).vtable.forEach((fi, s) => {
          if (s < entry.vtable.length && !overrides.has(fi)) overrides.set(fi, entry.vtable[s]);
        });
      classes.set(ti, new ClassInfo(ti, cname, fnames, vals, [...entry.vtable], new Set([...chain, ...itables.keys()]),
        itables, slots, overrides));
    });
    const alloc = this.alloc;
    const arrays = arrayOps(defaults, alloc);
    const containers = containerOps(defaults, alloc);
    m.imports.forEach(([mod, fld, t, flags], i) => {
      const q = `${mod}.${fld}`;
      const spec = this.natives[q];
      const [params, results] = m.types[t] as FuncType;
      if (spec === undefined) throw new WiretError(STATUS_LINK, `unresolved import ${q}`);
      if (spec.capability && !this.granted.has(spec.capability))
        throw new WiretError(STATUS_LINK, `import ${q} needs capability '${spec.capability}', which the host has not granted`);
      const same = (a: VT[], b: VT[]) => a.length === b.length && a.every((x, j) => x === b[j]);
      if (!same(spec.params.map(([, x]) => VT_OF[x]), params) || !same(spec.results.map(([, x]) => VT_OF[x]), results))
        throw new WiretError(STATUS_LINK, `import ${q} has a different signature than the registered native`);
      funcs.push(new Func(i, q, params, results, flags, spec.fn as any, q, spec.cost));
    });
    const nimp = m.imports.length;
    m.funcs.forEach(([t, flags], i) => {
      const body = m.bodies[i];
      const [instrs] = verified[i];
      const fi = nimp + i;
      const [params, results] = m.types[t] as FuncType;
      const f = new Func(fi, names.get(fi) ?? `func${fi}`, params, results, flags);
      f.locals = [...body.locals];
      f.zeros = f.locals.map((vt) => defaults(vt));
      const indexOf = new Map(instrs.map((ins, k) => [ins.pc, k]));
      for (const ins of instrs) {
        let arg: any;
        const n = ins.name;
        if (n === "br" || n === "br_if" || n === "cont.push") arg = indexOf.get(ins.target());
        else if (n === "try.push") arg = { h: indexOf.get(ins.target())!, slot: ins.imms[1], node: null };
        else if (CONST_OPS.has(ins.op)) arg = ins.imms[0];
        else if (n === "string.const") arg = m.data[ins.imms[0]];
        else if (n === "array.new") arg = arrays.new((m.types[ins.imms[0]] as ArrayType).elem);
        else if (n === "array.len") arg = (a: CArray) => a.length;
        else if (n.startsWith("array.")) arg = arrays[n.slice(6)];
        else if (n.startsWith("map.") || n.startsWith("set.")) arg = containers(m.types[ins.imms[0]] as MapType | SetType, n);
        else if (ins.op > 0xFF) {
          const field = ins.imms.length ? ins.imms[0] : 0;
          arg = [lanes.effect(n, field)[0].length, lanes.laneFunction(n, field)];
        } else if (n === "struct.new") arg = (m.types[ins.imms[0]] as StructType).fields.length;
        else if (["struct.get", "struct.with", "class.get", "class.set"].includes(n)) arg = ins.imms[1];
        else if (n === "class.new") arg = classes.get(ins.imms[0]);
        else if (n === "call_virtual") {
          const [tt, slot] = ins.imms;
          arg = [slot, m.funcType((m.types[tt] as ClassType).vtable[slot])[0].length];
        } else if (n === "call_delegate") arg = (m.types[ins.imms[0]] as FuncType)[0].length;
        else if (n === "dispatcher.broadcast") arg = (m.types[(m.types[ins.imms[0]] as DispatcherType).functype] as FuncType)[0].length;
        else if (n === "delegate.new") arg = ins.imms;
        else if (n === "call_interface") {
          const [tt, k] = ins.imms;
          arg = [tt, k, 1 + (m.types[(m.types[tt] as InterfaceType).methods[k]] as FuncType)[0].length];
        } else arg = ins.imms.length ? ins.imms[0] : null;
        f.ops.push(ins.op);
        f.args.push(arg);
        f.pcs.push(ins.pc);
      }
      const [, entries] = debug.get(fi) ?? [null, [], []];
      f.local_names = localNames.get(fi) ?? new Map();
      f.pins = (pins.get(fi) ?? []).filter(([li]) => li < params.length + f.locals.length);
      const byPc = new Map<number, string[]>();
      for (const [pc, node] of entries) {
        let l = byPc.get(pc);
        if (!l) byPc.set(pc, l = []);
        l.push(node);
      }
      const purePcs = new Map(pure.get(fi) ?? []);
      let cur: string | null = null, here: string | null = null;
      instrs.forEach((ins, k) => {
        if (byPc.has(ins.pc)) {
          const l = byPc.get(ins.pc)!;
          cur = here = l[l.length - 1];
          f.starts.set(k, [...l]);
        }
        if (purePcs.has(ins.pc)) here = purePcs.get(ins.pc)!;
        f.node_at.push(cur);
        f.fault_at.push(here);
      });
      f.ops.forEach((op, k) => { if (op === OP_TRY_PUSH) f.args[k] = { ...f.args[k], node: f.node_at[k] }; });
      const stepPcs = new Map(steps.get(fi) ?? []);
      instrs.forEach((ins, k) => { if (stepPcs.has(ins.pc)) f.steps.set(k, stepPcs.get(ins.pc)!); });
      funcs.push(f);
    });
    const exports = new Map(m.exports.filter(([, kind]) => kind === 0).map(([name, , index]) => [name, index]));
    const gvals = m.globals.map(([vt, , init]) => (vt === STRING ? m.data[init] : vt instanceof Ref ? defaults(vt) : init));
    return new LoadedModule(m, meta.get("module") ?? "", funcs, exports, gvals, m.data, meta, localNames, parseGlobalNames(m),
      new Map([...classes.values()].map((c) => [c.name, c])), caps,
      new Set(m.exports.filter(([, , , flags]) => flags & wbc.EX_DECLARED).map(([name]) => name)));
  }

  // -- execution ----------------------------------------------------------------
  private _fiber(mod: LoadedModule, name: string, args: any[]): Fiber {
    if (!mod.exports.has(name)) throw new WiretError(STATUS_LINK, `no exported function '${name}'`);
    const f = mod.funcs[mod.exports.get(name)!];
    if (args.length !== f.params.length)
      throw new WiretError(STATUS_API, `'${name}' takes ${f.params.length} argument(s), got ${args.length}`);
    const nargs = f.params.map((vt, i) => normalise(vt, args[i], mod.wbc.types));
    const fb = new Fiber(this.next_fiber, mod, name, f, [...nargs, ...f.zeros], this.time);
    this.next_fiber += 1;
    return fb;
  }

  /** wr_call on a function that cannot suspend: its results, or a WiretError. */
  call(mod: LoadedModule, name: string, args: any[]): any[] {
    return this.logged("call", [mod, name, args], () => {
      const fb = this._fiber(mod, name, args);
      if (fb.f.flags & wbc.FN_LATENT)
        throw new WiretError(STATUS_API, `'${name}' is latent and may suspend; run it with start() and advance()`);
      this._resume(fb);
      return fb.results!;
    });
  }

  /** wr_start: a new fiber for `name`, queued to run on the next advance(). */
  start(mod: LoadedModule, name: string, args: any[], now = false): Fiber {
    return this.logged("start", [mod, name, args, now], () => {
      const fb = this._fiber(mod, name, args);
      this.fibers.push(fb);
      if (now) this._resume(fb);
      return fb;
    });
  }

  /** wr_advance: move virtual time forward by `dt`, then run every fiber runnable at the
   * new time. Returns the fibers that ran. */
  advance(dt = 0.0): Fiber[] {
    return this.logged("advance", [dt], () => {
      if (dt < 0 || dt !== dt) throw new WiretError(STATUS_API, "advance needs a time step of 0 or more");
      this.time += dt;
      const due = sortedBy(this.fibers.filter((fb) => fb.status === FIBER_READY || (fb.waiting === "time" && fb.wake <= this.time)),
        (fb) => [fb.wake, fb.id]);
      for (const fb of due) {
        try {
          this._resume(fb);
        } catch (e) {
          if (!(e instanceof WiretError)) throw e;
          if (this.on_fault !== null) this.on_fault(fb);
        }
      }
      this.fibers = this.fibers.filter((fb) => fb.status === FIBER_READY || fb.status === FIBER_SUSPENDED);
      return due;
    });
  }

  /** wr_signal_fire: every fiber waiting on `signal` becomes runnable. */
  fire(signal: Signal): void {
    this.logged("fire", [signal], () => {
      const waiters = signal.waiters;
      signal.waiters = [];
      for (const fb of waiters as Fiber[]) {
        fb.status = FIBER_READY;
        fb.waiting = null;
        fb.signal = null;
        fb.wake = this.time;
      }
    });
  }

  /** wr_fiber_kill: end a fiber without running anything more of it. */
  kill(fb: Fiber): void {
    this.logged("kill", [fb], () => {
      if (fb.signal !== null) fb.signal.waiters = fb.signal.waiters.filter((x) => x !== fb);
      fb.status = FIBER_FAULTED;
      fb.waiting = null;
      fb.signal = null;
      fb.error = new WiretError(STATUS_FAULT, "killed by the host");
    });
  }

  /** The earliest time a Delay is waiting for, if any. */
  nextWake(): number | null {
    const times = this.fibers.filter((fb) => fb.waiting === "time").map((fb) => fb.wake);
    return times.length ? Math.min(...times) : null;
  }

  /** An instance of `cls` with its declared defaults (wr_push_new). */
  new(mod: LoadedModule, cls: string): Obj {
    return this.logged("new", [mod, cls], () => {
      if (!mod.classes.has(cls)) throw new WiretError(STATUS_LINK, `no class '${cls}'`);
      return new Obj(mod.classes.get(cls)!);
    });
  }

  /** The override of `method` for obj's class, with obj as self. */
  callMethod(mod: LoadedModule, obj: Obj | null, method: string, args: any[]): any[] {
    return this.logged("call_method", [mod, obj, method, args], () => {
      if (obj === null) throw new WiretError(STATUS_FAULT, "method call on a null object", [], FAULT_NULL);
      for (const fi of obj.cls.vtable) {
        const f = mod.funcs[fi];
        if (f.name.slice(f.name.lastIndexOf(".") + 1) === method) {
          const name = [...mod.exports].find(([, i]) => i === fi)?.[0];
          if (name !== undefined) return this.call(mod, name, [obj, ...args]);
        }
      }
      throw new WiretError(STATUS_LINK, `class '${obj.cls.name}' has no method '${method}'`);
    });
  }

  /** A delegate of an exported function, or of a method bound to `obj`. */
  delegate(mod: LoadedModule, func: string, obj: Obj | null = null): Delegate {
    return this.logged("delegate", [mod, func, obj], () => {
      if (!mod.exports.has(func)) throw new WiretError(STATUS_LINK, `no exported function '${func}'`);
      const fi = mod.exports.get(func)!;
      if (obj !== null) return new Delegate(obj.cls.overrides.get(fi) ?? fi, obj, true);
      return new Delegate(fi);
    });
  }

  /** Broadcast an object's dispatcher from the host, as the Broadcast node does. */
  broadcast(mod: LoadedModule, obj: Obj, dispatcher: string, args: any[]): void {
    this.logged("broadcast", [mod, obj, dispatcher, args], () => {
      const disp = obj.get(dispatcher);
      if (!(disp instanceof DispatcherObj)) throw new WiretError(STATUS_API, `'${dispatcher}' is not a dispatcher of ${obj.cls.name}`);
      this.fuel = this.fuel_limit;
      this._broadcast(mod, disp, [...args]);
    });
  }

  private _spawn(mod: LoadedModule, f: Func, args: any[]): Fiber {
    const fb = new Fiber(this.next_fiber, mod, f.name, f, [...args, ...f.zeros], this.time);
    this.next_fiber += 1;
    this.fibers.push(fb);
    return fb;
  }

  private _broadcast(mod: LoadedModule, disp: DispatcherObj, args: any[]): void {
    for (const d of [...disp.handlers]) {
      const f = mod.funcs[d.func];
      const cargs = [...(d.bound ? [d.recv] : []), ...args];
      if (f.flags & wbc.FN_LATENT) {
        this._spawn(mod, f, cargs);
        continue;
      }
      const sub = new Fiber(0, mod, f.name, f, [...cargs, ...f.zeros]);
      try {
        this._run(sub);
      } catch (e) {
        if (!(e instanceof WiretError)) throw e;
        if (e.status === STATUS_FUEL || e.status === STATUS_INTERRUPT) throw e;
        this.handler_faults.push(e);
        if (this.on_handler_fault !== null) this.on_handler_fault(e);
      }
    }
  }

  private _resume(fb: Fiber): void {
    this.fuel = this.fuel_limit;
    this.interrupted = false;
    fb.status = FIBER_RUNNING;
    try {
      this._run(fb);
    } catch (e) {
      if (e instanceof WiretError) {
        fb.status = FIBER_FAULTED;
        fb.error = e;
      }
      throw e;
    }
  }

  /** Frames from outermost to innermost, for a debugger. */
  static snapshot(frames: Frame[], f: Func, locs: any[], node: string | null): FrameView[] {
    const out = frames.map(([ff, ip, flocs]) => new FrameView(ff, ff.fault_at[Math.max(ip - 1, 0)], [...flocs]));
    out.push(new FrameView(f, node, [...locs]));
    return out;
  }

  /** The continuation stack as node ids, bottom first. */
  static pending(f: Func, cont: ContEntry[]): string[] {
    return cont.map((k) => (typeof k === "number" ? f.node_at[k]! : `${k.node}!fault`));
  }

  private _traceback(frames: [Func, number][]): [string, string | null][] {
    return frames.map(([f, ip]) => {
      const k = Math.max(ip - 1, 0);
      return [f.name, k < f.fault_at.length ? f.fault_at[k] : null];
    });
  }

  /** Run a fiber until it finishes (results in fb.results), suspends, or faults. */
  private _run(fb: Fiber): any[] | null {
    const mod = fb.mod;
    const funcs = mod.funcs;
    const gl = mod.globals;
    const numeric = NUMERIC;
    const hook = this.hook;
    let f = fb.f, ip = fb.ip, locs = fb.locs, stack = fb.stack, cont = fb.cont;
    const alloc = this.alloc;
    const frames = fb.frames;
    let ops = f.ops, args = f.args;
    let fuel = this.fuel;
    let executed = 0;
    const tb = () => this._traceback([...frames.map(([ff, fip]) => [ff, fip] as [Func, number]), [f, ip]]);
    try {
      for (;;) {
        try {
          for (;;) {
            if (hook !== null) {
              const nodes = f.starts.get(ip);
              if (nodes !== undefined) {
                const pending = VM.pending(f, cont);
                for (const node of nodes) {
                  const ff = f, fl = locs;
                  hook(f.name, node, pending, frames.length, () => VM.snapshot(frames, ff, fl, node), "enter");
                }
              }
              const node = f.steps.get(ip);
              if (node !== undefined) {
                const ff = f, fl = locs;
                hook(f.name, node, VM.pending(f, cont), frames.length, () => VM.snapshot(frames, ff, fl, node), "ready");
              }
            }
            const op = ops[ip], arg = args[ip];
            ip += 1;
            fuel -= 1;
            executed += 1;
            if (fuel < 0) {
              this.fuel = 0;
              throw new WiretError(STATUS_FUEL, "fuel exhausted", tb());
            }
            if ((executed & 0xFFF) === 0 && this.interrupted) throw new WiretError(STATUS_INTERRUPT, "interrupted by the host", tb());
            if (op === OP_LGET) {
              stack.push(locs[arg]);
              continue;
            }
            if (op === OP_LSET) {
              locs[arg] = stack.pop();
              continue;
            }
            const num = numeric.get(op);
            if (num !== undefined) {
              const [n, fn] = num;
              if (n === 2) {
                const b = stack.pop();
                stack[stack.length - 1] = fn(stack[stack.length - 1], b);
              } else stack[stack.length - 1] = fn(stack[stack.length - 1]);
              continue;
            }
            if (op > 0xFF) {
              const [n, fn] = arg;
              if (n === 1) stack[stack.length - 1] = fn(stack[stack.length - 1]);
              else if (n === 2) {
                const b = stack.pop();
                stack[stack.length - 1] = fn(stack[stack.length - 1], b);
              } else {
                const operands = stack.splice(stack.length - n, n);
                stack.push(fn(...operands));
              }
              continue;
            }
            switch (op) {
              case 0x20: case 0x21: case 0x22: case 0x23: case 0x24:
                stack.push(arg);
                break;
              case OP_LTEE:
                locs[arg] = stack[stack.length - 1];
                break;
              case OP_BR:
                ip = arg;
                break;
              case OP_BR_IF:
                if (stack.pop()) ip = arg;
                break;
              case OP_CONT_PUSH: case OP_TRY_PUSH:
                if (cont.length >= MAX_CONT) throw new Fault("continuation stack overflow", FAULT_STACK);
                cont.push(arg);
                break;
              case OP_CONT_POP:
                while (cont.length) {
                  const k = cont.pop()!;
                  if (typeof k === "number") {
                    ip = k;
                    break;
                  }
                }
                break;
              case OP_CONT_DEPTH:
                stack.push(cont.length);
                break;
              case OP_CONT_TRUNC: {
                const d = stack.pop();
                if (0 <= d && d < cont.length) cont.length = d;
                break;
              }
              case OP_SUSPEND:
                if (arg === 1) {
                  const secs = stack.pop();
                  fb.waiting = "time";
                  fb.wake = this.time + (secs > 0 ? secs : 0.0);
                  fb.status = FIBER_SUSPENDED;
                } else if (arg === 2) {
                  const sig = stack.pop();
                  if (sig === null) throw new Fault("Await on a null signal", FAULT_NULL);
                  sig.waiters.push(fb);
                  fb.waiting = "signal";
                  fb.signal = sig;
                  fb.status = FIBER_SUSPENDED;
                } else {
                  fb.waiting = null;
                  fb.wake = this.time;
                  fb.status = FIBER_READY;
                }
                fb.f = f;
                fb.ip = ip;
                fb.locs = locs;
                fb.stack = stack;
                fb.cont = cont;
                this.fuel = fuel;
                return null;
              case OP_THROW: {
                const fv = stack.pop();
                throw new Fault(fv.message, fv.code);
              }
              case OP_GGET:
                stack.push(gl[arg]);
                break;
              case OP_GSET:
                gl[arg] = stack.pop();
                break;
              case OP_SELECT: {
                const c = stack.pop();
                const b = stack.pop();
                if (!c) stack[stack.length - 1] = b;
                break;
              }
              case OP_DROP:
                stack.pop();
                break;
              case OP_CALL: case OP_CALL_VIRTUAL: case OP_CALL_INTERFACE: case OP_CALL_DELEGATE: {
                let callee: Func;
                if (op === OP_CALL) callee = funcs[arg];
                else if (op === OP_CALL_DELEGATE) {
                  const at = stack.length - arg - 1;
                  const d: Delegate | null = stack[at];
                  if (d === null) throw new Fault("invoke of a null delegate", FAULT_NULL);
                  if (d.bound) stack[at] = d.recv;
                  else stack.splice(at, 1);
                  callee = funcs[d.func];
                  if (callee.flags & wbc.FN_LATENT) {
                    const n = callee.params.length;
                    const cargs = n ? stack.splice(stack.length - n, n) : [];
                    this._spawn(mod, callee, cargs);
                    break;
                  }
                } else if (op === OP_CALL_VIRTUAL) {
                  const recv: Obj | null = stack[stack.length - arg[1]];
                  if (recv === null) throw new Fault("method call on a null object", FAULT_NULL);
                  callee = funcs[recv.cls.vtable[arg[0]]];
                } else {
                  const recv: Obj | null = stack[stack.length - arg[2]];
                  if (recv === null) throw new Fault("method call on a null object", FAULT_NULL);
                  callee = funcs[recv.cls.itables.get(arg[0])![arg[1]]];
                }
                fuel -= 4;
                this.stats.calls += 1;
                const np = callee.params.length;
                const cargs = np ? stack.splice(stack.length - np, np) : [];
                if (callee.native !== null) {
                  if (callee.cost !== null) fuel -= callee.cost(...cargs);
                  let res: any[];
                  try {
                    res = callee.native(this, ...cargs);
                  } catch (e) {
                    if (e instanceof NativeFault) throw new Fault(`${callee.native_name}: ${e.message}`, e.code);
                    throw e;
                  }
                  callee.results.forEach((vt, i) => stack.push(normalise(vt, res[i])));
                } else {
                  if (frames.length >= MAX_FRAMES) throw new Fault("stack overflow", FAULT_STACK);
                  frames.push([f, ip, locs, stack, cont]);
                  f = callee;
                  ops = f.ops;
                  args = f.args;
                  locs = [...cargs, ...f.zeros];
                  stack = [];
                  cont = [];
                  ip = 0;
                }
                break;
              }
              case OP_RETURN: {
                const nr = f.results.length;
                const res = nr ? stack.slice(stack.length - nr) : [];
                if (!frames.length) {
                  this.fuel = fuel;
                  const out = res.map(exportValue);
                  fb.status = FIBER_DONE;
                  fb.results = out;
                  return out;
                }
                [f, ip, locs, stack, cont] = frames.pop()!;
                ops = f.ops;
                args = f.args;
                stack.push(...res);
                break;
              }
              case OP_CLASS_GET: {
                const o: Obj | null = stack[stack.length - 1];
                if (o === null) throw new Fault("field read on a null object", FAULT_NULL);
                stack[stack.length - 1] = o.fields[arg];
                break;
              }
              case OP_CLASS_SET: {
                const v = stack.pop();
                const o: Obj | null = stack.pop();
                if (o === null) throw new Fault("field write on a null object", FAULT_NULL);
                o.fields[arg] = v;
                break;
              }
              case OP_CLASS_NEW:
                stack.push(new Obj(arg));
                fuel -= arg.defaults.length >> 3;
                break;
              case OP_REF_SHARE: {
                const c = stack[stack.length - 1];
                if (c !== null) c.shared = true;
                break;
              }
              case OP_REF_NULL:
                stack.push(null);
                break;
              case OP_REF_IS_NULL:
                stack[stack.length - 1] = stack[stack.length - 1] === null ? 1 : 0;
                break;
              case OP_REF_VALID:
                stack[stack.length - 1] = stack[stack.length - 1] !== null ? 1 : 0;
                break;
              case OP_REF_EQ: {
                const b = stack.pop();
                stack[stack.length - 1] = stack[stack.length - 1] === b ? 1 : 0;
                break;
              }
              case OP_REF_TEST: {
                const o: Obj | null = stack[stack.length - 1];
                stack[stack.length - 1] = o !== null && o.cls.ancestors.has(arg) ? 1 : 0;
                break;
              }
              case OP_REF_CAST: {
                const o: Obj | null = stack[stack.length - 1];
                if (o !== null && !o.cls.ancestors.has(arg)) throw new Fault(`${o.cls.name} cannot be cast to type ${arg}`, FAULT_CAST);
                break;
              }
              case OP_DELEGATE_NEW: {
                let [fi, flags] = arg;
                if (flags & 1) {
                  const recv: Obj | null = stack.pop();
                  if (recv === null) throw new Fault("delegate bound to a null object", FAULT_NULL);
                  if (flags & 2) fi = recv.cls.overrides.get(fi) ?? fi;
                  stack.push(new Delegate(fi, recv, true));
                } else stack.push(new Delegate(fi));
                break;
              }
              case OP_BIND: case OP_UNBIND: {
                const d: Delegate | null = stack.pop();
                const disp: DispatcherObj | null = stack.pop();
                if (d === null || disp === null)
                  throw new Fault(`${op === OP_BIND ? "Bind" : "Unbind"} with a null ${d === null ? "handler" : "object"}`, FAULT_NULL);
                const at = disp.handlers.findIndex((h) => h.equals(d));
                if (op === OP_BIND) {
                  if (at < 0) disp.handlers.push(d);
                } else if (at >= 0) disp.handlers.splice(at, 1);
                break;
              }
              case OP_BROADCAST: {
                const bargs = arg ? stack.splice(stack.length - arg, arg) : [];
                const disp: DispatcherObj | null = stack.pop();
                if (disp === null) throw new Fault("Broadcast on a null object", FAULT_NULL);
                this.fuel = fuel;
                this._broadcast(mod, disp, bargs);
                fuel = this.fuel;
                break;
              }
              case 0xD0: {
                const vals = arg ? stack.splice(stack.length - arg, arg) : [];
                stack.push(vals);
                fuel -= arg >> 3;
                break;
              }
              case 0xD1:
                stack[stack.length - 1] = stack[stack.length - 1][arg];
                break;
              case 0xD2: {
                const v = stack.pop();
                const s0: any[] = stack[stack.length - 1];
                const s1 = [...s0];
                s1[arg] = v;
                stack[stack.length - 1] = s1;
                fuel -= s0.length >> 3;
                break;
              }
              case OP_NOP:
                break;
              case OP_UNREACHABLE:
                throw new Fault("unreachable executed", FAULT_UNREACHABLE);
              default: {
                const arity = ARRAY_ARITY.get(op);
                if (arity !== undefined) {
                  if (arity === 1) stack[stack.length - 1] = arg(stack[stack.length - 1]);
                  else if (arity === 2) {
                    const b = stack.pop();
                    stack[stack.length - 1] = arg(stack[stack.length - 1], b);
                  } else {
                    const c = stack.pop();
                    const b = stack.pop();
                    stack[stack.length - 1] = arg(stack[stack.length - 1], b, c);
                  }
                  if (alloc[0]) {
                    fuel -= alloc[0] >> 3;
                    alloc[0] = 0;
                  }
                } else if (op >= 0xE0 && op <= 0xEF) {
                  const [fn, nin] = arg as CFn;
                  const res = nin ? fn(...stack.splice(stack.length - nin, nin)) : fn();
                  stack.push(...res);
                  if (alloc[0]) {
                    fuel -= alloc[0] >> 3;
                    alloc[0] = 0;
                  }
                } else throw new WiretError(STATUS_API, `unimplemented opcode 0x${op.toString(16).toUpperCase().padStart(2, "0")}`);
              }
            }
          }
        } catch (e) {
          if (!(e instanceof Fault)) throw e;
          const at: [Func, number][] = [...frames.map(([ff, fip]) => [ff, fip] as [Func, number]), [f, ip]];
          while (!cont.some((k) => typeof k !== "number")) {
            if (!frames.length) {
              this.fuel = fuel;
              throw new WiretError(STATUS_FAULT, e.message, this._traceback(at), e.code);
            }
            [f, ip, locs, stack, cont] = frames.pop()!;
            ops = f.ops;
            args = f.args;
          }
          let k: ContEntry;
          for (;;) {
            k = cont.pop()!;
            if (typeof k !== "number") break;
          }
          ip = k.h;
          locs[k.slot] = new FaultValue(e.message, e.code);
          stack.length = 0;
        }
      }
    } catch (e) {
      if (e instanceof RangeError && /call stack/i.test(e.message)) throw new WiretError(STATUS_FAULT, "stack overflow");
      throw e;
    } finally {
      this.stats.instructions += executed;
      this.fuel = Math.max(fuel, 0);
    }
  }
}

// -- the input log and replay (section 4.10) -----------------------------------------------------
export class ReplayMismatch extends Error {
  constructor(public index: number, public op: string, public what: string, public expected: unknown, public got: unknown) {
    super(`entry ${index} (${op}): ${what} differs: recorded ${pyRepr(JSON.stringify(expected))}, replay gave ${pyRepr(JSON.stringify(got))}`);
  }
}

const isHandle = (v: unknown) => v instanceof Obj || v instanceof Signal || v instanceof Fiber || v instanceof Delegate ||
  v instanceof DispatcherObj || v instanceof LoadedModule;

function encode(vm: VM, v: any, newOk: boolean): any {
  if (v === null || v === undefined || typeof v === "boolean" || typeof v === "string") return v ?? null;
  if (typeof v === "bigint") return { i: v.toString() };
  if (typeof v === "number") return Number.isInteger(v) && !Object.is(v, -0) ? v : { f: floatHex(v) };
  if (Array.isArray(v)) return { a: v.map((x) => encode(vm, x, newOk)) };
  if (v instanceof Map) return { m: [...v].map(([k, x]) => [encode(vm, k, newOk), encode(vm, x, newOk)]) };
  if (v instanceof CMap) return { m: v.entries().map(([k, x]) => [encode(vm, k, newOk), encode(vm, x, newOk)]) };
  if (isHandle(v)) {
    let h = vm._handles.get(v);
    if (h === undefined) {
      if (!newOk) throw new WiretError(STATUS_API, `${v.constructor.name} did not come from this VM's API, so a deterministic run cannot log it`);
      h = vm._handle_objs.length;
      vm._handles.set(v, h);
      vm._handle_objs.push(v);
    }
    return { h };
  }
  throw new WiretError(STATUS_API, `cannot log a ${v?.constructor?.name ?? typeof v}`);
}

function decode(vm: VM, v: any): any {
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    if ("f" in v) return floatFromHex(v.f);
    if ("i" in v) return BigInt(v.i);
    if ("a" in v) return v.a.map((x: any) => decode(vm, x));
    if ("m" in v) return new Map(v.m.map(([k, x]: [any, any]) => [decode(vm, k), decode(vm, x)]));
    return vm._handle_objs[v.h];
  }
  return v;
}

const LOG_METHODS: Record<string, (vm: VM, a: any[]) => unknown> = {
  load: (vm, a) => vm.load(a[0]), grant: (vm, a) => vm.grant(a[0]), signal: (vm) => vm.signal(),
  call: (vm, a) => vm.call(a[0], a[1], a[2]), start: (vm, a) => vm.start(a[0], a[1], a[2], a[3]),
  advance: (vm, a) => vm.advance(a[0]), fire: (vm, a) => vm.fire(a[0]), kill: (vm, a) => vm.kill(a[0]),
  new: (vm, a) => vm.new(a[0], a[1]), call_method: (vm, a) => vm.callMethod(a[0], a[1], a[2], a[3]),
  delegate: (vm, a) => vm.delegate(a[0], a[1], a[2]), broadcast: (vm, a) => vm.broadcast(a[0], a[1], a[2], a[3]),
};

/** Run an input log again on a new deterministic VM and check that every call gives the same
 * result or fault, instruction count, fuel and output (section 4.10). */
export function replay(data: Uint8Array, log: any[], opts: VMOptions = {}): VM {
  const vm = new VM({ ...opts, deterministic: true });
  log.forEach((entry, i) => {
    const op = entry.op;
    let args: any[];
    if (op === "load") {
      if (sha256Hex(data) !== entry.args[0]) throw new ReplayMismatch(i, op, "module", entry.args[0], "different bytes");
      args = [data];
    } else args = entry.args.map((a: any) => decode(vm, a));
    try {
      LOG_METHODS[op](vm, args);
    } catch (e) {
      if (!(e instanceof WiretError)) throw e;
    }
    const got = vm.input_log[vm.input_log.length - 1];
    for (const what of ["out", "error", "instructions", "fuel", "output"])
      if (JSON.stringify(got[what]) !== JSON.stringify(entry[what])) throw new ReplayMismatch(i, op, what, entry[what], got[what]);
  });
  return vm;
}
