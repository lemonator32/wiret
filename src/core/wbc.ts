/** WBC 1 binary format (spec section 5): opcodes, LEB128 and the section container.
 *
 * Encoding choices the draft leaves open, fixed here for the prototype:
 * - every `u32` in the container (section sizes, vector lengths, indices) is unsigned LEB128;
 *   only magic, version and flags are fixed-width little-endian;
 * - branch offsets `L` are signed LEB128 padded to exactly 5 bytes, so code can be laid out
 *   in one pass;
 * - custom section payload layouts are documented in `prototype/README.md`. */
import { IMM_OPS as _LANE_IMM, SUB_OPS as _LANE_SUB } from "./lanes.js";
import { fromUtf8, utf8 } from "./pyutil.js";

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
export const VT_NAMES: Map<number, string> = new Map([[I32, "i32"], [I64, "i64"], [F32, "f32"], [F64, "f64"],
  [STRING, "string"], [ANYREF, "anyref"], [FAULT, "fault"], [SIGNAL, "signal"], ...LANE_VTS]);
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

export function isFuncType(e: TypeEntry | undefined): e is FuncType {
  return Array.isArray(e);
}

/** Class names by type index, for messages and disassembly; set from a module's `name` section. */
export const CLASS_NAMES = new Map<number, string>();

export function vtName(vt: VT, types: TypeEntry[] | null = null, depth = 0): string {
  if (vt instanceof Ref) {
    const entry = types !== null && vt.type < types.length ? types[vt.type] : null;
    if (entry instanceof ArrayType && depth < 8) return `array#<${vtName(entry.elem, types, depth + 1)}>`;
    if (entry instanceof StructType) return `struct ${vt.type}`;
    if (entry instanceof ClassType || entry instanceof InterfaceType)
      return CLASS_NAMES.get(vt.type) ?? `${entry instanceof ClassType ? "class" : "interface"} ${vt.type}`;
    if (entry instanceof MapType && depth < 8)
      return `map#<${vtName(entry.key, types, depth + 1)}, ${vtName(entry.value, types, depth + 1)}>`;
    if (entry instanceof SetType && depth < 8) return `set#<${vtName(entry.elem, types, depth + 1)}>`;
    return `ref ${vt.type}`;
  }
  return VT_NAMES.get(vt) ?? `0x${vt.toString(16).toUpperCase().padStart(2, "0")}`;
}

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

export const BY_CODE = new Map<number, [string, string]>(
  Object.entries(OPS).map(([name, [code, imm]]) => [code, [name, imm]]));

export const LATER_TIER_OPS = new Map<number, string>();

// -- byte writer / reader ------------------------------------------------------------
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

export class Reader {
  p: number;
  end: number;
  private dv: DataView;

  constructor(public d: Uint8Array, pos = 0, end: number | null = null) {
    this.p = pos;
    this.end = end === null ? d.length : end;
    this.dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  }

  eof(): boolean { return this.p >= this.end; }

  need(n: number): void {
    if (this.p + n > this.end) throw new WbcError("unexpected end of data");
  }

  u8(): number {
    this.need(1);
    return this.d[this.p++];
  }

  u32(): number {
    let result = 0, shift = 0, b: number;
    for (;;) {
      b = this.u8();
      result += (b & 0x7F) * 2 ** shift;
      shift += 7;
      if (!(b & 0x80)) break;
      if (shift > 35) throw new WbcError("LEB128 too long");
    }
    if (result > 0xFFFFFFFF) throw new WbcError("u32 out of range");
    return result;
  }

  slebBig(bits = 64): bigint {
    let result = 0n, shift = 0n, b: number;
    for (;;) {
      b = this.u8();
      result |= BigInt(b & 0x7F) << shift;
      shift += 7n;
      if (!(b & 0x80)) break;
      if (shift > BigInt(bits + 7)) throw new WbcError("LEB128 too long");
    }
    if (b & 0x40) result -= 1n << shift;
    return result;
  }

  sleb(bits = 32): number {
    return Number(this.slebBig(bits));
  }

  f32(): number {
    this.need(4);
    const v = this.dv.getFloat32(this.p, true);
    this.p += 4;
    return v;
  }

  f64(): number {
    this.need(8);
    const v = this.dv.getFloat64(this.p, true);
    this.p += 8;
    return v;
  }

  i64(): bigint {
    this.need(8);
    const v = this.dv.getBigInt64(this.p, true);
    this.p += 8;
    return v;
  }

  u32le(): number {
    this.need(4);
    const v = this.dv.getUint32(this.p, true);
    this.p += 4;
    return v;
  }

  raw(n: number): Uint8Array {
    this.need(n);
    const v = this.d.slice(this.p, this.p + n);
    this.p += n;
    return v;
  }

  name(): string {
    const n = this.u32();
    try {
      return fromUtf8(this.raw(n));
    } catch (e) {
      if (e instanceof WbcError) throw e;
      throw new WbcError("invalid UTF-8 in name");
    }
  }

  blob(): Uint8Array { return this.raw(this.u32()); }

  vt(): VT {
    const code = this.u8();
    return code === REF ? Ref.of(this.u32()) : code;
  }
}

// -- instructions --------------------------------------------------------------------
export class Instr {
  constructor(public pc: number, public size: number, public op: number, public name: string,
              public imms: any[]) {}

  /** Absolute pc of a label immediate. */
  target(): number { return this.pc + this.size + this.imms[0]; }
}

export function decodeCode(code: Uint8Array): Instr[] {
  const out: Instr[] = [];
  const r = new Reader(code);
  while (!r.eof()) {
    const pc = r.p;
    let op = r.u8();
    if (op === LANE_PREFIX) {
      const sub = r.u32();
      op = 0xFB00 | sub;
      if (!BY_CODE.has(op)) throw new WbcError(`invalid lane sub-opcode FB ${sub.toString(16).toUpperCase().padStart(2, "0")} at pc ${pc}`);
    }
    let name: string, imm: string;
    if (BY_CODE.has(op)) [name, imm] = BY_CODE.get(op)!;
    else if (LATER_TIER_OPS.has(op)) throw new WbcError(`opcode 0x${hex2(op)} (${LATER_TIER_OPS.get(op)}) is not supported by this VM`);
    else throw new WbcError(`invalid opcode 0x${hex2(op)} at pc ${pc}`);
    let imms: any[];
    switch (imm) {
      case "": imms = []; break;
      case "L": imms = [r.sleb(32)]; break;
      case "Lu": imms = [r.sleb(32), r.u32()]; break;
      case "b": imms = [r.u8()]; break;
      case "ub": imms = [r.u32(), r.u8()]; break;
      case "u": imms = [r.u32()]; break;
      case "uu": imms = [r.u32(), r.u32()]; break;
      case "s": imms = [r.sleb(32)]; break;
      case "S": imms = [r.slebBig(64)]; break;
      case "f": imms = [r.f32()]; break;
      case "d": imms = [r.f64()]; break;
      case "T": {
        const n = r.u32();
        imms = [];
        for (let i = 0; i < n + 1; i++) imms.push(r.sleb(32));
        break;
      }
      default: throw new Error(imm);
    }
    out.push(new Instr(pc, r.p - pc, op, name, imms));
  }
  return out;
}

function hex2(n: number): string {
  return n.toString(16).toUpperCase().padStart(2, "0");
}

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

  custom(name: string): Uint8Array | null {
    for (const [n, payload] of this.customs) if (n === name) return payload;
    return null;
  }

  /** [params, results, flags] for a function index (imports first). */
  funcType(fidx: number): [VT[], VT[], number] {
    if (fidx < this.imports.length) {
      const imp = this.imports[fidx];
      const t = this.types[imp[2]] as FuncType;
      return [t[0], t[1], imp[3]];
    }
    const [t, flags] = this.funcs[fidx - this.imports.length];
    const ft = this.types[t] as FuncType;
    return [ft[0], ft[1], flags];
  }
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

function readConst(r: Reader, vt: VT): any {
  if (typeof vt === "number" && LANE_LAYOUT.has(vt))
    return LANE_LAYOUT.get(vt)!.map((fvt) => LANE_LAYOUT.has(fvt) ? readConst(r, fvt) : r.f32());
  if (vt instanceof Ref || vt === SIGNAL) return null;
  if (vt === I32) return Number(r.i64());
  if (vt === I64) return r.i64();
  if (vt === F32) { const v = r.f32(); r.raw(4); return v; }
  if (vt === F64) return r.f64();
  if (vt === STRING) return r.u32();
  throw new WbcError(`bad const type 0x${hex2(vt as number)}`);
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

export function decodeModule(data: Uint8Array): WbcModule {
  if (data.length < 12 || !MAGIC.every((b, i) => data[i] === b)) throw new WbcError("not a WBC module (bad magic)");
  const head = new Reader(data, 4);
  const version = head.u32le(), flags = head.u32le();
  if (version !== VERSION) throw new WbcError(`unsupported WBC version ${version}`);
  if (flags & ~(FLAG_HAS_SOURCE | FLAG_LANES))
    throw new WbcError(`module requires unknown features (flags 0x${(flags >>> 0).toString(16).toUpperCase().padStart(8, "0")})`);
  const m = new WbcModule();
  m.flags = flags;
  const r = new Reader(data, 12);
  let last = 0;
  while (!r.eof()) {
    const sid = r.u8();
    const size = r.u32();
    r.need(size);
    const s = new Reader(data, r.p, r.p + size);
    r.p += size;
    if (sid === SEC_CUSTOM) {
      const name = s.name();
      m.customs.push([name, data.slice(s.p, s.end)]);
      continue;
    }
    if (sid > SEC_CODE) throw new WbcError(`unknown section id ${sid}`);
    if (sid <= last) throw new WbcError(`section ${sid} out of order`);
    last = sid;
    if (sid === SEC_TYPE) {
      for (let n = s.u32(); n > 0; n--) {
        const code = s.u8();
        if (code === ARRAY_TYPE) { m.types.push(new ArrayType(s.vt())); continue; }
        if (code === MAP_TYPE) { const k = s.vt(); m.types.push(new MapType(k, s.vt())); continue; }
        if (code === DELEGATE_TYPE) { m.types.push(new DelegateType(s.u32())); continue; }
        if (code === DISPATCHER_TYPE) { m.types.push(new DispatcherType(s.u32())); continue; }
        if (code === INTERFACE_TYPE) {
          const methods: number[] = [];
          for (let k = s.u32(); k > 0; k--) methods.push(s.u32());
          m.types.push(new InterfaceType(methods));
          continue;
        }
        if (code === SET_TYPE) { m.types.push(new SetType(s.vt())); continue; }
        if (code === STRUCT_TYPE || code === CLASS_TYPE) {
          let sup: number | null = null;
          const ifaces: [number, number[]][] = [];
          if (code === CLASS_TYPE) {
            if (s.u8() !== 0) throw new WbcError("host class types are not supported by this VM");
            const sp = s.u32();
            sup = sp === 0 ? null : sp - 1;
            for (let k = s.u32(); k > 0; k--) {
              const iface = s.u32();
              const impl: number[] = [];
              for (let j = s.u32(); j > 0; j--) impl.push(s.u32());
              ifaces.push([iface, impl]);
            }
          }
          const fields: [VT, any][] = [];
          for (let k = s.u32(); k > 0; k--) {
            const vt = s.vt();
            const fl = s.u8();
            if (fl & ~1) throw new WbcError(`struct field flags 0x${hex2(fl)} are not supported`);
            if (fl && vt instanceof Ref) throw new WbcError("a reference field cannot have a default");
            fields.push([vt, fl ? readConst(s, vt) : null]);
          }
          if (code === CLASS_TYPE) {
            const vtable: number[] = [];
            for (let k = s.u32(); k > 0; k--) vtable.push(s.u32());
            m.types.push(new ClassType(sup, fields, vtable, ifaces));
          } else m.types.push(new StructType(fields));
          continue;
        }
        if (code !== FUNC_TYPE) throw new WbcError(`type entry 0x${hex2(code)} is not supported by this VM`);
        const params: VT[] = [], results: VT[] = [];
        for (let k = s.u32(); k > 0; k--) params.push(s.vt());
        for (let k = s.u32(); k > 0; k--) results.push(s.vt());
        m.types.push([params, results]);
      }
    } else if (sid === SEC_IMPORT) {
      for (let n = s.u32(); n > 0; n--) {
        const mod = s.name(), fld = s.name();
        if (s.u8() !== 0) throw new WbcError("only function imports are supported");
        const t = s.u32();
        m.imports.push([mod, fld, t, s.u8()]);
      }
    } else if (sid === SEC_FUNCTION) {
      for (let n = s.u32(); n > 0; n--) { const t = s.u32(); m.funcs.push([t, s.u8()]); }
    } else if (sid === SEC_GLOBAL) {
      for (let n = s.u32(); n > 0; n--) {
        const vt = s.vt(), mut = s.u8();
        m.globals.push([vt, mut, readConst(s, vt)]);
      }
    } else if (sid === SEC_EXPORT) {
      for (let n = s.u32(); n > 0; n--) {
        const name = s.name(), kind = s.u8(), index = s.u32();
        m.exports.push([name, kind, index, s.u8()]);
      }
    } else if (sid === SEC_DATA) {
      for (let n = s.u32(); n > 0; n--) {
        try {
          m.data.push(fromUtf8(s.blob()));
        } catch (e) {
          if (e instanceof WbcError) throw e;
          throw new WbcError("invalid UTF-8 in data section");
        }
      }
    } else if (sid === SEC_CODE) {
      for (let n = s.u32(); n > 0; n--) {
        const bsize = s.u32();
        s.need(bsize);
        const b = new Reader(data, s.p, s.p + bsize);
        s.p += bsize;
        const locs: VT[] = [];
        for (let k = b.u32(); k > 0; k--) {
          const count = b.u32(), vt = b.vt();
          if (count > 65536 || locs.length + count > 65536) throw new WbcError("too many locals");
          for (let j = 0; j < count; j++) locs.push(vt);
        }
        const ms = b.u32(), mc = b.u32();
        m.bodies.push(new Body(locs, ms, mc, data.slice(b.p, b.end)));
      }
    }
    if (!s.eof()) throw new WbcError(`section ${sid} has trailing bytes`);
  }
  return m;
}
