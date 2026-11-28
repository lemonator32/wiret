/** Helpers shared by the CLI and the editor for calling a function with typed arguments. */
import { Lit, Module } from "./model.js";
import { floatToText } from "./natives.js";
import { ParseError, Parser, parseLiteral } from "./parser.js";
import {
  arrayElem, enumValues, FLOAT_TYPES, isContainer, laneLitFits, laneValue, litFits, mapTypes, ModuleIndex, setElem,
} from "./registry.js";
import * as lanes from "./lanes.js";
import { LANE_FIELDS } from "./lanes.js";
import { LoadedModule, Obj, VM } from "./vm.js";
import { pyRepr, ValueError } from "./pyutil.js";

export { ValueError };

/** A VM value for a literal argument of type `ty`. */
export function litValue(lit: Lit, ty: string, name: string, idx: ModuleIndex | null = null): any {
  let elem = arrayElem(ty);
  if (elem !== null) {
    if (lit.kind !== "list") throw new ValueError(`argument ${name}: write an array as [1, 2, 3]`);
    return lit.value.map((x: Lit) => litValue(x, elem!, name, idx));
  }
  elem = setElem(ty);
  if (elem !== null) {
    if (lit.kind !== "list") throw new ValueError(`argument ${name}: write a set as [1, 2, 3]`);
    return new Map(lit.value.map((x: Lit) => [litValue(x, elem!, name, idx), null]));
  }
  const kv = mapTypes(ty);
  if (kv !== null) {
    if (lit.kind === "list" && !lit.value.length) return new Map();
    if (lit.kind !== "map") throw new ValueError(`argument ${name}: write a map as {"a": 1, "b": 2}`);
    return new Map(lit.value.map(([k, v]: [Lit, Lit]) => [litValue(k, kv[0], name, idx), litValue(v, kv[1], name, idx)]));
  }
  if (ty in LANE_FIELDS) {
    if (!laneLitFits(lit, ty)) {
      const example = ty === "transform" ? "((0, 0, 0), (0, 0, 0, 1), (1, 1, 1))" : "(" + LANE_FIELDS[ty].map(() => "0").join(", ") + ")";
      throw new ValueError(`argument ${name}: write a ${ty} as ${example}`);
    }
    return lanes.normalise(ty, laneValue(lit, ty));
  }
  if (idx !== null && idx.structs.has(ty))
    throw new ValueError(`argument ${name}: a ${ty} struct cannot be typed as an argument; call a function that makes one instead`);
  if (idx !== null && idx.enums.has(ty)) {
    const values = new Map(enumValues(idx.enums.get(ty)!));
    const member = lit.kind === "enum" ? lit.value.split(".").slice(1).join(".") : null;
    if (!litFits(lit, ty) || member === null || !values.has(member)) {
      const names = [...values.keys()].map((m) => `${ty}::${m}`).join(", ");
      throw new ValueError(`argument ${name}: write one of ${names}`);
    }
    return values.get(member)!;
  }
  if (!litFits(lit, ty)) throw new ValueError(`argument ${name}: ${pyRepr(lit.value)} is not a ${ty}`);
  if (ty === "bool") return lit.value ? 1 : 0;
  if (FLOAT_TYPES.includes(ty)) return Number(lit.value);
  return lit.value;
}

export function parseArgsFor(m: Module, func: string, texts: string[]): any[] {
  const g = m.graph(func);
  if (g === null || g.kind === "macro") throw new ValueError(`no function '${func}'`);
  if (texts.length !== g.params.length) {
    const sig = g.params.map((p) => `${p.name}: ${p.type}`).join(", ");
    throw new ValueError(`${func}(${sig}) takes ${g.params.length} argument(s), got ${texts.length}`);
  }
  const idx = new ModuleIndex(m);
  return g.params.map((p, i) => {
    const t = texts[i];
    let lit: Lit;
    try {
      if (isContainer(p.type)) lit = new Parser(t).value();
      else lit = parseLiteral(p.type !== "string" || t.startsWith('"') ? t : `"${t}"`);
    } catch (e) {
      if (e instanceof ParseError) throw new ValueError(`argument ${p.name}: ${e.msg}`);
      throw e;
    }
    return litValue(lit, p.type, p.name, idx);
  });
}

/** Split comma-separated arguments, keeping [..] arrays and "..." strings together. */
export function splitArgs(text: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "", quoted = false;
  for (const ch of text) {
    if (ch === '"' && !cur.endsWith("\\")) quoted = !quoted;
    if (!quoted && ch === "[") depth += 1;
    else if (!quoted && ch === "]") depth -= 1;
    if (ch === "," && depth === 0 && !quoted) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** A value as text: `Vec2 { x: 1.0, y: 1.5 }` for a struct and `Mode::Chase` for an enum
 * when `idx` knows the type; without it, a struct shows as a list of its field values. */
export function formatValue(ty: string | null, v: any, idx: ModuleIndex | null = null): string {
  if ((v === null || v === undefined) && (ty === null || idx === null || idx.classes.has(ty))) return "null";
  if (v instanceof Obj) {
    const names = v.cls.field_names;
    const types: (string | null)[] = idx !== null && idx.classes.has(v.cls.name)
      ? idx.classFields(v.cls.name).map(([, f]) => f.type) : names.map(() => null);
    // only the declared fields: dispatchers and methods' state come after them in the object
    const shown = Math.min(names.length, types.length, v.fields.length);
    const inner = names.slice(0, shown).map((n, i) => {
      const x = v.fields[i];
      return `${n}: ${x instanceof Obj ? "<" + x.cls.name + ">" : formatValue(types[i] ?? null, x, idx)}`;
    }).join(", ");
    return inner ? `${v.cls.name} { ${inner} }` : `${v.cls.name} {}`;
  }
  if (ty !== null && ty in LANE_FIELDS && Array.isArray(v)) return lanes.toText(v, (x) => formatValue("f32", x));
  if (idx !== null && ty !== null && idx.structs.has(ty) && Array.isArray(v)) {
    const fields = idx.structs.get(ty)!.fields;
    const inner = fields.map((f, i) => `${f.name}: ${formatValue(f.type, v[i], idx)}`).join(", ");
    return inner ? `${ty} { ${inner} }` : `${ty} {}`;
  }
  if (idx !== null && ty !== null && idx.enums.has(ty)) {
    const base = idx.enumBase(ty)!;
    for (const [name, value] of enumValues(idx.enums.get(ty)!))
      if (formatValue(base, normInt(base, value)) === formatValue(base, v)) return `${ty}::${name}`;
    return `${ty}(${formatValue(base, v)})`;
  }
  if (v instanceof Map) {
    const kv = ty ? mapTypes(ty) : null;
    let isMap: boolean;
    if (kv === null && setElem(ty || "") === null) isMap = [...v.values()].some((x) => x !== null);
    else isMap = kv !== null;
    if (isMap) {
      const [kTy, vTy] = kv ?? [null, null];
      return "{" + [...v].map(([k, x]) => `${formatValue(kTy, k, idx)}: ${formatValue(vTy, x, idx)}`).join(", ") + "}";
    }
    return "{" + [...v.keys()].map((x) => formatValue(setElem(ty || ""), x, idx)).join(", ") + "}";
  }
  const elem = ty ? arrayElem(ty) : null;
  if (elem !== null || Array.isArray(v)) return "[" + [...v].map((x: any) => formatValue(elem, x, idx)).join(", ") + "]";
  if (ty === "bool") return v ? "true" : "false";
  if (ty === "string") return pyRepr(v);
  if (ty === "u8" || ty === "u16" || ty === "u32") return String(Number(v) >>> 0);
  if (ty === "u64") return BigInt.asUintN(64, BigInt(v)).toString();
  if (typeof v === "number") {
    // Python tells a float from an int by its type; here the Wiret type says which
    if (ty !== null && FLOAT_TYPES.includes(ty)) return floatToText(v, ty === "f32");
    if (ty !== null && (isIntType(ty) || (idx !== null && idx.enums.has(ty)))) return String(v);
    return Number.isInteger(v) && !Object.is(v, -0) ? String(v) : floatToText(v);
  }
  return String(v);
}

const isIntType = (ty: string) => /^[iu](8|16|32|64)$/.test(ty) || ty === "bool";

/** An enum's value as the VM holds it for its base type. */
function normInt(base: string, v: bigint): number | bigint {
  return base === "i64" || base === "u64" ? BigInt.asIntN(64, v) : Number(BigInt.asIntN(32, v));
}

export function formatResults(m: Module | null, func: string, values: any[]): string {
  const g = m ? m.graph(func) : null;
  if (g === null) return values.length ? values.map((v) => String(v)).join(", ") : "(no results)";
  if (!g.result_list.length) return "(no results)";
  const idx = new ModuleIndex(m!);
  return g.result_list.map((r, i) => `${r.name} = ${formatValue(r.type, values[i], idx)}`).join(", ");
}

/** Call `func` and return its results. A latent function or event runs as a fiber (section
 * 4.5): idle virtual time is skipped, so a `Delay` of five seconds finishes at once. The
 * runtime does the stepping (`Vm::run_function` in runtime/src/vm.rs). */
export function runFunction(vm: VM, lm: LoadedModule, func: string, args: any[]): any[] {
  return vm.runFunction(lm, func, args);
}
