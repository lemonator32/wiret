/** Macro expansion, lowering and WBC emission (spec sections 4.2, 4.3 and 4.8).
 *
 * Every impure node becomes one block labelled with its (path-style) node id. A block
 * evaluates the pure subgraph feeding its inputs at that node's evaluation point, performs
 * the node's operation, stores its outputs in frame slots and ends with an exec transfer.
 * This is the `-O0` lowering: `cont.push` / `cont.pop` pairs are kept. */
import pako from "pako";
import * as lanes from "./lanes.js";
import * as wbc from "./wbc.js";
import { check, Diag, hasErrors } from "./checker.js";
import { Attr, Graph, Lit, Module, Node, PinRef } from "./model.js";
import { INTERNAL, STD } from "./natives.js";
import { layoutHash, printModule, semanticHash } from "./printer.js";
import {
  ARRAY_MUTATORS, arrayElem, classFieldTarget, delegateSig, dispatcherParams, dispatcherTarget, enumValues, fieldPlace,
  FLOAT_TYPES, formatParts, INT_TYPES, isContainer, laneValue, MAP_PURE, mapTypes, ModuleIndex, parentMethod, Pin,
  PLACE_MUTATORS, REGISTRY_NAME, REGISTRY_VERSION, SET_PURE, setElem, Sig, SIGNED_TYPES, signature, zeroLit,
} from "./registry.js";
import { F32, F64, FAULT, I32, I64, SIGNAL, STRING, VT as WVT } from "./wbc.js";
import { Project } from "./ids.js";
import { capitalize, Counter, sha256Hex, sortedBy, utf8 } from "./pyutil.js";
import { verify } from "./verifier.js";

export const CONTAINER_OPS: Record<string, string> = {
  MapFind: "map.find", MapHas: "map.has", MapLength: "map.len", MapKeyAt: "map.key_at",
  MapValueAt: "map.value_at", MapSet: "map.set", MapRemove: "map.remove", MapClear: "map.clear",
  SetHas: "set.has", SetLength: "set.len", SetAt: "set.at", SetAdd: "set.add", SetRemove: "set.remove",
  SetClear: "set.clear",
};

export const COMPILER_VERSION = "wiretc-proto 0.1";

export const VT: Record<string, number> = {
  bool: I32, i8: I32, u8: I32, i16: I32, u16: I32, i32: I32, u32: I32, i64: I64, u64: I64,
  f32: F32, f64: F64, string: STRING, fault: FAULT, "std.Signal": SIGNAL,
};
const PFX: Record<number, string> = { [I32]: "i32", [I64]: "i64", [F32]: "f32", [F64]: "f64" };
const LANE_VT: Record<string, number> = {};
for (const [vt, name] of wbc.LANE_VTS) LANE_VT[name] = vt;
const LP = lanes.PREFIX;
const LANE_ARITH: Record<string, string> = {
  Add: "add", Sub: "sub", Mul: "mul", Div: "div", Min: "min", Max: "max", Neg: "neg", Abs: "abs",
  Scale: "scale", Eq: "eq", Ne: "ne",
};
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** Normalise an integer to the signed representation of its slot: a number for 32-bit
 * slots, a bigint for 64-bit ones. */
export function wrapInt(ty: string, v: bigint | number): number | bigint {
  const x = BigInt(v);
  const bits = ({ i8: 8, u8: 8, i16: 16, u16: 16 } as Record<string, number>)[ty];
  if (bits) {
    let r = x & ((1n << BigInt(bits)) - 1n);
    if (ty.startsWith("i") && r >= 1n << BigInt(bits - 1)) r -= 1n << BigInt(bits);
    return Number(r);
  }
  if (VT[ty] === I64) return BigInt.asIntN(64, x);
  return Number(BigInt.asIntN(32, x));
}

export class Src {
  constructor(public kind: "lit" | "local" | "node", public a: any, public b: string | null = null, public type = "i32") {}
}

type Exec = [string, string | null];

export class IRNode {
  inputs: [string, string, Src][] = [];
  execs: Exec[] = [];
  extra: Record<string, any> = {};
  constructor(public id: string, public kind: string, public sig: Sig | null, public symbol: string | null = null,
              public targs: string[] = [], public pure = false, public attrs: Attr[] = []) {}
  get data_outs(): Pin[] { return this.sig ? this.sig.data_outs : []; }
}

type StateSlot = number | ["field", number, number];

class Ctx {
  params = new Map<string, string>();
  locals = new Map<string, string>();
  states = new Map<string, StateSlot>();
  depth: string | null = null;
  exits = new Map<string, string | null>();
  results = new Map<string, string>();
  constructor(public graph: Graph, public prefix: string, public mpath: string | null, public sigs: Map<string, Sig>) {}
}

export class CompileResult {
  constructor(public ok: boolean, public diags: Diag[], public wbc: Uint8Array | null = null,
              public module: wbc.WbcModule | null = null) {}
}

export const LAZY_KINDS = ["Select", "And", "Or"];

class EvalPoint {
  uses = new Counter<string>();
  temps = new Map<string, number>();
}

type FuncRef = ["import" | "func", string];
type CodeItem = { op: string; imms: any[] };

const tk = (...parts: (string | number)[]) => parts.join("\0");

export class Compiler {
  idx: ModuleIndex;
  diags: Diag[] = [];
  globals: [string, string, any][] = [];
  global_index = new Map<string, number>();
  data: string[] = [];
  data_index = new Map<string, number>();
  imports: string[] = [];
  import_index = new Map<string, number>();
  types: (wbc.TypeEntry | null)[] = [];
  type_keys = new Map<string, number>();
  type_key_info = new Map<string, [string, string]>();     // key -> [kind, name] for class/interface
  funcs: Graph[];
  func_names = new Map<string, number>();
  caps = new Set<string>();
  uses_lanes = false;

  constructor(public m: Module, public source: string | null = null, public embed_source = true,
              public debug = false, public project: Project | null = null, public export_all = false) {
    this.idx = new ModuleIndex(m);
    this.funcs = sortedBy(m.graphs(["func", "event"]), (g) => g.name);
    this.funcs.forEach((g, i) => this.func_names.set(g.name, i));
  }

  // -- tables -------------------------------------------------------------------
  vt(ty: string): WVT {
    if (ty === "anyref") return wbc.ANYREF;
    if (has(LANE_VT, ty)) {
      this.uses_lanes = true;
      return LANE_VT[ty];
    }
    let elem = arrayElem(ty);
    if (elem !== null) return wbc.Ref.of(this.arrayType(elem));
    const kv = mapTypes(ty);
    if (kv !== null) return wbc.Ref.of(this.mapType(kv[0], kv[1]));
    elem = setElem(ty);
    if (elem !== null) return wbc.Ref.of(this.setType(elem));
    if (this.idx.structs.has(ty)) return wbc.Ref.of(this.structType(ty));
    if (this.idx.classes.has(ty)) return wbc.Ref.of(this.classType(ty));
    if (this.idx.interfaces.has(ty)) return wbc.Ref.of(this.interfaceType(ty));
    const sig = delegateSig(ty);
    if (sig !== null) return wbc.Ref.of(this.callableType("delegate", sig[0], sig[1]));
    const params = dispatcherParams(ty);
    if (params !== null) return wbc.Ref.of(this.callableType("dispatcher", params, []));
    return VT[this.base(ty)];
  }

  vtRef(ty: string): wbc.Ref {
    return this.vt(ty) as wbc.Ref;
  }

  base(ty: string): string {
    return this.idx.enumBase(ty) || ty;
  }

  private reserve(key: string): number {
    const i = this.types.length;
    this.type_keys.set(key, i);
    this.types.push(null);
    return i;
  }

  structType(name: string): number {
    const key = tk("struct", name);
    if (!this.type_keys.has(key)) {
      const i = this.reserve(key);
      const fields: [WVT, any][] = [];
      for (const f of this.idx.structs.get(name)!.fields) {
        const vt = this.vt(f.type);
        let def = null;
        if (f.default_ !== null && !(vt instanceof wbc.Ref)) def = this.constValue(f.default_, f.type);
        fields.push([vt, def]);
      }
      this.types[i] = new wbc.StructType(fields);
    }
    return this.type_keys.get(key)!;
  }

  classType(name: string): number {
    const key = tk("class", name);
    if (!this.type_keys.has(key)) {
      const i = this.reserve(key);
      this.type_key_info.set(key, ["class", name]);
      const c = this.idx.classes.get(name)!;
      const sup = c.base ? this.classType(c.base) : null;
      const fields: [WVT, any][] = [];
      for (const f of c.fields) {
        const vt = this.vt(f.type);
        let def = null;
        if (f.default_ !== null && !(vt instanceof wbc.Ref) && f.default_.kind !== "null") def = this.constValue(f.default_, f.type);
        fields.push([vt, def]);
      }
      for (const d of c.dispatchers) fields.push([this.vt(`dispatcher#<(${d.params.map((p) => p.type).join(", ")})>`), null]);
      for (const [, ty, def] of this.idx.classState(name)) {
        const vt = this.vt(ty);
        fields.push([vt, def !== null && !(vt instanceof wbc.Ref) ? this.constValue(def, ty) : null]);
      }
      this.types[i] = new wbc.ClassType(sup, fields, []);
    }
    return this.type_keys.get(key)!;
  }

  callableType(kind: string, params: string[], results: string[]): number {
    const key = tk(kind, params.join("\x01"), results.join("\x01"));
    if (!this.type_keys.has(key)) {
      const ft = this.funcType(params.map((t) => this.vt(t)), results.map((t) => this.vt(t)));
      this.type_keys.set(key, this.types.length);
      this.types.push(kind === "delegate" ? new wbc.DelegateType(ft) : new wbc.DispatcherType(ft));
    }
    return this.type_keys.get(key)!;
  }

  interfaceType(name: string): number {
    const key = tk("interface", name);
    if (!this.type_keys.has(key)) {
      const i = this.reserve(key);
      this.type_key_info.set(key, ["interface", name]);
      const it = this.idx.interfaces.get(name)!;
      this.types[i] = new wbc.InterfaceType(it.methods.map((m) =>
        this.funcType(m.params.map((p) => this.vt(p.type)), m.result_list.map((r) => this.vt(r.type)))));
    }
    return this.type_keys.get(key)!;
  }

  /** The vtable of a class as [method name, implementing graph]. */
  slots(cls: string): [string, string][] {
    const c = this.idx.classes.get(cls)!;
    const out: [string, string][] = c.base ? [...this.slots(c.base)] : [];
    const names = out.map(([s]) => s);
    for (const g of this.idx.methods(cls)) {
      if (g.static_) continue;
      const i = names.indexOf(g.short_name);
      if (i >= 0) out[i] = [g.short_name, g.name];
      else {
        out.push([g.short_name, g.name]);
        names.push(g.short_name);
      }
    }
    return out;
  }

  classFieldIndex(cls: string, fname: string): number {
    return this.idx.classLayout(cls).map(([n]) => n).indexOf(fname);
  }

  fieldIndex(struct: string, fieldName: string): number {
    return this.idx.structs.get(struct)!.fields.map((f) => f.name).indexOf(fieldName);
  }

  /** The integer of `Mode.Chase`. */
  enumValue(lit: Lit): bigint {
    const [name, member] = lit.value.split(".");
    return new Map(enumValues(this.idx.enums.get(name)!)).get(member)!;
  }

  /** A literal as the number or data index stored for a global or field default. */
  constValue(lit: Lit, ty: string): any {
    if (has(LANE_VT, ty)) return lanes.normalise(ty, laneValue(lit, ty));
    if (ty === "string") return this.stringIndex(lit.value);
    if (ty === "bool") return lit.value ? 1 : 0;
    if (FLOAT_TYPES.includes(ty)) return Number(lit.value);
    const v = lit.kind === "enum" ? this.enumValue(lit) : BigInt(lit.value);
    return wrapInt(this.base(ty), v);
  }

  arrayType(elem: string): number {
    const key = tk("array", elem);
    if (!this.type_keys.has(key)) {
      const entry = new wbc.ArrayType(this.vt(elem));
      this.type_keys.set(key, this.types.length);
      this.types.push(entry);
    }
    return this.type_keys.get(key)!;
  }

  mapType(k: string, v: string): number {
    const key = tk("map", k, v);
    if (!this.type_keys.has(key)) {
      const entry = new wbc.MapType(this.vt(k), this.vt(v));
      this.type_keys.set(key, this.types.length);
      this.types.push(entry);
    }
    return this.type_keys.get(key)!;
  }

  setType(elem: string): number {
    const key = tk("set", elem);
    if (!this.type_keys.has(key)) {
      const entry = new wbc.SetType(this.vt(elem));
      this.type_keys.set(key, this.types.length);
      this.types.push(entry);
    }
    return this.type_keys.get(key)!;
  }

  containerType(kind: string, targs: string[]): number {
    return kind.startsWith("Map") ? this.mapType(targs[0], targs[1]) : this.setType(targs[0]);
  }

  funcType(params: WVT[], results: WVT[]): number {
    const key = tk("func", params.map(wbc.vtKey).join(","), results.map(wbc.vtKey).join(","));
    if (!this.type_keys.has(key)) {
      this.type_keys.set(key, this.types.length);
      this.types.push([[...params], [...results]]);
    }
    return this.type_keys.get(key)!;
  }

  stringIndex(s: string): number {
    if (!this.data_index.has(s)) {
      this.data_index.set(s, this.data.length);
      this.data.push(s);
    }
    return this.data_index.get(s)!;
  }

  addGlobal(name: string, ty: string, init: Lit | null): number {
    if (this.global_index.has(name)) return this.global_index.get(name)!;
    const lit = init !== null ? init : zeroLit(ty);
    let value: any;
    if (has(LANE_VT, ty)) value = this.constValue(lit, ty);
    else if (isContainer(ty) || this.idx.structs.has(ty) || this.idx.classes.has(ty) || this.idx.interfaces.has(ty) || ty === "std.Signal")
      value = null;
    else value = this.constValue(lit, ty);
    this.global_index.set(name, this.globals.length);
    this.globals.push([name, ty, value]);
    return this.global_index.get(name)!;
  }

  importRef(qname: string): FuncRef {
    if (!this.import_index.has(qname)) {
      this.import_index.set(qname, this.imports.length);
      this.imports.push(qname);
    }
    return ["import", qname];
  }

  // -- driver -------------------------------------------------------------------
  compile(): CompileResult {
    this.diags = check(this.m, true, this.project);
    if (hasErrors(this.diags)) return new CompileResult(false, this.diags);
    for (const v of sortedBy(this.idx.vars.values(), (v) => v.name)) this.addGlobal(v.name, v.type, v.default_);
    const lowered: FuncLowerer[] = [];
    for (const g of this.funcs) {
      const fl = new FuncLowerer(this, g);
      fl.expandAll();
      fl.lower();
      lowered.push(fl);
    }
    if (hasErrors(this.diags)) return new CompileResult(false, this.diags);
    const mod = this.build(lowered);
    return new CompileResult(true, this.diags, wbc.encodeModule(mod), mod);
  }

  funcIndex(ref: FuncRef): number {
    const [kind, name] = ref;
    if (kind === "import") return this.import_index.get(name)!;
    return this.imports.length + this.func_names.get(name)!;
  }

  build(lowered: FuncLowerer[]): wbc.WbcModule {
    const mod = new wbc.WbcModule();
    const natives = { ...STD, ...INTERNAL };
    for (const q of this.imports) {
      let params: WVT[], results: WVT[], pure: boolean;
      if (has(natives, q)) {
        const spec = natives[q];
        params = spec.params.map(([, t]) => this.vt(t));
        results = spec.results.map(([, t]) => this.vt(t));
        pure = spec.purity === "pure";
      } else {
        const ext = this.idx.externs.get(q)!;
        params = ext.params.map((p) => this.vt(p.type));
        results = (ext.results ?? []).map((r) => this.vt(r.type));
        pure = ext.hasAttr("pure");
        for (const a of ext.attrs) if (a.name === "capability" && a.arg() !== null) this.caps.add(a.arg()!.value);
      }
      const dot = q.lastIndexOf(".");
      mod.imports.push([q.slice(0, dot), q.slice(dot + 1), this.funcType(params, results), pure ? 1 : 0]);
    }
    for (const fl of lowered) {
      const g = fl.g;
      const flags = (g.hasAttr("pure") ? wbc.FN_PURE : 0) | (g.kind === "event" ? wbc.FN_EVENT | wbc.FN_LATENT : 0) |
        (g.hasAttr("latent") ? wbc.FN_LATENT : 0);
      const t = this.funcType([...(g.receiver ? [this.vt(g.receiver)] : []), ...g.params.map((p) => this.vt(p.type))],
        g.result_list.map((r) => this.vt(r.type)));
      mod.funcs.push([t, flags]);
    }
    for (const [, ty, value] of this.globals) mod.globals.push([this.vt(ty), 1, value]);
    lowered.forEach((fl, i) => {
      const g = fl.g;
      const declared = g.hasAttr("export");
      if (!(declared || this.export_all)) return;
      const eflags = (g.kind === "event" ? wbc.EX_EVENT | wbc.EX_LATENT : 0) | (g.hasAttr("latent") ? wbc.EX_LATENT : 0) |
        (g.hasAttr("pure") ? wbc.EX_PURE : 0) | (declared ? wbc.EX_DECLARED : 0);
      mod.exports.push([g.name, wbc.EXPORT_FUNC, this.imports.length + i, eflags]);
    });
    for (const v of sortedBy(this.idx.vars.values(), (v) => v.name))
      if (exported(v)) mod.exports.push([v.name, wbc.EXPORT_GLOBAL, this.global_index.get(v.name)!, wbc.EX_DECLARED]);
    const named = new Map<string, { attrs: Attr[] }>([...this.idx.structs, ...this.idx.classes, ...this.idx.interfaces]);
    for (const name of sortedBy([...named].filter(([, t]) => exported(t)).map(([n]) => n)))
      mod.exports.push([name, wbc.EXPORT_TYPE, this.vtRef(name).type, wbc.EX_DECLARED]);
    mod.data = [...this.data];
    for (const [key, ti] of [...this.type_keys]) {
      const info = this.type_key_info.get(key);
      if (info && info[0] === "class") {
        const e = this.types[ti] as wbc.ClassType;
        const ifaces: [number, number[]][] = this.idx.classInterfaces(info[1]).map((i) => [
          this.interfaceType(i),
          this.idx.interfaces.get(i)!.methods.map((m) => this.funcIndex(["func", this.idx.findMethod(info[1], m.name)!.name])),
        ]);
        this.types[ti] = new wbc.ClassType(e.super_, e.fields, this.slots(info[1]).map(([, impl]) => this.funcIndex(["func", impl])), ifaces);
      }
    }
    mod.types = this.types as wbc.TypeEntry[];
    const assembled = lowered.map((fl) => fl.assemble());
    mod.bodies = lowered.map((fl, i) => new wbc.Body(fl.local_types.slice(fl.nparams).map((t) => this.vt(t)), 0xFFFF, 0, assembled[i][0]));
    mod.customs = this.customSections(lowered, assembled);
    if (this.embed_source) mod.flags |= wbc.FLAG_HAS_SOURCE;
    if (this.uses_lanes) mod.flags |= wbc.FLAG_LANES;
    verify(mod).forEach(([, maxH], i) => { mod.bodies[i].max_stack = maxH; });
    verify(mod);
    return mod;
  }

  customSections(lowered: FuncLowerer[], assembled: Assembled[]): [string, Uint8Array][] {
    const out: [string, Uint8Array][] = [];
    let w = new wbc.Writer();
    const nimp = this.imports.length;
    w.u32(this.imports.length + lowered.length);
    this.imports.forEach((q, i) => { w.u32(i); w.name(q); });
    lowered.forEach((fl, i) => { w.u32(nimp + i); w.name(`${this.m.name}.${fl.g.name}`); });
    w.u32(lowered.length);
    lowered.forEach((fl, i) => {
      w.u32(nimp + i);
      w.u32(fl.local_names.length);
      fl.local_names.forEach((name, li) => { w.u32(li); w.name(name); });
    });
    w.u32(this.globals.length);
    this.globals.forEach(([name], gi) => { w.u32(gi); w.name(name); });
    const classes = sortedBy([...this.type_key_info].map(([key, [, name]]) => [this.type_keys.get(key)!, name] as [number, string]),
      (x) => x);
    w.u32(classes.length);
    for (const [ti, name] of classes) {
      w.u32(ti);
      w.name(name);
      const fields = this.idx.classes.has(name) ? this.idx.classLayout(name) : [];
      w.u32(fields.length);
      for (const [fname] of fields) w.name(fname);
    }
    out.push(["name", w.bytes()]);

    w = new wbc.Writer();
    w.u32(lowered.length);
    const pins = new wbc.Writer();
    pins.u32(lowered.length);
    const stepw = new wbc.Writer();
    stepw.u32(lowered.length);
    const purew = new wbc.Writer();
    purew.u32(lowered.length);
    lowered.forEach((fl, i) => {
      const [, debug, steps, pure] = assembled[i];
      const table: string[] = [];
      const tindex = new Map<string, number>();
      const sid = (s: string) => {
        if (!tindex.has(s)) {
          tindex.set(s, table.length);
          table.push(s);
        }
        return tindex.get(s)!;
      };
      const entries = debug.map(([pc, node]) => [pc, sid(node)]);
      const pinEntries = sortedBy([...fl.pin_map], ([li]) => li).map(([li, [node, pin]]) => [li, sid(node), sid(pin)]);
      const stepEntries = steps.map(([pc, node]) => [pc, sid(node)]);
      const pureEntries = pure.map(([pc, node]) => [pc, sid(node)]);
      w.u32(nimp + i);
      w.name(fl.g.name);
      w.u32(table.length);
      for (const s of table) w.name(s);
      w.u32(entries.length);
      let last = 0;
      for (const [pc, node] of entries) {
        w.u32(pc - last);
        w.u32(node);
        last = pc;
      }
      for (const [tw, tentries] of [[stepw, stepEntries], [purew, pureEntries]] as [wbc.Writer, number[][]][]) {
        tw.u32(nimp + i);
        tw.u32(tentries.length);
        let l2 = 0;
        for (const [pc, node] of tentries) {
          tw.u32(pc - l2);
          tw.u32(node);
          l2 = pc;
        }
      }
      pins.u32(nimp + i);
      pins.u32(pinEntries.length);
      for (const [li, node, pin] of pinEntries) {
        pins.u32(li);
        pins.u32(node);
        pins.u32(pin);
      }
    });
    out.push(["wr.debug", w.bytes()]);
    out.push(["wr.pins", pins.bytes()]);
    out.push(["wr.pure", purew.bytes()]);
    if (this.debug) out.push(["wr.steps", stepw.bytes()]);

    w = new wbc.Writer();
    const idAttr = this.m.attrs.find((a) => a.name === "id" && a.arg());
    const mid = idAttr ? idAttr.arg()!.value : "";
    const canonical = printModule(this.m);
    for (const s of [this.m.name, mid, COMPILER_VERSION, `${REGISTRY_NAME}@${REGISTRY_VERSION}`, semanticHash(this.m),
                     layoutHash(this.m), sha256Hex(this.source || canonical), this.export_all ? "export-all" : "declared"])
      w.name(s);
    out.push(["wr.meta", w.bytes()]);

    w = new wbc.Writer();
    w.u32(this.caps.size);
    for (const c of sortedBy(this.caps)) w.name(c);
    out.push(["wr.caps", w.bytes()]);
    if (this.embed_source) out.push(["wr.graph", pako.deflate(utf8(canonical), { level: 9 })]);
    return out;
  }
}

type Assembled = [Uint8Array, [number, string][], [number, string][], [number, string][]];

export class FuncLowerer {
  local_names: string[] = [];
  local_types: string[] = [];
  local_index = new Map<string, number>();
  local_defaults: [string, Lit][] = [];
  pin_map = new Map<number, [string, string]>();
  nparams: number;
  ir = new Map<string, IRNode>();
  entry: string | null = null;
  code: CodeItem[] = [];
  temp_free = new Map<WVT, number[]>();
  temp_count = 0;
  slots = new Map<string, number>();
  debug_locals = new Map<string, number>();
  at: string[] = [];
  uses_end = false;
  lazy_cache = new Map<string, boolean>();
  lazy_count = 0;

  constructor(public c: Compiler, public g: Graph) {
    const entryId = g.nodes.find((n) => n.kind === "Entry")?.id ?? "entry";
    const params: [string, string][] = [...(g.receiver ? [["self", g.receiver] as [string, string]] : []),
      ...g.params.map((p) => [p.name, p.type] as [string, string])];
    for (const [name, ty] of params) {
      this.addLocal(name, ty);
      this.pin_map.set(this.local_index.get(name)!, [entryId, name]);
    }
    this.nparams = params.length;
  }

  addLocal(name: string, ty: string, def: Lit | null = null): number {
    if (!this.local_index.has(name)) {
      this.local_index.set(name, this.local_names.length);
      this.local_names.push(name);
      this.local_types.push(ty);
      if (def !== null) this.local_defaults.push([name, def]);
    }
    return this.local_index.get(name)!;
  }

  li(name: string): number {
    return this.local_index.get(name)!;
  }

  diag(code: string, msg: string, node: string | null = null, pin: string | null = null): void {
    this.c.diags.push(new Diag(code, msg, this.c.m.name, this.g.name, node, pin));
  }

  // -- expansion ----------------------------------------------------------------
  sigsFor(g: Graph): Map<string, Sig> {
    return new Map(g.nodes.map((n) => [n.id, signature(n, g, this.c.idx)]));
  }

  expandAll(): void {
    const g = this.g;
    const ctx = new Ctx(g, "", null, this.sigsFor(g));
    for (const p of g.params) ctx.params.set(p.name, p.name);
    if (g.receiver) ctx.params.set("self", "self");
    for (const l of sortedBy(g.locals, (l) => l.name)) {
      ctx.locals.set(l.name, l.name);
      this.addLocal(l.name, l.type, l.default_);
    }
    for (const s of sortedBy(g.states, (s) => s.name)) ctx.states.set(s.name, this.stateSlot(null, s));
    this.expand(ctx);
  }

  stateSlot(mpath: string | null, s: { name: string; type: string; default_: Lit | null }): StateSlot {
    const g = this.g;
    if (!g.owner) {
      const name = mpath === null ? `${g.name}.${s.name}` : `${g.name}/${mpath}.${s.name}`;
      return this.c.addGlobal(name, s.type, s.default_);
    }
    const where = mpath === null ? g.short_name : `${g.short_name}/${mpath}`;
    return ["field", this.c.classType(g.owner), this.c.classFieldIndex(g.owner, `${where}.${s.name}`)];
  }

  outTarget(ctx: Ctx, n: Node, pin: string): string | null {
    const sig = ctx.sigs.get(n.id)!;
    for (const e of n.execs) {
      const p = e.pin || (sig.exec_outs.length ? sig.exec_outs[0].name : null);
      if (p === pin) return this.resolveTarget(ctx, e.target, e.target_pin);
    }
    return null;
  }

  resolveTarget(ctx: Ctx, tid: string, tpin: string | null, depth = 0): string | null {
    const t = ctx.graph.node(tid);
    if (t === null || depth > 64) return null;
    if (t.kind === "Macro") {
      if (!tpin) {
        const ins = ctx.sigs.has(tid) ? ctx.sigs.get(tid)!.exec_ins : [];
        tpin = ins.length ? ins[0].name : "in";
      }
      return `${ctx.prefix}${tid}!${tpin}`;
    }
    if (t.kind === "Reroute") {
      if (!t.execs.length) return null;
      const e = t.execs[0];
      return this.resolveTarget(ctx, e.target, e.target_pin, depth + 1);
    }
    return ctx.prefix + tid;
  }

  resolveRef(ctx: Ctx, ref: PinRef, ty: string, depth = 0): Src {
    const s = ctx.graph.node(ref.node);
    if (s === null || depth > 64) return new Src("lit", zeroLit(ty), null, ty);
    if (s.kind === "Entry") return new Src("local", ctx.params.get(ref.pin!), null, ty);
    if (s.kind === "Macro") return new Src("local", `${ctx.prefix}${ref.node}.${ref.pin}`, null, ty);
    if (s.kind === "Reroute") {
      const b = s.binding("in");
      if (b === null) return new Src("lit", zeroLit(ty), null, ty);
      if (b.value instanceof Lit) return new Src("lit", b.value, null, ty);
      return this.resolveRef(ctx, b.value, ty, depth + 1);
    }
    if (s.attr("disabled")) return new Src("lit", zeroLit(ty), null, ty);
    return new Src("node", ctx.prefix + ref.node, ref.pin, ty);
  }

  src(ctx: Ctx, n: Node, pin: Pin): Src {
    const b = n.binding(pin.name);
    if (b === null) return new Src("lit", pin.defaultLit() || zeroLit(pin.type), null, pin.type);
    if (b.value instanceof Lit) return new Src("lit", b.value, null, pin.type);
    return this.resolveRef(ctx, b.value, pin.type);
  }

  expand(ctx: Ctx): void {
    const idx = this.c.idx;
    for (const n of sortedBy(ctx.graph.nodes, (n) => n.id)) {
      const sig = ctx.sigs.get(n.id)!;
      const nid = ctx.prefix + n.id;
      if (n.kind === "Entry") {
        if (ctx.mpath === null) {
          this.entry = nid;
          const ir = new IRNode(nid, "Entry", sig);
          ir.execs = [["then", this.outTarget(ctx, n, "then")]];
          this.ir.set(nid, ir);
        }
        continue;
      }
      if (n.kind === "Reroute") continue;
      if (n.kind === "Macro") {
        this.expandMacro(ctx, n, sig);
        continue;
      }
      if (n.attr("disabled")) {
        if (!sig.pure) {
          const first = sig.exec_outs.length ? sig.exec_outs[0].name : null;
          const tgt = first ? this.outTarget(ctx, n, first) : null;
          const ir = new IRNode(nid, "Nop", sig);
          ir.execs = [["then", tgt]];
          this.ir.set(nid, ir);
        }
        continue;
      }
      const ir = new IRNode(nid, n.kind, sig, n.symbol, [...n.targs], sig.pure, n.attrs);
      if (n.kind === "Exit" || n.kind === "Leave") {
        if (n.kind === "Leave") ir.extra.leave = ctx.depth;
        for (const p of sig.data_ins) if (n.binding(p.name) !== null) ir.inputs.push([p.name, p.type, this.src(ctx, n, p)]);
        ir.extra.assign = ir.inputs.map(([p]) => ctx.results.get(p)!);
        ir.execs = [["then", ctx.exits.get(n.symbol!) ?? null]];
      } else {
        let ins = sig.data_ins;
        if (n.kind === "Switch") ins = ins.filter((p) => p.name === "value" || n.binding(p.name) !== null);
        ir.inputs = ins.map((p) => [p.name, p.type, this.src(ctx, n, p)]);
        ir.execs = sig.exec_outs.map((p) => [p.name, this.outTarget(ctx, n, p.name)]);
      }
      if (n.kind === "GetLocal" || n.kind === "SetLocal") ir.extra.local = ctx.locals.get(n.symbol!);
      else if (n.kind === "GetState" || n.kind === "SetState") ir.extra.global = ctx.states.get(n.symbol!);
      else if (n.kind === "GetVar" || n.kind === "SetVar") {
        if (idx.consts.has(n.symbol!)) ir.extra.const = idx.consts.get(n.symbol!)!.value;
        else ir.extra.global = this.c.global_index.get(n.symbol!);
      } else if (PLACE_MUTATORS.has(n.kind)) {
        const fp = ctx.locals.has(n.symbol!) ? null : fieldPlace(n.symbol, ctx.graph, idx);
        if (ctx.locals.has(n.symbol!)) ir.extra.place = ["local", ctx.locals.get(n.symbol!)];
        else if (fp !== null) ir.extra.place = ["field", [this.c.classType(fp[0]), this.c.classFieldIndex(fp[0], fp[1])]];
        else ir.extra.place = ["global", this.c.global_index.get(n.symbol!)];
      } else if (n.kind === "CallParent") {
        ir.extra.func = ["func", parentMethod(n, ctx.graph, idx)!.name];
      } else if (n.kind === "Call" && has(lanes.INTRINSICS, idx.callee(n.symbol!, n.targs)!.name)) {
        const op = lanes.INTRINSICS[idx.callee(n.symbol!, n.targs)!.name];
        ir.extra.intrinsic = typeof op === "string" ? [op] : op;
        this.c.uses_lanes = true;
      } else if (n.kind === "Call") {
        const callee = idx.callee(n.symbol!, n.targs)!;
        if (callee.kind === "func" || callee.kind === "event") ir.extra.func = ["func", callee.name];
        else if (callee.kind !== "interface") ir.extra.func = this.c.importRef(callee.name);
        ir.extra.nresults = callee.results.length;
        const short = callee.name.slice(callee.name.lastIndexOf(".") + 1);
        if (callee.kind === "interface") {
          const it = idx.interfaces.get(callee.method_of!)!;
          ir.extra.interface = [this.c.interfaceType(callee.method_of!), it.methods.map((m) => m.name).indexOf(short)];
        } else if (callee.method_of && !callee.final) {
          const names = this.c.slots(callee.method_of).map(([s]) => s);
          ir.extra.virtual = [this.c.classType(callee.method_of), names.indexOf(short)];
        }
      } else if (n.kind === "CreateDelegate") {
        const callee = idx.callee(n.symbol!)!;
        const virtual = !!callee.method_of && !callee.final;
        ir.extra.delegate = [["func", callee.name], (callee.method_of ? 1 : 0) | (virtual ? 2 : 0)];
        this.c.vt(sig.outputs[0].type);
      } else if (n.kind === "Invoke") {
        const ds = delegateSig(n.targs[0])!;
        ir.extra.functype = this.c.funcType(ds[0].map((t) => this.c.vt(t)), ds[1].map((t) => this.c.vt(t)));
        this.c.vt(n.targs[0]);
      } else if (n.kind === "Bind" || n.kind === "Unbind" || n.kind === "Broadcast") {
        const [cls, name] = dispatcherTarget(n, ctx.graph, idx);
        const d = idx.classDispatcher(cls!, name)![1];
        const dtype = `dispatcher#<(${d.params.map((p) => p.type).join(", ")})>`;
        ir.extra.dispatcher = [this.c.classType(cls!), this.c.classFieldIndex(cls!, name), this.c.vtRef(dtype).type];
        if (n.kind !== "Broadcast") this.c.vt(sig.inputs[2].type);
      } else if ((n.kind === "GetField" || n.kind === "SetField") && sig.category === "Classes") {
        const [cls, fname] = classFieldTarget(n, ctx.graph, idx)!;
        ir.extra.class_field = [this.c.classType(cls), this.c.classFieldIndex(cls, fname)];
      }
      this.ir.set(nid, ir);
    }
  }

  expandMacro(ctx: Ctx, n: Node, sig: Sig): void {
    const mg = this.c.idx.macro(n.symbol, n.targs)!;
    const mpath = ctx.prefix + n.id;
    const sub = new Ctx(mg, mpath + "/", mpath, this.sigsFor(mg));
    for (const p of mg.params) {
      if (p.type !== "exec") {
        sub.params.set(p.name, `${mpath}.${p.name}`);
        this.addLocal(sub.params.get(p.name)!, p.type);
      }
    }
    for (const r of mg.result_list) {
      if (r.type === "exec") sub.exits.set(r.name, this.outTarget(ctx, n, r.name));
      else {
        sub.results.set(r.name, `${mpath}.${r.name}`);
        this.pin_map.set(this.addLocal(sub.results.get(r.name)!, r.type), [ctx.prefix + n.id, r.name]);
      }
    }
    for (const l of sortedBy(mg.locals, (l) => l.name)) {
      sub.locals.set(l.name, `${mpath}.${l.name}`);
      this.addLocal(sub.locals.get(l.name)!, l.type, l.default_);
    }
    for (const s of sortedBy(mg.states, (s) => s.name)) sub.states.set(s.name, this.stateSlot(mpath, s));
    if (mg.nodes.some((m) => m.kind === "Leave")) {
      sub.depth = `${mpath}.!depth`;
      this.addLocal(sub.depth, "i32");
    }
    const entry = mg.nodes.find((m) => m.kind === "Entry") ?? null;
    const dataParams = sig.data_ins;
    for (const p of mg.params) {
      if (p.type !== "exec") continue;
      const cid = `${mpath}!${p.name}`;
      const ir = new IRNode(cid, "Capture", null);
      ir.inputs = dataParams.map((q) => [q.name, q.type, this.src(ctx, n, q)]);
      ir.extra.assign = dataParams.map((q) => sub.params.get(q.name)!);
      ir.execs = [["then", entry ? this.outTarget(sub, entry, p.name) : null]];
      const firstE = entry ? entry.execs.find((e) => e.pin === p.name) ?? null : null;
      const first = firstE !== null ? mg.node(firstE.target) : null;
      if (sub.depth && (first === null || first.kind !== "Leave")) ir.extra.record = sub.depth;
      this.ir.set(cid, ir);
    }
    this.expand(sub);
  }

  // -- analysis -----------------------------------------------------------------
  successors(n: IRNode): (string | null)[] {
    let ts = n.execs.map(([, t]) => t);
    if (n.kind === "Branch") ts = [...ts].reverse();
    else if (n.kind === "Try") ts = [ts[1], ts[0], ts[2]];
    else if (n.kind === "Switch") ts = [...ts.slice(-1), ...ts.slice(0, -1)];
    return ts;
  }

  reachable(): string[] {
    const order: string[] = [], seen = new Set<string>(), work: (string | null)[] = [this.entry];
    while (work.length) {
      let cur: string | null = work.pop() ?? null;
      while (cur !== null && cur !== undefined && !seen.has(cur) && this.ir.has(cur)) {
        seen.add(cur);
        order.push(cur);
        const succ = this.successors(this.ir.get(cur)!);
        for (const s of [...succ.slice(1)].reverse()) if (s !== null && s !== undefined && !seen.has(s)) work.push(s);
        cur = succ.length ? succ[0] : null;
      }
    }
    return order;
  }

  /** W0302: a chain can end with an empty continuation stack in a function with results. */
  checkChainEnds(): void {
    if (!this.g.result_list.length) return;
    const warned = new Set<string>(), states = new Set<string>();
    type S = (string | null)[];
    type M = [string, number][];
    const work: [string, S, M][] = [[this.entry!, [], []]];
    const chainEnd = (nid: string, S: S, M: M) => {
      for (;;) {
        if (!S.length) {
          if (!warned.has(nid)) {
            warned.add(nid);
            this.diag("W0302", "this chain can end without reaching Return; the function would return zero values", nid);
          }
          return;
        }
        const k = S[S.length - 1];
        S = S.slice(0, -1);
        if (k !== null) {
          work.push([k, S, M]);
          return;
        }
      }
    };
    while (work.length && states.size < 20000) {
      let [nid, S, M] = work.pop()!;
      const key = JSON.stringify([nid, S, M]);
      if (states.has(key) || S.length > 64) continue;
      states.add(key);
      const n = this.ir.get(nid)!;
      if ("record" in n.extra) {
        const d = new Map(M);
        d.set(n.extra.record, S.length);
        M = sortedBy([...d], (x) => x[0]);
      }
      if ("leave" in n.extra) {
        const d = new Map(M);
        if (d.has(n.extra.leave)) S = S.slice(0, d.get(n.extra.leave)!);
      }
      if (n.kind === "Return" || n.kind === "Throw") continue;
      if (n.kind === "Try") {
        const t = new Map(n.execs);
        const base: S = [...S, ...(t.get("then") ? [t.get("then")!] : [])];
        const nexts: [string | null, S][] = [[t.get("body") ?? null, [...base, null]], [t.get("fault") ?? null, base]];
        for (const [tgt, s] of nexts) {
          if (tgt === null) chainEnd(nid, s, M);
          else work.push([tgt, s, M]);
        }
        continue;
      }
      let nexts: [string | null, S][];
      if (n.kind === "Sequence") {
        const outs = n.execs.map(([, t]) => t);
        if (!outs.length) {
          chainEnd(nid, S, M);
          continue;
        }
        const S2 = [...S, ...[...outs.slice(1)].reverse()];
        nexts = [[outs[0], S2]];
      } else {
        nexts = n.execs.map(([, t]) => [t, S] as [string | null, S]);
        if (!nexts.length) nexts = [[null, S]];
      }
      for (const [t, s] of nexts) {
        if (t === null) chainEnd(nid, s, M);
        else work.push([t, s, M]);
      }
    }
  }

  // -- lowering -----------------------------------------------------------------
  lower(): void {
    if (this.entry === null) return;
    const order = this.reachable();
    this.checkChainEnds();
    const ids = sortedBy(this.ir.keys());
    for (const nid of ids) {
      for (const [, ty, s] of this.ir.get(nid)!.inputs) {
        if (s.kind === "node" && this.ir.has(s.a) && !this.ir.get(s.a)!.pure) {
          const key = tk(s.a, s.b!);
          if (!this.slots.has(key)) {
            const sig = this.ir.get(s.a)!.sig;
            const out = sig !== null ? sig.output(s.b) : null;
            this.slots.set(key, this.addLocal(`${s.a}.${s.b}`, out ? out.type : ty));
            this.pin_map.set(this.slots.get(key)!, [s.a, s.b!]);
          }
        }
      }
    }
    if (this.c.debug) {
      for (const nid of ids) {
        const n = this.ir.get(nid)!;
        if (!n.pure && (["Call", "CallParent", "Try", "New", "Invoke"].includes(n.kind) || PLACE_MUTATORS.has(n.kind))) {
          for (const p of n.data_outs) {
            const key = tk(nid, p.name);
            if (!this.slots.has(key)) {
              this.slots.set(key, this.addLocal(`${nid}.${p.name}`, p.type));
              this.pin_map.set(this.slots.get(key)!, [nid, p.name]);
            }
          }
        }
      }
    }
    this.code = [];
    this.lazy_cache = new Map();
    this.lazy_count = 0;
    order.forEach((nid, i) => this.emitBlock(this.ir.get(nid)!, i + 1 < order.length ? order[i + 1] : null));
    if (this.uses_end) {
      this.mark("label", "$end");
      this.emitChainEnd();
    }
  }

  E(op: string, ...imms: any[]): void {
    this.code.push({ op, imms });
  }

  mark(kind: "label" | "node" | "step" | "pure", name: string): void {
    this.code.push({ op: kind, imms: [name] });
  }

  L(target: string | null | undefined): string {
    if (target === null || target === undefined) {
      this.uses_end = true;
      return "$end";
    }
    return target;
  }

  debugLocal(nid: string, pin: string, ty: string): number {
    const key = tk(nid, pin);
    if (!this.debug_locals.has(key)) {
      const li = this.addLocal(`${nid}.${pin}`, ty);
      this.debug_locals.set(key, li);
      this.pin_map.set(li, [nid, pin]);
    }
    return this.debug_locals.get(key)!;
  }

  temp(ty: string): number {
    const vt = this.c.vt(ty);
    let free = this.temp_free.get(vt);
    if (!free) this.temp_free.set(vt, free = []);
    if (free.length) return free.pop()!;
    this.temp_count += 1;
    return this.addLocal(`$t${this.temp_count}`, ty);
  }

  emitChainEnd(): void {
    this.E("cont.pop");
    for (const r of this.g.result_list) this.emitConst(zeroLit(r.type), r.type);
    this.E("return");
  }

  transfer(target: string | null | undefined, nxt: string | null): void {
    if (target === null || target === undefined) this.emitChainEnd();
    else if (target !== nxt) this.E("br", target);
  }

  private storeOuts(n: IRNode): void {
    for (const p of [...n.sig!.data_outs].reverse()) {
      const slot = this.slots.get(tk(n.id, p.name));
      if (slot === undefined) this.E("drop");
      else this.E("local.set", slot);
    }
  }

  emitBlock(n: IRNode, nxt: string | null): void {
    this.mark("label", n.id);
    this.mark("node", n.id);
    this.at = [n.id];
    this.temp_free = new Map();
    for (const [name, li] of this.local_index) {
      if (name.startsWith("$t")) {
        const vt = this.c.vt(this.local_types[li]);
        let l = this.temp_free.get(vt);
        if (!l) this.temp_free.set(vt, l = []);
        l.push(li);
      }
    }
    const k = n.kind;
    const then = n.execs.length ? n.execs[0][1] : null;
    if (k === "Entry") {
      for (const [name, lit] of this.local_defaults) {
        const ty = this.local_types[this.li(name)];
        this.emitConst(lit, ty);
        this.E("local.set", this.li(name));
      }
      this.ready(n);
      this.transfer(then, nxt);
    } else if (k === "Nop") {
      this.ready(n);
      this.transfer(then, nxt);
    } else if (k === "Capture" || k === "Exit" || k === "Leave") {
      if ("record" in n.extra) {
        this.E("cont.depth");
        this.E("i32.const", 1);
        this.E("i32.add");
        this.E("local.set", this.li(n.extra.record));
      }
      this.emitInputs(n);
      for (const name of [...n.extra.assign].reverse()) this.E("local.set", this.li(name));
      if ("leave" in n.extra) {
        this.E("local.get", this.li(n.extra.leave));
        this.E("i32.const", 1);
        this.E("i32.sub");
        this.E("cont.trunc");
      }
      this.transfer(then, nxt);
    } else if (k === "SetLocal") {
      this.emitInputs(n);
      this.E("local.set", this.li(n.extra.local));
      this.transfer(then, nxt);
    } else if ((k === "SetVar" || k === "SetState") && Array.isArray(n.extra.global)) {
      const [, t, f] = n.extra.global;
      this.emitInputs(n, () => this.E("local.get", this.li("self")));
      this.E("class.set", t, f);
      this.transfer(then, nxt);
    } else if (k === "SetVar" || k === "SetState") {
      this.emitInputs(n);
      this.E("global.set", n.extra.global);
      this.transfer(then, nxt);
    } else if (k === "CallParent") {
      this.emitInputs(n, () => this.E("local.get", this.li("self")));
      this.E("call", n.extra.func);
      this.storeOuts(n);
      this.transfer(then, nxt);
    } else if (k === "Call") {
      this.emitInputs(n);
      this.emitCall(n);
      this.storeOuts(n);
      this.transfer(then, nxt);
    } else if (k === "Return") {
      this.emitInputs(n);
      this.E("return");
    } else if (k === "Branch") {
      this.emitInputs(n);
      const targets = new Map(n.execs);
      this.E("br_if", this.L(targets.get("then")));
      this.transfer(targets.get("else") ?? null, nxt);
    } else if (k === "Try") {
      this.ready(n);
      const t = new Map(n.execs);
      if (t.get("then") !== null && t.get("then") !== undefined) this.E("cont.push", t.get("then"));
      const faultLocal = this.addLocal(`${n.id}.$fault`, "fault");
      const handler = `${n.id}!fault`;
      this.E("try.push", handler, faultLocal);
      if (t.get("body") === null || t.get("body") === undefined) this.emitChainEnd();
      else this.E("br", t.get("body"));
      this.mark("label", handler);
      for (const [pin, native] of [["message", "std.fault.Message"], ["code", "std.fault.Code"]]) {
        const slot = this.slots.get(tk(n.id, pin));
        if (slot !== undefined) {
          this.E("local.get", faultLocal);
          this.E("call", this.c.importRef(native));
          this.E("local.set", slot);
        }
      }
      this.transfer(t.get("fault") ?? null, nxt);
    } else if (k === "Delay" || k === "Yield" || k === "Await") {
      this.emitInputs(n);
      this.E("suspend", ({ Yield: 0, Delay: 1, Await: 2 } as Record<string, number>)[k]);
      this.transfer(then, nxt);
    } else if (k === "Invoke") {
      this.emitInputs(n);
      this.E("call_delegate", n.extra.functype);
      this.storeOuts(n);
      this.transfer(then, nxt);
    } else if (k === "Bind" || k === "Unbind" || k === "Broadcast") {
      const [clsT, slot, dispT] = n.extra.dispatcher;
      const ep = this.newEp(n);
      this.eval(n.inputs[0][2], ep);
      this.E("class.get", clsT, slot);
      for (const [, , s] of n.inputs.slice(1)) this.eval(s, ep);
      this.ready(n);
      this.E(({ Bind: "dispatcher.bind", Unbind: "dispatcher.unbind", Broadcast: "dispatcher.broadcast" } as Record<string, string>)[k], dispT);
      this.transfer(then, nxt);
    } else if (k === "New") {
      this.ready(n);
      this.E("class.new", this.c.classType(n.symbol!));
      const slot = this.slots.get(tk(n.id, "result"));
      if (slot === undefined) this.E("drop");
      else this.E("local.set", slot);
      this.transfer(then, nxt);
    } else if (k === "SetField") {
      this.emitInputs(n);
      this.E("class.set", ...n.extra.class_field);
      this.transfer(then, nxt);
    } else if (k === "Throw") {
      this.emitInputs(n);
      this.E("call", this.c.importRef("std.fault.Make"));
      this.E("throw");
    } else if (k === "Sequence") {
      this.ready(n);
      const outs = n.execs.map(([, t]) => t);
      for (const t of [...outs.slice(1)].reverse()) this.E("cont.push", this.L(t));
      this.transfer(outs.length ? outs[0] : null, nxt);
    } else if (k === "Switch") {
      const ty = n.targs[0];
      const ep = this.newEp(n);
      const value = n.inputs[0][2], cases = n.inputs.slice(1);
      this.eval(value, ep, false);
      const tmp = this.temp(ty);
      this.E("local.set", tmp);
      this.ready(n);
      const targets = new Map(n.execs);
      for (const [pin, , s] of cases) {
        this.E("local.get", tmp);
        this.eval(s, ep, false);
        this.emitEq(ty);
        this.E("br_if", this.L(targets.get(pin)));
      }
      this.transfer(targets.get("default") ?? null, nxt);
    } else if (PLACE_MUTATORS.has(k)) {
      const [kind, where] = n.extra.place;
      const idx = kind === "local" ? this.li(where) : where;
      if (kind === "field") {
        const ep = this.newEp(n);
        this.eval(n.inputs[0][2], ep, false);
        const obj = this.temp(n.inputs[0][1]);
        this.E("local.tee", obj);
        this.E("local.get", obj);
        this.E("class.get", ...idx);
        for (const [, , s] of n.inputs.slice(1)) this.eval(s, ep);
        this.ready(n);
      } else this.emitInputs(n, () => this.E(`${kind}.get`, idx));
      if (has(ARRAY_MUTATORS, k)) {
        const op = ({ ArraySet: "array.set", ArrayAdd: "array.push", ArrayInsert: "array.insert", ArrayRemove: "array.remove",
                      ArrayClear: "array.clear" } as Record<string, string>)[k];
        this.E(op, this.c.arrayType(n.targs[0]));
      } else this.E(CONTAINER_OPS[k], this.c.containerType(k, n.targs));
      this.storeOuts(n);
      if (kind === "field") this.E("class.set", ...idx);
      else this.E(`${kind}.set`, idx);
      this.transfer(then, nxt);
    } else throw new Error(`cannot lower impure node kind ${k}`);
  }

  // -- evaluation points --------------------------------------------------------
  count(s: Src, ep: EvalPoint): void {
    if (s.kind === "node" && this.ir.has(s.a) && this.ir.get(s.a)!.pure) {
      ep.uses.add(s.a);
      if (ep.uses.count(s.a) === 1) for (const [, , inner] of this.ir.get(s.a)!.inputs) this.count(inner, ep);
    }
  }

  newEp(n: IRNode): EvalPoint {
    const ep = new EvalPoint();
    for (const [, , s] of n.inputs) this.count(s, ep);
    if (n.inputs.some(([, , s]) => this.hasLazy(s))) for (const [, , s] of n.inputs) this.spill(s, ep);
    return ep;
  }

  emitInputs(n: IRNode, pre: (() => void) | null = null): void {
    const ep = this.newEp(n);
    if (pre !== null) pre();
    for (const [, , s] of n.inputs) this.eval(s, ep);
    this.ready(n);
  }

  // -- lazy nodes (Select, And, Or: section 4.3) --------------------------------
  hasLazy(s: Src): boolean {
    if (s.kind !== "node") return false;
    const t = this.ir.get(s.a);
    if (t === undefined || !t.pure) return false;
    if (!this.lazy_cache.has(s.a)) {
      this.lazy_cache.set(s.a, false);
      this.lazy_cache.set(s.a, LAZY_KINDS.includes(t.kind) || t.inputs.some(([, , inner]) => this.hasLazy(inner)));
    }
    return this.lazy_cache.get(s.a)!;
  }

  spill(s: Src, ep: EvalPoint): void {
    if (s.kind !== "node" || ep.temps.has(tk(s.a, s.b!))) return;
    const t = this.ir.get(s.a);
    if (t === undefined || !t.pure) return;
    this._eval(s, ep);
    const tmp = this.temp(s.type);
    this.E("local.set", tmp);
    ep.temps.set(tk(s.a, s.b!), tmp);
  }

  branchValue(s: Src, ep: EvalPoint, tmp: number): void {
    const saved = new Map(ep.temps);
    this._eval(s, ep);
    this.E("local.set", tmp);
    ep.temps = saved;
  }

  emitLazy(n: IRNode, ep: EvalPoint): void {
    this.lazy_count += 1;
    const end = `${n.id}!lazy${this.lazy_count}`;
    const out = this.temp(n.data_outs[0].type);
    if (n.kind === "Select") {
      const [[, , cond], [, , a], [, , b]] = n.inputs;
      const takeA = end + "a";
      this._eval(cond, ep);
      this.E("br_if", takeA);
      this.branchValue(b, ep, out);
      this.E("br", end);
      this.mark("label", takeA);
      this.branchValue(a, ep, out);
    } else {
      const [[, , a], [, , b]] = n.inputs;
      this._eval(a, ep);
      this.E("local.tee", out);
      if (n.kind === "And") this.E("i32.eqz");
      this.E("br_if", end);
      this.branchValue(b, ep, out);
    }
    this.mark("label", end);
    this.E("local.get", out);
  }

  ready(n: IRNode): void {
    if (this.c.debug) {
      this.mark("step", n.id);
      this.E("nop");
    }
  }

  eval(s: Src, ep: EvalPoint, keep = true): void {
    this._eval(s, ep);
    if (keep && s.kind !== "lit" && isContainer(s.type)) this.E("ref.share");
  }

  _eval(s: Src, ep: EvalPoint): void {
    if (s.kind === "lit") this.emitConst(s.a, s.type);
    else if (s.kind === "local") this.E("local.get", this.li(s.a));
    else {
      const t = this.ir.get(s.a);
      if (t === undefined) this.emitConst(zeroLit(s.type), s.type);
      else if (!t.pure) {
        const slot = this.slots.get(tk(s.a, s.b!));
        if (slot === undefined) this.emitConst(zeroLit(s.type), s.type);
        else this.E("local.get", slot);
      } else if (ep.temps.has(tk(s.a, s.b!))) this.E("local.get", ep.temps.get(tk(s.a, s.b!)));
      else {
        const outs = t.data_outs;
        if (!LAZY_KINDS.includes(t.kind) && this.hasLazy(s)) for (const [, , inner] of t.inputs) this.spill(inner, ep);
        this.at.push(t.id);
        this.mark("pure", t.id);
        this.emitPure(t, ep);
        this.at.pop();
        if (this.at.length) this.mark("pure", this.at[this.at.length - 1]);
        if (outs.length === 1) {
          if (ep.uses.count(s.a) > 1) {
            const tmp = this.temp(outs[0].type);
            this.E("local.tee", tmp);
            ep.temps.set(tk(s.a, s.b!), tmp);
          }
          if (this.c.debug) this.E("local.tee", this.debugLocal(s.a, outs[0].name, outs[0].type));
        } else {
          for (const o of [...outs].reverse()) {
            const tmp = this.temp(o.type);
            this.E("local.set", tmp);
            ep.temps.set(tk(s.a, o.name), tmp);
          }
          if (this.c.debug) {
            for (const o of outs) {
              this.E("local.get", ep.temps.get(tk(s.a, o.name)));
              this.E("local.set", this.debugLocal(s.a, o.name, o.type));
            }
          }
          this.E("local.get", ep.temps.get(tk(s.a, s.b!)));
        }
      }
    }
  }

  emitCall(n: IRNode): void {
    if ("interface" in n.extra) this.E("call_interface", ...n.extra.interface);
    else if ("virtual" in n.extra) this.E("call_virtual", ...n.extra.virtual);
    else this.E("call", n.extra.func);
  }

  emitConst(lit: Lit, ty: string): void {
    if (ty === "std.Signal") {
      this.E("local.get", this.addLocal("$null.signal", ty));
      return;
    }
    if (ty === "anyref" || delegateSig(ty) !== null) {
      this.E("local.get", this.addLocal(`$null.${ty}`, ty));
      return;
    }
    const idx = this.c.idx;
    if (idx.classes.has(ty) || idx.interfaces.has(ty)) {
      this.E("ref.null", this.c.vtRef(ty).type);
      return;
    }
    let elem = arrayElem(ty);
    if (elem !== null) {
      this.E("i32.const", 0);
      this.E("array.new", this.c.arrayType(elem));
      return;
    }
    const kv = mapTypes(ty);
    if (kv !== null) {
      this.E("map.new", this.c.mapType(kv[0], kv[1]));
      return;
    }
    elem = setElem(ty);
    if (elem !== null) {
      this.E("set.new", this.c.setType(elem));
      return;
    }
    if (has(LANE_VT, ty)) {
      if (ty === "transform") lit.value.forEach((x: Lit, i: number) => this.emitConst(x, lanes.LANE_FIELDS[ty][i][1]));
      else for (const x of lit.value) this.E("f32.const", Number(x.value));
      this.E(`${LP[ty]}.make`);
      return;
    }
    if (idx.structs.has(ty)) {
      for (const f of idx.structs.get(ty)!.fields) this.emitConst(f.default_ !== null ? f.default_ : zeroLit(f.type), f.type);
      this.E("struct.new", this.c.structType(ty));
      return;
    }
    if (lit.kind === "enum") lit = new Lit("int", this.c.enumValue(lit));
    ty = this.c.base(ty);
    const vt = VT[ty];
    if (ty === "bool") this.E("i32.const", lit.value ? 1 : 0);
    else if (ty === "string") this.E("string.const", this.c.stringIndex(lit.value));
    else if (vt === F32) this.E("f32.const", Number(lit.value));
    else if (vt === F64) this.E("f64.const", Number(lit.value));
    else if (vt === I64) this.E("i64.const", wrapInt(ty, lit.value));
    else this.E("i32.const", wrapInt(ty, lit.value));
  }

  narrow(ty: string): void {
    if (ty === "i8") this.E("i32.extend8_s");
    else if (ty === "i16") this.E("i32.extend16_s");
    else if (ty === "u8") {
      this.E("i32.const", 0xFF);
      this.E("i32.and");
    } else if (ty === "u16") {
      this.E("i32.const", 0xFFFF);
      this.E("i32.and");
    }
  }

  static NARROW_RANGES: Record<string, [number, number]> = { i8: [-128, 127], u8: [0, 255], i16: [-32768, 32767], u16: [0, 65535] };

  clampNarrow(ty: string): void {
    const rng = FuncLowerer.NARROW_RANGES[ty];
    if (rng === undefined) return;
    const [lo, hi] = rng;
    const signed = SIGNED_TYPES.has(ty);
    const t = this.temp("i32");
    this.E("local.set", t);
    if (signed) {
      this.E("local.get", t);
      this.E("i32.const", lo);
      this.E("local.get", t);
      this.E("i32.const", lo);
      this.E("i32.gt_s");
      this.E("select");
      this.E("local.set", t);
    }
    this.E("local.get", t);
    this.E("i32.const", hi);
    this.E("local.get", t);
    this.E("i32.const", hi);
    this.E(signed ? "i32.lt_s" : "i32.lt_u");
    this.E("select");
  }

  emitEq(ty: string): void {
    const idx = this.c.idx;
    if (isContainer(ty)) {
      const kind = arrayElem(ty) !== null ? "array" : mapTypes(ty) !== null ? "map" : "set";
      this.E("call", this.c.importRef(`std.${kind}.Equals`));
      return;
    }
    if (idx.classes.has(ty) || idx.interfaces.has(ty)) {
      this.E("ref.eq");
      return;
    }
    if (has(LANE_VT, ty)) {
      this.E(`${LP[ty]}.eq`);
      return;
    }
    if (idx.structs.has(ty)) {
      const t = this.c.structType(ty);
      const fields = idx.structs.get(ty)!.fields;
      const tb = this.temp(ty), ta = this.temp(ty);
      this.E("local.set", tb);
      this.E("local.set", ta);
      this.E("i32.const", 1);
      fields.forEach((f, i) => {
        this.E("local.get", ta);
        this.E("struct.get", t, i);
        this.E("local.get", tb);
        this.E("struct.get", t, i);
        this.emitEq(f.type);
        this.E("i32.and");
      });
      return;
    }
    ty = this.c.base(ty);
    if (ty === "string") this.E("string.eq");
    else this.E(`${PFX[VT[ty]]}.eq`);
  }

  emitPure(n: IRNode, ep: EvalPoint): void {
    const k = n.kind;
    const idx = this.c.idx;
    if (k === "GetLocal") {
      this.E("local.get", this.li(n.extra.local));
      return;
    }
    if (k === "GetVar" || k === "GetState") {
      if ("const" in n.extra) this.emitConst(n.extra.const, n.sig!.outputs[0].type);
      else if (Array.isArray(n.extra.global)) {
        const [, t, f] = n.extra.global;
        this.E("local.get", this.li("self"));
        this.E("class.get", t, f);
      } else this.E("global.get", n.extra.global);
      return;
    }
    if (has(MAP_PURE, k) || has(SET_PURE, k)) {
      for (const [, , src] of n.inputs) this.eval(src, ep, false);
      this.E(CONTAINER_OPS[k], this.c.containerType(k, n.targs));
      return;
    }
    if (k === "MakeArray") {
      const t = this.c.arrayType(n.targs[0]);
      this.E("i32.const", n.inputs.length);
      this.E("array.new", t);
      n.inputs.forEach(([, , item], i) => {
        this.E("i32.const", i);
        this.eval(item, ep);
        this.E("array.set", t);
      });
      return;
    }
    if (k === "ArrayGet") {
      this.eval(n.inputs[0][2], ep, false);
      this.eval(n.inputs[1][2], ep);
      this.E("array.get", this.c.arrayType(n.targs[0]));
      return;
    }
    if (k === "ArrayLength") {
      this.eval(n.inputs[0][2], ep, false);
      this.E("array.len");
      return;
    }
    if (k === "GetField" && "class_field" in n.extra) {
      this.eval(n.inputs[0][2], ep);
      this.E("class.get", ...n.extra.class_field);
      return;
    }
    if (["MakeStruct", "BreakStruct", "GetField", "WithField"].includes(k)) {
      this.emitStructNode(n, ep);
      return;
    }
    if (k === "IsValid") {
      this.eval(n.inputs[0][2], ep);
      this.E("ref.valid");
      return;
    }
    if (k === "CreateDelegate") {
      for (const [, , s] of n.inputs) this.eval(s, ep);
      this.E("delegate.new", ...n.extra.delegate);
      return;
    }
    if (k === "Cast") {
      const t = this.c.vtRef(n.symbol!).type;
      this.eval(n.inputs[0][2], ep);
      const obj = this.temp("anyref"), ok = this.temp("bool");
      this.E("local.tee", obj);
      this.E("ref.test", t);
      this.E("local.set", ok);
      this.E("local.get", obj);
      this.E("ref.null", t);
      this.E("local.get", ok);
      this.E("select");
      this.E("ref.cast", t);
      this.E("local.get", ok);
      return;
    }
    if (LAZY_KINDS.includes(k)) {
      this.emitLazy(n, ep);
      return;
    }
    if (k === "Format") {
      this.emitFormat(n, ep);
      return;
    }
    if (k === "CallParent") this.E("local.get", this.li("self"));
    for (const [, , s] of n.inputs) this.eval(s, ep, k !== "Eq" && k !== "Ne");
    if (k === "Call" && "intrinsic" in n.extra) {
      for (const op of n.extra.intrinsic) this.E(op);
      return;
    }
    if (k === "Call") {
      this.emitCall(n);
      return;
    }
    if (k === "CallParent") {
      this.E("call", n.extra.func);
      return;
    }
    if (k === "Convert") {
      this.emitConvert(n.targs[0], n.targs[1]);
      return;
    }
    if (k === "Not") {
      this.E("i32.eqz");
      return;
    }
    if (k === "Xor") {
      this.E("i32.xor");
      return;
    }
    let T = n.targs[0];
    if (has(LANE_VT, T)) {
      this.E(`${LP[T]}.${LANE_ARITH[k]}`);
      return;
    }
    if (idx.structs.has(T) || idx.classes.has(T) || idx.interfaces.has(T) || isContainer(T)) {
      this.emitEq(T);
      if (k === "Ne") this.E("i32.eqz");
      return;
    }
    T = this.c.base(T);
    const vt = VT[T];
    const p = PFX[vt];
    const signed = SIGNED_TYPES.has(T);
    const isFloat = FLOAT_TYPES.includes(T);
    const su = signed ? "s" : "u";
    if (k === "Eq" || k === "Ne") {
      this.emitEq(T);
      if (k === "Ne") this.E("i32.eqz");
    } else if (["Lt", "Le", "Gt", "Ge"].includes(k)) {
      const op = k.toLowerCase();
      if (T === "string") {
        this.E("string.cmp");
        this.E("i32.const", 0);
        this.E(`i32.${op}_s`);
      } else if (isFloat) this.E(`${p}.${op}`);
      else this.E(`${p}.${op}_${su}`);
    } else if (k === "Add" || k === "Sub" || k === "Mul") {
      this.E(`${p}.${k.toLowerCase()}`);
      this.narrow(T);
    } else if (k === "Div" || k === "Rem") {
      if (isFloat && k === "Rem") this.E("call", this.c.importRef(T === "f32" ? "std.math.FRem32" : "std.math.FRem64"));
      else if (isFloat) this.E(`${p}.div`);
      else {
        this.E(`${p}.${k.toLowerCase()}_${su}`);
        this.narrow(T);
      }
    } else if (k === "Min" || k === "Max") {
      if (isFloat) this.E(`${p}.${k.toLowerCase()}`);
      else {
        const ta = this.temp(T), tb = this.temp(T);
        this.E("local.set", tb);
        this.E("local.set", ta);
        this.E("local.get", ta);
        this.E("local.get", tb);
        this.E("local.get", ta);
        this.E("local.get", tb);
        this.E(`${p}.${k === "Min" ? "lt" : "gt"}_${su}`);
        this.E("select");
      }
    } else if (k === "Neg") {
      this.E(`${p}.neg`);
      this.narrow(T);
    } else if (k === "Abs") {
      if (isFloat) this.E(`${p}.abs`);
      else {
        const t = this.temp(T);
        this.E("local.set", t);
        this.E("local.get", t);
        this.E(`${p}.neg`);
        this.E("local.get", t);
        this.E("local.get", t);
        this.emitConst(new Lit("int", 0n), T);
        this.E(`${p}.lt_s`);
        this.E("select");
        this.narrow(T);
      }
    } else if (k === "BitAnd" || k === "BitOr" || k === "BitXor") {
      this.E(`${p}.${k.slice(3).toLowerCase()}`);
    } else if (k === "BitNot") {
      this.E(`${p}.not`);
      this.narrow(T);
    } else if (k === "Shl" || k === "Shr") {
      const width = ({ i8: 8, u8: 8, i16: 16, u16: 16 } as Record<string, number>)[T];
      if (width) {
        this.E("i32.const", width - 1);
        this.E("i32.and");
      }
      if (k === "Shl") {
        this.E(`${p}.shl`);
        this.narrow(T);
      } else this.E(`${p}.shr_${su}`);
    } else throw new Error(`cannot lower pure node kind ${k}`);
  }

  emitStructNode(n: IRNode, ep: EvalPoint): void {
    const k = n.kind;
    const sym = n.symbol || "";
    const dot = sym.indexOf(".");
    const name = dot < 0 ? sym : sym.slice(0, dot), fname = dot < 0 ? "" : sym.slice(dot + 1);
    if (has(LANE_VT, name)) {
      for (const [, , src] of n.inputs) this.eval(src, ep);
      const p = LP[name];
      const names = lanes.LANE_FIELDS[name].map(([f]) => f);
      if (k === "MakeStruct") this.E(`${p}.make`);
      else if (k === "GetField" || k === "WithField") this.E(`${p}.${k === "GetField" ? "get" : "with"}`, names.indexOf(fname));
      else {
        const tmp = this.temp(name);
        this.E("local.set", tmp);
        for (let i = 0; i < names.length; i++) {
          this.E("local.get", tmp);
          this.E(`${p}.get`, i);
        }
      }
      return;
    }
    const t = this.c.structType(name);
    for (const [, , src] of n.inputs) this.eval(src, ep);
    if (k === "MakeStruct") this.E("struct.new", t);
    else if (k === "GetField") this.E("struct.get", t, this.c.fieldIndex(name, fname));
    else if (k === "WithField") this.E("struct.with", t, this.c.fieldIndex(name, fname));
    else {
      const tmp = this.temp(name);
      this.E("local.set", tmp);
      for (let i = 0; i < this.c.idx.structs.get(name)!.fields.length; i++) {
        this.E("local.get", tmp);
        this.E("struct.get", t, i);
      }
    }
  }

  emitFormat(n: IRNode, ep: EvalPoint): void {
    const srcs = new Map(n.inputs.map(([pin, ty, s]) => [pin, [ty, s] as [string, Src]]));
    const concat = this.c.importRef("std.string.Concat");
    const parts = formatParts(n.symbol!);
    parts.forEach(([kind, v], i) => {
      if (kind === "text") this.emitConst(new Lit("string", v), "string");
      else {
        const [ty, s] = srcs.get(v)!;
        this.eval(s, ep);
        this.emitConvert(ty, "string");
      }
      if (i) this.E("call", concat);
    });
    if (!parts.length) this.emitConst(new Lit("string", ""), "string");
  }

  emitConvert(f: string, t: string): void {
    f = this.c.base(f);
    t = this.c.base(t);
    if (f === t) return;
    if (has(LANE_VT, f)) {
      if (t === "string") this.E("call", this.c.importRef(`std.convert.From${capitalize(f)}`));
      else this.E(f === "vec2" ? "v3.from_v2" : "v3.to_v2");
      return;
    }
    const vf = VT[f], vt = VT[t];
    if (t === "string") {
      const name = ({ bool: "FromBool", u32: "FromU32", i64: "FromI64", u64: "FromU64", f32: "FromF32", f64: "FromF64" } as Record<string, string>)[f] ?? "FromI32";
      this.E("call", this.c.importRef(`std.convert.${name}`));
      return;
    }
    if (t === "bool") {
      this.E(`${PFX[vf]}.eqz`);
      this.E("i32.eqz");
      return;
    }
    const fs = SIGNED_TYPES.has(f) ? "s" : "u";
    if ([...INT_TYPES, "bool"].includes(f) && INT_TYPES.includes(t)) {
      if (vf === I32 && vt === I64) this.E(`i64.extend_i32_${fs}`);
      else if (vf === I64 && vt === I32) this.E("i32.wrap_i64");
      this.narrow(t);
    } else if (INT_TYPES.includes(f) && FLOAT_TYPES.includes(t)) {
      this.E(`${PFX[vt]}.convert_${PFX[vf]}_${fs}`);
    } else if (FLOAT_TYPES.includes(f) && INT_TYPES.includes(t)) {
      const ts = SIGNED_TYPES.has(t) ? "s" : "u";
      this.E(`${PFX[vt]}.trunc_${PFX[vf]}_${ts}`);
      this.clampNarrow(t);
    } else if (f === "f32" && t === "f64") this.E("f64.promote_f32");
    else if (f === "f64" && t === "f32") this.E("f32.demote_f64");
  }

  // -- assembly -----------------------------------------------------------------
  /** Resolve labels and function references. Returns [code bytes, block starts, step
   * points, pure-node code], each table [pc, node id]. */
  assemble(): Assembled {
    const pcs = new Map<string, number>();
    let pc = 0;
    for (const item of this.code) {
      if (item.op === "label") pcs.set(item.imms[0], pc);
      else if (!["node", "step", "pure"].includes(item.op)) pc += wbc.instrSize(item.op, this.imms(item, pcs, 0, false));
    }
    const w = new wbc.Writer();
    const tables: Record<string, [number, string][]> = { node: [], step: [], pure: [] };
    for (const item of this.code) {
      if (item.op === "label") continue;
      if (item.op in tables) {
        tables[item.op].push([w.length, item.imms[0]]);
        continue;
      }
      const start = w.length;
      const size = wbc.instrSize(item.op, this.imms(item, pcs, 0, false));
      wbc.encodeInstr(w, item.op, this.imms(item, pcs, start + size, true));
    }
    return [w.bytes(), tables.node, tables.step, tables.pure];
  }

  private imms(item: CodeItem, pcs: Map<string, number>, end: number, final: boolean): any[] {
    const { op, imms } = item;
    const kind = wbc.OPS[op][1];
    if (kind === "L") return final ? [pcs.get(imms[0])! - end] : [0];
    if (kind === "Lu") return final ? [pcs.get(imms[0])! - end, imms[1]] : [0, imms[1]];
    if (op === "call") return [this.c.funcIndex(imms[0])];
    if (op === "delegate.new") return [this.c.funcIndex(imms[0]), imms[1]];
    return imms;
  }
}

function exported(item: { attrs: Attr[] | null }): boolean {
  return (item.attrs ?? []).some((a) => a.name === "export");
}

/** Compile and verify. `exportAll` is `wiretc build --export-all` (section 5.2). */
export function compileModule(module: Module, source: string | null = null, embedSource = true, debug = false,
                              project: Project | null = null, exportAll = false): CompileResult {
  return new Compiler(module, source, embedSource, debug, project, exportAll).compile();
}
