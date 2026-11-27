/** Canonical writer and hashes (spec section 2.5).
 *
 * A graph is written as its `exec` statements in the order they run, walked from its Entry
 * node (section 2.3). The writer decides how each node is written: inline in the one input it
 * feeds, as an `exec` statement where control reaches it, under a name (`node name = ...`)
 * when it is read or entered from more than one place, or after a `!` when nothing reaches it. */
import {
  Attr, Binding, Box, Class, Const, Enum, ExecOut, Extern, Graph, Interface, ITEM_ORDER, Item, itemKind, Lit,
  META_ORDER, Module, Node, NODE_GENERICS, Param, PinRef, SEMANTIC_ATTRS, stripComments, Struct, Use, Var,
} from "./model.js";
import { fieldPlace, flattenablePin, litEqual, litFits, ModuleIndex, outputValues, PLACE_MUTATORS, Sig, signature } from "./registry.js";
import { deepcopy, floatRepr, sha256Hex, sortedBy } from "./pyutil.js";
import { selfReceiver } from "./parser.js";

export const IND = "  ";

export const PLACE_PROP_ORDER = ["pos", "label", "color", "size", "collapsed", "hidden"];
export const BOX_PROP_ORDER = ["title", "pos", "size", "color"];
const _IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const _NOT_NAMES = new Set(["true", "false", "null", "self"]);

const pk = (nid: string, pin: string) => `${nid}\0${pin}`;
type Scope = Map<string, [string, string]>;

// -- values ----------------------------------------------------------------------
export function fmtString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\n";
    else if (ch === "\t") out += "\\t";
    else if (c < 0x20 || c === 0x7F) out += `\\u{${c.toString(16).toUpperCase()}}`;
    else out += ch;
  }
  return out + '"';
}

export function fmtFloat(x: number): string {
  if (!Number.isFinite(x)) throw new RangeError("non-finite float literal");
  let s = floatRepr(x);
  if (s.includes("e")) {
    const [mant, exp] = s.split("e");
    s = `${mant}e${parseInt(exp, 10)}`;
  }
  return s;
}

export function fmtLit(v: Lit): string {
  const k = v.kind;
  const sfx = v.suffix || "";
  if (k === "int") return `${v.value}${sfx}`;
  if (k === "float") return `${fmtFloat(Number(v.value))}${sfx}`;
  if (k === "bool") return v.value ? "true" : "false";
  if (k === "null") return "null";
  if (k === "string") return fmtString(v.value);
  if (k === "enum") return v.value.replace(".", "::");
  if (k === "ident") return v.value;
  if (k === "tuple") return "(" + v.value.map(fmtLit).join(", ") + ")";
  if (k === "list") return "[" + v.value.map(fmtLit).join(", ") + "]";
  if (k === "map") return "{" + v.value.map(([a, b]: [Lit, Lit]) => `${fmtLit(a)}: ${fmtLit(b)}`).join(", ") + "}";
  throw new RangeError(k);
}

/** A type as written. */
export function fmtType(t: string): string {
  return t;
}

export function fmtArgs(a: Attr): string {
  if (a.args === null) return "";
  return "(" + a.args.map(([k, v]) => (k ? `${k}: ` : "") + fmtLit(v)).join(", ") + ")";
}

export function fmtAttr(a: Attr): string {
  return `@${a.name}${fmtArgs(a)}`;
}

/** Known semantic attributes alphabetically, then unknown ones as written. */
export function sortedAttrs(attrs: Attr[]): Attr[] {
  const sem = sortedBy(attrs.filter((a) => SEMANTIC_ATTRS.has(a.name)), (a) => a.name);
  return [...sem, ...attrs.filter((a) => !SEMANTIC_ATTRS.has(a.name))];
}

/** Semantic decorators written before an element on its line: `@id("p1") `. */
export function fmtAttrs(attrs: Attr[]): string {
  return sortedAttrs(attrs).map((a) => fmtAttr(a) + " ").join("");
}

/** `doc`, `category`, `keywords`, then notes, then anything else; stable within each. */
export function sortedMeta(meta: Attr[]): Attr[] {
  return sortedBy(meta, (a) => {
    const i = META_ORDER.indexOf(a.name);
    return i < 0 ? META_ORDER.length : i;
  });
}

/** The metadata decorator lines above an element (section 2.4); none in the semantic text. */
export function fmtMeta(meta: Attr[], indent: string, semantic = false): string[] {
  if (semantic) return [];
  return sortedMeta(meta).map((a) => `${indent}${fmtAttr(a)}`);
}

/** The `//` lines attached to an element, directly above it (section 2.1). */
export function fmtComment(lines: string[], indent: string): string[] {
  return lines.map((c) => `${indent}//` + (c ? ` ${c}` : ""));
}

export interface Decorated { comment?: string[]; meta?: Attr[]; attrs?: Attr[] }

/** What stands directly above a declaration or statement: its `//` lines, its metadata
 * decorators, then (with `attrs`) its semantic decorators, one per line. */
export function decoratorLines(x: Decorated, indent: string, semantic = false, attrs = true): string[] {
  const out = [...fmtComment(x.comment ?? [], indent), ...fmtMeta(x.meta ?? [], indent, semantic)];
  if (attrs) for (const a of sortedAttrs(x.attrs ?? [])) out.push(`${indent}${fmtAttr(a)}`);
  return out;
}

export function above(x: Decorated, indent: string, semantic = false): string[] {
  return decoratorLines(x, indent, semantic);
}

export function fmtParam(p: Param): string {
  let s = `${fmtAttrs(p.attrs)}${p.name}: ${fmtType(p.type)}`;
  if (p.default_ !== null) s += ` = ${fmtLit(p.default_)}`;
  return s;
}

export function fmtParams(ps: Param[] | null, receiver = false): string {
  const parts = [...(receiver ? ["self"] : []), ...(ps ?? []).map(fmtParam)];
  return "(" + parts.join(", ") + ")";
}

/** `{key=value, ...}`: a node's or box's attribute block (section 2.3). */
export function fmtProps(props: [string, Lit][], order = PLACE_PROP_ORDER): string {
  const ps = sortedBy(props, ([k]) => {
    const i = order.indexOf(k);
    return i < 0 ? order.length : i;
  });
  return "{" + ps.map(([k, v]) => `${k}=${fmtLit(v)}`).join(", ") + "}";
}

const intLit = (x: number) => new Lit("int", BigInt(x));

export function placeProps(g: Graph, nid: string): [string, Lit][] {
  const p = g.place(nid);
  if (p === null) return [];
  return [["pos", new Lit("tuple", [intLit(p.x), intLit(p.y)])], ...p.props];
}

export function boxProps(b: Box): [string, Lit][] {
  return [["title", new Lit("string", b.title)],
          ["pos", new Lit("tuple", [intLit(b.x), intLit(b.y)])],
          ["size", new Lit("tuple", [intLit(b.w), intLit(b.h)])], ...b.props];
}

// -- nodes -----------------------------------------------------------------------
function orderedBindings(node: Node, sig: Sig): Binding[] {
  if (sig.error && !sig.inputs.length) return [...node.bindings];
  const order = new Map(sig.inputs.map((p, i) => [p.name, i]));
  const out: Binding[] = [];
  for (const b of node.bindings) {
    const pin = sig.input(b.pin);
    if (pin !== null && b.value instanceof Lit) {
      const d = pin.defaultLit();
      if (d !== null && litFits(b.value, pin.type) && litEqual(d, b.value) && !b.comment.length) continue;
    }
    out.push(b);
  }
  return sortedBy(out, (b) => order.get(b.pin) ?? order.size);
}

export function orderedExecs(node: Node, sig: Sig): ExecOut[] {
  const order = new Map(sig.exec_outs.map((p, i) => [p.name, i]));
  return sortedBy(node.execs, (e) => e.pin ? order.get(e.pin) ?? order.size : -1);
}

export function fmtTargs(targs: string[]): string {
  return targs.length ? "#<" + targs.map(fmtType).join(", ") + ">" : "";
}

/** The symbol as the canonical form writes it (section 2.3, rule 3). */
export function qualifiedSymbol(node: Node, g: Graph | null, idx: ModuleIndex): string | null {
  const sym = node.symbol;
  if (!sym || sym.includes(".") || g === null || !g.owner || !idx.classes.has(g.owner)) return sym;
  const k = node.kind;
  if (["GetField", "SetField", "Bind", "Unbind", "Broadcast"].includes(k) ||
      (PLACE_MUTATORS.has(k) && fieldPlace(sym, g, idx) !== null)) return `${g.owner}.${sym}`;
  return sym;
}

/** `Kind symbol#<targs>#count<n>`, or `ArrayAdd#<i32> acc` for a place mutator (3.3). */
export function fmtHead(node: Node, names: GraphNames | null = null): string {
  const targs = fmtTargs(node.targs);
  let sym = names !== null ? names.symbol(node) : node.symbol;
  if (node.kind === "Format" && sym !== null) sym = fmtString(sym);
  let head = PLACE_MUTATORS.has(node.kind) ? node.kind + targs + (sym ? ` ${sym}` : "")
    : node.kind + (sym ? ` ${sym}` : "") + targs;
  for (const a of node.attrs)
    if (NODE_GENERICS.includes(a.name)) head += `#${a.name}<` + (a.args ?? []).map(([, v]) => fmtLit(v)).join(", ") + ">";
  return head;
}

/** The semantic decorators of a node: all but its named generics. */
export function nodeDecorators(node: Node): Attr[] {
  return node.attrs.filter((a) => !NODE_GENERICS.includes(a.name));
}

type Out = [string, Stmt[] | null];

/** An `exec` statement of the tree: a node and its exec outputs' blocks. A block of null is
 * the flattened last output. */
export class ExecStmt {
  outs: Out[] = [];
  constructor(public nid: string, public comment: string[] = []) {}
}

export class GotoStmt {
  bound = false;
  constructor(public target: string, public tpin: string | null, public comment: string[]) {}
}

export type Stmt = ExecStmt | GotoStmt;
type Region = ["exec" | "block", Stmt[]] | ["pure", string];
type Anc = [string, string][];

/** How a graph's nodes are written (section 2.3). */
export class GraphNames {
  current: string | null = null;
  sigs: Map<string, Sig>;
  nodes = new Map<string, Node>();
  entry: string | null;
  params: Set<string>;
  refs = new Map<string, [string, string][]>();
  targets = new Map<string, [string, ExecOut][]>();
  parent = new Map<string, [string, string]>();
  children = new Map<string, Map<string, Node>>();
  owner = new Map<string, ExecOut>();
  regions: Region[] = [];
  placed = new Set<string>();
  top: Stmt[] = [];
  site = new Map<string, Anc>();
  goto_sites: [GotoStmt, Anc][] = [];
  named: string[] = [];
  name_of: Map<string, string> | null = null;
  _taken = new Set<string>();
  bound = new Map<string, Map<string, [string, string]>>();
  names = new Map<string, string>();

  constructor(public g: Graph, public idx: ModuleIndex, sigs: Map<string, Sig> | null = null, public semantic = false) {
    this.sigs = sigs ?? new Map(g.nodes.map((n) => [n.id, signature(n, g, idx)]));
    for (const n of g.nodes) if (!this.nodes.has(n.id)) this.nodes.set(n.id, n);
    this.entry = g.nodes.find((n) => n.kind === "Entry")?.id ?? null;
    this.params = new Set(g.params.map((p) => p.name));
    if (g.receiver) this.params.add("self");
    this._inline();
    this._tree();
    this._names();
    this._ids();
  }

  // -- which nodes are inline ------------------------------------------------
  private _inline(): void {
    const g = this.g, nodes = this.nodes;
    for (const n of g.nodes)
      for (const b of n.bindings)
        if (b.value instanceof PinRef && nodes.has(b.value.node)) {
          let l = this.refs.get(b.value.node);
          if (!l) this.refs.set(b.value.node, l = []);
          l.push([n.id, b.pin]);
        }
    for (const n of g.nodes)
      for (const e of n.execs) {
        let l = this.targets.get(e.target);
        if (!l) this.targets.set(e.target, l = []);
        l.push([n.id, e]);
      }
    const ids = g.nodes.map((n) => n.id);
    const count = (id: string) => ids.filter((x) => x === id).length;
    for (const n of g.nodes) {
      const sig = this.sigs.get(n.id);
      const r = this.refs.get(n.id) ?? [];
      if (sig !== undefined && r.length === 1 && r[0][0] !== n.id && count(n.id) === 1 &&
          count(r[0][0]) === 1 && !n.named && !n.execs.length && !n.comment.length &&
          !this.targets.has(n.id) && !sig.error && !sig.exec_ins.length && !sig.exec_outs.length &&
          !["Entry", "Return", "Exit", "Leave"].includes(n.kind) &&
          nodes.get(r[0][0])!.bindings.filter((b) => b.pin === r[0][1]).length === 1)
        this.parent.set(n.id, r[0]);
    }
    for (const nid of [...this.parent.keys()]) {
      const seen: string[] = [];
      let cur = nid;
      while (this.parent.has(cur) && !seen.includes(cur)) {
        seen.push(cur);
        cur = this.parent.get(cur)![0];
      }
      if (seen.includes(cur)) for (const x of seen.slice(seen.indexOf(cur))) this.parent.delete(x);
    }
    for (const [nid, [c, pin]] of this.parent) {
      let m = this.children.get(c);
      if (!m) this.children.set(c, m = new Map());
      m.set(pin, nodes.get(nid)!);
    }
  }

  /** The node whose statement an inline node is written in. */
  root(nid: string): string {
    const seen = new Set<string>();
    while (this.parent.has(nid) && !seen.has(nid)) {
      seen.add(nid);
      nid = this.parent.get(nid)![0];
    }
    return nid;
  }

  /** Whether a node that is not inline is written as an `exec` statement. */
  isExec(nid: string): boolean {
    const n = this.nodes.get(nid)!, sig = this.sigs.get(nid)!;
    return !!(sig.exec_ins.length || sig.exec_outs.length || n.execs.length || this.targets.has(nid) ||
              (sig.error && !(this.refs.get(nid)?.length)) || ["Entry", "Return", "Exit", "Leave"].includes(n.kind));
  }

  /** Whether an exec wire enters `nid` at its default input. */
  defaultIn(nid: string, tpin: string | null): boolean {
    if (tpin === null) return true;
    if (!this.nodes.has(nid)) return false;
    const ins = this.sigs.get(nid)!.exec_ins;
    return ins.length > 0 && ins[0].name === tpin;
  }

  // -- the exec tree ---------------------------------------------------------
  private _tree(): void {
    this.owner = new Map();
    this.regions = [];
    if (this.entry !== null) {
      this._chooseOwners();
      this.placed = new Set();
      this.top = [];
      this._walk(this.entry, this.top);
      const missed = new Set([...this._gotos(this.top)].map((s) => s.target).filter((t) => !this.placed.has(t)));
      if ([...missed].some((t) => this.nodes.has(t) && this._reaches(this.entry!, t))) {
        this.owner = new Map();
        this.placed = new Set();
        this.top = [];
        this._walk(this.entry, this.top);
      }
    } else {
      this.placed = new Set();
      this.top = [];
    }
    let rest = this.g.nodes.map((n) => n.id).filter((i) => !this.parent.has(i) && !this.placed.has(i) && this.isExec(i));
    if (this.semantic) rest = sortedBy(rest, (i) => [this.nodes.get(i)!.kind, this.nodes.get(i)!.symbol || "", i]);
    const seen = new Set<string>();
    rest = rest.filter((i) => !seen.has(i) && (seen.add(i), true));
    const fed = new Set<string>();
    for (const i of rest) for (const e of this.nodes.get(i)!.execs) fed.add(e.target);
    for (const nid of [...rest.filter((i) => !fed.has(i)), ...rest]) {
      if (this.placed.has(nid)) continue;
      const stmts: Stmt[] = [];
      this._walk(nid, stmts);
      const alone = stmts.length === 1 && !(stmts[0] as ExecStmt).outs.some(([, blk]) => blk && blk.length);
      this.regions.push([alone ? "exec" : "block", stmts]);
    }
    let pure = this.g.nodes.map((n) => n.id).filter((i) => !this.parent.has(i) && !this.placed.has(i) &&
      !this.isExec(i) && !this.nodes.get(i)!.named && !(this.refs.get(i)?.length));
    if (this.semantic) pure = sortedBy(pure, (i) => [this.nodes.get(i)!.kind, this.nodes.get(i)!.symbol || "", i]);
    for (const nid of pure) this.regions.push(["pure", nid]);
    this._flattenAll();
  }

  private *_gotos(stmts: Stmt[]): Generator<GotoStmt> {
    for (const st of stmts) {
      if (st instanceof GotoStmt) yield st;
      else for (const [, blk] of st.outs) yield* this._gotos(blk ?? []);
    }
  }

  /** Whether exec wires lead from `a` to `b`. */
  private _reaches(a: string, b: string): boolean {
    const seen = new Set<string>(), work = [a];
    while (work.length) {
      const x = work.pop()!;
      if (x === b) return true;
      if (seen.has(x) || !this.nodes.has(x)) continue;
      seen.add(x);
      for (const e of this.nodes.get(x)!.execs) work.push(e.target);
    }
    return false;
  }

  /** Where to write a node that several exec wires enter. */
  private _chooseOwners(): void {
    const preds = new Map<string, ExecOut[]>();
    for (const n of this.g.nodes)
      for (const e of n.execs)
        if (this.defaultIn(e.target, e.target_pin)) {
          let l = preds.get(e.target);
          if (!l) preds.set(e.target, l = []);
          l.push(e);
        }
    const multi = new Set([...preds].filter(([t, es]) => es.length > 1 && this.nodes.has(t)).map(([t]) => t));
    if (!multi.size) return;
    const seenEdges: [string, ExecOut, number][] = [];
    this.placed = new Set();
    this._probe(this.entry!, 0, seenEdges);
    const best = new Map<string, [[number, number], ExecOut]>();
    seenEdges.forEach(([src, e, d], k) => {
      const t = e.target;
      if (!multi.has(t) || this._reaches(t, src)) return;
      const cur = best.get(t);
      if (!cur || d < cur[0][0] || (d === cur[0][0] && k < cur[0][1])) best.set(t, [[d, k], e]);
    });
    this.owner = new Map([...best].map(([t, [, e]]) => [t, e]));
  }

  private _probe(nid0: string, d0: number, seenEdges: [string, ExecOut, number][]): void {
    const stack: [string, number][] = [[nid0, d0]];
    while (stack.length) {
      const [nid, d] = stack.pop()!;
      if (this.placed.has(nid) || !this.nodes.has(nid)) continue;
      this.placed.add(nid);
      const n = this.nodes.get(nid)!, sig = this.sigs.get(nid)!;
      const edges = orderedExecs(n, sig);
      const nxt: [string, number][] = [];
      const single = edges.length === 1 && sig.exec_outs.length <= 1;
      edges.forEach((e, i) => {
        const last = i === edges.length - 1;
        const cd = single || (last && this.flattens(nid, e.pin)) ? d : d + 1;
        seenEdges.push([nid, e, cd]);
        const t = e.target;
        if (this.nodes.has(t) && !this.parent.has(t) && this.isExec(t)) nxt.push([t, cd]);
      });
      stack.push(...nxt.reverse());
    }
  }

  /** Place `nid` in `stmts` and follow its wires. */
  private _walk(nid: string, stmts: Stmt[]): void {
    for (;;) {
      this.placed.add(nid);
      const st = new ExecStmt(nid);
      stmts.push(st);
      const n = this.nodes.get(nid)!, sig = this.sigs.get(nid)!;
      const edges = orderedExecs(n, sig);
      const valued = outputValues(sig);
      if (!edges.length && !valued.length) return;
      const outs = sig.exec_outs;
      const single = edges.length === 1 && outs.length <= 1 &&
        (edges[0].pin === null || (outs.length > 0 && edges[0].pin === outs[0].name));
      if (!single) {
        for (const e of edges) {
          const blk: Stmt[] = [];
          st.outs.push([e.pin || (outs.length ? outs[0].name : "then"), blk]);
          const nxt = this._follow(e, blk);
          if (nxt !== null) this._walk(nxt, blk);
        }
        const wired = new Set(st.outs.map((o) => o[0]));
        for (const p of valued) if (!wired.has(p)) st.outs.push([p, []]);
        const order = new Map(outs.map((p, i) => [p.name, i]));
        st.outs = sortedBy(st.outs, (o) => order.get(o[0]) ?? order.size);
        return;
      }
      const nxt = this._follow(edges[0], stmts);
      if (nxt === null) return;
      nid = nxt;
    }
  }

  /** The node an exec wire places next, or null after writing a `goto` for it. */
  private _follow(e: ExecOut, stmts: Stmt[]): string | null {
    const t = e.target;
    const owner = this.owner.get(t);
    if (this.nodes.has(t) && !this.placed.has(t) && !this.parent.has(t) && this.defaultIn(t, e.target_pin) &&
        this.isExec(t) && (owner === undefined || owner === e)) {
      if (e.comment.length) {
        const tn = this.nodes.get(t)!;
        tn.comment = [...e.comment, ...tn.comment];
      }
      return t;
    }
    stmts.push(new GotoStmt(t, this.defaultIn(t, e.target_pin) ? null : e.target_pin, [...e.comment]));
    return null;
  }

  private _flattenAll(): void {
    const uses = this._uses();
    const lists = [this.top, ...this.regions.filter((r) => r[0] !== "pure").map((r) => r[1] as Stmt[])];
    for (const stmts of lists) this._flatten(stmts, uses);
  }

  private _flatten(stmts: Stmt[], uses: Set<string>): void {
    let i = 0;
    while (i < stmts.length) {
      const st = stmts[i];
      let flattened = false;
      if (st instanceof ExecStmt && st.outs.length) {
        for (const out of st.outs) if (out[1] !== null) this._flatten(out[1], uses);
        const last = st.outs[st.outs.length - 1];
        if (last[1] && last[1].length && !uses.has(pk(st.nid, last[0])) && this.flattens(st.nid, last[0])) {
          stmts.splice(i + 1, 0, ...last[1]);
          last[1] = null;
          flattened = true;
        }
      }
      if (st instanceof ExecStmt && !flattened && i === stmts.length - 1) {
        const pin = this.flatUnwired(st);
        if (pin !== null) st.outs.push([pin, null]);
      }
      i += 1;
    }
  }

  /** Whether a node's last exec output, `pin`, continues in its block (section 2.5). */
  flattens(nid: string, pin: string | null = null): boolean {
    const n = this.nodes.get(nid)!;
    if (n.flat !== null && !this.semantic) {
      if (n.flat && pin !== null && n.flat_pin !== null && pin !== n.flat_pin &&
          n.flat_pin === flattenablePin(n, this.sigs.get(nid)!)) return false;
      return n.flat;
    }
    return n.kind === "Try" || n.kind === "Sequence";
  }

  /** The bottom exec output of a node flattened on the canvas, when nothing is wired to it. */
  flatUnwired(st: ExecStmt): string | null {
    const n = this.nodes.get(st.nid)!, sig = this.sigs.get(st.nid)!;
    if (this.semantic || !n.flat || n.flat_pin === null) return null;
    if (n.flat_pin !== flattenablePin(n, sig) || st.outs.some((o) => o[0] === n.flat_pin)) return null;
    return n.flat_pin;
  }

  private _sites(): void {
    this.site = new Map();
    this.goto_sites = [];
    const visit = (stmts: Stmt[], anc: Anc) => {
      for (const st of stmts) {
        if (st instanceof GotoStmt) {
          this.goto_sites.push([st, anc]);
          continue;
        }
        this.site.set(st.nid, anc);
        for (const [pin, blk] of st.outs) if (blk !== null) visit(blk, [...anc, [st.nid, pin]]);
      }
    };
    visit(this.top, []);
    for (const r of this.regions) if (r[0] !== "pure") visit(r[1] as Stmt[], []);
  }

  /** [site blocks, producer id, output pin, consumer id] for every data wire not inline. */
  reads(): [Anc, string, string | null, string][] {
    const out: [Anc, string, string | null, string][] = [];
    const add = (n: Node) => {
      const root = this.root(n.id);
      const anc = this._declared(root) ? [] : this.site.get(root) ?? [];
      for (const b of n.bindings)
        if (b.value instanceof PinRef && this.nodes.has(b.value.node) && (this.parent.get(b.value.node)?.[0] ?? null) !== n.id)
          out.push([anc, b.value.node, b.value.pin, n.id]);
    };
    for (const n of this.g.nodes) if (!this.parent.has(n.id)) add(n);
    for (const nid of this.parent.keys()) add(this.nodes.get(nid)!);
    return out;
  }

  private _declared(nid: string): boolean {
    return (this.name_of !== null && this.name_of.has(nid)) || this.nodes.get(nid)!.named;
  }

  private _uses(): Set<string> {
    this._sites();
    const uses = new Set<string>();
    for (const [anc, x] of this.reads())
      for (const blk of anc) if (blk[0] === x && x !== this.entry) uses.add(pk(blk[0], blk[1]));
    for (const [st, anc] of this.goto_sites)
      if (st.tpin !== null) for (const blk of anc) if (blk[0] === st.target) uses.add(pk(blk[0], blk[1]));
    return uses;
  }

  // -- names -----------------------------------------------------------------
  private _names(): void {
    this._sites();
    const g = this.g;
    this.named = g.nodes.filter((n) => n.named && !this.parent.has(n.id)).map((n) => n.id);
    if (this.semantic) this.named = sortedBy(this.named);
    const nameOf = this.name_of = new Map(this.named.map((nid) => [nid, nid]));
    const taken = new Set([...nameOf.values(), ...this.params]);
    for (const k of this.idx.module?.retired_nodes ?? []) {
      const [gn, i] = k.split("\0");
      if (gn === g.name) taken.add(i);
    }
    this._taken = taken;
    const need = new Set<string>();
    for (const nid of this.nodes.keys()) {
      if (this.parent.has(nid) || nameOf.has(nid) || this.isExec(nid)) continue;
      if (this.refs.get(nid)?.length || this.nodes.get(nid)!.comment.length) need.add(nid);
    }
    for (const [st] of this.goto_sites) if (st.tpin === null && this.nodes.has(st.target)) need.add(st.target);
    for (;;) {
      for (const nid of sortedBy([...need].filter((x) => !nameOf.has(x)), (x) => this._order(x))) this._name(nid);
      const reads = this.reads();
      this.bound = new Map();
      const more = new Set<string>();
      const bind = (blk: [string, string], name: string, val: [string, string]) => {
        const k = pk(blk[0], blk[1]);
        let m = this.bound.get(k);
        if (!m) this.bound.set(k, m = new Map());
        m.set(name, val);
      };
      for (const [anc, x, pin] of reads) {
        if (x === this.entry || nameOf.has(x) || this.parent.has(x) || !this.isExec(x)) continue;
        const blk = anc.find((b) => b[0] === x);
        if (blk === undefined) more.add(x);
        else bind(blk, pin!, [x, pin!]);
      }
      for (const [st, anc] of this.goto_sites) {
        if (st.tpin === null || nameOf.has(st.target) || !this.nodes.has(st.target)) continue;
        const blk = anc.find((b) => b[0] === st.target);
        if (blk === undefined) more.add(st.target);
        else bind(blk, st.tpin, [st.target, st.tpin]);
      }
      const names = new Set([...nameOf.values(), ...this.params]);
      for (const [k, bound] of this.bound)
        if ([...bound.keys()].some((x) => names.has(x))) more.add(k.split("\0")[0]);
      for (const [anc, x, pin] of reads) {
        if (nameOf.has(x) || x === this.entry) continue;
        let inside = false;
        for (const b of anc) {
          if (b[0] === x) {
            inside = true;
            continue;
          }
          const bb = this.bound.get(pk(b[0], b[1]));
          if (inside && bb && bb.has(pin!) && bb.get(pin!)![0] !== x) more.add(x);
        }
      }
      if (![...more].some((x) => !nameOf.has(x))) break;
      for (const x of more) need.add(x);
    }
    const declaredNames = new Set([...nameOf.values()].filter((v) => !this.named.includes(v)));
    if (this.entry !== null && !nameOf.has(this.entry) && [...this.params].some((p) => declaredNames.has(p)))
      this._name(this.entry);
    else if (this.entry !== null && !nameOf.has(this.entry) && [...this.params].some((p) => this.named.includes(p)))
      this._name(this.entry);
    for (const [st] of this.goto_sites) if (st.tpin !== null && !nameOf.has(st.target)) st.bound = true;
  }

  private _order(nid: string): number {
    return this.nodes.has(nid) ? this.g.nodes.findIndex((n) => n.id === nid) : 0;
  }

  /** A name for a node that must be named. */
  private _name(nid: string): void {
    const n = this.nodes.get(nid)!;
    let name: string;
    if (_IDENT_RE.test(nid) && !this._taken.has(nid) && !_NOT_NAMES.has(nid)) name = nid;
    else {
      const parts = (n.symbol || "").split(".");
      const last = parts[parts.length - 1];
      let base = n.kind === "Entry" ? "entry" : last && _IDENT_RE.test(last) && n.kind !== "Format" ? last : n.kind;
      base = base.replace(/(?<=[a-z0-9])(?=[A-Z])/g, "_").toLowerCase();
      base = base.replace(/[^a-z0-9_]/g, "_").replace(/^_+|_+$/g, "") || "node";
      if (!_IDENT_RE.test(base) || _NOT_NAMES.has(base)) base = "n_" + base;
      name = base;
      let k = 2;
      while (this._taken.has(name)) {
        name = `${base}_${k}`;
        k += 1;
      }
    }
    this._taken.add(name);
    this.name_of!.set(nid, name);
    this.named.push(nid);
  }

  // -- ids -------------------------------------------------------------------
  private _ids(): void {
    this.names = new Map(this.name_of!);
    const block = (stmts: Stmt[], prefix: string) => {
      let k = 0;
      for (const st of stmts) {
        if (st instanceof GotoStmt) continue;
        if (!this.names.has(st.nid)) this.names.set(st.nid, `${prefix}${k}`);
        k += 1;
        for (const [pin, blk] of st.outs) if (blk !== null) block(blk, `${this.names.get(st.nid)}.${pin}.`);
      }
    };
    block(this.top, "");
    this.regions.forEach((reg, r) => {
      if (reg[0] === "pure") {
        if (!this.names.has(reg[1])) this.names.set(reg[1], `~${r}`);
      } else if (reg[0] === "exec") {
        const s0 = reg[1][0] as ExecStmt;
        if (!this.names.has(s0.nid)) this.names.set(s0.nid, `~${r}`);
        for (const [pin, blk] of s0.outs) if (blk !== null) block(blk, `${this.names.get(s0.nid)}.${pin}.`);
      } else block(reg[1], `~${r}.`);
    });
    for (const nid of this.nodes.keys()) if (!this.names.has(nid) && !this.parent.has(nid)) this.names.set(nid, nid);
    const name = (nid: string): string => {
      if (!this.names.has(nid)) {
        const [c, pin] = this.parent.get(nid)!;
        this.names.set(nid, `${name(c)}.${pin}`);
      }
      return this.names.get(nid)!;
    };
    for (const nid of this.parent.keys()) name(nid);
  }

  name(nid: string): string {
    return this.names.get(nid) ?? nid;
  }

  symbol(node: Node): string | null {
    return qualifiedSymbol(node, this.g, this.idx);
  }

  inline(nid: string): boolean {
    return this.parent.has(nid);
  }

  isNamed(nid: string): boolean {
    return this.name_of!.has(nid);
  }

  /** The named nodes, in the order they were named. */
  declared(): Node[] {
    return this.named.filter((nid) => this.nodes.has(nid)).map((nid) => this.nodes.get(nid)!);
  }

  boundAt(nid: string, pin: string): Map<string, [string, string]> {
    return this.bound.get(pk(nid, pin)) ?? new Map();
  }
}

/** Whether a wire from a named node is written with its name alone (section 2.3). */
export function impliedOutput(ref: PinRef, names: GraphNames): boolean {
  const sig = names.sigs.get(ref.node);
  if (sig === undefined || sig.error || !names.isNamed(ref.node)) return false;
  const n = names.g.node(ref.node);
  const outs = sig.data_outs;
  return n !== null && n.kind !== "Entry" && n.kind !== "Macro" && outs.length === 1 && outs[0].name === ref.pin;
}

export function fmtValue(b: Binding, names: GraphNames | null = null, scope: Scope | null = null): string {
  const v = b.value;
  if (!(v instanceof PinRef)) return fmtLit(v);
  if (names === null) return v.pin ? `${v.node}.${v.pin}` : v.node;
  if (!names.nodes.has(v.node)) return !v.pin ? v.node : `${v.node}.${v.pin}`;
  if (v.node === names.entry && !names.isNamed(v.node)) return v.pin!;
  const s = scope !== null && v.pin !== null ? scope.get(v.pin) : undefined;
  if (s !== undefined && s[0] === v.node && s[1] === v.pin) return v.pin!;
  if (impliedOutput(v, names) && (scope === null || !scope.has(names.name(v.node)))) return names.name(v.node);
  return `${names.name(v.node)}.${v.pin}`;
}

/** The value of a binding. An inline node is written in place. */
export function fmtInput(b: Binding, indent: string, names: GraphNames | null = null, scope: Scope | null = null): string {
  const kids = names !== null ? names.children.get(names.current!) ?? new Map<string, Node>() : new Map<string, Node>();
  const kid = kids.get(b.pin);
  if (kid === undefined || !(b.value instanceof PinRef) || b.value.node !== kid.id) return fmtValue(b, names, scope);
  const sig = names!.sigs.get(kid.id)!;
  const text = fmtExpr(kid, sig, indent, names, false, scope);
  const outs = sig.data_outs;
  if (!sig.error && outs.length === 1 && outs[0].name === b.value.pin) return text;
  return `${text}.${b.value.pin}`;
}

function implicitSelf(node: Node, b: Binding, names: GraphNames): boolean {
  return b.pin === "self" && b.value instanceof PinRef && b.value.node === names.entry && b.value.pin === "self" &&
    !b.comment.length && !names.isNamed(names.entry!) && selfReceiver(node, names.g, names.idx);
}

/** `Kind symbol#<targs>{attrs}(`, one `.pin <- value` line per bound input and `)`. */
export function fmtExpr(node: Node, sig: Sig, indent: string, names: GraphNames | null = null, semantic = false,
                        scope: Scope | null = null): string {
  let bindings = orderedBindings(node, sig);
  const valued = new Set(outputValues(sig));
  bindings = bindings.filter((b) => !valued.has(b.pin));
  if (names !== null) bindings = bindings.filter((b) => !implicitSelf(node, b, names));
  let head = fmtHead(node, names);
  if (names !== null && !semantic && !names.semantic) {
    const props = placeProps(names.g, node.id);
    if (props.length) head += fmtProps(props);
  }
  if (!bindings.length) return head + "()";
  const lines = [head + "("];
  for (const b of bindings) {
    if (names !== null) names.current = node.id;
    const kid = names !== null ? names.children.get(node.id)?.get(b.pin) : undefined;
    const val = fmtInput(b, indent + IND, names, scope);
    lines.push(...fmtComment(b.comment, indent + IND));
    if (kid !== undefined && b.value instanceof PinRef && b.value.node === kid.id)
      lines.push(...decoratorLines({ meta: kid.meta, attrs: nodeDecorators(kid) }, indent + IND, semantic || names!.semantic));
    lines.push(`${indent}${IND}.${b.pin} <- ${val}`);
  }
  lines.push(`${indent})`);
  return lines.join("\n");
}

// -- graphs and module -----------------------------------------------------------
export function fmtLocal(kw: string, l: { attrs: Attr[]; name: string; type: string; default_: Lit | null; meta: Attr[]; comment: string[] },
                         indent: string, semantic = false): string[] {
  let s = `${indent}${fmtAttrs(l.attrs)}${kw} ${l.name}: ${fmtType(l.type)}`;
  if (l.default_ !== null) s += ` = ${fmtLit(l.default_)}`;
  return [...decoratorLines(l, indent, semantic, false), s];
}

/** The binding a function is written `= value` with (section 2.3), or null. */
export function exprValue(g: Graph, names: GraphNames): Binding | null {
  if (g.kind !== "func" || g.owner || g.results === null || g.results.length !== 1 || g.locals.length ||
      g.states.length || g.places.length || g.boxes.length || g.nodes.some((n) => n.meta.length) || names.regions.length)
    return null;
  if (names.top.length !== 2 || !names.top.every((s) => s instanceof ExecStmt)) return null;
  const entry = names.nodes.get((names.top[0] as ExecStmt).nid)!, ret = names.nodes.get((names.top[1] as ExecStmt).nid)!;
  if (entry.kind !== "Entry" || ret.kind !== "Return" || names.named.length) return null;
  if (entry.bindings.length || entry.attrs.length || entry.comment.length || ret.attrs.length || ret.comment.length || ret.execs.length)
    return null;
  if (entry.execs.length !== 1 || entry.execs[0].comment.length) return null;
  if (ret.bindings.length !== 1 || ret.bindings[0].pin !== g.results[0].name || ret.bindings[0].comment.length) return null;
  const inl = [...names.parent.keys()].filter((nid) => names.root(nid) === ret.id).length;
  if (g.nodes.length !== 2 + inl) return null;
  return ret.bindings[0];
}

function boundList(names: GraphNames, nid: string, pin: string): string {
  const bound = names.boundAt(nid, pin);
  if (!bound.size) return "";
  const sig = names.sigs.get(nid)!;
  const all = [...sig.data_outs, ...sig.exec_ins];
  const order = new Map(all.map((p, i) => [p.name, i]));
  return "|" + sortedBy(bound.keys(), (k) => order.get(k) ?? order.size).join(", ") + "|";
}

export function fmtStmts(stmts: Stmt[], names: GraphNames, indent: string, scope: Scope, semantic: boolean): string[] {
  const lines: string[] = [];
  for (const st of stmts) {
    if (st instanceof GotoStmt) {
      if (!semantic) lines.push(...fmtComment(st.comment, indent));
      if (st.bound) lines.push(`${indent}goto ${st.tpin}`);
      else lines.push(`${indent}goto ${names.name(st.target)}` + (st.tpin ? `.${st.tpin}` : ""));
      continue;
    }
    lines.push(...fmtExec(st, names, indent, scope, semantic));
  }
  return lines;
}

export function fmtExec(st: ExecStmt, names: GraphNames, indent: string, scope: Scope, semantic: boolean, bang = ""): string[] {
  const n = names.nodes.get(st.nid)!, sig = names.sigs.get(st.nid)!;
  let lines: string[];
  if (names.isNamed(st.nid)) lines = [`${indent}${bang}exec ${names.name(st.nid)}`];
  else {
    const deco = decoratorLines({ meta: n.meta, attrs: nodeDecorators(n), comment: n.comment }, indent, semantic);
    lines = [...deco, ...(`${indent}${bang}exec ` + fmtExpr(n, sig, indent, names, semantic, scope)).split("\n")];
  }
  const valued = new Set(outputValues(sig));
  for (const [pin, blk] of st.outs) {
    let head = `.${pin}`;
    const b = valued.has(pin) ? n.binding(pin) : null;
    if (b !== null) {
      names.current = st.nid;
      head += " " + fmtInput(b, indent, names, scope);
    }
    if (blk === null) {
      append(lines, head);
      continue;
    }
    if (!blk.length) {
      append(lines, head + " -> {}");
      continue;
    }
    const inner: Scope = new Map(scope);
    for (const [k, v] of names.boundAt(st.nid, pin)) inner.set(k, v);
    append(lines, `${head}${boundList(names, st.nid, pin)} -> {`);
    lines.push(...fmtStmts(blk, names, indent + IND, inner, semantic));
    lines.push(`${indent}}`);
  }
  return lines;
}

/** Continue the last line with `text`, which may run over several lines. */
function append(lines: string[], text: string): void {
  const [first, ...rest] = text.split("\n");
  lines[lines.length - 1] += first;
  lines.push(...rest);
}

/** A graph: its decorators and head, then its locals and states, its boxes, its named nodes,
 * its `exec` statements from Entry, and the statements that nothing reaches. */
export function fmtGraph(g: Graph, idx: ModuleIndex, indent = "", semantic = false): string[] {
  let head = `${indent}${g.kind} ${g.short_name}`;
  if (g.tparams.length) head += "#<" + g.tparams.join(", ") + ">";
  head += fmtParams(g.params, !!g.receiver);
  if (g.results !== null) head += " -> " + fmtParams(g.results);
  const names = new GraphNames(g, idx, null, semantic);
  const lines = [...decoratorLines(g, indent, semantic), head];
  const value = exprValue(g, names);
  if (value !== null) {
    names.current = (names.top[1] as ExecStmt).nid;
    return [...lines.slice(0, -1), lines[lines.length - 1] + " = " + fmtInput(value, indent, names, new Map())];
  }
  lines[lines.length - 1] += " {";
  const inner = indent + IND;
  const groups: string[][] = [];
  const loc: string[] = [];
  for (const l of sortedBy(g.locals, (l) => l.name)) loc.push(...fmtLocal("local", l, inner, semantic));
  for (const l of sortedBy(g.states, (l) => l.name)) loc.push(...fmtLocal("state", l, inner, semantic));
  groups.push(loc);
  if (!semantic) {
    const bx: string[] = [];
    for (const b of g.boxes) {
      bx.push(...fmtMeta(b.meta, inner));
      bx.push(`${inner}box ${fmtProps(boxProps(b), BOX_PROP_ORDER)}`);
    }
    groups.push(bx);
  }
  const decl: string[] = [];
  for (const n of names.declared()) {
    const sig = names.sigs.get(n.id)!;
    decl.push(...decoratorLines({ meta: n.meta, attrs: nodeDecorators(n), comment: n.comment }, inner, semantic));
    decl.push(...(`${inner}node ${names.name(n.id)} = ` + fmtExpr(n, sig, inner, names, semantic, new Map())).split("\n"));
  }
  groups.push(decl);
  groups.push(fmtStmts(names.top, names, inner, new Map(), semantic));
  for (const reg of names.regions) {
    if (reg[0] === "pure") {
      const n = names.nodes.get(reg[1])!;
      const deco = decoratorLines({ meta: n.meta, attrs: nodeDecorators(n), comment: n.comment }, inner, semantic);
      groups.push([...deco, ...(`${inner}!` + fmtExpr(n, names.sigs.get(reg[1])!, inner, names, semantic, new Map())).split("\n")]);
    } else if (reg[0] === "exec") {
      groups.push(fmtExec(reg[1][0] as ExecStmt, names, inner, new Map(), semantic, "!"));
    } else {
      groups.push([`${inner}!{`, ...fmtStmts(reg[1], names, inner + IND, new Map(), semantic), `${inner}}`]);
    }
  }
  const body: string[] = [];
  for (const grp of groups) {
    if (grp.length) {
      if (body.length) body.push("");
      body.push(...grp);
    }
  }
  return [...lines, ...body, indent + "}"];
}

/** A struct or enum. Members keep the order written. */
export function fmtTypeDecl(it: Struct | Enum, semantic = false): string[] {
  let head: string;
  const members: [Decorated, string][] = [];
  if (it instanceof Struct) {
    head = `struct ${it.name}`;
    for (const f of it.fields) {
      let line = `${IND}${fmtAttrs(f.attrs)}${f.name}: ${fmtType(f.type)}`;
      if (f.default_ !== null) line += ` = ${fmtLit(f.default_)}`;
      members.push([f, line]);
    }
  } else {
    head = `enum ${it.name}` + (it.base ? `: ${it.base}` : "");
    for (const m of it.members)
      members.push([m, `${IND}${fmtAttrs(m.attrs)}${m.name}` + (m.value !== null ? ` = ${m.value}` : "")]);
  }
  if (!members.length) return [head + " {}"];
  const lines = [head + " {"];
  for (const [m, line] of members) {
    lines.push(...decoratorLines(m, IND, semantic, false));
    lines.push(line);
  }
  return [...lines, "}"];
}

/** A class: fields in the order written, then its methods, funcs before events, by name. */
export function fmtClass(c: Class, methods: Graph[], idx: ModuleIndex, semantic = false): string[] {
  const head = `class ${c.name}` + (c.base ? ` : ${c.base}` : "") + (c.impls.length ? ` impl ${c.impls.join(", ")}` : "");
  if (!c.fields.length && !c.dispatchers.length && !methods.length) return [head + " {}"];
  const lines = [head + " {"];
  for (const f of c.fields) {
    let line = `${IND}${fmtAttrs(f.attrs)}${f.name}: ${fmtType(f.type)}`;
    if (f.default_ !== null) line += ` = ${fmtLit(f.default_)}`;
    lines.push(...decoratorLines(f, IND, semantic, false));
    lines.push(line);
  }
  for (const d of c.dispatchers) {
    lines.push(...decoratorLines(d, IND, semantic));
    lines.push(`${IND}dispatcher ${d.name}${fmtParams(d.params)}`);
  }
  for (const g of sortedBy(methods, (g) => [g.kind !== "func" ? 1 : 0, g.name])) {
    if (lines.length > 1) lines.push("");
    lines.push(...fmtGraph(g, idx, IND, semantic));
  }
  return [...lines, "}"];
}

/** An interface: its method signatures in the order written (their dispatch slots). */
export function fmtInterface(it: Interface, semantic = false): string[] {
  const head = `interface ${it.name}`;
  if (!it.methods.length) return [head + " {}"];
  const lines = [head + " {"];
  for (const m of it.methods) {
    let s = `${IND}func ${m.name}${fmtParams(m.params, true)}`;
    if (m.results !== null) s += " -> " + fmtParams(m.results);
    lines.push(...decoratorLines(m, IND, semantic));
    lines.push(s);
  }
  return [...lines, "}"];
}

export function fmtItem(it: Item, idx: ModuleIndex, semantic = false, methods: Graph[] | null = null): string[] {
  if (it instanceof Graph) return fmtGraph(it, idx, "", semantic);
  if (it instanceof Interface) return [...above(it, "", semantic), ...fmtInterface(it, semantic)];
  if (it instanceof Class) return [...above(it, "", semantic), ...fmtClass(it, methods ?? [], idx, semantic)];
  if (it instanceof Struct || it instanceof Enum) return [...above(it, "", semantic), ...fmtTypeDecl(it, semantic)];
  return [...above(it, "", semantic), ...fmtDecl(it)];
}

function fmtDecl(it: Item): string[] {
  if (it instanceof Use) return [`use ${it.name}` + (it.alias ? ` as ${it.alias}` : "")];
  if (it instanceof Extern) {
    if (it.kind === "type") return [`extern type ${it.name}`];
    let s = `extern func ${it.name}${fmtParams(it.params)}`;
    if (it.results !== null) s += " -> " + fmtParams(it.results);
    return [s];
  }
  if (it instanceof Const) return [`const ${it.name}: ${fmtType(it.type)} = ${fmtLit(it.value)}`];
  if (it instanceof Var) return [`var ${it.name}: ${fmtType(it.type)}` + (it.default_ !== null ? ` = ${fmtLit(it.default_)}` : "")];
  throw new TypeError(String(it));
}

export function printModule(m: Module, semantic = false): string {
  if (semantic) {
    m = deepcopy(m);
    stripComments(m);
  }
  const idx = new ModuleIndex(m);
  const lines = [`wiret ${m.version}`, ...above(m, "", semantic), `module ${m.name}`];
  const owned = new Map<string, Graph[]>();
  for (const it of m.items)
    if (it instanceof Graph && it.owner) {
      let l = owned.get(it.owner);
      if (!l) owned.set(it.owner, l = []);
      l.push(it);
    }
  const items = sortedBy(m.items.filter((it) => !(it instanceof Graph && it.owner)),
    (it) => [ITEM_ORDER.indexOf(itemKind(it)), it.name]);
  let prevKind: string | null = null;
  for (const it of items) {
    const k = itemKind(it);
    const block = it instanceof Graph || it instanceof Struct || it instanceof Enum || it instanceof Class || it instanceof Interface;
    const x = it as Decorated;
    const decorated = !!((x.meta && x.meta.length) || (x.attrs && x.attrs.length) || (x.comment && x.comment.length));
    if (block || k !== prevKind || decorated) lines.push("");
    lines.push(...fmtItem(it, idx, semantic, owned.get(it.name) ?? null));
    prevKind = !(block || decorated) ? k : null;
  }
  return (lines.join("\n") + "\n").normalize("NFC");
}

// -- hashes ----------------------------------------------------------------------
/** Bypass and remove Reroute nodes (they are visual only). */
export function stripReroutes(m: Module): Module {
  m = deepcopy(m);
  for (const g of m.graphs()) {
    const rr = new Map(g.nodes.filter((n) => n.kind === "Reroute").map((n) => [n.id, n]));
    if (!rr.size) continue;
    const dataSrc = (ref: PinRef, depth = 0): PinRef | Lit => {
      const n = rr.get(ref.node);
      if (n === undefined || depth > 64) return ref;
      const b = n.binding("in");
      if (b === null || !(b.value instanceof PinRef)) return b ? b.value : ref;
      return dataSrc(b.value, depth + 1);
    };
    const execTgt = (e: ExecOut, depth = 0): ExecOut | null => {
      const n = rr.get(e.target);
      if (n === undefined || depth > 64) return e;
      if (!n.execs.length) return null;
      const nxt = n.execs[0];
      return execTgt(new ExecOut(e.pin, nxt.target, nxt.target_pin), depth + 1);
    };
    for (const n of g.nodes) {
      if (rr.has(n.id)) continue;
      n.bindings = n.bindings.map((b) => b.value instanceof PinRef ? new Binding(b.pin, dataSrc(b.value)) : b);
      n.execs = n.execs.map((e) => execTgt(e)).filter((x): x is ExecOut => x !== null);
    }
    g.nodes = g.nodes.filter((n) => !rr.has(n.id));
  }
  return m;
}

export function semanticText(m: Module): string {
  return printModule(stripReroutes(m), true);
}

export function semanticHash(m: Module): string {
  return sha256Hex(semanticText(m));
}

export function layoutHash(m: Module): string {
  return sha256Hex(printModule(m));
}
