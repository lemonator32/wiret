/** In-memory model of a parsed `.wiret` module (spec section 2).
 *
 * The model is what the parser produces, what the canonical printer consumes and what the
 * graph editor mutates. Node order inside a graph is not significant; the printer sorts
 * everything (section 2.5). */

/** A literal or attribute value.
 *
 * kind is one of: int, float, bool, string, null, enum, ident, tuple, list, map. An `int`
 * holds a bigint; for an enum member `value` is "Enum.Member"; for tuple/list a Lit[]; for
 * map a [Lit, Lit][]. */
export class Lit {
  constructor(public kind: string, public value: any, public suffix: string | null = null) {}
}

/** Semantic decorators (section 2.4): they change the program. Any other `@` name is metadata. */
export const SEMANTIC_ATTRS = new Set(["id", "pure", "reads", "final", "private", "export", "inline",
  "deprecated", "disabled", "capability", "latent", "live"]);
/** Named generic arguments of a node, `#count<3>` and `#cases<...>` (section 2.3). */
export const NODE_GENERICS = ["count", "cases"];
/** Metadata decorators in canonical order; any other metadata name follows them (section 2.5). */
export const META_ORDER = ["doc", "category", "keywords", "note"];

export type AttrArg = [string | null, Lit];

/** A decorator, `@name(...)`: semantic in an `attrs` list, metadata in a `meta` list. A
 * node's named generic (`#count<3>`) is also kept in its `attrs`. */
export class Attr {
  constructor(public name: string, public args: AttrArg[] | null = null) {}

  arg(i = 0): Lit | null {
    if (!this.args || i >= this.args.length) return null;
    return this.args[i][1];
  }

  kwarg(key: string): Lit | null {
    for (const [k, v] of this.args ?? []) if (k === key) return v;
    return null;
  }
}

/** An `@note("text")` line; `detached` names the deleted target it came from (section 2.4). */
export function note(text: string, detached: string | null = null): Attr {
  const args: AttrArg[] = [[null, new Lit("string", text)]];
  if (detached !== null) args.push(["detached", new Lit("string", detached)]);
  return new Attr("note", args);
}

export function noteText(a: Attr): string {
  const v = a.arg();
  return v !== null && v.kind === "string" ? v.value : "";
}

export function setNoteText(a: Attr, text: string): void {
  a.args = [[null, new Lit("string", text)], ...(a.args ?? []).slice(1)];
}

export function noteDetached(a: Attr): string | null {
  const v = a.kwarg("detached");
  return v !== null && v.kind === "string" ? v.value : null;
}

export function notes(meta: Attr[]): Attr[] {
  return meta.filter((a) => a.name === "note");
}

/** The string argument of the first `@name("...")` decorator, e.g. a declaration's doc. */
export function metaValue(meta: Attr[], name: string): string | null {
  for (const a of meta) if (a.name === name && a.arg() !== null && a.arg()!.kind === "string") return a.arg()!.value;
  return null;
}

export class PinRef {
  constructor(public node: string, public pin: string | null) {}
}

export class Binding {
  constructor(public pin: string, public value: PinRef | Lit, public comment: string[] = []) {}
}

/** One exec wire, stored on its source node. In the text it is where one `exec` statement
 * follows another, an exec output's block, or a `goto` (section 2.3). */
export class ExecOut {
  constructor(public pin: string | null, public target: string, public target_pin: string | null = null,
              public comment: string[] = []) {}
}

export class Node {
  /** declared by name with a `node` statement (section 2.3) */
  named = false;
  /** whether its last exec output was written flattened (`}.then`) or as a block; null: the
   * canonical default (section 2.5) */
  flat: boolean | null = null;
  /** the exec output written flattened, when `flat` is true */
  flat_pin: string | null = null;

  constructor(public id: string, public kind: string, public symbol: string | null = null,
              public targs: string[] = [], public bindings: Binding[] = [], public execs: ExecOut[] = [],
              public attrs: Attr[] = [], public meta: Attr[] = [], public comment: string[] = []) {}

  binding(pin: string): Binding | null {
    for (const b of this.bindings) if (b.pin === pin) return b;
    return null;
  }

  attr(name: string): Attr | null {
    for (const a of this.attrs) if (a.name === name) return a;
    return null;
  }
}

export class Param {
  constructor(public name: string, public type: string, public default_: Lit | null = null,
              public attrs: Attr[] = []) {}
}

export class Local {
  constructor(public name: string, public type: string, public default_: Lit | null = null,
              public attrs: Attr[] = [], public meta: Attr[] = [], public comment: string[] = []) {}
}

export class Place {
  constructor(public id: string, public x: number, public y: number,
              public props: [string, Lit][] = []) {}

  prop(key: string): Lit | null {
    for (const [k, v] of this.props) if (k === key) return v;
    return null;
  }

  setProp(key: string, value: Lit | null): void {
    this.props = this.props.filter(([k]) => k !== key);
    if (value !== null) this.props.push([key, value]);
  }
}

/** `box {title="...", pos=(x, y), size=(w, h), ...}`: a frame drawn behind nodes. Its `id`
 * is its place among the graph's boxes, for the editor. */
export class Box extends Place {
  title: string;
  w: number;
  h: number;
  meta: Attr[];

  constructor(id: string, x: number, y: number, props: [string, Lit][] = [],
              opts: { title?: string; w?: number; h?: number; meta?: Attr[] } = {}) {
    super(id, x, y, props);
    this.title = opts.title ?? "";
    this.w = opts.w ?? 200;
    this.h = opts.h ?? 120;
    this.meta = opts.meta ?? [];
  }
}

/** A func, event or macro. A method is a module item of its own, named `Class.Method`, with
 * `owner` set; the printer writes it inside the class (section 2.2). */
export class Graph {
  tparams: string[] = [];
  params: Param[] = [];
  results: Param[] | null = null;
  attrs: Attr[] = [];
  locals: Local[] = [];
  states: Local[] = [];
  nodes: Node[] = [];
  meta: Attr[] = [];
  comment: string[] = [];
  places: Place[] = [];
  boxes: Box[] = [];
  owner: string | null = null;
  static_ = false;

  constructor(public kind: string, public name: string,
              opts: { owner?: string | null; attrs?: Attr[]; params?: Param[]; results?: Param[] | null;
                      nodes?: Node[]; locals?: Local[]; tparams?: string[] } = {}) {
    if (opts.owner !== undefined) this.owner = opts.owner;
    if (opts.attrs) this.attrs = opts.attrs;
    if (opts.params) this.params = opts.params;
    if (opts.results !== undefined) this.results = opts.results;
    if (opts.nodes) this.nodes = opts.nodes;
    if (opts.locals) this.locals = opts.locals;
    if (opts.tparams) this.tparams = opts.tparams;
  }

  /** The class of `self`: the owner of an instance method, null otherwise. */
  get receiver(): string | null {
    return this.owner && !this.static_ ? this.owner : null;
  }

  /** The name as written in its declaration: `TakeDamage` for `Player.TakeDamage`. */
  get short_name(): string {
    return this.owner ? this.name.slice(this.owner.length + 1) : this.name;
  }

  node(nid: string): Node | null {
    for (const n of this.nodes) if (n.id === nid) return n;
    return null;
  }

  place(nid: string): Place | null {
    for (const p of this.places) if (p.id === nid) return p;
    return null;
  }

  box(bid: string): Box | null {
    for (const b of this.boxes) if (b.id === bid) return b;
    return null;
  }

  local(name: string): Local | null {
    for (const l of this.locals) if (l.name === name) return l;
    return null;
  }

  state(name: string): Local | null {
    for (const l of this.states) if (l.name === name) return l;
    return null;
  }

  hasAttr(name: string): boolean {
    return this.attrs.some((a) => a.name === name);
  }

  /** The graph (`on` is null), node or box whose `meta` holds the notes on `on`. */
  noteOwner(on: string | null): Graph | Node | Box | null {
    if (on === null) return this;
    return this.node(on) ?? this.box(on);
  }

  /** [target id, or null for the graph; index among that target's notes; the note]. */
  allNotes(): [string | null, number, Attr][] {
    const out: [string | null, number, Attr][] = notes(this.meta).map((a, i) => [null, i, a]);
    for (const o of [...this.nodes, ...this.boxes]) notes(o.meta).forEach((a, i) => out.push([o.id, i, a]));
    return out;
  }

  get result_list(): Param[] {
    return this.results ?? [];
  }
}

export class Use {
  constructor(public name: string, public alias: string | null = null, public attrs: Attr[] = [],
              public meta: Attr[] = [], public comment: string[] = []) {}
}

export class Extern {
  constructor(public kind: string, public name: string, public params: Param[] = [],
              public results: Param[] | null = null, public attrs: Attr[] = [],
              public meta: Attr[] = [], public comment: string[] = []) {}

  hasAttr(name: string): boolean {
    return this.attrs.some((a) => a.name === name);
  }
}

export class Const {
  constructor(public name: string, public type: string, public value: Lit, public attrs: Attr[] = [],
              public meta: Attr[] = [], public comment: string[] = []) {}
}

export class Var {
  constructor(public name: string, public type: string, public default_: Lit | null = null,
              public attrs: Attr[] = [], public meta: Attr[] = [], public comment: string[] = []) {}
}

/** A struct field: `name: type [= default] @attrs` (section 2.2). */
export class Field {
  constructor(public name: string, public type: string, public default_: Lit | null = null,
              public attrs: Attr[] = [], public meta: Attr[] = [], public comment: string[] = []) {}
}

/** A value type. Field order is the order written; it is semantic and never sorted. */
export class Struct {
  constructor(public name: string, public fields: Field[] = [], public attrs: Attr[] = [],
              public meta: Attr[] = [], public comment: string[] = []) {}

  field(name: string): Field | null {
    for (const f of this.fields) if (f.name === name) return f;
    return null;
  }
}

/** `class Name [: Base] { fields, methods }`, a reference type (section 2.2). */
export class Class {
  base: string | null = null;
  fields: Field[] = [];
  meta: Attr[] = [];
  comment: string[] = [];
  impls: string[] = [];
  dispatchers: Dispatcher[] = [];

  constructor(public name: string, public attrs: Attr[] = []) {}

  field(name: string): Field | null {
    for (const f of this.fields) if (f.name === name) return f;
    return null;
  }
}

/** `dispatcher Name(params) @attrs` in a class: a multicast event slot on each object. */
export class Dispatcher {
  params: Param[] = [];
  results: null = null;

  constructor(public name: string, public attrs: Attr[] = [], public meta: Attr[] = [],
              public comment: string[] = []) {}

  get result_list(): Param[] { return []; }

  hasAttr(name: string): boolean {
    return this.attrs.some((a) => a.name === name);
  }
}

/** `func Name(params) -> (results) @attrs` inside an interface: a signature, no body. */
export class IfaceMethod {
  params: Param[] = [];
  results: Param[] | null = null;
  attrs: Attr[] = [];
  meta: Attr[] = [];
  comment: string[] = [];

  constructor(public name: string) {}

  get result_list(): Param[] { return this.results ?? []; }

  hasAttr(name: string): boolean {
    return this.attrs.some((a) => a.name === name);
  }
}

/** `interface Name { func ... }` (section 2.2). Method order is the dispatch slot order. */
export class Interface {
  methods: IfaceMethod[] = [];
  meta: Attr[] = [];
  comment: string[] = [];

  constructor(public name: string, public attrs: Attr[] = []) {}

  method(name: string): IfaceMethod | null {
    for (const m of this.methods) if (m.name === name) return m;
    return null;
  }
}

/** An enum member: `Name [= value] @attrs`. `value` is a bigint, or null. */
export class EnumMember {
  value: bigint | null = null;
  attrs: Attr[] = [];
  meta: Attr[] = [];
  comment: string[] = [];

  constructor(public name: string) {}
}

/** `enum Name [: inttype] { ... }`. Member order is the order written, never sorted. */
export class Enum {
  base: string | null = null;
  members: EnumMember[] = [];
  meta: Attr[] = [];
  comment: string[] = [];

  constructor(public name: string, public attrs: Attr[] = []) {}

  member(name: string): EnumMember | null {
    for (const m of this.members) if (m.name === name) return m;
    return null;
  }
}

export type Anchor = ["node", string, string] | ["graph", string];

/** A `//` comment that is attached to nothing: trivia, not part of the model (section 2.1). */
export class Comment {
  constructor(public line: number, public text: string, public anchor: Anchor | null = null) {}
}

export type Item = Use | Extern | Const | Var | Enum | Struct | Interface | Class | Graph;

export class Module {
  items: Item[] = [];
  meta: Attr[] = [];
  comment: string[] = [];
  comments: Comment[] = [];
  /** "graph\0node" keys retired in the project's wiret.ids (section 7.3); not part of the text. */
  retired_nodes = new Set<string>();

  constructor(public version: number, public name: string, public attrs: Attr[] = []) {}

  graphs(kinds: string[] = ["func", "event", "macro"]): Graph[] {
    return this.items.filter((i): i is Graph => i instanceof Graph && kinds.includes(i.kind));
  }

  graph(name: string): Graph | null {
    for (const i of this.items) if (i instanceof Graph && i.name === name) return i;
    return null;
  }
}

export const ITEM_ORDER = ["use", "extern", "const", "var", "enum", "struct", "interface", "class",
  "macro", "func", "event"];

export function itemKind(item: Item): string {
  if (item instanceof Use) return "use";
  if (item instanceof Extern) return "extern";
  if (item instanceof Const) return "const";
  if (item instanceof Var) return "var";
  if (item instanceof Enum) return "enum";
  if (item instanceof Struct) return "struct";
  if (item instanceof Class) return "class";
  if (item instanceof Interface) return "interface";
  if (item instanceof Graph) return item.kind;
  throw new TypeError(String(item));
}

/** Clear every attached `//` comment in a model tree, in place. */
export function stripComments(obj: unknown): void {
  const seen = new Set<object>();
  const walk = (x: any): void => {
    if (Array.isArray(x)) { for (const y of x) walk(y); return; }
    if (x === null || typeof x !== "object" || seen.has(x)) return;
    if (!(x instanceof Lit || x instanceof Attr || x instanceof PinRef || x instanceof Binding ||
          x instanceof ExecOut || x instanceof Node || x instanceof Param || x instanceof Local ||
          x instanceof Place || x instanceof Graph || x instanceof Use || x instanceof Extern ||
          x instanceof Const || x instanceof Var || x instanceof Field || x instanceof Struct ||
          x instanceof Class || x instanceof Dispatcher || x instanceof IfaceMethod ||
          x instanceof Interface || x instanceof EnumMember || x instanceof Enum ||
          x instanceof Comment || x instanceof Module)) return;
    seen.add(x);
    const o = x as any;
    if (Array.isArray(o.comment)) o.comment = [];
    for (const k of Object.keys(o)) if (k !== "comment") walk(o[k]);
  };
  walk(obj);
}
