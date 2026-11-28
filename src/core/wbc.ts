/** WBC 1 binary format (spec section 5): opcodes, LEB128 and the section container, as the
 * compiler writes them. Reading modules (decoding, verifying, disassembling) is the runtime's
 * job (runtime/src/wbc.rs).
 *
 * Encoding choices the draft leaves open, fixed here for the prototype:
 * - every `u32` in the container (section sizes, vector lengths, indices) is unsigned LEB128;
 *   only magic, version and flags are fixed-width little-endian;
 * - branch offsets `L` are signed LEB128 padded to exactly 5 bytes, so code can be laid out
 *   in one pass;
 * - custom section payload layouts are documented in `prototype/README.md`. */
import { IMM_OPS as _LANE_IMM, SUB_OPS as _LANE_SUB } from "./lanes.js";
import { utf8 } from "./pyutil.js";

export const MAGIC = new Uint8Array([0x00, 0x57, 0x42, 0x43]);   // "\0WBC"
export const VERSION = 1;
export const FLAG_HAS_SOURCE = 1;
export const FLAG_LANES = 2;

// value types (section 5.3)
export const I32 = 0x7F, I64 = 0x7E, F32 = 0x7D, F64 = 0x7C, STRING = 0x6E;
export const REF = 0x6B;
export const ANYREF = 0x6D;
export const FAULT = 0x6A;
export const SIGNAL = 0x69;
export const VEC2 = 0x76, VEC3 = 0x75, QUAT = 0x74, TRANSFORM = 0x73;
export const LANE_VTS: Map<number, string> = new Map([[VEC2, "vec2"], [VEC3, "vec3"], [QUAT, "quat"], [TRANSFORM, "transform"]]);
export const LANE_LAYOUT: Map<number, number[]> = new Map([
  [VEC2, [F32, F32]], [VEC3, [F32, F32, F32]], [QUAT, [F32, F32, F32, F32]], [TRANSFORM, [VEC3, QUAT, VEC3]]]);
export const FUNC_TYPE = 0x60;
export const ARRAY_TYPE = 0x5E;
export const STRUCT_TYPE = 0x5F;
export const MAP_TYPE = 0x5D;
export const SET_TYPE = 0x5C;
export const CLASS_TYPE = 0x5B;
export const INTERFACE_TYPE = 0x5A;
export const DELEGATE_TYPE = 0x59;
export const DISPATCHER_TYPE = 0x58;

/** Value type `6B t`: a reference to the type entry at index t. Interned, so `===` and Map
 * keys work as Python's frozen dataclass equality does. */
export class Ref {
  private static cache = new Map<number, Ref>();
  private constructor(readonly type: number) {}
  static of(type: number): Ref {
    let r = Ref.cache.get(type);
    if (!r) Ref.cache.set(type, r = new Ref(type));
    return r;
  }
  toString(): string { return `Ref(${this.type})`; }
}

/** A value type: a byte code or a Ref. */
export type VT = number | Ref;

export function vtKey(vt: VT): string {
  return vt instanceof Ref ? `r${vt.type}` : String(vt);
}

export class ArrayType { constructor(readonly elem: VT) {} }
/** Each field is [value type, default or null]. */
export class StructType { constructor(readonly fields: [VT, any][]) {} }
export class MapType { constructor(readonly key: VT, readonly value: VT) {} }
export class SetType { constructor(readonly elem: VT) {} }
export class ClassType {
  constructor(readonly super_: number | null, readonly fields: [VT, any][], readonly vtable: number[],
              readonly interfaces: [number, number[]][] = []) {}
}
export class DelegateType { constructor(readonly functype: number) {} }
export class DispatcherType { constructor(readonly functype: number) {} }
export class InterfaceType { constructor(readonly methods: number[]) {} }
/** A function type: [params, results]. */
export type FuncType = [VT[], VT[]];
export type TypeEntry = FuncType | ArrayType | StructType | MapType | SetType | ClassType
  | DelegateType | DispatcherType | InterfaceType;

// section ids
export const SEC_CUSTOM = 0, SEC_TYPE = 1, SEC_IMPORT = 2, SEC_FUNCTION = 3, SEC_GLOBAL = 4,
  SEC_EXPORT = 5, SEC_DATA = 6, SEC_CODE = 7;

export const FN_PURE = 1, FN_LATENT = 2, FN_EVENT = 4;
export const EX_EVENT = 1, EX_LATENT = 2, EX_PURE = 4, EX_DECLARED = 8;
export const EXPORT_FUNC = 0, EXPORT_GLOBAL = 1, EXPORT_TYPE = 2;

export class WbcError extends Error {}

// -- opcodes -----------------------------------------------------------------------
// immediates: L = branch label (padded s32), u = u32, s = s32, S = s64, f = f32 bytes,
//             d = f64 bytes, T = br_table, b = u8, Lu = label then u32 (try.push)
export const OPS: Record<string, [number, string]> = {
  "unreachable": [0x00, ""], "nop": [0x01, ""], "br": [0x02, "L"], "br_if": [0x03, "L"],
  "br_table": [0x04, "T"], "return": [0x05, ""], "call": [0x06, "u"],
  "cont.push": [0x0A, "L"], "cont.pop": [0x0B, ""], "try.push": [0x0C, "Lu"],
  "cont.depth": [0x17, ""], "cont.trunc": [0x18, ""],
  "throw": [0x0E, ""], "suspend": [0x0D, "b"], "call_virtual": [0x07, "uu"],
  "call_interface": [0x08, "uu"], "call_delegate": [0x09, "u"],
  "delegate.new": [0xF4, "ub"], "dispatcher.bind": [0xF5, "u"],
  "dispatcher.unbind": [0xF6, "u"], "dispatcher.broadcast": [0xF7, "u"],
  "ref.null": [0x25, "u"], "ref.is_null": [0x26, ""], "ref.eq": [0x27, ""],
  "ref.cast": [0x28, "u"], "ref.test": [0x29, "u"], "ref.valid": [0x2A, ""],
  "ref.share": [0x2B, ""],
  "class.new": [0xD3, "u"], "class.get": [0xD4, "uu"], "class.set": [0xD5, "uu"],
  "drop": [0x10, ""], "select": [0x11, ""],
  "local.get": [0x12, "u"], "local.set": [0x13, "u"], "local.tee": [0x14, "u"],
  "global.get": [0x15, "u"], "global.set": [0x16, "u"],
  "i32.const": [0x20, "s"], "i64.const": [0x21, "S"], "f32.const": [0x22, "f"],
  "f64.const": [0x23, "d"], "string.const": [0x24, "u"],
  "string.concat": [0xF0, ""], "string.len": [0xF1, ""], "string.eq": [0xF2, ""],
  "string.cmp": [0xF3, ""],
  "array.new": [0xD6, "u"], "array.len": [0xD7, ""], "array.get": [0xD8, "u"],
  "array.set": [0xD9, "u"], "array.push": [0xDA, "u"], "array.insert": [0xDB, "u"],
  "array.remove": [0xDC, "u"], "array.clear": [0xDD, "u"], "array.clone": [0xDE, "u"],
  "struct.new": [0xD0, "u"], "struct.get": [0xD1, "uu"], "struct.with": [0xD2, "uu"],
  "map.new": [0xE0, "u"], "map.find": [0xE1, "u"], "map.set": [0xE2, "u"],
  "map.remove": [0xE3, "u"], "map.has": [0xE4, "u"], "map.len": [0xE5, "u"],
  "map.key_at": [0xE6, "u"], "map.value_at": [0xE7, "u"], "map.clear": [0xE8, "u"],
  "set.new": [0xE9, "u"], "set.add": [0xEA, "u"], "set.remove": [0xEB, "u"],
  "set.has": [0xEC, "u"], "set.len": [0xED, "u"], "set.at": [0xEE, "u"],
  "set.clear": [0xEF, "u"],
};
export const INT_OPS = ["eqz", "eq", "ne", "lt_s", "lt_u", "gt_s", "gt_u", "le_s", "le_u", "ge_s", "ge_u",
  "add", "sub", "mul", "div_s", "div_u", "rem_s", "rem_u", "and", "or", "xor", "shl",
  "shr_s", "shr_u", "neg", "not", "extend8_s", "extend16_s"];
export const FLOAT_OPS = ["eq", "ne", "lt", "gt", "le", "ge", "add", "sub", "mul", "div", "min", "max", "neg",
  "abs", "sqrt", "ceil", "floor", "trunc", "nearest", "copysign"];
INT_OPS.forEach((n, i) => { OPS[`i32.${n}`] = [0x30 + i, ""]; });
[...INT_OPS, "extend32_s"].forEach((n, i) => { OPS[`i64.${n}`] = [0x50 + i, ""]; });
FLOAT_OPS.forEach((n, i) => { OPS[`f32.${n}`] = [0x70 + i, ""]; OPS[`f64.${n}`] = [0x90 + i, ""]; });
export const CONV = ["i32.wrap_i64", "i64.extend_i32_s", "i64.extend_i32_u", "i32.trunc_f32_s",
  "i32.trunc_f32_u", "i32.trunc_f64_s", "i32.trunc_f64_u", "i64.trunc_f32_s",
  "i64.trunc_f32_u", "i64.trunc_f64_s", "i64.trunc_f64_u", "f32.convert_i32_s",
  "f32.convert_i32_u", "f32.convert_i64_s", "f32.convert_i64_u", "f64.convert_i32_s",
  "f64.convert_i32_u", "f64.convert_i64_s", "f64.convert_i64_u", "f32.demote_f64",
  "f64.promote_f32", "i32.reinterpret_f32", "i64.reinterpret_f64", "f32.reinterpret_i32",
  "f64.reinterpret_i64"];
CONV.forEach((n, i) => { OPS[n] = [0xB0 + i, ""]; });

for (const [n, sub] of Object.entries(_LANE_SUB)) OPS[n] = [0xFB00 | sub, _LANE_IMM.has(n) ? "b" : ""];
export const LANE_PREFIX = 0xFB;

// -- byte writer ---------------------------------------------------------------------
export class Writer {
  private buf = new Uint8Array(256);
  length = 0;

  private grow(n: number): void {
    if (this.length + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.length + n) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.length));
    this.buf = nb;
  }

  get b(): Uint8Array { return this.buf.subarray(0, this.length); }
  bytes(): Uint8Array { return this.buf.slice(0, this.length); }

  u8(v: number): void {
    this.grow(1);
    this.buf[this.length++] = v & 0xFF;
  }

  u32(v: number): void {
    if (v < 0) throw new RangeError("u32 must be non-negative");
    for (;;) {
      const byte = v & 0x7F;
      v = Math.floor(v / 128);
      if (v) this.u8(byte | 0x80);
      else { this.u8(byte); return; }
    }
  }

  sleb(v: number | bigint): void {
    let x = BigInt(v);
    for (;;) {
      const byte = Number(x & 0x7Fn);
      x >>= 7n;
      if ((x === 0n && !(byte & 0x40)) || (x === -1n && (byte & 0x40))) { this.u8(byte); return; }
      this.u8(byte | 0x80);
    }
  }

  /** Signed LEB128 padded to five bytes (branch offsets). */
  sleb5(v: number): void {
    let x = BigInt(v);
    for (let i = 0; i < 5; i++) {
      const byte = Number(x & 0x7Fn);
      x >>= 7n;
      this.u8(byte | (i < 4 ? 0x80 : 0));
    }
  }

  f32(v: number): void {
    this.grow(4);
    new DataView(this.buf.buffer).setFloat32(this.length, v, true);
    this.length += 4;
  }

  f64(v: number): void {
    this.grow(8);
    new DataView(this.buf.buffer).setFloat64(this.length, v, true);
    this.length += 8;
  }

  i64(v: bigint): void {
    this.grow(8);
    new DataView(this.buf.buffer).setBigInt64(this.length, BigInt.asIntN(64, v), true);
    this.length += 8;
  }

  u32le(v: number): void {
    this.grow(4);
    new DataView(this.buf.buffer).setUint32(this.length, v, true);
    this.length += 4;
  }

  raw(data: Uint8Array | number[]): void {
    this.grow(data.length);
    this.buf.set(data, this.length);
    this.length += data.length;
  }

  name(s: string): void {
    const data = utf8(s);
    this.u32(data.length);
    this.raw(data);
  }

  blob(data: Uint8Array): void {
    this.u32(data.length);
    this.raw(data);
  }
}

export function writeVt(w: Writer, vt: VT): void {
  if (vt instanceof Ref) {
    w.u8(REF);
    w.u32(vt.type);
  } else w.u8(vt);
}

// -- instructions --------------------------------------------------------------------
export function encodeInstr(w: Writer, name: string, imms: any[]): void {
  const [code, imm] = OPS[name];
  if (code > 0xFF) {
    w.u8(LANE_PREFIX);
    w.u32(code & 0xFF);
  } else w.u8(code);
  switch (imm) {
    case "L": w.sleb5(imms[0]); break;
    case "Lu": w.sleb5(imms[0]); w.u32(imms[1]); break;
    case "b": w.u8(imms[0]); break;
    case "ub": w.u32(imms[0]); w.u8(imms[1]); break;
    case "u": w.u32(imms[0]); break;
    case "uu": w.u32(imms[0]); w.u32(imms[1]); break;
    case "s": case "S": w.sleb(imms[0]); break;
    case "f": w.f32(imms[0]); break;
    case "d": w.f64(imms[0]); break;
    case "T": throw new Error("br_table is not emitted by this compiler");
  }
}

export function instrSize(name: string, imms: any[]): number {
  const w = new Writer();
  encodeInstr(w, name, imms);
  return w.length;
}

// -- module --------------------------------------------------------------------------
export class Body {
  constructor(public locals: VT[], public max_stack: number, public max_cont: number,
              public code: Uint8Array) {}
}

export class WbcModule {
  flags = 0;
  types: TypeEntry[] = [];
  imports: [string, string, number, number][] = [];     // [module, field, typeidx, flags]
  funcs: [number, number][] = [];                       // [typeidx, flags]
  globals: [VT, number, any][] = [];                    // [vt, mut, init]
  exports: [string, number, number, number][] = [];     // [name, kind, index, flags]
  data: string[] = [];
  bodies: Body[] = [];
  customs: [string, Uint8Array][] = [];
}

function writeConst(w: Writer, vt: VT, value: any): void {
  if (typeof vt === "number" && LANE_LAYOUT.has(vt)) {
    LANE_LAYOUT.get(vt)!.forEach((fvt, i) => {
      if (LANE_LAYOUT.has(fvt)) writeConst(w, fvt, value[i]);
      else w.f32(value[i]);
    });
    return;
  }
  if (vt instanceof Ref || vt === SIGNAL) return;
  if (vt === I32 || vt === I64) w.i64(BigInt(value));
  else if (vt === F32) { w.f32(value); w.raw(new Uint8Array(4)); }
  else if (vt === F64) w.f64(value);
  else if (vt === STRING) w.u32(value);
  else throw new WbcError(`bad const type ${vt}`);
}

export function encodeModule(m: WbcModule): Uint8Array {
  const out = new Writer();
  out.raw(MAGIC);
  out.u32le(VERSION);
  out.u32le(m.flags);

  const section = (sid: number, w: Writer) => {
    out.u8(sid);
    out.blob(w.b);
  };

  let w = new Writer();
  w.u32(m.types.length);
  for (const entry of m.types) {
    if (entry instanceof ArrayType) { w.u8(ARRAY_TYPE); writeVt(w, entry.elem); continue; }
    if (entry instanceof MapType) { w.u8(MAP_TYPE); writeVt(w, entry.key); writeVt(w, entry.value); continue; }
    if (entry instanceof SetType) { w.u8(SET_TYPE); writeVt(w, entry.elem); continue; }
    if (entry instanceof DelegateType || entry instanceof DispatcherType) {
      w.u8(entry instanceof DelegateType ? DELEGATE_TYPE : DISPATCHER_TYPE);
      w.u32(entry.functype);
      continue;
    }
    if (entry instanceof InterfaceType) {
      w.u8(INTERFACE_TYPE);
      w.u32(entry.methods.length);
      for (const t of entry.methods) w.u32(t);
      continue;
    }
    if (entry instanceof StructType || entry instanceof ClassType) {
      if (entry instanceof ClassType) {
        w.u8(CLASS_TYPE);
        w.u8(0);
        w.u32(entry.super_ === null ? 0 : entry.super_ + 1);
        w.u32(entry.interfaces.length);
        for (const [iface, impl] of entry.interfaces) {
          w.u32(iface);
          w.u32(impl.length);
          for (const f of impl) w.u32(f);
        }
      } else w.u8(STRUCT_TYPE);
      w.u32(entry.fields.length);
      for (const [vt, def] of entry.fields) {
        writeVt(w, vt);
        w.u8(def === null ? 0 : 1);
        if (def !== null) writeConst(w, vt, def);
      }
      if (entry instanceof ClassType) {
        w.u32(entry.vtable.length);
        for (const f of entry.vtable) w.u32(f);
      }
      continue;
    }
    const [params, results] = entry;
    w.u8(FUNC_TYPE);
    w.u32(params.length);
    for (const p of params) writeVt(w, p);
    w.u32(results.length);
    for (const r of results) writeVt(w, r);
  }
  section(SEC_TYPE, w);

  w = new Writer();
  w.u32(m.imports.length);
  for (const [mod, fld, t, flags] of m.imports) {
    w.name(mod); w.name(fld); w.u8(0); w.u32(t); w.u8(flags);
  }
  section(SEC_IMPORT, w);

  w = new Writer();
  w.u32(m.funcs.length);
  for (const [t, flags] of m.funcs) { w.u32(t); w.u8(flags); }
  section(SEC_FUNCTION, w);

  w = new Writer();
  w.u32(m.globals.length);
  for (const [vt, mut, init] of m.globals) { writeVt(w, vt); w.u8(mut); writeConst(w, vt, init); }
  section(SEC_GLOBAL, w);

  w = new Writer();
  w.u32(m.exports.length);
  for (const [name, kind, index, flags] of m.exports) { w.name(name); w.u8(kind); w.u32(index); w.u8(flags); }
  section(SEC_EXPORT, w);

  w = new Writer();
  w.u32(m.data.length);
  for (const s of m.data) w.blob(utf8(s));
  section(SEC_DATA, w);

  w = new Writer();
  w.u32(m.bodies.length);
  for (const body of m.bodies) {
    const bw = new Writer();
    const groups: [number, VT][] = [];
    for (const vt of body.locals) {
      if (groups.length && groups[groups.length - 1][1] === vt) groups[groups.length - 1][0] += 1;
      else groups.push([1, vt]);
    }
    bw.u32(groups.length);
    for (const [count, vt] of groups) { bw.u32(count); writeVt(bw, vt); }
    bw.u32(body.max_stack);
    bw.u32(body.max_cont);
    bw.raw(body.code);
    w.blob(bw.b);
  }
  section(SEC_CODE, w);

  for (const [name, payload] of m.customs) {
    w = new Writer();
    w.name(name);
    w.raw(payload);
    section(SEC_CUSTOM, w);
  }
  return out.bytes();
}

