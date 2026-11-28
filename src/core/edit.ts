/** `wiret edit`: the editing protocol for tools and LLMs (spec section 7.2).
 *
 * A request is JSON: `{"if_hash": "<layout hash>", "ops": [ ... ]}`. Each op is an object with
 * an `"op"` field. The whole request is applied to a copy of the model; if any op fails,
 * nothing changes. A stale `if_hash` is E0900. */
import { check, Diag } from "./checker.js";
import { attachRetired, Project, Retired, retiredBetween } from "./ids.js";
import { Attr, Graph, Lit, Module, Node, NODE_GENERICS, PinRef, SEMANTIC_ATTRS } from "./model.js";
import { bind, createNode, deleteNode, place, renameNode, unbind, unwireExec, wireExec } from "./ops.js";
import { parse, ParseError, Parser, resolveEnumValues } from "./parser.js";
import { layoutHash, printModule } from "./printer.js";
import { ModuleIndex, signature } from "./registry.js";
import { rename, RenameError } from "./rename.js";
import { deepcopy, pyRepr } from "./pyutil.js";
import { splitlinesKeep, unifiedDiff } from "./difflib.js";

export class EditError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export class EditResult {
  constructor(public ok: boolean, public text: string, public hash: string, public diagnostics: Diag[] = [],
              public diff = "", public error: Record<string, unknown> | null = null, public removed: string[] = [],
              public retired: Retired[] = []) {}

  toJson(): Record<string, unknown> {
    const out: Record<string, unknown> = {
      ok: this.ok, hash: this.hash, diagnostics: this.diagnostics.map((d) => JSON.parse(d.toJson())), diff: this.diff,
    };
    if (this.error) out.error = this.error;
    if (this.removed.length) out.removed_wires = this.removed;
    if (this.retired.length) out.retired = this.retired.map((r) => r.line());
    return out;
  }
}

/** Apply an edit request to a document's text. Never throws for a bad request. */
export function applyRequest(text: string, request: Record<string, any>, project: Project | null = null): EditResult {
  let curHash = "";
  let m: Module;
  try {
    m = parse(text);
    curHash = layoutHash(m);
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    return new EditResult(false, text, "", [], "", { code: "parse", message: e.message });
  }
  if (request.if_hash !== curHash)
    return new EditResult(false, text, curHash, [], "", { code: "E0900", message: "the document changed since the hash this edit was based on; read it again" });
  const nu = deepcopy(m);
  const removed: string[] = [];
  const ops: any[] = request.ops || [];
  for (let i = 0; i < ops.length; i++) {
    try {
      removed.push(...(applyOp(nu, ops[i]) ?? []));
    } catch (e) {
      if (e instanceof EditError) return new EditResult(false, text, curHash, [], "", { op: i, code: e.code, message: e.message });
      if (e instanceof TypeError || e instanceof RangeError || e instanceof BadOp)
        return new EditResult(false, text, curHash, [], "", { op: i, code: "request", message: `bad op: ${e.message}` });
      throw e;
    }
  }
  attachRetired(nu, project);
  const out = printModule(nu);
  let reparsed: Module;
  try {
    reparsed = parse(out);
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    return new EditResult(false, text, curHash, [], "", { code: "request", message: `result does not parse: ${e.message}` });
  }
  const retired = project !== null ? project.retire(retiredBetween(m, reparsed)) : [];
  const diff = unifiedDiff(splitlinesKeep(text), splitlinesKeep(out), "before", "after").join("");
  return new EditResult(true, out, layoutHash(reparsed), check(reparsed, false, project), diff, null, removed, retired);
}

class BadOp extends Error {}

function need(op: Record<string, any>, key: string): any {
  if (!(key in op)) throw new BadOp(`KeyError(${pyRepr(key)})`);
  return op[key];
}

// -- operations ------------------------------------------------------------------------
function graphOf(m: Module, op: Record<string, any>): Graph {
  const name = op.graph;
  const g = name ? m.graph(name) : null;
  if (g === null) throw new EditError("E0501", `no graph '${name ?? "None"}'`);
  return g;
}

function nodeOf(g: Graph, nid: string): Node {
  const n = g.node(nid);
  if (n === null) throw new EditError("E0101", `no node '${nid}' in ${g.name}`);
  return n;
}

/** The right-hand side of `.pin <- text`: a pin reference or a literal. */
export function valueOf(_m: Module, g: Graph, text: unknown): PinRef | Lit {
  const s = String(text).trim();
  const i = s.lastIndexOf(".");
  const node = i < 0 ? "" : s.slice(0, i), pin = i < 0 ? s : s.slice(i + 1);
  if (node && /^[A-Za-z_]\w*$/.test(pin) && (g.node(node) !== null || /^[A-Za-z_]\w*(\.\w+)*$/.test(node))) return new PinRef(node, pin);
  const p = new Parser(s);
  p.skipNl();
  let lit: Lit;
  try {
    lit = p.literal();
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    throw new EditError("request", `'${text}' is neither a pin reference nor a literal: ${e.msg}`);
  }
  p.skipNl();
  if (!p.at("eof")) throw new EditError("request", `unexpected text after '${text}'`);
  return lit;
}

/** A decorator, `@name(args)`, or a node's named generic, `#count<3>` (section 2.4). */
export function attrOf(text: unknown, meta: boolean): Attr {
  const src = String(text).trim();
  const p = new Parser(src + "\n");
  p.skipNl();
  let a: Attr;
  try {
    if (p.atP("#") && p.at("id", null, 1)) {
      p.next();
      const name = p.ident();
      if (!NODE_GENERICS.includes(name)) throw new EditError("request", `unknown named generic '#${name}'`);
      p.expectP("<");
      const args: [string | null, Lit][] = [];
      while (!p.atP(">")) {
        args.push([null, p.value()]);
        if (p.atP(",")) p.next();
      }
      p.next();
      a = new Attr(name, args);
    } else if (p.atP("@")) {
      p.next();
      const name = p.qname();
      if (NODE_GENERICS.includes(name)) throw new EditError("request", `'@${name}' is a named generic: write '#${name}<...>'`);
      a = new Attr(name, p.atP("(") ? p.attrArgs() : null);
    } else {
      throw new EditError("request", `a decorator is written @name(...), as in @note("..."), not '${src}'`);
    }
    p.skipNl();
    if (!p.at("eof")) throw new EditError("request", `expected one decorator in '${src}'`);
  } catch (e) {
    if (e instanceof ParseError) throw new EditError("request", `'${src}': ${e.msg}`);
    throw e;
  }
  const semantic = SEMANTIC_ATTRS.has(a.name) || NODE_GENERICS.includes(a.name);
  if (meta && semantic) throw new EditError("request", `'${src}' changes the program; set it with set_attr`);
  if (!meta && !semantic) throw new EditError("request", `'${src}' is metadata; set it with set_meta`);
  return a;
}

function targetOf(m: Module, op: Record<string, any>): any {
  if ("decl" in op) {
    const it = m.items.find((x) => x.name === op.decl);
    if (it === undefined) throw new EditError("E0501", `no declaration '${op.decl}'`);
    return it;
  }
  const g = graphOf(m, op);
  if ("node" in op) {
    const t = g.node(op.node) ?? g.box(op.node);
    if (t === null) throw new EditError("E0101", `no node or box '${op.node}' in ${g.name}`);
    return t;
  }
  return g;
}

function execEnd(text: unknown): [string, string | null] {
  const s = String(text);
  const i = s.indexOf(".");
  return i < 0 ? [s, null] : [s.slice(0, i), s.slice(i + 1) || null];
}

function singleExecOut(m: Module, g: Graph, n: Node): string | null {
  const sig = signature(n, g, new ModuleIndex(m));
  return sig.exec_outs.length === 1 ? sig.exec_outs[0].name : null;
}

export function applyOp(m: Module, op: Record<string, any>): string[] {
  const kind = op.op;
  if (kind === "create_node") {
    const g = graphOf(m, op);
    const nid = op.id ?? null;
    if (nid !== null && (g.node(nid) || g.box(nid))) throw new EditError("E0102", `'${nid}' is already used in ${g.name}`);
    const n = createNode(g, need(op, "kind"), op.symbol ?? null, op.targs ?? null, op.x ?? 0, op.y ?? 0, nid);
    for (const a of op.attrs ?? []) n.attrs.push(attrOf(a, false));
    for (const [pin, value] of Object.entries(op.bindings ?? {})) bind(g, n.id, pin, valueOf(m, g, value));
    for (const [pin, target] of Object.entries(op.execs ?? {})) {
      const [t, tpin] = execEnd(target);
      wireExec(g, n.id, pin || singleExecOut(m, g, n)!, t, tpin, singleExecOut(m, g, n));
    }
    op.id = n.id;
    return [];
  }
  if (kind === "bind" || kind === "unbind") {
    const g = graphOf(m, op);
    nodeOf(g, need(op, "node"));
    if (kind === "bind") bind(g, op.node, need(op, "pin"), valueOf(m, g, need(op, "value")));
    else unbind(g, op.node, need(op, "pin"));
    return [];
  }
  if (kind === "wire_exec" || kind === "unwire_exec") {
    const g = graphOf(m, op);
    let [src, pin] = execEnd(need(op, "from"));
    const n = nodeOf(g, src);
    const single = singleExecOut(m, g, n);
    pin = pin || single;
    if (pin === null) throw new EditError("E0103", `'${src}' has several exec outputs; name one, as in '${src}.then'`);
    if (kind === "wire_exec") {
      const [t, tpin] = execEnd(need(op, "to"));
      nodeOf(g, t);
      wireExec(g, src, pin, t, tpin, single);
    } else unwireExec(g, src, pin, single);
    return [];
  }
  if (kind === "set_attr" || kind === "remove_attr") {
    const t = targetOf(m, op);
    if (kind === "set_attr") {
      const a = attrOf(need(op, "attr"), false);
      t.attrs = [...t.attrs.filter((x: Attr) => x.name !== a.name), a];
    } else {
      const name = String(need(op, "name")).replace(/^[@#]+/, "");
      t.attrs = t.attrs.filter((x: Attr) => x.name !== name);
    }
    return [];
  }
  if (kind === "set_meta" || kind === "remove_meta") {
    const t = targetOf(m, op);
    if (kind === "set_meta") {
      const a = attrOf(need(op, "meta"), true);
      if (a.name === "note") t.meta.push(a);
      else t.meta = [...t.meta.filter((x: Attr) => x.name !== a.name), a];
    } else {
      const name = String(need(op, "name")).replace(/^@+/, ""), text = op.text ?? null;
      t.meta = t.meta.filter((x: Attr) => !(x.name === name && (text === null || (x.arg() !== null && x.arg()!.value === text))));
    }
    return [];
  }
  if (kind === "place") {
    const g = graphOf(m, op);
    const nid = need(op, "node");
    if (g.node(nid) === null && g.box(nid) === null) throw new EditError("E0101", `no node or box '${nid}' in ${g.name}`);
    const cur = g.box(nid) ?? g.place(nid);
    place(g, nid, op.x ?? (cur ? cur.x : 0), op.y ?? (cur ? cur.y : 0));
    const target = (g.box(nid) ?? g.place(nid))!;
    for (const [k, value] of Object.entries(op.props ?? {})) target.setProp(k, value === null ? null : propValue(value));
    return [];
  }
  if (kind === "delete_node") {
    const g = graphOf(m, op);
    const nid = need(op, "node");
    nodeOf(g, nid);
    const refs = [
      ...g.nodes.flatMap((n) => n.bindings.filter((b) => b.value instanceof PinRef && b.value.node === nid).map((b) => `${n.id}.${b.pin}`)),
      ...g.nodes.flatMap((n) => n.execs.filter((x) => x.target === nid).map(() => `${n.id} -> ${nid}`)),
    ];
    if (refs.length && !op.cascade) throw new EditError("request", `'${nid}' is still wired to ${refs.join(", ")}; set cascade to remove those wires too`);
    return deleteNode(g, nid);
  }
  if (kind === "rename") {
    if ("id" in op) {
      try {
        rename(m, op.id, need(op, "to"));
      } catch (e) {
        if (e instanceof RenameError) throw new EditError("request", e.message);
        throw e;
      }
      resolveEnumValues(m);
      return [];
    }
    const g = graphOf(m, op);
    nodeOf(g, need(op, "node"));
    if (!/^[A-Za-z_]\w*$/.test(String(need(op, "to")))) throw new EditError("request", `a node's name is an identifier, not '${op.to}'`);
    if (g.node(op.to) || g.box(op.to)) throw new EditError("E0102", `'${op.to}' is already used in ${g.name}`);
    renameNode(g, op.node, op.to);
    return [];
  }
  throw new EditError("request", `unknown op '${kind ?? "None"}'`);
}

function propValue(text: unknown): Lit {
  const p = new Parser(String(text));
  p.skipNl();
  return p.value();
}
