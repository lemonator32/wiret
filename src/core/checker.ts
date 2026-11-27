/** Resolver, type checker and graph validator (spec sections 4.3 and 4.7). */
import {
  Class, Const, Enum, Extern, Graph, Interface, Lit, Module, Node, NODE_GENERICS, noteDetached, notes, Param, PinRef,
  SEMANTIC_ATTRS, Struct, Var, Local, Attr,
} from "./model.js";
import {
  arrayElem, assignable, BUILTIN_TYPE_NAMES, COUNTED_OUTPUTS, countedSide, enumValues, fieldPlace, HANDLE_TYPES,
  handleOk, instantiate, INT_RANGES, litFits, litInRange, ModuleIndex, outputValues, parentMethod, PLACE_MUTATORS, Sig,
  signature, substitute, typeOk,
} from "./registry.js";
import { checkIds, Project } from "./ids.js";
import { fmtLit } from "./printer.js";
import { jsonDumps, sortedBy } from "./pyutil.js";

/** Decorators that are metadata: they explain the program and never change it (section 2.4). */
export const META_NAMES = new Set(["doc", "category", "keywords", "note"]);

export class Diag {
  constructor(public code: string, public message: string, public module = "", public graph: string | null = null,
              public node: string | null = null, public pin: string | null = null,
              public data: Record<string, any> | null = null) {}

  get severity(): string {
    return this.code.startsWith("E") ? "error" : "warning";
  }

  /** The node id in the source graph (path-style ids map to their macro call node). */
  get top_node(): string | null {
    if (!this.node) return null;
    return this.node.split("/")[0].split("!")[0];
  }

  toJson(): string {
    return jsonDumps({ code: this.code, message: this.message, module: this.module, graph: this.graph,
      node: this.node, pin: this.pin, data: this.data, severity: this.severity });
  }

  toString(): string {
    let where = [this.graph, this.node].filter((x) => x).join(".");
    if (this.pin) where += `.${this.pin}`;
    return `${this.severity} ${this.code}: ${where ? where + ": " : ""}${this.message}`;
  }
}

export function hasErrors(diags: Diag[]): boolean {
  return diags.some((d) => d.severity === "error");
}

/** The exec input a wire enters: the one it names, else the node's first (section 2.3). */
export function execTargetPin(_target: Node, pin: string | null, sig: Sig | null = null): string {
  if (pin) return pin;
  const ins = sig !== null ? sig.exec_ins : [];
  return ins.length ? ins[0].name : "in";
}

/** Resolved signatures and exec edges of one graph; shared by checker and editor. */
export class GraphInfo {
  nodes = new Map<string, Node>();
  sigs = new Map<string, Sig>();

  constructor(public g: Graph, idx: ModuleIndex) {
    for (const n of g.nodes) if (!this.nodes.has(n.id)) this.nodes.set(n.id, n);
    for (const [nid, n] of this.nodes) this.sigs.set(nid, signature(n, g, idx));
  }

  execPin(node: Node, e: { pin: string | null }): string | null {
    if (e.pin !== null) return e.pin;
    const outs = this.sigs.get(node.id)!.exec_outs;
    return outs.length ? outs[0].name : null;
  }

  successors(nid: string): string[] {
    const n = this.nodes.get(nid);
    if (n === undefined) return [];
    return n.execs.filter((e) => this.nodes.has(e.target)).map((e) => e.target);
  }

  entry(): string | null {
    for (const [nid, n] of this.nodes) if (n.kind === "Entry") return nid;
    return null;
  }
}

export type D = (code: string, msg: string, graph?: string | null, node?: string | null, pin?: string | null,
                 data?: Record<string, any>) => void;

/** Every diagnostic for a module. With a `project`, also the identity checks. */
export function check(module: Module, commentsOk = false, project: Project | null = null): Diag[] {
  const diags: Diag[] = [];
  const idx = new ModuleIndex(module);
  const mod = module.name;
  const D: D = (code, msg, graph = null, node = null, pin = null, data) => {
    diags.push(new Diag(code, msg, mod, graph ?? null, node ?? null, pin ?? null, data && Object.keys(data).length ? data : null));
  };

  const seen = new Set<string>();
  for (const it of module.items) {
    if (seen.has(it.name)) D("E0102", `duplicate declaration '${it.name}'`);
    seen.add(it.name);
  }
  for (const it of module.items) {
    const tparams = it instanceof Graph ? it.tparams : [];
    const typed: (Param | Local | Var | Const)[] = [];
    if (it instanceof Graph || it instanceof Extern) typed.push(...it.params, ...(it.results ?? []));
    if (it instanceof Graph) typed.push(...it.locals, ...it.states);
    if (it instanceof Var || it instanceof Const) typed.push(it);
    const subst = new Map(tparams.map((t) => [t, "i32"]));
    for (const p of typed) {
      const ty = substitute(p.type, subst);
      if (ty !== "exec" && !handleOk(ty, idx)) {
        D("E0501", unknownTypeMessage(p.type, module.name), it.name, null, null, { type: p.type });
        continue;
      }
      const def = p instanceof Const ? p.value : p.default_;
      if (def !== null && def.kind === "enum") {
        if (checkEnumValue(def, idx, D, it.name, null, p.name) && !litFits(def, ty))
          D("E0110", `default of '${p.name}' is a ${def.value.split(".")[0]} value, not ${ty}`, it.name, null, p.name,
            { literal: true, dst: ty });
      } else if (def !== null && !(litFits(def, ty, idx) && litInRange(def, ty))) {
        D("E0110", `the value of '${p.name}' does not fit type ${ty}`, it.name, null, p.name, { literal: true, dst: ty });
      }
    }
  }
  checkTypeDecls(module, idx, D);
  checkAttrNames(module, D);
  checkCapabilities(module, project, D);
  if (project !== null) checkIds(module, project, D);
  for (const owner of [module, ...module.items.filter((i) => !(i instanceof Graph))] as { meta: Attr[]; name: string }[]) {
    for (const nt of notes(owner.meta))
      if (noteDetached(nt) !== null)
        D("W0604", `a note is detached from '${noteDetached(nt)}', which was deleted`, owner !== module ? owner.name : null);
  }
  if (module.comments.length && !commentsOk) {
    for (const c of module.comments)
      D("W0603", `line ${c.line}: this '//' comment is not directly above a statement ` +
                 `or an input, so it is attached to nothing and would be dropped; ` +
                 `move it above what it explains, or convert it to a note`);
  }
  for (const g of module.graphs()) {
    if (g.tparams.length) checkGraph(instantiate(g, g.tparams.map(() => "i32")), idx, D);
    else checkGraph(g, idx, D);
  }
  checkMacroRecursion(module, idx, D);
  return diags;
}

export function unknownTypeMessage(ty: string, moduleName: string): string {
  if (ty.includes("dispatcher#<"))
    return `type '${ty}': a dispatcher is declared as a class member, ` +
           `'dispatcher OnDied(amount: i32)', and is not a type you can store`;
  if ([...HANDLE_TYPES].some((h) => ty.includes(h)) && !HANDLE_TYPES.has(ty))
    return `type '${ty}': a signal can be a parameter, result, local, state or variable, ` +
           `but not a struct field or an item in an array, map or set`;
  const prefix = moduleName + ".";
  const base = arrayElem(ty) || ty;
  if (base.startsWith(prefix))
    return `type '${ty}' names a type of this module with its module prefix; write '${ty.split(prefix).join("")}'`;
  return `unknown type '${ty}': not a built-in type, struct or enum of this module`;
}

function checkTypeDecls(module: Module, idx: ModuleIndex, D: D): void {
  for (const it of module.items) {
    if (!(it instanceof Struct || it instanceof Enum)) continue;
    const kind = it instanceof Struct ? "struct" : "enum";
    if (BUILTIN_TYPE_NAMES.has(it.name)) D("E0102", `${kind} '${it.name}' has the name of a built-in type; choose another name`, it.name);
    const members: { name: string }[] = it instanceof Struct ? it.fields : it.members;
    const seen = new Set<string>();
    for (const x of members) {
      if (seen.has(x.name)) {
        const what = kind === "struct" ? "field" : "member";
        D("E0102", `duplicate ${what} '${x.name}' in ${kind} '${it.name}'`, it.name, null, x.name);
      }
      seen.add(x.name);
    }
    if (it instanceof Struct) {
      for (const f of it.fields) {
        if (f.type === "exec")
          D("E0501", `field '${it.name}.${f.name}' cannot have type exec: exec is only for macro parameters`, it.name, null, f.name, { type: f.type });
        else if (!typeOk(f.type, idx))
          D("E0501", unknownTypeMessage(f.type, module.name), it.name, null, f.name, { type: f.type });
        else if (f.default_ !== null && f.default_.kind === "enum" && !checkEnumValue(f.default_, idx, D, it.name, null, f.name)) {
          // reported
        } else if (f.default_ !== null && !(litFits(f.default_, f.type) && litInRange(f.default_, f.type)))
          D("E0110", `default of field '${it.name}.${f.name}' does not fit type ${f.type}`, it.name, null, f.name, { literal: true, dst: f.type });
      }
    } else {
      const base = it.base || "i32";
      if (it.attrs.some((a) => a.name === "export"))
        D("W0203", `enum '${it.name}' is marked @export, but an enum is stored as its ` +
                   `${base} values and has no type entry, so it is not in the export ` +
                   `table; remove @export`, it.name);
      const [lo, hi] = INT_RANGES[base];
      for (const [name, v] of enumValues(it))
        if (!(lo <= v && v <= hi))
          D("E0110", `value ${v} of enum member '${it.name}.${name}' does not fit its type ${base} (${lo} to ${hi})`,
            it.name, null, name, { literal: true, dst: base });
    }
  }
  checkStructCycles(idx, D);
  checkInterfaces(module, idx, D);
  checkClasses(module, idx, D);
}

function checkInterfaces(module: Module, idx: ModuleIndex, D: D): void {
  for (const it of idx.interfaces.values()) {
    if (BUILTIN_TYPE_NAMES.has(it.name)) D("E0102", `interface '${it.name}' has the name of a built-in type; choose another name`, it.name);
    const seen = new Set<string>();
    for (const m of it.methods) {
      if (seen.has(m.name)) D("E0102", `duplicate method '${m.name}' in interface '${it.name}'`, it.name, null, m.name);
      seen.add(m.name);
      for (const p of [...m.params, ...m.result_list])
        if (p.type === "exec" || !handleOk(p.type, idx))
          D("E0501", unknownTypeMessage(p.type, module.name), it.name, null, m.name, { type: p.type });
      if (m.hasAttr("latent"))
        D("E0501", `'${it.name}.${m.name}' is @latent; interface methods that can wait are not supported by this prototype yet`, it.name, null, m.name);
    }
  }
}

const types = (ps: { type: string }[]) => ps.map((p) => p.type).join("\0");

function checkImplementations(c: Class, idx: ModuleIndex, D: D): void {
  for (const name of c.impls) {
    if (!idx.interfaces.has(name)) {
      const what = idx.classes.has(name) ? "a class" : "not declared in this module";
      D("E0151", `class '${c.name}' implements '${name}', which is ${what}, not an interface`, c.name);
    }
  }
  for (const name of c.impls) {
    const it = idx.interfaces.get(name);
    if (it === undefined) continue;
    for (const m of it.methods) {
      const g = idx.findMethod(c.name, m.name);
      const want = `func ${m.name}(${m.params.map((p) => p.type).join(", ")}) -> (${m.result_list.map((r) => r.type).join(", ")})`;
      if (g === null) D("E0152", `class '${c.name}' implements '${name}' but has no method '${m.name}'; add ${want}`, c.name, null, m.name);
      else if (g.kind !== "func" || g.hasAttr("latent") || types(g.params) !== types(m.params) || types(g.result_list) !== types(m.result_list))
        D("E0152", `'${g.name}' does not match '${name}.${m.name}': an implementation is a func that does not wait, written ${want}`, c.name, null, m.name);
    }
  }
}

function checkClasses(module: Module, idx: ModuleIndex, D: D): void {
  for (const c of idx.classes.values()) {
    if (BUILTIN_TYPE_NAMES.has(c.name)) D("E0102", `class '${c.name}' has the name of a built-in type; choose another name`, c.name);
    if (c.base !== null && !idx.classes.has(c.base)) D("E0151", `class '${c.name}' extends '${c.base}', which is not a class of this module`, c.name);
    const chain = idx.classChain(c.name);
    const last = idx.classes.get(chain[chain.length - 1])!;
    if (last.base !== null && chain.includes(last.base)) {
      D("E0151", `class '${c.name}' inherits from itself: ${[...chain, last.base].join(" -> ")}`, c.name);
      continue;
    }
    checkImplementations(c, idx, D);
    const inherited = new Map<string, string>();
    if (c.base) for (const [owner, f] of idx.classFields(c.base)) inherited.set(f.name, owner);
    const seen = new Set<string>();
    for (const d of c.dispatchers)
      for (const p of d.params)
        if (p.type === "exec" || !handleOk(p.type, idx)) D("E0501", unknownTypeMessage(p.type, module.name), c.name, null, d.name, { type: p.type });
    if (c.base) for (const owner of idx.classChain(c.base)) for (const d of idx.classes.get(owner)!.dispatchers) inherited.set(d.name, owner);
    for (const f of [...c.fields, ...c.dispatchers]) {
      if (seen.has(f.name)) D("E0102", `duplicate member '${f.name}' in class '${c.name}'`, c.name, null, f.name);
      else if (inherited.has(f.name)) D("E0102", `field '${f.name}' of class '${c.name}' is already declared by '${inherited.get(f.name)}'`, c.name, null, f.name);
      seen.add(f.name);
      if (!("type" in f)) continue;
      if (f.type === "exec" || !typeOk(f.type, idx)) D("E0501", unknownTypeMessage(f.type, module.name), c.name, null, f.name, { type: f.type });
      else if (f.default_ !== null && !(litFits(f.default_, f.type, idx) && litInRange(f.default_, f.type)))
        D("E0110", `default of field '${c.name}.${f.name}' does not fit type ${f.type}`, c.name, null, f.name, { literal: true, dst: f.type });
    }
    for (const g of idx.methods(c.name)) {
      const baseM = c.base ? idx.findMethod(c.base, g.short_name) : null;
      if (baseM === null) continue;
      if (baseM.hasAttr("final")) D("E0150", `'${g.name}' overrides '${baseM.name}', which is @final`, g.name);
      else if (baseM.kind !== g.kind || types(baseM.params) !== types(g.params) || types(baseM.result_list) !== types(g.result_list) ||
               baseM.hasAttr("latent") !== g.hasAttr("latent"))
        D("E0150", `'${g.name}' overrides '${baseM.name}' but its signature differs; an override takes the same parameters and results`, g.name);
    }
  }
}

/** E0501 unless `Mode.Chase` names an enum of this module and one of its members. */
export function checkEnumValue(lit: Lit, idx: ModuleIndex, D: D, graph: string | null = null, node: string | null = null, pin: string | null = null): boolean {
  const i = lit.value.indexOf(".");
  const name = i < 0 ? lit.value : lit.value.slice(0, i), member = i < 0 ? "" : lit.value.slice(i + 1);
  const en = idx.enums.get(name);
  if (en === undefined) {
    D("E0501", `unknown enum '${name}' in value '${lit.value.replace(".", "::")}'`, graph, node, pin);
    return false;
  }
  if (en.member(member) === null) {
    D("E0501", `enum '${name}' has no member '${member}'`, graph, node, pin, { members: en.members.map((m) => m.name) });
    return false;
  }
  return true;
}

function checkSwitchCases(n: Node, sig: Sig, idx: ModuleIndex, G: string, D: D): void {
  const vin = sig.input("value");
  if (vin === null) return;
  const ty = vin.type;
  outputValues(sig).forEach((pin, i) => {
    const b = n.binding(pin);
    if (b === null) {
      D("W0201", `case ${i} has no value, so it is never taken; write it after the output, '.${pin} <value> -> { ... }'`, G, n.id, pin, { type: ty });
      return;
    }
    if (!(b.value instanceof Lit)) return;
    const lit = b.value;
    if (lit.kind === "enum" && !checkEnumValue(lit, idx, D, G, n.id, pin)) return;
    if (!(litFits(lit, ty) && litInRange(lit, ty))) {
      const hint = idx.enums.has(ty) && lit.kind !== "enum" ? `; write it as ${ty}::Member` : "";
      D("E0110", `case ${i} (${fmtLit(lit)}) is not a value of type ${ty}${hint}`, G, n.id, pin, { literal: true, dst: ty });
    }
  });
}

/** E0503: a struct that holds itself by value has no finite zero value. */
function checkStructCycles(idx: ModuleIndex, D: D): void {
  const byValue = (st: Struct) => st.fields.map((f) => f.type).filter((t) => idx.structs.has(t));
  const reported = new Set<string>();
  for (const name of sortedBy(idx.structs.keys())) {
    let stack: [string, string[]][] = [[name, [name]]];
    const visited = new Set<string>();
    while (stack.length) {
      const [cur, path] = stack.pop()!;
      for (const nxt of byValue(idx.structs.get(cur)!)) {
        if (nxt === name) {
          const cycle = sortedBy(new Set(path)).join("\0");
          if (!reported.has(cycle)) {
            reported.add(cycle);
            D("E0503", `struct '${name}' contains itself by value: ${[...path, nxt].join(" -> ")}`, name);
          }
          stack = [];
          break;
        }
        if (!visited.has(nxt)) {
          visited.add(nxt);
          stack.push([nxt, [...path, nxt]]);
        }
      }
    }
  }
}

function checkMacroRecursion(_module: Module, idx: ModuleIndex, D: D): void {
  const uses = (g: Graph) => [...new Set(g.nodes.filter((n) => n.kind === "Macro" && idx.macros.has(n.symbol ?? "")).map((n) => n.symbol!))];
  for (const name of idx.macros.keys()) {
    let stack: [string, string[]][] = [[name, [name]]];
    const seen = new Set<string>();
    while (stack.length) {
      const [cur, path] = stack.pop()!;
      for (const nxt of uses(idx.macros.get(cur)!)) {
        if (nxt === name) {
          D("E0401", `macro expands itself: ${[...path, nxt].join(" -> ")}`, name);
          stack = [];
          break;
        }
        if (!seen.has(nxt)) {
          seen.add(nxt);
          stack.push([nxt, [...path, nxt]]);
        }
      }
    }
  }
}

const NUMBERED = /^([A-Za-z_]+)(\d+)$/;

function checkGraph(g: Graph, idx: ModuleIndex, D: D): void {
  const G = g.name;
  const info = new GraphInfo(g, idx);
  const nodes = info.nodes, sigs = info.sigs;

  const ids = new Set<string>();
  for (const n of g.nodes) {
    if (ids.has(n.id)) D("E0102", `two nodes are named '${n.id}'`, G, n.id);
    ids.add(n.id);
  }
  const seen = new Set<string>();
  for (const l of [...g.locals, ...g.states]) {
    if (seen.has(l.name)) D("E0102", `'${l.name}' is declared twice in '${g.name}'`, G, null, l.name);
    seen.add(l.name);
  }
  const entries = g.nodes.filter((n) => n.kind === "Entry");
  if (!entries.length) D("E0101", "graph has no Entry node", G);
  for (const extra of entries.slice(1)) D("E0102", "a graph has exactly one Entry node", G, extra.id);

  const pureAttr = g.hasAttr("pure");
  const readsAttr = g.hasAttr("reads");

  for (const n of g.nodes) {
    const sig = sigs.get(n.id)!;
    if (sig.error) D(sig.error[0], sig.error[1], G, n.id);
    if (n.kind === "Switch" && !sig.error) checkSwitchCases(n, sig, idx, G, D);
    if (n.attr("live") !== null && !sig.pure)
      D("E0104", "@live belongs on a node without exec pins: it says that each consumer re-reads the node's value (section 4.3)", G, n.id);
    const bound = new Set<string>();
    const valued = new Set(outputValues(sig));
    for (const b of n.bindings) {
      const pin = sig.input(b.pin);
      if (bound.has(b.pin)) D("E0111", `input '${b.pin}' is bound twice`, G, n.id, b.pin);
      bound.add(b.pin);
      if (pin === null) {
        if (sig.error) { /* reported */ } else if (sig.output(b.pin) !== null && sig.output(b.pin)!.is_exec)
          D("E0103", `exec output '${b.pin}' takes no value; write '.${b.pin} -> { ... }'`, G, n.id, b.pin);
        else {
          const m = NUMBERED.exec(b.pin);
          const hint = m && countedSide(n) === "in" ? `; its numbered inputs are written with brackets, '${m[1]}[${m[2]}]'` : "";
          D("E0103", `${n.kind} has no input pin '${b.pin}'${hint}`, G, n.id, b.pin);
        }
        continue;
      }
      if (pin.is_exec) {
        D("E0120", `'${b.pin}' is an exec input; wire it from an exec output`, G, n.id, b.pin);
        continue;
      }
      if (b.value instanceof PinRef) {
        const src = nodes.get(b.value.node);
        if (src === undefined) {
          D("E0101", `unknown node '${b.value.node}'` + (b.value.pin ? "" :
            ` (a node written in place has its inputs in parentheses, as in '${b.value.node}()')`), G, n.id, b.pin);
          continue;
        }
        const spin = sigs.get(src.id)!.output(b.value.pin);
        if (spin === null) {
          if (!sigs.get(src.id)!.error) D("E0103", `${src.kind} '${src.id}' has no output pin '${b.value.pin}'`, G, n.id, b.pin);
          continue;
        }
        if (spin.is_exec) D("E0120", `'${src.id}.${spin.name}' is an exec output`, G, n.id, b.pin);
        else if (!assignable(spin.type, pin.type, idx))
          D("E0110", `wire type mismatch: ${spin.type} -> ${pin.type}; insert Convert#<${spin.type}, ${pin.type}>`, G, n.id, b.pin,
            { src: spin.type, dst: pin.type });
      } else if (valued.has(b.pin)) {
        // a case value: checkSwitchCases says it in its words
      } else {
        if (b.value.kind === "enum" && !checkEnumValue(b.value, idx, D, G, n.id, b.pin)) continue;
        if (!litFits(b.value, pin.type, idx)) D("E0110", `literal does not fit pin type ${pin.type}`, G, n.id, b.pin, { dst: pin.type, literal: true });
      }
    }
    if (!sig.error && n.kind !== "Exit" && n.kind !== "Leave")
      for (const p of sig.data_ins)
        if (!bound.has(p.name) && p.default_ === null && !valued.has(p.name))
          D("W0201", `input '${p.name}' is unbound and has no default`, G, n.id, p.name, { type: p.type });
    const listed = new Set<string>();
    for (const e of n.execs) {
      const pname = info.execPin(n, e);
      if (pname === null) {
        D("E0103", `${n.kind} has no exec output`, G, n.id);
        continue;
      }
      if (listed.has(pname)) D("E0121", `exec output '${pname}' is listed twice`, G, n.id, pname);
      listed.add(pname);
      const out = sig.output(pname);
      if (out === null && !sig.error) {
        const m = NUMBERED.exec(pname);
        const hint = m && n.kind in COUNTED_OUTPUTS ? `; its numbered outputs are written with brackets, '${m[1]}[${m[2]}]'` : "";
        D("E0103", `${n.kind} has no exec output '${pname}'${hint}`, G, n.id, pname);
      } else if (out !== null && !out.is_exec) D("E0120", `'${pname}' is a data output, not an exec output`, G, n.id, pname);
      const tgt = nodes.get(e.target);
      if (tgt === undefined) {
        D("E0101", `exec target names unknown node '${e.target}'`, G, n.id, pname);
        continue;
      }
      const tpinName = execTargetPin(tgt, e.target_pin, sigs.get(tgt.id)!);
      const tpin = sigs.get(tgt.id)!.input(tpinName);
      if (tpin === null) {
        if (!sigs.get(tgt.id)!.error) D("E0103", `${tgt.kind} '${tgt.id}' has no exec input '${tpinName}'`, G, n.id, pname);
      } else if (!tpin.is_exec) D("E0120", `'${tgt.id}.${tpinName}' is a data input`, G, n.id, pname);
    }
    if (pureAttr || readsAttr) {
      const attr = pureAttr ? "@pure" : "@reads";
      if (PLACE_MUTATORS.has(n.kind) && fieldPlace(n.symbol, g, idx) && !g.local(n.symbol ?? ""))
        D("E0302", `${attr} function changes the field '${n.symbol}'`, G, n.id);
      if (PLACE_MUTATORS.has(n.kind) && idx.vars.has(n.symbol ?? "") && !g.local(n.symbol!))
        D("E0302", `${attr} function changes the module variable '${n.symbol}'`, G, n.id);
      if (n.kind === "SetVar" || n.kind === "SetState")
        D("E0302", `${attr} function writes ${n.kind === "SetVar" ? "a variable" : "state"}`, G, n.id);
      if (["Bind", "Unbind", "Broadcast", "Invoke"].includes(n.kind))
        D("E0302", `${attr} function uses ${n.kind}, which changes objects or runs code it cannot check`, G, n.id);
      if (n.kind === "SetField" && !sig.error) D("E0302", `${attr} function writes the field '${n.symbol}'`, G, n.id);
      if (n.kind === "New") D("E0302", `${attr} function creates an object, which is an effect`, G, n.id);
      if (pureAttr && n.kind === "GetField" && sig.purity === "reads") D("E0304", `@pure function reads the field '${n.symbol}' of an object`, G, n.id);
      if (pureAttr && n.kind === "GetState") D("E0304", "@pure function reads state", G, n.id);
      if (pureAttr && n.kind === "GetVar" && !idx.consts.has(n.symbol ?? "")) D("E0304", "@pure function reads a module variable", G, n.id);
      if ((n.kind === "Call" || n.kind === "CallParent") && !sig.error) {
        if (pureAttr && sig.purity !== "pure") D("E0304", `@pure function calls '${n.symbol}', which is not @pure`, G, n.id);
        else if (readsAttr && sig.purity === "impure") D("E0302", `@reads function calls '${n.symbol}', which is neither @reads nor @pure`, G, n.id);
      }
      if (n.kind === "Macro" && idx.macros.has(n.symbol ?? "") && idx.macros.get(n.symbol!)!.states.length)
        D("E0302", `${attr} function expands macro '${n.symbol}', which keeps state`, G, n.id);
    }
  }
  checkPureCycles(info, G, D);
  checkFlow(info, G, D);
  checkTryNesting(info, G, D);
  checkLatency(g, info, idx, G, D);
  checkLayout(g, ids, G, D);
}

export const LATENT_KINDS = ["Delay", "Yield", "Await"];

/** Events are implicitly latent; a func is latent when declared @latent (section 4.4). */
export function graphLatent(g: Graph): boolean {
  return g.kind === "event" || g.hasAttr("latent");
}

/** Whether expanding a macro brings in a latent node or a call to a latent function. */
export function macroLatent(name: string, idx: ModuleIndex, seen = new Set<string>()): boolean {
  const m = idx.macros.get(name);
  if (m === undefined || seen.has(name)) return false;
  seen.add(name);
  for (const n of m.nodes) {
    if (LATENT_KINDS.includes(n.kind)) return true;
    if (n.kind === "Call") {
      const c = idx.callee(n.symbol ?? "");
      if (c !== null && c.latent) return true;
    }
    if (n.kind === "Macro" && macroLatent(n.symbol ?? "", idx, seen)) return true;
  }
  return false;
}

const sortedIds = (info: GraphInfo) => sortedBy(info.nodes.keys());

function checkLatency(g: Graph, info: GraphInfo, idx: ModuleIndex, G: string, D: D): void {
  if (g.kind === "macro") return;
  const pure = g.hasAttr("pure") || g.hasAttr("reads");
  const attr = g.hasAttr("pure") ? "@pure" : "@reads";
  if (pure && g.hasAttr("latent")) {
    D("E0302", `a function cannot be both @latent and ${attr}: suspending is an effect`, G);
    return;
  }
  if (graphLatent(g)) return;
  for (const nid of sortedIds(info)) {
    const n = info.nodes.get(nid)!;
    let why: string | null = null;
    if (LATENT_KINDS.includes(n.kind)) why = `${n.kind} suspends`;
    else if (n.kind === "CallParent" && !info.sigs.get(nid)!.error) {
      const pm = parentMethod(n, g, idx);
      if (pm !== null && (pm.kind === "event" || pm.hasAttr("latent")))
        why = `the parent '${pm.name}' is ${pm.kind === "event" ? "an event" : "latent"}`;
    } else if (n.kind === "Call" && !info.sigs.get(nid)!.error) {
      const c = idx.callee(n.symbol ?? "");
      if (c !== null && c.latent) why = `'${n.symbol}' is ${c.kind === "event" ? "an event" : "latent"}`;
    } else if (n.kind === "Macro" && macroLatent(n.symbol ?? "", idx)) why = `macro '${n.symbol}' can suspend`;
    if (why === null) continue;
    if (pure) D("E0302", `${attr} function cannot wait: ${why}`, G, nid);
    else D("E0201", `${why}, so '${G}' must be declared @latent`, G, nid);
  }
}

function checkTryNesting(info: GraphInfo, G: string, D: D): void {
  const edges = new Map<string, [string, string | null][]>();
  for (const [nid, n] of info.nodes)
    for (const e of n.execs)
      if (info.nodes.has(e.target)) {
        let l = edges.get(e.target);
        if (!l) edges.set(e.target, l = []);
        l.push([nid, info.execPin(n, e)]);
      }
  for (const tid of sortedIds(info)) {
    const t = info.nodes.get(tid)!;
    if (t.kind !== "Try" || info.sigs.get(tid)!.error) continue;
    const starts = t.execs.filter((e) => info.execPin(t, e) === "body" && info.nodes.has(e.target)).map((e) => e.target);
    const body = new Set(starts), todo = [...starts];
    while (todo.length) for (const s of info.successors(todo.pop()!)) if (!body.has(s)) { body.add(s); todo.push(s); }
    if (body.has(tid)) {
      D("E0412", `the body of Try '${tid}' leads back to '${tid}' itself; loop inside the body, or around the whole Try from its 'then'`, G, tid);
      continue;
    }
    const exits = sortedBy([...body].filter((nid) => info.nodes.get(nid)!.kind === "Exit"));
    if (exits.length) {
      D("E0412", `the body of Try '${tid}' reaches Exit '${exits[0]}', which would leave the macro with the fault handler still active`, G, tid);
      continue;
    }
    for (const nid of sortedBy(body)) {
      const outside = (edges.get(nid) ?? []).filter(([p, pin]) => !body.has(p) && !(p === tid && pin === "body"));
      if (outside.length) {
        const [p, pin] = outside[0];
        D("E0412", `'${nid}' is inside the body of Try '${tid}' but is also reached from '${p}.${pin}' outside it; the body must be entered only through '${tid}.body'`, G, tid);
        break;
      }
    }
  }
}

export function pureDeps(info: GraphInfo, nid: string): string[] {
  const n = info.nodes.get(nid)!;
  return n.bindings.filter((b) => b.value instanceof PinRef && info.nodes.has(b.value.node)).map((b) => (b.value as PinRef).node);
}

function checkPureCycles(info: GraphInfo, G: string, D: D): void {
  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const reported = new Set<string>();
  const visit = (nid: string, path: string[]): void => {
    color.set(nid, GREY);
    for (const d of pureDeps(info, nid)) {
      if (!info.sigs.get(d)!.pure) continue;
      const c = color.get(d) ?? WHITE;
      if (c === GREY) {
        const cyc = path.includes(d) ? path.slice(path.indexOf(d)) : [d];
        const k = sortedBy(new Set(cyc)).join("\0");
        if (!reported.has(k)) {
          reported.add(k);
          D("E0301", `cycle among pure nodes: ${[...cyc, d].join(" -> ")}`, G, d);
        }
      } else if (c === WHITE) visit(d, [...path, d]);
    }
    color.set(nid, BLACK);
  };
  for (const [nid, sig] of info.sigs) if (sig.pure && (color.get(nid) ?? WHITE) === WHITE) visit(nid, [nid]);
}

/** [producer, pin, consumer pin] for impure outputs read at nid's evaluation point. */
export function impureSources(info: GraphInfo, nid: string, seen = new Set<string>()): [string, string | null, string][] {
  const out: [string, string | null, string][] = [];
  const n = info.nodes.get(nid)!;
  for (const b of n.bindings) {
    if (!(b.value instanceof PinRef) || !info.nodes.has(b.value.node)) continue;
    const src = b.value.node;
    if (info.sigs.get(src)!.pure) {
      if (!seen.has(src)) {
        seen.add(src);
        for (const [p, pin] of impureSources(info, src, seen)) out.push([p, pin, b.pin]);
      }
    } else out.push([src, b.value.pin, b.pin]);
  }
  return out;
}

function checkFlow(info: GraphInfo, G: string, D: D): void {
  const entry = info.entry();
  if (entry === null) return;
  const impure = [...info.sigs].filter(([, s]) => !s.pure).map(([nid]) => nid);
  const succ = new Map(impure.map((nid) => [nid, info.successors(nid)]));
  const reach = new Set([entry]), todo = [entry];
  while (todo.length) {
    const cur = todo.pop()!;
    for (const s of succ.get(cur) ?? []) if (!reach.has(s)) { reach.add(s); todo.push(s); }
  }
  for (const nid of sortedBy(impure)) if (!reach.has(nid) && info.nodes.get(nid)!.kind !== "Entry") D("W0301", "node is unreachable from Entry", G, nid);

  const order = sortedBy(reach);
  const preds = new Map(order.map((nid) => [nid, [] as string[]]));
  for (const nid of order) for (const s of succ.get(nid) ?? []) if (preds.has(s)) preds.get(s)!.push(nid);
  const dom = new Map(order.map((nid) => [nid, new Set(order)]));
  dom.set(entry, new Set([entry]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const nid of order) {
      if (nid === entry) continue;
      const ps = preds.get(nid)!.map((p) => dom.get(p)!);
      let nu: Set<string>;
      if (ps.length) {
        nu = new Set([...ps[0]].filter((x) => ps.every((s) => s.has(x))));
      } else nu = new Set();
      nu.add(nid);
      const old = dom.get(nid)!;
      if (nu.size !== old.size || [...nu].some((x) => !old.has(x))) {
        dom.set(nid, nu);
        changed = true;
      }
    }
  }
  for (const nid of order) {
    for (const [prod, pin, cpin] of impureSources(info, nid)) {
      if (info.nodes.get(prod)!.kind === "Entry") continue;
      if (!dom.get(nid)!.has(prod) || prod === nid)
        D("E0310", `reads '${prod}.${pin}', but '${prod}' does not run on every path to this node (store it in a local on every path instead)`, G, nid, cpin);
    }
  }
  const later = runsAfter(info, impure, succ);
  const live = new Set([...info.nodes].filter(([, n]) => n.attr("live") !== null).map(([nid]) => nid));
  for (const rid of sortedBy(info.sigs.keys())) {
    const sig = info.sigs.get(rid)!;
    if (sig.purity !== "reads" || live.has(rid)) continue;
    const consumers = sortedBy(impure.filter((nid) => pureClosure(info, nid, live).has(rid)));
    let pair: [string, string] | null = null;
    outer: for (const a of consumers) for (const b of consumers) if (a !== b && later.get(a)?.has(b)) { pair = [a, b]; break outer; }
    if (pair === null) continue;
    const [a, b] = pair;
    D("E0320", `'${rid}' reads mutable state and is evaluated again at '${a}' and at '${b}', ` +
               `which can run one after the other, so they may see different values; ` +
               `store it in a local before '${a}' (SetLocal, then GetLocal), or mark it ` +
               `@live if each should read the current value`, G, rid);
  }
}

function runsAfter(info: GraphInfo, impure: string[], succ: Map<string, string[]>): Map<string, Set<string>> {
  const ext = new Map(impure.map((nid) => [nid, [...(succ.get(nid) ?? [])]]));
  const reach = (starts: string[], edges: Map<string, string[]>): Set<string> => {
    const seen = new Set<string>(), todo = [...starts];
    while (todo.length) {
      const cur = todo.pop()!;
      if (seen.has(cur) || !edges.has(cur)) continue;
      seen.add(cur);
      todo.push(...edges.get(cur)!);
    }
    return seen;
  };
  for (const nid of impure)
    if (["Sequence", "Try", "Macro"].includes(info.nodes.get(nid)!.kind))
      for (const r of reach(succ.get(nid) ?? [], succ)) if (r !== nid) ext.get(r)!.push(nid);
  return new Map(impure.map((nid) => [nid, reach(ext.get(nid)!, ext)]));
}

function pureClosure(info: GraphInfo, nid: string, stop: Set<string> = new Set()): Set<string> {
  const out = new Set<string>(), todo = pureDeps(info, nid);
  while (todo.length) {
    const d = todo.pop()!;
    if (out.has(d) || stop.has(d) || !info.sigs.get(d)!.pure) continue;
    out.add(d);
    todo.push(...pureDeps(info, d));
  }
  return out;
}

function checkCapabilities(module: Module, project: Project | null, D: D): void {
  for (const it of module.items) {
    for (const a of it.attrs) {
      if (a.name !== "capability") continue;
      const name = it.name;
      if (!(it instanceof Extern && it.kind === "func")) {
        D("E0104", "@capability belongs on an extern func: it says what that host function needs to be granted", name);
        continue;
      }
      const arg = a.arg();
      if (arg === null || arg.kind !== "string" || (a.args ?? []).length !== 1) {
        D("E0104", '@capability takes the capability name as one string, as in @capability("console.write")', name);
        continue;
      }
      const allowed = project !== null ? project.capabilities : null;
      if (allowed !== null && !allowed.has(arg.value))
        D("E0160", `'${it.name}' needs capability '${arg.value}', which wiret.toml does not allow; add it to [capabilities] allow`, name, null, null,
          { capability: arg.value });
    }
  }
}

function checkAttrNames(module: Module, D: D): void {
  const known = sortedBy(new Set([...SEMANTIC_ATTRS, ...META_NAMES])).map((n) => "@" + n).join(", ");
  const walk = (owner: string, attrs: Attr[], graph: string | null = null, node: string | null = null, meta: Attr[] = []) => {
    for (const a of [...attrs, ...meta]) {
      if (SEMANTIC_ATTRS.has(a.name) || META_NAMES.has(a.name) || a.name.includes(".") || /^\p{Lu}/u.test(a.name)) continue;
      if (node !== null && NODE_GENERICS.includes(a.name)) continue;
      if (NODE_GENERICS.includes(a.name)) {
        D("E0104", `'#${a.name}<...>' belongs on a node, after its kind`, graph, node);
        continue;
      }
      D("E0104", `unknown decorator '@${a.name}' on ${owner}; the decorators are ${known}, ` +
                 `and a third party's are named with a dot, as in @x.acme.${a.name}`, graph, node);
    }
  };
  walk(`module ${module.name}`, module.attrs, null, null, module.meta);
  for (const it of module.items) {
    const name = it.name;
    walk(name, it.attrs, it instanceof Graph ? name : null, null, it.meta);
    if (it instanceof Graph || it instanceof Extern)
      for (const p of [...it.params, ...(it.results ?? [])]) walk(`parameter '${p.name}'`, p.attrs, name);
    const subs: { name: string; attrs: Attr[]; meta: Attr[] }[] = [];
    if (it instanceof Struct || it instanceof Class) subs.push(...it.fields);
    if (it instanceof Enum) subs.push(...it.members);
    if (it instanceof Interface) subs.push(...it.methods);
    if (it instanceof Class) subs.push(...it.dispatchers);
    for (const f of subs) walk(`'${name}.${f.name}'`, f.attrs, null, null, f.meta);
    if (it instanceof Graph) {
      for (const l of [...it.locals, ...it.states]) walk(`'${l.name}'`, l.attrs, name, null, l.meta);
      for (const n of it.nodes) walk(`node '${n.id}'`, n.attrs, name, n.id, n.meta);
      for (const b of it.boxes) walk("a box", [], name, null, b.meta);
    }
  }
}

function checkLayout(g: Graph, _ids: Set<string>, G: string, D: D): void {
  for (const nt of notes(g.meta))
    if (noteDetached(nt) !== null) D("W0604", `a note is detached from '${noteDetached(nt)}', which was deleted`, G);
}
