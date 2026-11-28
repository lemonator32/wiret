/** Rename a declaration, parameter, result, field, enum member, local or state slot and
 * rewrite every reference to it (the `rename` edit operation, section 7.2). The merge uses
 * the same rewrite to carry a rename on one side into the other side's additions (7.1). */
import { Element, elements } from "./ids.js";
import { Class, Const, Enum, Extern, Graph, Interface, Lit, Module, Node, PinRef, Struct, Var, Item } from "./model.js";
import { RESERVED } from "./parser.js";
import { PLACE_MUTATORS } from "./registry.js";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class RenameError extends Error {}

export function findElement(m: Module, token: string): Element | null {
  for (const e of elements(m)) if (e.id === token) return e;
  return null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function retype(ty: string, old: string, nu: string): string {
  return ty.replace(new RegExp(`(?<![A-Za-z0-9_.])${escapeRe(old)}(?![A-Za-z0-9_])`, "g"), nu);
}

type LitSlot = [any, string];

/** Every literal that may hold an enum value: bindings, defaults and consts. */
function* lits(m: Module): Generator<LitSlot> {
  for (const it of m.items as any[]) {
    for (const attr of ["default_", "value"]) if (it[attr] instanceof Lit) yield [it, attr];
    for (const p of [...(it.params ?? []), ...(it.results ?? [])]) if (p.default_ !== null && p.default_ !== undefined) yield [p, "default_"];
    for (const f of it.fields ?? []) if (f.default_ !== null) yield [f, "default_"];
    if (it instanceof Graph) {
      for (const loc of [...it.locals, ...it.states]) if (loc.default_ !== null) yield [loc, "default_"];
      for (const n of it.nodes) for (const b of n.bindings) if (b.value instanceof Lit) yield [b, "value"];
    }
  }
}

/** Every object with a `.type`, for rewriting type names. */
function* typed(m: Module): Generator<{ type: string; name?: string }> {
  for (const it of m.items as any[]) {
    if (it instanceof Const || it instanceof Var) yield it;
    for (const p of [...(it.params ?? []), ...(it.results ?? [])]) yield p;
    for (const f of it.fields ?? []) yield f;
    if (it instanceof Graph) {
      yield* it.locals;
      yield* it.states;
    }
  }
}

function* calls(m: Module, kinds: string[], name: string): Generator<[Graph, Node]> {
  const full = `${m.name}.${name}`;
  for (const g of m.graphs()) for (const n of g.nodes) if (kinds.includes(n.kind) && (n.symbol === name || n.symbol === full)) yield [g, n];
}

/** Rename the element with `@id` `token` to `nu`. Returns a description of every reference
 * rewritten. Throws RenameError when the rename is not possible. */
export function rename(m: Module, token: string, nu: string): string[] {
  const e = findElement(m, token);
  if (e === null) throw new RenameError(`no element has @id '${token}'`);
  return renameElement(m, e, nu);
}

export function renameElement(m: Module, e: Element, nu: string): string[] {
  const old = e.name;
  const obj = e.obj as any;
  if (!IDENT.test(nu) || RESERVED.has(nu)) throw new RenameError(`'${nu}' is not a valid name`);
  if (nu === old) return [];
  if (e.kind === "module") throw new RenameError("renaming a module moves its file; it is not an edit operation");
  const siblings = new Set([...elements(m)].filter((x) => x.owner === e.owner && x.kind !== "module" && sameNamespace(x.kind, e.kind)).map((x) => x.name));
  if (siblings.has(nu)) throw new RenameError(`'${nu}' is already used next to '${old}'`);
  const out: string[] = [];
  const owner = e.owner ? (m.items.find((it) => it.name === e.owner) ?? null) : null;
  const kind = e.kind;
  if (["func", "event", "macro"].includes(kind)) {
    obj.name = nu;
    for (const [g, n] of calls(m, ["Call", "Macro"], old)) {
      n.symbol = nu;
      out.push(`${g.name}.${n.id}`);
    }
  } else if (kind === "extern") {
    throw new RenameError("an extern's name is the host's; rename it on the host side");
  } else if (kind === "var" || kind === "const") {
    obj.name = nu;
    for (const g of m.graphs())
      for (const n of g.nodes)
        if (n.symbol === old && (n.kind === "GetVar" || n.kind === "SetVar" || (isPlace(n) && g.local(old) === null))) {
          n.symbol = nu;
          out.push(`${g.name}.${n.id}`);
        }
  } else if (kind === "struct" || kind === "enum") {
    obj.name = nu;
    for (const x of typed(m)) {
      const t = retype(x.type, old, nu);
      if (t !== x.type) {
        x.type = t;
        out.push(`type of ${x.name ?? "?"}`);
      }
    }
    for (const g of m.graphs()) {
      for (const n of g.nodes) {
        const targs = n.targs.map((t) => retype(t, old, nu));
        if (targs.join("\0") !== n.targs.join("\0")) {
          n.targs = targs;
          out.push(`${g.name}.${n.id}`);
        }
        if (kind === "struct" && ["MakeStruct", "BreakStruct", "GetField", "WithField"].includes(n.kind) && n.symbol) {
          const i = n.symbol.indexOf(".");
          const head = i < 0 ? n.symbol : n.symbol.slice(0, i), rest = i < 0 ? "" : n.symbol.slice(i);
          if (head === old) {
            n.symbol = nu + rest;
            out.push(`${g.name}.${n.id}`);
          }
        }
      }
    }
    if (kind === "enum") out.push(...renameEnumValues(m, (en) => en === old, (_en, mem) => [nu, mem]));
  } else if (kind === "member") {
    obj.name = nu;
    out.push(...renameEnumValues(m, (en, mem) => en === e.owner && mem === old, (en) => [en, nu]));
  } else if (kind === "field") {
    obj.name = nu;
    const st = e.owner;
    for (const g of m.graphs()) {
      for (const n of g.nodes) {
        if ((n.kind === "GetField" || n.kind === "WithField") && n.symbol === `${st}.${old}`) {
          n.symbol = `${st}.${nu}`;
          out.push(`${g.name}.${n.id}`);
        }
        if (n.kind === "MakeStruct" && n.symbol === st) out.push(...renameBinding(g, n, old, nu));
      }
      const breaks = new Set(g.nodes.filter((n) => n.kind === "BreakStruct" && n.symbol === st).map((n) => n.id));
      out.push(...renameRefs(g, breaks, old, nu));
    }
  } else if (kind === "param" || kind === "result") {
    out.push(...renameSignaturePin(m, owner, e, old, nu));
  } else if (kind === "local" || kind === "state") {
    obj.name = nu;
    const [get, set] = kind === "local" ? ["GetLocal", "SetLocal"] : ["GetState", "SetState"];
    for (const n of (owner as Graph).nodes)
      if (n.symbol === old && (n.kind === get || n.kind === set || (kind === "local" && isPlace(n)))) {
        n.symbol = nu;
        out.push(`${owner!.name}.${n.id}`);
      }
  } else throw new RenameError(`a ${kind} cannot be renamed`);
  return out;
}

function sameNamespace(a: string, b: string): boolean {
  const top = new Set(["use", "extern", "const", "var", "enum", "struct", "func", "event", "macro"]);
  if (top.has(a) && top.has(b)) return true;
  const pins = new Set(["param", "result"]);
  return a === b || (pins.has(a) && pins.has(b));
}

const isPlace = (n: Node) => PLACE_MUTATORS.has(n.kind);

function renameBinding(g: Graph, n: Node, old: string, nu: string): string[] {
  const out: string[] = [];
  for (const b of n.bindings)
    if (b.pin === old) {
      b.pin = nu;
      out.push(`${g.name}.${n.id}.${old}`);
    }
  return out;
}

function renameRefs(g: Graph, sources: Set<string>, old: string, nu: string): string[] {
  const out: string[] = [];
  for (const n of g.nodes)
    for (const b of n.bindings)
      if (b.value instanceof PinRef && sources.has(b.value.node) && b.value.pin === old) {
        b.value = new PinRef(b.value.node, nu);
        out.push(`${g.name}.${n.id}.${b.pin}`);
      }
  return out;
}

function renameExecs(g: Graph, sources: Set<string>, old: string, nu: string): string[] {
  const out: string[] = [];
  for (const n of g.nodes)
    for (const x of n.execs)
      if (sources.has(n.id) && x.pin === old) {
        x.pin = nu;
        out.push(`${g.name}.${n.id}.${old}`);
      }
  return out;
}

function renameExecTargets(g: Graph, targets: Set<string>, old: string, nu: string): string[] {
  const out: string[] = [];
  for (const n of g.nodes)
    for (const x of n.execs)
      if (targets.has(x.target) && x.target_pin === old) {
        x.target_pin = nu;
        out.push(`${g.name}.${n.id} -> ${x.target}`);
      }
  return out;
}

function renameSignaturePin(m: Module, g: Item | null, e: Element, old: string, nu: string): string[] {
  const out: string[] = [];
  const p = e.obj as any;
  p.name = nu;
  if (!(g instanceof Graph)) return out;
  const isExec = p.type === "exec";
  if (e.kind === "param") {
    const entries = new Set(g.nodes.filter((n) => n.kind === "Entry").map((n) => n.id));
    out.push(...(isExec ? renameExecs(g, entries, old, nu) : renameRefs(g, entries, old, nu)));
    for (const [cg, n] of calls(m, ["Call", "Macro"], g.name))
      out.push(...(isExec ? renameExecTargets(cg, new Set([n.id]), old, nu) : renameBinding(cg, n, old, nu)));
  } else {
    for (const n of g.nodes) {
      if (n.kind === "Return" || ((n.kind === "Exit" || n.kind === "Leave") && !isExec)) out.push(...renameBinding(g, n, old, nu));
      if ((n.kind === "Exit" || n.kind === "Leave") && isExec && n.symbol === old) {
        n.symbol = nu;
        out.push(`${g.name}.${n.id}`);
      }
    }
    for (const [cg, n] of calls(m, ["Call", "Macro"], g.name))
      out.push(...(isExec ? renameExecs(cg, new Set([n.id]), old, nu) : renameRefs(cg, new Set([n.id]), old, nu)));
  }
  return out;
}

function renameEnumValues(m: Module, match: (en: string, mem: string) => boolean, change: (en: string, mem: string) => [string, string]): string[] {
  const out: string[] = [];
  const fix = (lit: Lit): Lit | null => {
    if ((lit.kind !== "enum" && lit.kind !== "ident") || lit.value.split(".").length !== 2) return null;
    const [en, mem] = lit.value.split(".");
    if (!match(en, mem)) return null;
    const [en2, mem2] = change(en, mem);
    return new Lit(lit.kind, `${en2}.${mem2}`);
  };
  for (const [obj, attr] of lits(m)) {
    const lit: Lit = obj[attr];
    const nu = lit.kind === "enum" ? fix(lit) : null;
    if (nu !== null) {
      obj[attr] = nu;
      out.push(`value ${nu.value}`);
    }
  }
  return out;
}

export type { Class, Enum, Extern, Interface, Struct };
