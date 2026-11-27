/** The node registry (spec section 3.5): pin names, types, defaults and purity.
 *
 * Static kinds are described as data. Kinds whose pins depend on context (Entry, Return,
 * Call, Macro, Exit, the variable accessors) are expanded by `signature`. */
import { DEFAULTS as LANE_DEFAULTS, LANE_FIELDS, LANE_TYPES, VECTORS } from "./lanes.js";
import { Class, Const, Dispatcher, Enum, Extern, Field, Graph, Interface, Lit, Module, Node, Struct, Var } from "./model.js";
import { stdNatives } from "./natives.js";
import { CONTENT } from "./content.gen.js";
import { deepcopy, key, sortedBy } from "./pyutil.js";
import { parse } from "./parser.js";

export const INT_TYPES = ["i8", "u8", "i16", "u16", "i32", "u32", "i64", "u64"];
export const FLOAT_TYPES = ["f32", "f64"];
export const NUM_TYPES = [...INT_TYPES, ...FLOAT_TYPES];
export const PRIM_TYPES = ["bool", ...NUM_TYPES, "string"];
export const SIGNED_TYPES = new Set(["i8", "i16", "i32", "i64"]);

export const CONSTRAINTS: Record<string, string[]> = {
  number: NUM_TYPES,
  int: INT_TYPES,
  signed: ["i8", "i16", "i32", "i64", "f32", "f64"],
  eq: ["bool", ...NUM_TYPES, "string", ...LANE_TYPES],
  ord: [...NUM_TYPES, "string"],
  switch: ["bool", ...INT_TYPES, "string"],
  any: [...PRIM_TYPES, ...LANE_TYPES],
  convertible: [...PRIM_TYPES, ...VECTORS, "quat", "transform"],
  arith: [...NUM_TYPES, ...VECTORS],
  mul: [...NUM_TYPES, ...LANE_TYPES],
  neg: ["i8", "i16", "i32", "i64", "f32", "f64", ...VECTORS],
  vector: [...VECTORS],
};

/** Names a struct or enum may not take: they already mean a built-in type. */
export const BUILTIN_TYPE_NAMES = new Set([...PRIM_TYPES, "array", "set", "map", "delegate", "dispatcher", "exec", ...LANE_TYPES]);

/** A lane type as the struct it behaves like (section 3.1.1). */
export function laneStruct(name: string): Struct {
  const fields = LANE_FIELDS[name].map(([fname, fty], i) => {
    const d = LANE_DEFAULTS[name][i];
    const def = Array.isArray(d) ? laneLit(d) : new Lit("float", d);
    return new Field(fname, fty, def);
  });
  return new Struct(name, fields);
}

/** A lane value as its literal: a tuple of floats, nested for a transform. */
export function laneLit(v: any[]): Lit {
  return new Lit("tuple", v.map((x) => Array.isArray(x) ? laneLit(x) : new Lit("float", Number(x))));
}

/** The value of a lane literal, as floats (not yet rounded to f32). */
export function laneValue(lit: Lit, ty: string): any[] {
  if (ty === "transform") return lit.value.map((x: Lit, i: number) => laneValue(x, LANE_FIELDS[ty][i][1]));
  return lit.value.map((x: Lit) => Number(x.value));
}

/** A tuple with one number per field, nested for a transform (section 3.1.1). */
export function laneLitFits(lit: Lit, ty: string): boolean {
  if (lit.kind !== "tuple" || lit.value.length !== LANE_FIELDS[ty].length) return false;
  return LANE_FIELDS[ty].every(([, t], i) => {
    const x: Lit = lit.value[i];
    return t in LANE_FIELDS ? laneLitFits(x, t) : x.kind === "int" || x.kind === "float";
  });
}

export const INT_RANGES: Record<string, [bigint, bigint]> = Object.fromEntries(INT_TYPES.map((t) => {
  const b = BigInt(parseInt(t.slice(1), 10));
  return [t, t[0] === "i" ? [-(1n << (b - 1n)), (1n << (b - 1n)) - 1n] : [0n, (1n << b) - 1n]];
}));

export const USER_CONSTRAINTS: Record<string, string[]> = {
  eq: ["struct", "enum", "class"], ord: ["enum"], switch: ["enum"],
  any: ["struct", "enum", "class"], convertible: ["enum"],
};

/** `i32, map#<string, i32>, f32` -> the three types, splitting only at top-level commas. */
export function splitTypes(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "<" || ch === "(") depth += 1;
    else if (ch === ">" || ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function _tlist(s: string): string[] | null {
  s = s.trim();
  if (!(s.startsWith("(") && s.endsWith(")"))) return null;
  return splitTypes(s.slice(1, -1));
}

/** `delegate#<(i32, f32) -> (bool)>` -> [["i32", "f32"], ["bool"]]; null otherwise. */
export function delegateSig(ty: string): [string[], string[]] | null {
  if (!ty.startsWith("delegate#<") || !ty.endsWith(">")) return null;
  const inner = ty.slice("delegate#<".length, -1);
  let depth = 0, cut: number | null = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "<" || ch === "(") depth += 1;
    else if (ch === ">" || ch === ")") depth -= 1;
    else if (depth === 0 && inner.startsWith("->", i)) {
      cut = i;
      break;
    }
  }
  const params = _tlist(cut === null ? inner : inner.slice(0, cut));
  const results = cut === null ? [] : _tlist(inner.slice(cut + 2));
  if (params === null || results === null) return null;
  return [params, results];
}

/** `dispatcher#<(i32)>` -> ["i32"]; null otherwise. */
export function dispatcherParams(ty: string): string[] | null {
  if (!ty.startsWith("dispatcher#<") || !ty.endsWith(">")) return null;
  return _tlist(ty.slice("dispatcher#<".length, -1));
}

/** The canonical text of a delegate type (results left out when there are none). */
export function delegateType(params: string[], results: string[]): string {
  const t = `delegate#<(${params.join(", ")})`;
  return t + (results.length ? ` -> (${results.join(", ")})>` : ">");
}

export function dispatcherType(params: string[]): string {
  return `dispatcher#<(${params.join(", ")})>`;
}

/** Whether a type argument meets a constraint of a registry kind. */
export function allows(constraint: string, ty: string, idx: ModuleIndex | null = null): boolean {
  if (CONSTRAINTS[constraint].includes(ty)) return true;
  if (constraint === "eq") return typeOk(ty, idx) && delegateSig(ty) === null;
  if (idx === null) return false;
  const kinds = USER_CONSTRAINTS[constraint] ?? [];
  return (kinds.includes("struct") && idx.structs.has(ty)) || (kinds.includes("enum") && idx.enums.has(ty)) ||
    (kinds.includes("class") && (idx.classes.has(ty) || idx.interfaces.has(ty)));
}

/** Every type argument a constraint accepts, built-in types first, then the module's
 * structs and enums by name: what the palette and menus offer. */
export function typeChoices(constraint: string, idx: ModuleIndex | null = null): string[] {
  const out = [...CONSTRAINTS[constraint]];
  if (idx !== null)
    for (const t of [...sortedBy(idx.structs.keys()), ...sortedBy(idx.enums.keys())])
      if (allows(constraint, t, idx) && !out.includes(t)) out.push(t);
  return out;
}

/** Whether a struct holds only primitives, enums and structs of those (section 3.1). */
export function plainStruct(ty: string, idx: ModuleIndex): boolean {
  const path = new Set<string>();
  const ok = (t: string): boolean => {
    if (idx.structs.has(t)) {
      if (path.has(t)) return false;
      path.add(t);
      const result = idx.structs.get(t)!.fields.every((f) => ok(f.type));
      path.delete(t);
      return result;
    }
    return CONSTRAINTS.eq.includes(t) || idx.enums.has(t);
  };
  return ok(ty);
}

/** pin default: the zero value of the pin's type */
export const ZERO = Symbol("ZERO");

/** The element type of `array#<T>`, else null. */
export function arrayElem(ty: string): string | null {
  return ty.startsWith("array#<") && ty.endsWith(">") ? ty.slice("array#<".length, -1) : null;
}

/** [K, V] of `map#<K, V>`, else null. */
export function mapTypes(ty: string): [string, string] | null {
  if (ty.startsWith("map#<") && ty.endsWith(">")) {
    let depth = 0;
    const inner = ty.slice("map#<".length, -1);
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];
      if (ch === "<") depth += 1;
      if (ch === ">") depth -= 1;
      if (ch === "," && depth === 0) return [inner.slice(0, i).trim(), inner.slice(i + 1).trim()];
    }
  }
  return null;
}

/** The element type of `set#<T>`, else null. */
export function setElem(ty: string): string | null {
  return ty.startsWith("set#<") && ty.endsWith(">") ? ty.slice("set#<".length, -1) : null;
}

export function isContainer(ty: string): boolean {
  return arrayElem(ty) !== null || mapTypes(ty) !== null || setElem(ty) !== null;
}

/** A map key or set element: a primitive, a lane type, an enum, or a struct of those. */
export function keyTypeOk(ty: string, idx: ModuleIndex | null = null): boolean {
  if (CONSTRAINTS.eq.includes(ty)) return true;
  return idx !== null && (idx.enums.has(ty) || (idx.structs.has(ty) && plainStruct(ty, idx)));
}

/** Built-in handle types (section 3.1). */
export const HANDLE_TYPES = new Set(["std.Signal"]);

/** Whether a value of type `src` may flow into a pin of type `dst` (section 3.1). */
export function assignable(src: string, dst: string, idx: ModuleIndex | null = null): boolean {
  if (src === dst) return true;
  if (idx === null) return false;
  if (idx.interfaces.has(src)) return dst === "anyref";
  if (!idx.classes.has(src)) return false;
  return dst === "anyref" || idx.isSubclass(src, dst) || idx.implements(src, dst);
}

/** typeOk, also accepting a handle type such as std.Signal. */
export function handleOk(ty: string, idx: ModuleIndex | null = null): boolean {
  return HANDLE_TYPES.has(ty) || typeOk(ty, idx);
}

/** A value type this prototype supports. */
export function typeOk(ty: string, idx: ModuleIndex | null = null): boolean {
  let elem = arrayElem(ty);
  if (elem !== null) return typeOk(elem, idx);
  const kv = mapTypes(ty);
  if (kv !== null) return keyTypeOk(kv[0], idx) && typeOk(kv[1], idx);
  elem = setElem(ty);
  if (elem !== null) return keyTypeOk(elem, idx);
  const sig = delegateSig(ty);
  if (sig !== null) return [...sig[0], ...sig[1]].every((t) => typeOk(t, idx) || HANDLE_TYPES.has(t));
  return PRIM_TYPES.includes(ty) || ty in LANE_FIELDS || (idx !== null && idx.userType(ty) !== null);
}

/** [member name, value] in declaration order. */
export function enumValues(en: Enum): [string, bigint][] {
  const out: [string, bigint][] = [];
  let nxt = 0n;
  for (const m of en.members) {
    const v = m.value !== null ? m.value : nxt;
    out.push([m.name, v]);
    nxt = v + 1n;
  }
  return out;
}

/** Replace type parameter names in a type (generic macros). */
export function substitute(ty: string, subst: Map<string, string>): string {
  if (!subst.size) return ty;
  return ty.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (m) => subst.get(m) ?? m);
}

export const REGISTRY_NAME = "wiret.core";
export const REGISTRY_VERSION = "0.1-proto";

export function zeroLit(ty: string): Lit {
  if (ty in LANE_DEFAULTS) return laneLit(LANE_DEFAULTS[ty]);
  if (isContainer(ty)) return new Lit("null", null);
  if (ty === "bool") return new Lit("bool", false);
  if (FLOAT_TYPES.includes(ty)) return new Lit("float", 0.0);
  if (ty === "string") return new Lit("string", "");
  return new Lit("int", 0n);
}

/** Whether a literal can be written for a value of type `ty`. */
export function litFits(lit: Lit, ty: string, idx: ModuleIndex | null = null): boolean {
  if (lit.kind === "null" && (ty === "anyref" || ty === "std.Signal" || delegateSig(ty) !== null ||
      (idx !== null && (idx.classes.has(ty) || idx.interfaces.has(ty))))) return true;
  if (lit.kind === "enum") return rsplit1(lit.value)[0] === ty;
  if (ty in LANE_FIELDS) return laneLitFits(lit, ty);
  if (INT_TYPES.includes(ty)) return lit.kind === "int";
  if (FLOAT_TYPES.includes(ty)) return lit.kind === "int" || lit.kind === "float";
  if (ty === "bool") return lit.kind === "bool";
  if (ty === "string") return lit.kind === "string";
  return isContainer(ty) && lit.kind === "null";
}

function rsplit1(s: string): [string, string] {
  const i = s.lastIndexOf(".");
  return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i + 1)];
}

/** For an integer type, whether the literal's value fits; any other type passes. */
export function litInRange(lit: Lit, ty: string): boolean {
  if (!(ty in INT_RANGES) || lit.kind !== "int") return true;
  const [lo, hi] = INT_RANGES[ty];
  return lo <= lit.value && lit.value <= hi;
}

function numEq(a: any, b: any): boolean {
  if (typeof a === "bigint" && typeof b === "bigint") return a === b;
  return Number(a) === Number(b);
}

export function litEqual(a: Lit, b: Lit): boolean {
  if ((a.kind === "int" || a.kind === "float") && (b.kind === "int" || b.kind === "float"))
    return numEq(a.value, b.value) && a.suffix === b.suffix;
  return a.kind === b.kind && a.value === b.value;
}

export function canConvert(src: string, dst: string, idx: ModuleIndex | null = null): boolean {
  if (src === dst) return false;
  if (idx !== null && (idx.enums.has(src) || idx.enums.has(dst)))
    return idx.enumBase(src) === dst || idx.enumBase(dst) === src;
  if (dst === "string") return (PRIM_TYPES.includes(src) || src in LANE_FIELDS) && src !== "string";
  if (src in LANE_FIELDS || dst in LANE_FIELDS)
    return (src === "vec2" && dst === "vec3") || (src === "vec3" && dst === "vec2");
  if (src === "bool" || dst === "bool") return INT_TYPES.includes(dst === "bool" ? src : dst);
  return NUM_TYPES.includes(src) && NUM_TYPES.includes(dst);
}

export type PinDefault = null | typeof ZERO | Lit;

export class Pin {
  constructor(public name: string, public type: string, public default_: PinDefault = null) {}

  get is_exec(): boolean { return this.type === "exec"; }

  defaultLit(): Lit | null {
    if (this.default_ === ZERO) return zeroLit(this.type);
    return this.default_ as Lit | null;
  }
}

export class Sig {
  inputs: Pin[] = [];
  outputs: Pin[] = [];
  purity = "impure";
  error: [string, string] | null = null;
  category = "Other";

  constructor(opts: { purity?: string; category?: string } = {}) {
    if (opts.purity) this.purity = opts.purity;
    if (opts.category) this.category = opts.category;
  }

  input(name: string | null): Pin | null { return this.inputs.find((p) => p.name === name) ?? null; }
  output(name: string | null): Pin | null { return this.outputs.find((p) => p.name === name) ?? null; }
  get exec_ins(): Pin[] { return this.inputs.filter((p) => p.is_exec); }
  get exec_outs(): Pin[] { return this.outputs.filter((p) => p.is_exec); }
  get data_ins(): Pin[] { return this.inputs.filter((p) => !p.is_exec); }
  get data_outs(): Pin[] { return this.outputs.filter((p) => !p.is_exec); }
  get pure(): boolean { return this.purity === "pure" || this.purity === "reads"; }
}

type PinSpec = [string, "in" | "out", string, PinDefault];
const _BIN: PinSpec[] = [["a", "in", "T", null], ["b", "in", "T", null], ["result", "out", "T", null]];
const _CMP: PinSpec[] = [["a", "in", "T", null], ["b", "in", "T", null], ["result", "out", "bool", null]];
const _UN: PinSpec[] = [["value", "in", "T", null], ["result", "out", "T", null]];
const _LOGIC: PinSpec[] = [["a", "in", "bool", null], ["b", "in", "bool", null], ["result", "out", "bool", null]];

/** kind -> [category, purity, type param constraints, pins] */
export const STATIC_KINDS: Record<string, [string, string, string[], PinSpec[]]> = {
  Branch: ["Flow", "impure", [], [["in", "in", "exec", null], ["cond", "in", "bool", ZERO],
                                 ["then", "out", "exec", null], ["else", "out", "exec", null]]],
  Select: ["Flow", "pure", ["any"], [["cond", "in", "bool", ZERO], ["a", "in", "T", null],
                                     ["b", "in", "T", null], ["result", "out", "T", null]]],
  Convert: ["Math", "pure", ["convertible", "convertible"], [["value", "in", "T0", null], ["result", "out", "T1", null]]],
  Not: ["Logic", "pure", [], [["value", "in", "bool", null], ["result", "out", "bool", null]]],
  Try: ["Flow", "impure", [], [["in", "in", "exec", null], ["body", "out", "exec", null],
                               ["fault", "out", "exec", null], ["then", "out", "exec", null],
                               ["message", "out", "string", null], ["code", "out", "i32", null]]],
  Throw: ["Flow", "impure", [], [["in", "in", "exec", null], ["message", "in", "string", null],
                                 ["code", "in", "i32", ZERO]]],
  Delay: ["Time", "impure", [], [["in", "in", "exec", null], ["seconds", "in", "f64", null],
                                 ["then", "out", "exec", null]]],
  Yield: ["Time", "impure", [], [["in", "in", "exec", null], ["then", "out", "exec", null]]],
  Await: ["Time", "impure", [], [["in", "in", "exec", null], ["signal", "in", "std.Signal", null],
                                 ["then", "out", "exec", null]]],
  BitNot: ["Bits", "pure", ["int"], _UN],
};
for (const k of ["Add", "Sub", "Div", "Min", "Max"]) STATIC_KINDS[k] = ["Math", "pure", ["arith"], _BIN];
STATIC_KINDS.Mul = ["Math", "pure", ["mul"], _BIN];
STATIC_KINDS.Rem = ["Math", "pure", ["number"], _BIN];
for (const k of ["Neg", "Abs"]) STATIC_KINDS[k] = ["Math", "pure", ["neg"], _UN];
STATIC_KINDS.Scale = ["Math", "pure", ["vector"], [["v", "in", "T", null], ["s", "in", "f32", null], ["result", "out", "T", null]]];
for (const k of ["Eq", "Ne"]) STATIC_KINDS[k] = ["Compare", "pure", ["eq"], _CMP];
for (const k of ["Lt", "Le", "Gt", "Ge"]) STATIC_KINDS[k] = ["Compare", "pure", ["ord"], _CMP];
for (const k of ["And", "Or", "Xor"]) STATIC_KINDS[k] = ["Logic", "pure", [], _LOGIC];
for (const k of ["BitAnd", "BitOr", "BitXor", "Shl", "Shr"]) STATIC_KINDS[k] = ["Bits", "pure", ["int"], _BIN];

/** Kinds handled by `signature` directly. */
export const CONTEXT_KINDS: Record<string, string> = {
  Entry: "Flow", Return: "Flow", Sequence: "Flow", Switch: "Flow", Reroute: "Flow",
  Macro: "Macro", Exit: "Macro", Leave: "Macro", Call: "Call", CallParent: "Call",
  MakeArray: "Arrays", ArrayGet: "Arrays", ArrayLength: "Arrays", ArraySet: "Arrays",
  ArrayAdd: "Arrays", ArrayInsert: "Arrays", ArrayRemove: "Arrays", ArrayClear: "Arrays",
  GetLocal: "Variables", SetLocal: "Variables", GetVar: "Variables",
  SetVar: "Variables", GetState: "Variables", SetState: "Variables",
  MakeStruct: "Structs", BreakStruct: "Structs", GetField: "Structs", WithField: "Structs",
  MapFind: "Maps", MapHas: "Maps", MapLength: "Maps", MapKeyAt: "Maps",
  MapValueAt: "Maps", MapSet: "Maps", MapRemove: "Maps", MapClear: "Maps",
  SetHas: "Sets", SetLength: "Sets", SetAt: "Sets", SetAdd: "Sets",
  SetRemove: "Sets", SetClear: "Sets",
  Format: "Text",
};

export const STRUCT_KINDS: Record<string, string> = { MakeStruct: "struct", BreakStruct: "struct", GetField: "field", WithField: "field" };

export const LATER_TIER_KINDS = new Set<string>();

export const DELEGATE_KINDS = new Set(["CreateDelegate", "Invoke", "Bind", "Unbind", "Broadcast"]);

export const ALL_KINDS = sortedBy(new Set([...Object.keys(STATIC_KINDS), ...Object.keys(CONTEXT_KINDS)]));

export const ARRAY_MUTATORS: Record<string, [string, string][]> = {
  ArraySet: [["index", "i32"], ["item", "T"]],
  ArrayAdd: [["item", "T"]],
  ArrayInsert: [["index", "i32"], ["item", "T"]],
  ArrayRemove: [["index", "i32"]],
  ArrayClear: [],
};

type ContSpec = [[string, string][], [string, string][]];
export const MAP_PURE: Record<string, ContSpec> = {
  MapFind: [[["key", "K"]], [["value", "V"], ["found", "bool"]]],
  MapHas: [[["key", "K"]], [["result", "bool"]]],
  MapLength: [[], [["length", "i32"]]],
  MapKeyAt: [[["index", "i32"]], [["key", "K"]]],
  MapValueAt: [[["index", "i32"]], [["value", "V"]]],
};
export const MAP_MUTATORS: Record<string, ContSpec> = {
  MapSet: [[["key", "K"], ["value", "V"]], []],
  MapRemove: [[["key", "K"]], [["removed", "bool"]]],
  MapClear: [[], []],
};
export const SET_PURE: Record<string, ContSpec> = {
  SetHas: [[["item", "T"]], [["result", "bool"]]],
  SetLength: [[], [["length", "i32"]]],
  SetAt: [[["index", "i32"]], [["item", "T"]]],
};
export const SET_MUTATORS: Record<string, ContSpec> = {
  SetAdd: [[["item", "T"]], [["added", "bool"]]],
  SetRemove: [[["item", "T"]], [["removed", "bool"]]],
  SetClear: [[], []],
};

export const PLACE_MUTATORS = new Set([...Object.keys(ARRAY_MUTATORS), ...Object.keys(MAP_MUTATORS), ...Object.keys(SET_MUTATORS)]);

export class Callee {
  constructor(public name: string, public kind: string, public params: Pin[], public results: Pin[],
              public purity: string, public latent = false, public method_of: string | null = null,
              public final = false) {}
}

let _STD_FLOW: Map<string, Graph> | null = null;

/** The `std.flow` macros (section 3.4), written in Wiret and shipped as source. */
export function stdFlowMacros(): Map<string, Graph> {
  if (_STD_FLOW === null) {
    _STD_FLOW = new Map(parse(CONTENT["std/flow.wiret"]).graphs(["macro"]).map((g) => [g.name, g]));
  }
  return _STD_FLOW;
}

export const STD_FLOW_SOURCE = (): string => CONTENT["std/flow.wiret"];

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** Name lookup over one module, shared by the checker, printer and compiler. */
export class ModuleIndex {
  graphs: Map<string, Graph>;
  macros: Map<string, Graph>;
  externs: Map<string, Extern>;
  vars: Map<string, Var>;
  consts: Map<string, Const>;
  structs: Map<string, Struct>;
  enums: Map<string, Enum>;
  classes: Map<string, Class>;
  interfaces: Map<string, Interface>;
  private _instances = new Map<string, Graph>();

  constructor(public module: Module) {
    this.graphs = new Map(module.graphs(["func", "event"]).map((g) => [g.name, g]));
    this.macros = new Map(module.graphs(["macro"]).map((g) => [g.name, g]));
    if (module.name !== "std.flow")
      for (const [name, g] of stdFlowMacros()) if (!this.macros.has(`std.flow.${name}`)) this.macros.set(`std.flow.${name}`, g);
    const items = module.items;
    this.externs = new Map(items.filter((i): i is Extern => i instanceof Extern && i.kind === "func").map((i) => [i.name, i]));
    this.vars = new Map(items.filter((i): i is Var => i instanceof Var).map((i) => [i.name, i]));
    this.consts = new Map(items.filter((i): i is Const => i instanceof Const).map((i) => [i.name, i]));
    this.structs = new Map(items.filter((i): i is Struct => i instanceof Struct).map((i) => [i.name, i]));
    for (const name of LANE_TYPES) if (!this.structs.has(name)) this.structs.set(name, laneStruct(name));
    this.enums = new Map(items.filter((i): i is Enum => i instanceof Enum).map((i) => [i.name, i]));
    this.classes = new Map(items.filter((i): i is Class => i instanceof Class).map((i) => [i.name, i]));
    this.interfaces = new Map(items.filter((i): i is Interface => i instanceof Interface).map((i) => [i.name, i]));
  }

  // -- classes (section 2.2) ---------------------------------------------------------
  /** The class and its bases, nearest first. Stops at a cycle or an unknown base. */
  classChain(name: string | null): string[] {
    const out: string[] = [];
    while (name !== null && this.classes.has(name) && !out.includes(name)) {
      out.push(name);
      name = this.classes.get(name)!.base;
    }
    return out;
  }

  isSubclass(sub: string, sup: string): boolean {
    return this.classChain(sub).includes(sup);
  }

  /** [declaring class, Field] for every field, inherited ones first: the object layout. */
  classFields(name: string): [string, Field][] {
    const out: [string, Field][] = [];
    for (const c of [...this.classChain(name)].reverse()) for (const f of this.classes.get(c)!.fields) out.push([c, f]);
    return out;
  }

  /** [declaring class, Field] of a field of `name` or one of its bases, or null. */
  classField(name: string, fname: string): [string, Field] | null {
    for (const c of this.classChain(name)) {
      const f = this.classes.get(c)!.field(fname);
      if (f !== null) return [c, f];
    }
    return null;
  }

  /** The method `short` as seen from `cls`: its own, else the nearest base's. */
  findMethod(cls: string, short: string): Graph | null {
    for (const c of this.classChain(cls)) {
      const g = this.graphs.get(`${c}.${short}`);
      if (g !== undefined) return g;
    }
    return null;
  }

  /** [declaring class, Dispatcher] of `name` on `cls` or one of its bases, or null. */
  classDispatcher(cls: string, name: string): [string, Dispatcher] | null {
    for (const c of this.classChain(cls)) {
      const d = this.classes.get(c)!.dispatchers.find((x) => x.name === name);
      if (d !== undefined) return [c, d];
    }
    return null;
  }

  /** [member name, type] of every slot of an object, inherited ones first (section 5.3). */
  classLayout(name: string): [string, string][] {
    const out: [string, string][] = [];
    for (const c of [...this.classChain(name)].reverse()) {
      const cl = this.classes.get(c)!;
      for (const f of cl.fields) out.push([f.name, f.type]);
      for (const d of cl.dispatchers) out.push([d.name, dispatcherType(d.params.map((p) => p.type))]);
      for (const [slot, ty] of this.classState(c)) out.push([slot, ty]);
    }
    return out;
  }

  /** [slot name, type, default] for the `state` of a class's own methods (section 2.3). */
  classState(cls: string): [string, string, Lit | null][] {
    const out: [string, string, Lit | null][] = [];
    for (const g of this.methods(cls)) {
      for (const [path, s] of this.graphStates(g)) {
        const where = path ? `${g.short_name}/${path}` : g.short_name;
        out.push([`${where}.${s.name}`, s.type, s.default_]);
      }
    }
    return out;
  }

  /** [macro path, Local] for the state slots a graph needs, as macro expansion visits them. */
  graphStates(g: Graph, path = "", depth = 0): [string, import("./model.js").Local][] {
    let out: [string, import("./model.js").Local][] = sortedBy(g.states, (s) => s.name).map((s) => [path, s]);
    if (depth > 32) return out;
    for (const n of sortedBy(g.nodes, (n) => n.id)) {
      if (n.kind === "Macro") {
        const mg = this.macro(n.symbol, n.targs);
        if (mg !== null) out = out.concat(this.graphStates(mg, path ? `${path}${n.id}/` : `${n.id}/`, depth + 1));
      }
    }
    return out.map(([p, s]) => [p.replace(/\/+$/, ""), s]);
  }

  /** Every interface a class implements, its bases' first, in declaration order. */
  classInterfaces(cls: string): string[] {
    const out: string[] = [];
    for (const c of [...this.classChain(cls)].reverse())
      for (const i of this.classes.get(c)!.impls) if (this.interfaces.has(i) && !out.includes(i)) out.push(i);
    return out;
  }

  implements(cls: string, iface: string): boolean {
    return this.classInterfaces(cls).includes(iface);
  }

  methods(cls: string): Graph[] {
    return sortedBy([...this.graphs.values()].filter((g) => g.owner === cls), (g) => g.name);
  }

  /** The struct, enum, class or interface a type name refers to. */
  userType(ty: string): Struct | Enum | Class | Interface | null {
    return this.structs.get(ty) ?? this.enums.get(ty) ?? this.classes.get(ty) ?? this.interfaces.get(ty) ?? null;
  }

  /** The underlying integer type of an enum type (default `i32`), else null. */
  enumBase(ty: string): string | null {
    const en = this.enums.get(ty);
    return en !== undefined ? en.base ?? "i32" : null;
  }

  /** A macro, instantiated for its type arguments if it is generic. */
  macro(symbol: string | null, targs: string[]): Graph | null {
    const m = this.macros.get(symbol ?? "") ?? null;
    if (m === null || !m.tparams.length) return m;
    const k = key(symbol, targs);
    if (!this._instances.has(k)) this._instances.set(k, instantiate(m, targs));
    return this._instances.get(k)!;
  }

  private _strip(symbol: string): string {
    const prefix = this.module.name + ".";
    return symbol.startsWith(prefix) ? symbol.slice(prefix.length) : symbol;
  }

  callee(symbol: string, targs: string[] = []): Callee | null {
    if (targs.length) {
      const k = `${symbol}#<${targs.join(", ")}>`;
      if (!has(stdNatives(), k)) return null;
      const n = stdNatives()[k];
      return new Callee(k, "native", n.params.map(([a, t]) => new Pin(a, t)), n.results.map(([a, t]) => new Pin(a, t)), n.purity);
    }
    const s = this._strip(symbol);
    const dot = s.lastIndexOf(".");
    const cls = dot < 0 ? "" : s.slice(0, dot), short = dot < 0 ? s : s.slice(dot + 1);
    if (this.interfaces.has(cls)) {
      const m = this.interfaces.get(cls)!.method(short);
      if (m === null) return null;
      return new Callee(s, "interface",
        [new Pin("self", cls), ...m.params.map((p) => new Pin(p.name, p.type, p.default_))],
        m.result_list.map((r) => new Pin(r.name, r.type)), "impure", m.hasAttr("latent"), cls);
    }
    let g = this.graphs.get(s) ?? null;
    if (g === null && this.classes.has(cls)) g = this.findMethod(cls, short);
    if (g !== null) {
      const purity = g.hasAttr("pure") ? "pure" : g.hasAttr("reads") ? "reads" : "impure";
      let params = g.params.map((p) => new Pin(p.name, p.type, p.default_));
      if (g.receiver) params = [new Pin("self", cls), ...params];
      return new Callee(g.name, g.kind, params, g.result_list.map((r) => new Pin(r.name, r.type)),
        purity, g.kind === "event" || g.hasAttr("latent"), g.receiver ? cls : null, g.hasAttr("final"));
    }
    if (this.externs.has(symbol)) {
      const e = this.externs.get(symbol)!;
      const purity = e.hasAttr("pure") ? "pure" : e.hasAttr("reads") ? "reads" : "impure";
      return new Callee(symbol, "extern", e.params.map((p) => new Pin(p.name, p.type, p.default_)),
        (e.results ?? []).map((r) => new Pin(r.name, r.type)), purity);
    }
    if (has(stdNatives(), symbol)) {
      const n = stdNatives()[symbol];
      return new Callee(symbol, "native", n.params.map(([a, t]) => new Pin(a, t)), n.results.map(([a, t]) => new Pin(a, t)), n.purity);
    }
    return null;
  }

  varType(name: string): string | null {
    if (this.vars.has(name)) return this.vars.get(name)!.type;
    if (this.consts.has(name)) return this.consts.get(name)!.type;
    return null;
  }
}

export function typeKnown(ty: string): boolean {
  return typeOk(ty);
}

/** A copy of a generic macro with its type parameters replaced by `targs`. */
export function instantiate(m: Graph, targs: string[]): Graph {
  const subst = new Map<string, string>();
  m.tparams.forEach((t, i) => { if (i < targs.length) subst.set(t, targs[i]); });
  const g = deepcopy(m);
  g.tparams = [];
  for (const items of [g.params, g.result_list, g.locals, g.states])
    for (const p of items) p.type = substitute(p.type, subst);
  for (const n of g.nodes) n.targs = n.targs.map((t) => substitute(t, subst));
  return g;
}

function _staticSig(node: Node, idx: ModuleIndex | null = null): Sig {
  const [cat, purity, tps, pins] = STATIC_KINDS[node.kind];
  const sig = new Sig({ purity, category: cat });
  let targs = [...node.targs];
  if (targs.length !== tps.length) {
    sig.error = ["E0502", `${node.kind} needs ${tps.length} type argument(s), got ${targs.length}`];
    targs = [...targs, ...tps.map(() => "i32")].slice(0, tps.length);
  } else {
    targs.forEach((t, i) => {
      if (!allows(tps[i], t, idx)) sig.error = ["E0110", `${node.kind} does not accept type ${t}`];
    });
  }
  if (node.kind === "Convert" && !sig.error && !canConvert(targs[0], targs[1], idx) && targs[0] !== targs[1])
    sig.error = ["E0110", `no conversion from ${targs[0]} to ${targs[1]}`];
  const subst: Record<string, string> = { T: targs.length ? targs[0] : "i32" };
  targs.forEach((t, i) => { subst[`T${i}`] = t; });
  for (const [name, d, ty, def] of pins) {
    const pin = new Pin(name, subst[ty] ?? ty, def);
    (d === "in" ? sig.inputs : sig.outputs).push(pin);
  }
  return sig;
}

/** kind -> [named generic, pins' name, side, count without it, fewest]. */
export const COUNTED_PINS: Record<string, [string, string, string, number, number]> = {
  Sequence: ["count", "then", "out", 2, 1],
  Switch: ["cases", "case", "out", 0, 0],
  MakeArray: ["count", "item", "in", 2, 0],
};
export const COUNTED_OUTPUTS = Object.fromEntries(Object.entries(COUNTED_PINS).filter(([, v]) => v[2] === "out"));
const _INDEXED = /^([A-Za-z_]\w*)\[(\d+)\]$/;

/** The name of the `i`th of a node's variable pins, `case[0]`. */
export function indexedName(base: string, i: number | bigint): string {
  return `${base}[${i}]`;
}

/** [base, index] for an indexed pin name, `case[2]` -> ["case", 2], or null. */
export function pinIndex(name: string | null): [string, number] | null {
  const m = _INDEXED.exec(name ?? "");
  return m ? [m[1], parseInt(m[2], 10)] : null;
}

/** Which side a node's variable pins are on, "in" or "out", or null if it has none. */
export function countedSide(n: Node): string | null {
  const spec = COUNTED_PINS[n.kind];
  return spec ? spec[2] : null;
}

/** How many indexed pins a Sequence, Switch or MakeArray has, or null. */
export function pinCount(n: Node): number | null {
  const spec = COUNTED_PINS[n.kind];
  if (!spec) return null;
  const a = n.attr(spec[0]);
  if (a === null || !a.args || !a.args.length) return spec[3];
  const v = a.args[0][1];
  return a.args.length === 1 && v.kind === "int" ? Number(v.value) : null;
}

/** Whether pin `pin` on side `d` is one of a node's indexed pins that the editor can remove. */
export function removablePin(n: Node | null, pin: string, d: string): boolean {
  const count = n !== null ? pinCount(n) : null;
  if (count === null) return false;
  const [, base, side, , least] = COUNTED_PINS[n!.kind];
  const ix = pinIndex(pin);
  return d === side && ix !== null && ix[0] === base && ix[1] < count && count > least;
}

/** The exec outputs that take a value, in pin order (section 2.3). */
export function outputValues(sig: Sig): string[] {
  const out: string[] = [];
  for (const p of sig.exec_outs) {
    const q = sig.input(p.name);
    if (q !== null && !q.is_exec) out.push(p.name);
  }
  return out;
}

/** The exec output that the canvas can flatten (section 2.5), or null. */
export function flattenablePin(node: Node | null, sig: Sig | null): string | null {
  if (sig === null || node === null || sig.exec_outs.length < 2 || node.kind === "Entry") return null;
  const last = sig.exec_outs[sig.exec_outs.length - 1];
  if (pinIndex(last.name) || outputValues(sig).includes(last.name)) return null;
  if (node.kind === "Try") return last.name;
  if (sig.outputs.some((p) => !p.is_exec) && node.kind !== "Macro") return null;
  return last.name;
}

/** Whether a node is written flattened at its flattenable output (`}.else`). */
export function isFlat(node: Node, sig: Sig | null): boolean {
  const pin = flattenablePin(node, sig);
  if (pin === null) return false;
  if (node.flat === null) return node.kind === "Try";
  return node.flat && (node.flat_pin === null || node.flat_pin === pin);
}

export function attrInt(node: Node, name: string, def: number): number {
  const a = node.attr(name);
  if (a && a.args && a.args.length && a.args[0][1].kind === "int") return Number(a.args[0][1].value);
  return def;
}

const range = (n: number) => Array.from({ length: Math.max(0, n) }, (_, i) => i);

export function signature(node: Node, graph: Graph, idx: ModuleIndex): Sig {
  const k = node.kind;
  if (has(STATIC_KINDS, k)) return _staticSig(node, idx);
  const E = "exec";
  const sig = new Sig({ category: CONTEXT_KINDS[k] ?? "Other" });
  const isMacro = graph.kind === "macro";

  if (k === "Entry") {
    if (isMacro) sig.outputs = graph.params.map((p) => new Pin(p.name, p.type));
    else {
      sig.outputs = [new Pin("then", E), ...graph.params.map((p) => new Pin(p.name, p.type))];
      if (graph.receiver) sig.outputs.splice(1, 0, new Pin("self", graph.receiver));
    }
    return sig;
  }
  if (k === "Return") {
    sig.inputs = [new Pin("in", E), ...graph.result_list.map((r) => new Pin(r.name, r.type))];
    if (isMacro) sig.error = ["E0501", "Return is not allowed in a macro; use Exit"];
    return sig;
  }
  if (k === "Sequence") {
    const n = attrInt(node, "count", 2);
    sig.inputs = [new Pin("in", E)];
    sig.outputs = range(n).map((i) => new Pin(indexedName("then", i), E));
    return sig;
  }
  if (k === "Switch") {
    if (node.targs.length !== 1) sig.error = ["E0502", "Switch needs one type argument"];
    const t = node.targs.length ? node.targs[0] : "i32";
    if (!allows("switch", t, idx)) sig.error = ["E0110", `Switch does not accept type ${t}`];
    const a = node.attr("cases");
    let n = attrInt(node, "cases", 0);
    if (a !== null && a.args && a.args.length && !(a.args.length === 1 && a.args[0][1].kind === "int")) {
      sig.error = ["E0502", "#cases takes the number of cases, '#cases<2>'; each case's " +
                            "value follows its output, '.case[0] Mode::Idle -> { ... }'"];
      n = a.args.length;
    } else if (!(0 <= n && n <= 64)) {
      sig.error = ["E0502", "#cases takes a number of cases from 0 to 64"];
      n = Math.max(0, Math.min(n, 64));
    }
    const cases = range(n).map((i) => indexedName("case", i));
    sig.inputs = [new Pin("in", E), new Pin("value", t), ...cases.map((c) => new Pin(c, t))];
    sig.outputs = [...cases.map((c) => new Pin(c, E)), new Pin("default", E)];
    return sig;
  }
  if (k === "Reroute") {
    if (node.targs.length !== 1) sig.error = ["E0502", "Reroute needs one type argument"];
    const t = node.targs.length ? node.targs[0] : "i32";
    sig.purity = t === "exec" ? "impure" : "pure";
    sig.inputs = [new Pin("in", t)];
    sig.outputs = [new Pin("out", t)];
    return sig;
  }
  if (["GetLocal", "SetLocal", "GetState", "SetState", "GetVar", "SetVar"].includes(k)) {
    let ty: string | null;
    if (!node.symbol) {
      sig.error = ["E0501", `${k} needs a symbol`];
      ty = "i32";
    } else if (k.endsWith("Local")) {
      const loc = graph.local(node.symbol);
      ty = loc ? loc.type : null;
      if (!loc) sig.error = ["E0501", `unknown local '${node.symbol}'`];
    } else if (k.endsWith("State")) {
      const st = graph.state(node.symbol);
      ty = st ? st.type : null;
      if (!st) sig.error = ["E0501", `unknown state '${node.symbol}'`];
    } else {
      ty = idx.varType(node.symbol);
      if (ty === null) sig.error = ["E0501", `unknown variable '${node.symbol}'`];
      else if (k === "SetVar" && idx.consts.has(node.symbol)) sig.error = ["E0501", `'${node.symbol}' is a const and cannot be set`];
    }
    ty = ty || "i32";
    if (k.startsWith("Get")) {
      sig.purity = k === "GetLocal" || idx.consts.has(node.symbol ?? "") ? "pure" : "reads";
      sig.outputs = [new Pin("value", ty)];
    } else {
      sig.inputs = [new Pin("in", E), new Pin("value", ty)];
      sig.outputs = [new Pin("then", E)];
    }
    return sig;
  }
  if (k === "Call") {
    const c = idx.callee(node.symbol ?? "", node.targs);
    if (c === null) {
      const generic = Object.keys(stdNatives()).filter((q) => q.startsWith(`${node.symbol}#<`));
      if (generic.length && !node.targs.length)
        sig.error = ["E0502", `'${node.symbol}' needs a type argument, as in 'Call ${generic[0]}'`];
      else if (generic.length)
        sig.error = ["E0110", `'${node.symbol}' does not take ${node.targs.join(", ")}; it takes ` +
                              generic.map((q) => q.slice(node.symbol!.length)).join(", ")];
      else sig.error = ["E0501", `unresolved function '${node.symbol}'`];
      return sig;
    }
    sig.purity = c.purity;
    sig.category = "Call";
    if (c.purity === "impure") {
      sig.inputs = [new Pin("in", E)];
      sig.outputs = [new Pin("then", E)];
    }
    sig.inputs.push(...c.params);
    sig.outputs.push(...c.results);
    return sig;
  }
  if (k === "Macro") {
    const generic = idx.macros.get(node.symbol ?? "") ?? null;
    if (generic === null) {
      sig.error = ["E0501", `unresolved macro '${node.symbol}'`];
      return sig;
    }
    if (node.targs.length !== generic.tparams.length) {
      sig.error = ["E0502", `macro ${node.symbol} needs ${generic.tparams.length} type argument(s), got ${node.targs.length}`];
      return sig;
    }
    const bad = node.targs.filter((t) => !typeOk(t, idx));
    if (bad.length) {
      sig.error = ["E0501", `type '${bad[0]}' is not supported by this prototype`];
      return sig;
    }
    const m = idx.macro(node.symbol, node.targs)!;
    sig.inputs = m.params.map((p) => new Pin(p.name, p.type, p.default_));
    sig.outputs = m.result_list.map((r) => new Pin(r.name, r.type));
    return sig;
  }
  if (k === "Exit" || k === "Leave") {
    if (!isMacro) {
      sig.error = ["E0501", `${k} is only allowed in a macro`];
      return sig;
    }
    const r = graph.result_list.find((x) => x.name === (node.symbol ?? "")) ?? null;
    if (r === null || r.type !== "exec") sig.error = ["E0501", `'${node.symbol}' is not an exec output of macro ${graph.name}`];
    sig.inputs = [new Pin("in", E), ...graph.result_list.filter((x) => x.type !== "exec").map((x) => new Pin(x.name, x.type, ZERO))];
    return sig;
  }
  if (k === "MakeArray" || k === "ArrayGet" || k === "ArrayLength" || has(ARRAY_MUTATORS, k)) return _arraySig(node, graph, idx, sig);
  if (DELEGATE_KINDS.has(k)) return _delegateSig(node, graph, idx, sig);
  if (k === "CallParent") return _callParentSig(node, graph, idx, sig);
  if (CLASS_KINDS.has(k) || ((k === "GetField" || k === "SetField") && classFieldTarget(node, graph, idx)))
    return _classSig(node, graph, idx, sig);
  if (has(STRUCT_KINDS, k)) return _structSig(node, idx, sig);
  if (has(MAP_PURE, k) || has(MAP_MUTATORS, k) || has(SET_PURE, k) || has(SET_MUTATORS, k)) return _containerSig(node, graph, idx, sig);
  if (k === "Format") return _formatSig(node, graph, idx, sig);
  if (k === "SetField" && idx.structs.has((node.symbol ?? "").split(".")[0])) {
    sig.error = ["E0501", `structs are immutable, so SetField cannot change one; use 'WithField ${node.symbol}', which makes a changed copy`];
    return sig;
  }
  if (LATER_TIER_KINDS.has(k)) sig.error = ["E0501", `node kind '${k}' belongs to a later tier and is not in this prototype`];
  else sig.error = ["E0501", `unknown node kind '${k}'`];
  return sig;
}

export const CLASS_KINDS = new Set(["New", "Cast", "IsValid"]);

const _IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type FormatPart = ["text" | "pin", string];

export class FormatError extends Error {}

/** A Format template (section 3.3) as [["text", s] | ["pin", name]]. Throws FormatError for
 * a malformed template. */
export function formatParts(template: string): FormatPart[] {
  const parts: FormatPart[] = [];
  let buf = "", i = 0;
  const t = template;
  while (i < t.length) {
    const c = t[i];
    if (t.startsWith("{{", i) || t.startsWith("}}", i)) {
      buf += c;
      i += 2;
    } else if (c === "{") {
      const j = t.indexOf("}", i);
      const name = j >= 0 ? t.slice(i + 1, j) : "";
      if (j < 0 || !_IDENT.test(name))
        throw new FormatError(`a Format template names an input between braces, as in ` +
          `'{total}', and writes a brace as '{{' or '}}'; '${j >= 0 ? t.slice(i, j + 1) : t.slice(i)}' is neither`);
      if (buf) {
        parts.push(["text", buf]);
        buf = "";
      }
      parts.push(["pin", name]);
      i = j + 1;
    } else if (c === "}") {
      throw new FormatError("a '}' in a Format template closes no '{'; write a brace as '}}'");
    } else {
      buf += c;
      i += 1;
    }
  }
  if (buf) parts.push(["text", buf]);
  return parts;
}

const _FORMAT_BUSY = new Set<string>();
const graphIds = new WeakMap<Graph, number>();
let nextGraphId = 0;
function gid(g: Graph): number {
  let i = graphIds.get(g);
  if (i === undefined) graphIds.set(g, i = nextGraphId++);
  return i;
}

/** A Format input takes the type of what is bound to it. Unbound, it is text. */
function _formatInputType(node: Node, name: string, graph: Graph, idx: ModuleIndex): string {
  const b = node.binding(name);
  if (b === null) return "string";
  const v = b.value;
  if (v instanceof Lit) {
    const m: Record<string, string> = { int: v.suffix || "i32", float: v.suffix || "f64", bool: "bool", string: "string" };
    return m[v.kind] ?? (v.kind === "enum" ? v.value.split(".")[0] : v.kind);
  }
  const src = graph.node(v.node);
  const k = `${gid(graph)}\0${v.node}`;
  if (src === null || _FORMAT_BUSY.has(k)) return "string";
  _FORMAT_BUSY.add(k);
  let p: Pin | null;
  try {
    p = signature(src, graph, idx).output(v.pin);
  } finally {
    _FORMAT_BUSY.delete(k);
  }
  return p !== null && !p.is_exec ? p.type : "string";
}

function _formatSig(node: Node, graph: Graph, idx: ModuleIndex, sig: Sig): Sig {
  sig.purity = "pure";
  sig.outputs = [new Pin("result", "string")];
  if (node.symbol === null) {
    sig.error = ["E0501", 'Format needs a template, as in Format "Total: {total}"(...)'];
    return sig;
  }
  if (node.targs.length) sig.error = ["E0502", "Format takes no type arguments: each input takes the type of what is bound to it"];
  let parts: FormatPart[];
  try {
    parts = formatParts(node.symbol);
  } catch (e) {
    if (!(e instanceof FormatError)) throw e;
    sig.error = ["E0501", e.message];
    return sig;
  }
  const names: string[] = [];
  for (const [kind, v] of parts) if (kind === "pin" && !names.includes(v)) names.push(v);
  for (const name of names) {
    const ty = _formatInputType(node, name, graph, idx);
    if (!PRIM_TYPES.includes(ty) && !(ty in LANE_FIELDS) && !sig.error)
      sig.error = ["E0110", `Format writes bool, number, vector and string values, but '${name}' is ${ty}; convert it first`];
    sig.inputs.push(new Pin(name, ty, node.binding(name) === null ? ZERO : null));
  }
  return sig;
}

/** For GetField and SetField on a class: [class, field name]. */
export function classFieldTarget(node: Node, graph: Graph | null, idx: ModuleIndex): [string, string] | null {
  const sym = node.symbol ?? "";
  const dot = sym.lastIndexOf(".");
  const cls = dot < 0 ? "" : sym.slice(0, dot), fname = dot < 0 ? sym : sym.slice(dot + 1);
  if (cls) return idx.classes.has(cls) ? [cls, fname] : null;
  if (graph !== null && graph.owner) return [graph.owner, sym];
  return null;
}

/** The method CallParent calls: the nearest base class's version of the symbol. */
export function parentMethod(node: Node, graph: Graph | null, idx: ModuleIndex): Graph | null {
  if (graph === null || !graph.owner || !idx.classes.has(graph.owner)) return null;
  const base = idx.classes.get(graph.owner)!.base;
  return base ? idx.findMethod(base, node.symbol || graph.short_name) : null;
}

function _callParentSig(node: Node, graph: Graph, idx: ModuleIndex, sig: Sig): Sig {
  sig.category = "Call";
  const g = parentMethod(node, graph, idx);
  if (g === null) {
    const where = graph !== null && graph.owner ? `'${graph.owner}'s base class` : "a base class";
    sig.error = ["E0501", `CallParent calls ${where}'s version of a method, so it belongs ` +
                          `in a method whose class extends a class that has '${node.symbol}'`];
    sig.inputs = [new Pin("in", "exec")];
    sig.outputs = [new Pin("then", "exec")];
    return sig;
  }
  const c = idx.callee(g.name)!;
  sig.purity = c.purity;
  if (c.purity === "impure") {
    sig.inputs = [new Pin("in", "exec")];
    sig.outputs = [new Pin("then", "exec")];
  }
  sig.inputs.push(...c.params.slice(1));
  sig.outputs.push(...c.results);
  return sig;
}

/** Why a callee cannot be bound into a delegate, or null when it can (section 3.3). */
export function bindable(c: Callee): string | null {
  if (c.kind !== "func" && c.kind !== "event") return `only a function, method or event of this module can be bound, not a ${c.kind}`;
  if (c.latent && c.kind !== "event")
    return "a @latent func cannot be bound, since invoking a delegate never waits; " +
           "make it an event, which a delegate starts on a fiber of its own";
  return null;
}

/** For Bind, Unbind and Broadcast: [class, dispatcher name]. */
export function dispatcherTarget(node: Node, graph: Graph | null, _idx: ModuleIndex): [string | null, string] {
  const sym = node.symbol ?? "";
  const dot = sym.lastIndexOf(".");
  if (dot >= 0) return [sym.slice(0, dot), sym.slice(dot + 1)];
  return graph !== null && graph.owner ? [graph.owner, sym] : [null, sym];
}

function _delegateSig(node: Node, graph: Graph, idx: ModuleIndex, sig: Sig): Sig {
  const k = node.kind;
  const E = "exec";
  sig.category = "Delegates";
  if (k === "CreateDelegate") {
    sig.purity = "pure";
    const c = idx.callee(node.symbol ?? "");
    if (c === null) {
      sig.error = ["E0501", `unresolved function '${node.symbol}'`];
      sig.outputs = [new Pin("result", "delegate#<()>")];
      return sig;
    }
    const why = bindable(c);
    if (why) sig.error = ["E0501", `cannot make a delegate of '${node.symbol}': ${why}`];
    const params = c.method_of ? c.params.slice(1) : c.params;
    if (c.method_of) sig.inputs = [new Pin("target", c.method_of)];
    sig.outputs = [new Pin("result", delegateType(params.map((p) => p.type), c.results.map((r) => r.type)))];
    return sig;
  }
  if (k === "Invoke") {
    let d: string | null = node.targs.length === 1 ? node.targs[0] : null;
    let ds = d ? delegateSig(d) : null;
    if (ds === null) {
      sig.error = ["E0502", "Invoke needs the delegate type, as in 'Invoke#<delegate#<(i32) -> (bool)>>'"];
      ds = [[], []];
      d = "delegate#<()>";
    }
    sig.inputs = [new Pin("in", E), new Pin("delegate", d!), ...ds[0].map((t, i) => new Pin(`arg${i}`, t))];
    sig.outputs = [new Pin("then", E), ...ds[1].map((t, i) => new Pin(`result${i}`, t))];
    return sig;
  }
  const [cls, name] = dispatcherTarget(node, graph, idx);
  const found = cls !== null && idx.classes.has(cls) ? idx.classDispatcher(cls, name) : null;
  let params: import("./model.js").Param[];
  if (found === null) {
    sig.error = ["E0501", cls !== null && idx.classes.has(cls) ? `class '${cls}' has no dispatcher '${name}'`
                                                               : `${k} names a dispatcher, as in '${k} Player.OnDied'`];
    params = [];
  } else params = found[1].params;
  sig.inputs = [new Pin("in", E), new Pin("obj", cls || "anyref")];
  if (k === "Broadcast") sig.inputs.push(...params.map((p) => new Pin(p.name, p.type, p.default_)));
  else sig.inputs.push(new Pin("handler", delegateType(params.map((p) => p.type), [])));
  sig.outputs = [new Pin("then", E)];
  return sig;
}

function _classSig(node: Node, graph: Graph, idx: ModuleIndex, sig: Sig): Sig {
  const k = node.kind;
  const E = "exec";
  sig.category = "Classes";
  if (k === "New") {
    if (!idx.classes.has(node.symbol ?? ""))
      sig.error = ["E0501", `New names the class to make, as in 'New Player'; '${node.symbol}' is not a class of this module`];
    sig.inputs = [new Pin("in", E)];
    sig.outputs = [new Pin("then", E), new Pin("result", node.symbol || "anyref")];
    return sig;
  }
  if (k === "Cast") {
    sig.purity = "pure";
    let target = node.symbol;
    const known = target !== null && (idx.classes.has(target) || idx.interfaces.has(target));
    if (!known || node.targs.length) {
      sig.error = ["E0501", "Cast names the class or interface to cast to, as in 'Cast Boss'"];
      target = known ? target : null;
    }
    sig.inputs = [new Pin("obj", "anyref")];
    sig.outputs = [new Pin("result", target || "anyref"), new Pin("ok", "bool")];
    return sig;
  }
  if (k === "IsValid") {
    sig.purity = "pure";
    sig.inputs = [new Pin("obj", "anyref")];
    sig.outputs = [new Pin("result", "bool")];
    return sig;
  }
  const [cls, fname] = classFieldTarget(node, graph, idx)!;
  const found = idx.classes.has(cls) ? idx.classField(cls, fname) : null;
  let ty: string;
  if (found === null) {
    sig.error = ["E0501", idx.classes.has(cls) ? `class '${cls}' has no field '${fname}'` : `unknown class '${cls}'`];
    ty = "i32";
  } else ty = found[1].type;
  if (k === "GetField") {
    sig.purity = "reads";
    sig.inputs = [new Pin("obj", cls)];
    sig.outputs = [new Pin("value", ty)];
  } else {
    sig.inputs = [new Pin("in", E), new Pin("obj", cls), new Pin("value", ty)];
    sig.outputs = [new Pin("then", E)];
  }
  return sig;
}

function _structSig(node: Node, idx: ModuleIndex, sig: Sig): Sig {
  const k = node.kind;
  sig.purity = "pure";
  const sym = node.symbol ?? "";
  let name: string, fname: string | null;
  if (STRUCT_KINDS[k] === "field") {
    const i = sym.indexOf(".");
    name = i < 0 ? sym : sym.slice(0, i);
    fname = i < 0 ? "" : sym.slice(i + 1);
    if (!fname) {
      sig.error = ["E0501", `${k} names the struct and the field, as in '${k} Vec2.x'`];
      return sig;
    }
  } else {
    name = sym;
    fname = null;
    if (!sym || sym.includes(".")) {
      sig.error = ["E0501", `${k} names the struct it works on, as in '${k} Vec2'`];
      return sig;
    }
  }
  if (node.targs.length) {
    sig.error = ["E0501", `${k} takes no type arguments; the struct's name says the type`];
    return sig;
  }
  const st = idx.structs.get(name);
  if (st === undefined) {
    const what = idx.enums.has(name) ? "that is an enum" : "no struct of this module has that name";
    sig.error = ["E0501", `unknown struct '${name}': ${what}`];
    return sig;
  }
  if (k === "MakeStruct") {
    sig.inputs = st.fields.map((f) => new Pin(f.name, f.type, f.default_ !== null ? f.default_ : ZERO));
    sig.outputs = [new Pin("result", name)];
    return sig;
  }
  if (k === "BreakStruct") {
    sig.inputs = [new Pin("obj", name)];
    sig.outputs = st.fields.map((f) => new Pin(f.name, f.type));
    return sig;
  }
  const f = st.field(fname!);
  if (f === null) {
    sig.error = ["E0501", `struct '${name}' has no field '${fname}'`];
    return sig;
  }
  if (k === "GetField") {
    sig.inputs = [new Pin("obj", name)];
    sig.outputs = [new Pin("value", f.type)];
  } else {
    sig.inputs = [new Pin("obj", name), new Pin("value", f.type)];
    sig.outputs = [new Pin("result", name)];
  }
  return sig;
}

/** A mutator place that is a class field (section 3.3): [class, field name, type], or null. */
export function fieldPlace(place: string | null, graph: Graph | null, idx: ModuleIndex): [string, string, string] | null {
  if (!place) return null;
  const dot = place.lastIndexOf(".");
  let cls = dot < 0 ? "" : place.slice(0, dot);
  const fname = dot < 0 ? place : place.slice(dot + 1);
  if (!cls) {
    if (graph === null || !graph.owner || graph.local(place) || idx.vars.has(place)) return null;
    cls = graph.owner;
  }
  if (!idx.classes.has(cls)) return null;
  const found = idx.classField(cls, fname);
  return found ? [cls, fname, found[1].type] : null;
}

/** The type of a mutator's place: a local of the graph, a module variable, or a field. */
export function placeType(place: string | null, graph: Graph, idx: ModuleIndex): string | null {
  if (!place) return null;
  const loc = graph.local(place);
  if (loc) return loc.type;
  if (idx.vars.has(place)) return idx.vars.get(place)!.type;
  const fp = fieldPlace(place, graph, idx);
  return fp ? fp[2] : null;
}

function _containerSig(node: Node, graph: Graph, idx: ModuleIndex, sig: Sig): Sig {
  const k = node.kind;
  const isMap = k.startsWith("Map");
  const want = isMap ? 2 : 1;
  const example = isMap ? `${k}#<string, i32>` : `${k}#<i32>`;
  if (node.targs.length !== want)
    sig.error = ["E0502", `${k} needs ${isMap ? "the key and value types" : "the item type"}, as in ${example}`];
  const targs = [...node.targs, "i32", "i32"].slice(0, want);
  let container: string, cname: string, subst: Record<string, string>, badKey: string | null, badValue: string | null;
  if (isMap) {
    const [K, V] = targs;
    container = `map#<${K}, ${V}>`;
    cname = "map";
    subst = { K, V };
    badKey = keyTypeOk(K, idx) ? null : K;
    badValue = typeOk(V, idx) ? null : V;
  } else {
    const T = targs[0];
    container = `set#<${T}>`;
    cname = "set";
    subst = { T };
    badKey = keyTypeOk(T, idx) ? null : T;
    badValue = null;
  }
  if (sig.error === null && badKey !== null)
    sig.error = ["E0501", `type '${badKey}' cannot be a ${cname} ${isMap ? "key" : "item"}: keys and set items are primitives, enums or structs of those`];
  else if (sig.error === null && badValue !== null)
    sig.error = ["E0501", `type '${badValue}' is not supported by this prototype`];
  const pure = isMap ? MAP_PURE : SET_PURE;
  const sub = (t: string) => subst[t] ?? t;
  if (has(pure, k)) {
    const [ins, outs] = pure[k];
    sig.purity = "pure";
    sig.inputs = [new Pin(cname, container), ...ins.map(([n, t]) => new Pin(n, sub(t)))];
    sig.outputs = outs.map(([n, t]) => new Pin(n, sub(t)));
    return sig;
  }
  const [ins, outs] = (isMap ? MAP_MUTATORS : SET_MUTATORS)[k];
  const place = node.symbol;
  const ty = placeType(place, graph, idx);
  if (ty === null) sig.error = ["E0130", `${k} must name the local, variable or field it changes, as in ${example} scores`];
  else if (ty !== container && !sig.error) sig.error = ["E0110", `'${place}' is ${ty}, not ${container}`];
  const fp = !graph.local(place ?? "") ? fieldPlace(place, graph, idx) : null;
  sig.inputs = [new Pin("in", "exec"), ...(fp ? [new Pin("obj", fp[0])] : []), ...ins.map(([n, t]) => new Pin(n, sub(t)))];
  sig.outputs = [new Pin("then", "exec"), ...outs.map(([n, t]) => new Pin(n, sub(t)))];
  return sig;
}

function _arraySig(node: Node, graph: Graph, idx: ModuleIndex, sig: Sig): Sig {
  const k = node.kind;
  if (node.targs.length !== 1) sig.error = ["E0502", `${k} needs one type argument: the element type, as in ${k}#<i32>`];
  const t = node.targs.length ? node.targs[0] : "i32";
  if (!typeOk(t, idx)) sig.error = ["E0501", `type '${t}' is not supported by this prototype`];
  const arr = `array#<${t}>`;
  if (k === "MakeArray") {
    sig.purity = "pure";
    sig.inputs = range(attrInt(node, "count", 2)).map((i) => new Pin(indexedName("item", i), t));
    sig.outputs = [new Pin("result", arr)];
  } else if (k === "ArrayGet") {
    sig.purity = "pure";
    sig.inputs = [new Pin("array", arr), new Pin("index", "i32")];
    sig.outputs = [new Pin("item", t)];
  } else if (k === "ArrayLength") {
    sig.purity = "pure";
    sig.inputs = [new Pin("array", arr)];
    sig.outputs = [new Pin("length", "i32")];
  } else {
    const place = node.symbol;
    const ty = placeType(place, graph, idx);
    if (!place || ty === null) sig.error = ["E0130", `${k} must name the local, variable or field it changes, as in ${k}#<${t}> scores`];
    else if (ty !== arr && !sig.error) sig.error = ["E0110", `'${place}' is ${ty}, not ${arr}`];
    const fp = !graph.local(place ?? "") ? fieldPlace(place, graph, idx) : null;
    sig.inputs = [new Pin("in", "exec"), ...(fp ? [new Pin("obj", fp[0])] : []),
                  ...ARRAY_MUTATORS[k].map(([n, pt]) => new Pin(n, pt === "T" ? t : pt))];
    sig.outputs = [new Pin("then", "exec")];
  }
  return sig;
}

/** The registry document printed by `wiretc schema --json`. */
export function registryJson(): Record<string, unknown> {
  const kinds: any[] = [];
  for (const k of sortedBy(Object.keys(STATIC_KINDS))) {
    const [cat, purity, tps, pins] = STATIC_KINDS[k];
    const entry: any = { kind: k, display: k, category: cat, purity, pins: [] };
    if (tps.length) entry.typeParams = Object.fromEntries(tps.map((c, i) => [tps.length === 1 ? "T" : `T${i}`, c]));
    for (const [name, d, ty, def] of pins) {
      const p: any = { name, dir: d, type: ty };
      if (def === ZERO) p.default = "zero";
      entry.pins.push(p);
    }
    kinds.push(entry);
  }
  for (const k of sortedBy(Object.keys(CONTEXT_KINDS)))
    kinds.push({ kind: k, display: k, category: CONTEXT_KINDS[k], purity: "context", pins: "derived from the symbol or the enclosing graph" });
  const natives = sortedBy(Object.keys(stdNatives())).map((n) => {
    const s = stdNatives()[n];
    return { name: n, purity: s.purity, params: s.params.map(([a, t]) => ({ name: a, type: t })),
             results: s.results.map(([a, t]) => ({ name: a, type: t })) };
  });
  return { registry: REGISTRY_NAME, version: REGISTRY_VERSION, kinds, natives };
}
