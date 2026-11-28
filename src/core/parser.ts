/** Lexer and parser for `.wiret` text (spec sections 2.1 to 2.4). */
import {
  Anchor, Attr, Binding, Box, Class, Comment, Const, Dispatcher, Enum, EnumMember, ExecOut, Extern, Field,
  Graph, IfaceMethod, Interface, Item, Lit, Local, Module, Node, NODE_GENERICS, Param, PinRef, Place,
  SEMANTIC_ATTRS, Struct, Use, Var,
} from "./model.js";
import { ModuleIndex, signature } from "./registry.js";
import { pyRepr } from "./pyutil.js";

export const KEYWORDS = new Set(("wiret module use extern const var local enum struct interface class impl macro " +
  "func event dispatcher node state exec goto box self").split(" "));
/** Keywords are contextual (section 2.1); only these words can never be a name. */
export const RESERVED = new Set(["true", "false", "null"]);

export const UNSUPPORTED_ITEMS = new Set<string>();

export const INT_TYPES = new Set(["i8", "u8", "i16", "u16", "i32", "u32", "i64", "u64"]);

export const GENERICS_HINT = "type arguments are written with '#<', as in Add#<i32> or array#<i32>";
export const FLOW_HINT = "the 'flow' block was removed: write the nodes as 'exec' statements in the order " +
  "they run (section 2.3)";
export const LAYOUT_HINT = "the 'layout' block was removed: write a node's position in its attribute block, " +
  "'Kind{pos=(x, y)}(...)', and its notes as @note(\"...\") lines above it";

export class ParseError extends Error {
  constructor(public msg: string, public line = 0, public col = 0) {
    super(`${line}:${col}: ${msg}`);
  }
}

export type TokKind = "id" | "int" | "float" | "str" | "nl" | "punct" | "eof";

export class Tok {
  /** int: [bigint, suffix|null]; float: [number, suffix|null]; id/str/punct: string; nl/eof: null */
  constructor(public kind: TokKind, public value: any, public line: number, public col: number) {}
}

/** [line, col, text (stripped), token index, own line, raw (one leading space dropped)] */
export type RawComment = [number, number, string, number, boolean, string];

const _NUM = /(-?(?:0[xX][0-9A-Fa-f_]+|[0-9][0-9_]*(?:\.[0-9][0-9_]*)?(?:[eE][+-]?[0-9]+)?))(i8|u8|i16|u16|i32|u32|i64|u64|f32|f64)?(?![A-Za-z0-9_])/y;
const _IDENT = /[A-Za-z_][A-Za-z0-9_]*/y;

const isDigit = (c: string) => /^\p{Nd}$/u.test(c);
const isAlpha = (c: string) => /^\p{L}$/u.test(c);

export function lex(text: string): [Tok[], RawComment[]] {
  const toks: Tok[] = [], comments: RawComment[] = [];
  let i = 0, line = 1, col0 = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const col = i - col0 + 1;
    if (c === "\n") {
      toks.push(new Tok("nl", null, line, col));
      i += 1;
      line += 1;
      col0 = i;
    } else if (c === " " || c === "\t" || c === "\r") {
      i += 1;
    } else if (text.startsWith("//", i)) {
      let j = text.indexOf("\n", i);
      j = j < 0 ? n : j;
      const raw = text.slice(i + 2, j).replace(/\s+$/u, "");
      const own = !toks.length || toks[toks.length - 1].kind === "nl";
      comments.push([line, col, raw.trim(), toks.length, own, raw.startsWith(" ") ? raw.slice(1) : raw]);
      i = j;
    } else if (c === '"') {
      const [ni, s] = lexString(text, i, line, col);
      i = ni;
      toks.push(new Tok("str", s, line, col));
    } else if (isDigit(c) || (c === "-" && i + 1 < n && isDigit(text[i + 1]))) {
      _NUM.lastIndex = i;
      const m = _NUM.exec(text);
      if (!m) throw new ParseError("malformed number", line, col);
      i = _NUM.lastIndex;
      const body = m[1].replace(/_/g, ""), suffix = m[2] ?? null;
      if (body.toLowerCase().replace(/^-+/, "").startsWith("0x")) {
        const neg = body.startsWith("-");
        const v = BigInt(body.replace(/^-/, ""));
        toks.push(new Tok("int", [neg ? -v : v, suffix], line, col));
      } else if (/[.eE]/.test(body) || suffix === "f32" || suffix === "f64") {
        toks.push(new Tok("float", [Number(body), suffix], line, col));
      } else {
        toks.push(new Tok("int", [BigInt(body), suffix], line, col));
      }
    } else if (isAlpha(c) || c === "_") {
      _IDENT.lastIndex = i;
      const m = _IDENT.exec(text);
      if (!m) throw new ParseError(`unexpected character ${pyRepr(c)}`, line, col);
      toks.push(new Tok("id", m[0], line, col));
      i = _IDENT.lastIndex;
    } else if (text.startsWith("->", i) || text.startsWith("<-", i) || text.startsWith("::", i)) {
      toks.push(new Tok("punct", text.slice(i, i + 2), line, col));
      i += 2;
    } else if ("(){}[]<>,:=.@#!|".includes(c)) {
      toks.push(new Tok("punct", c, line, col));
      i += 1;
    } else {
      throw new ParseError(`unexpected character ${pyRepr(String.fromCodePoint(text.codePointAt(i)!))}`, line, col);
    }
  }
  toks.push(new Tok("nl", null, line, 0));
  toks.push(new Tok("eof", null, line + 1, 0));
  return [toks, comments];
}

function lexString(text: string, i: number, line: number, col: number): [number, string] {
  let out = "";
  i += 1;
  for (;;) {
    if (i >= text.length || text[i] === "\n") throw new ParseError("unterminated string", line, col);
    const c = text[i];
    if (c === '"') return [i + 1, out];
    if (c === "\\") {
      const e = text.slice(i + 1, i + 2);
      if (e === "n") out += "\n";
      else if (e === "t") out += "\t";
      else if (e === '"') out += '"';
      else if (e === "\\") out += "\\";
      else if (e === "u" && text.slice(i + 2, i + 3) === "{") {
        const j = text.indexOf("}", i);
        const hex = text.slice(i + 3, j);
        const cp = /^[0-9A-Fa-f]+$/.test(hex) ? parseInt(hex, 16) : NaN;
        if (j < 0 || Number.isNaN(cp) || cp > 0x10FFFF) throw new ParseError(`bad escape \\u{${hex}}`, line, col);
        out += String.fromCodePoint(cp);
        i = j + 1;
        continue;
      } else throw new ParseError(`bad escape \\${e}`, line, col);
      i += 2;
    } else {
      out += c;
      i += 1;
    }
  }
}

type Scope = Map<string, [string, string]>[];

/** What the parser knows about the graph body it is reading (section 2.3). */
class Body {
  named = new Map<string, Node>();
  placed = new Set<string>();
  bare: [PinRef, string, Tok][] = [];
  gotos: [Node, string | null, string, string | null, Tok, string[]][] = [];
  regions = 0;
  boxes = 0;
  constructor(public g: Graph) {}
}

export class Parser {
  toks: Tok[];
  raw_comments: RawComment[];
  i = 0;
  anchors: [number, Anchor][] = [];
  pending_methods: Graph[] = [];
  graph_name: string | null = null;
  own: Map<number, number>;
  taken = new Set<number>();
  defaults: [string, PinRef, Node | null, Tok][] = [];
  body_state: Body | null = null;

  constructor(text: string) {
    [this.toks, this.raw_comments] = lex(text);
    this.own = new Map();
    this.raw_comments.forEach((c, k) => { if (c[4]) this.own.set(c[0], k); });
  }

  // -- token helpers -------------------------------------------------------
  peek(k = 0): Tok {
    return this.toks[Math.min(this.i + k, this.toks.length - 1)];
  }

  next(): Tok {
    return this.toks[this.i++];
  }

  at(kind: TokKind, value: string | null = null, k = 0): boolean {
    const t = this.peek(k);
    return t.kind === kind && (value === null || t.value === value);
  }

  atP(value: string, k = 0): boolean {
    return this.at("punct", value, k);
  }

  atKw(value: string, k = 0): boolean {
    return this.at("id", value, k);
  }

  error(msg: string, tok: Tok | null = null): never {
    tok = tok ?? this.peek();
    const got = tok.kind === "eof" ? "end of file" : tok.kind === "nl" ? "newline" : pyRepr(tok.value);
    throw new ParseError(`${msg} (found ${got})`, tok.line, tok.col);
  }

  expect(kind: TokKind, value: string | null = null, what: string | null = null): Tok {
    if (!this.at(kind, value)) this.error(`expected ${what ?? value ?? kind}`);
    return this.next();
  }

  expectP(value: string): Tok {
    return this.expect("punct", value);
  }

  ident(what = "identifier"): string {
    return this.expect("id", null, what).value;
  }

  /** A pin's name after its `.`: a name, or one of a node's variable pins with its index
   * right after it, `case[0]`, `item[2]` (section 2.3). */
  pinName(what = "pin name"): string {
    const t = this.peek();
    let name = this.ident(what);
    const b = this.peek();
    if (this.atP("[") && b.line === t.line && b.col === t.col + name.length) {
      this.next();
      const k = this.expect("int", null, `the pin's index, as in '${name}[0]'`);
      if (k.value[1] || k.value[0] < 0n) this.error(`a pin's index is a plain number, as in '${name}[0]'`, k);
      this.expectP("]");
      name = `${name}[${k.value[0]}]`;
    }
    return name;
  }

  skipNl(): boolean {
    let skipped = false;
    while (this.at("nl")) {
      this.i += 1;
      skipped = true;
    }
    return skipped;
  }

  endStmt(): void {
    if (this.atP("}")) return;
    if (this.atP("@") && this.at("id", null, 1) && NODE_GENERICS.includes(this.peek(1).value)) {
      const name = this.peek(1).value;
      this.error(`'@${name}(...)' is a named generic argument now, written after the ` +
                 `node's kind and type arguments: 'Sequence#${name}<2>()'`);
    }
    if (this.atP("@"))
      this.error("a decorator goes on the line above what it describes, or before a " +
                 "parameter or field on its line, not after it");
    this.expect("nl", null, "end of line");
    this.skipNl();
  }

  /** The `//` lines attached to a statement on line `stmt` whose decorator lines start on
   * line `top` (section 2.1). */
  leadComments(top: number, stmt: number): string[] {
    const free = (l: number) => this.own.has(l) && !this.taken.has(this.own.get(l)!);
    const above: number[] = [];
    let l = top - 1;
    while (free(l)) {
      above.push(this.own.get(l)!);
      l -= 1;
    }
    const ks = [...above.reverse()];
    for (let x = top; x < stmt; x++) if (free(x)) ks.push(this.own.get(x)!);
    for (const k of ks) this.taken.add(k);
    return ks.map((k) => this.raw_comments[k][5]);
  }

  qname(): string {
    const parts = [this.ident()];
    while (this.atP(".") && this.at("id", null, 1)) {
      this.next();
      parts.push(this.ident());
    }
    return parts.join(".");
  }

  // -- decorators ------------------------------------------------------------
  /** `@name` or `@name(args)` decorators (section 2.4). Returns [metadata, semantic]. */
  decorators(lines = true): [Attr[], Attr[]] {
    const meta: Attr[] = [], attrs: Attr[] = [];
    if (this.atP("#") && this.atP("[", 1)) this.error("decorators are written @name(...), as in @note(\"...\"), not #[...]");
    while (this.atP("@")) {
      const t = this.next();
      const name = this.qname();
      if (NODE_GENERICS.includes(name))
        throw new ParseError(`'@${name}' is a named generic argument now, written after the ` +
                             `node's kind: '#${name}<...>'`, t.line, t.col);
      const a = new Attr(name, this.atP("(") ? this.attrArgs() : null);
      (SEMANTIC_ATTRS.has(name) ? attrs : meta).push(a);
      if (lines && this.at("nl")) {
        this.next();
        if (this.at("nl") || this.atP("}") || this.at("eof"))
          throw new ParseError("a decorator must stand directly above what it describes, " +
                               "with no blank line between", t.line, t.col);
      }
      if (this.atP("#") && this.atP("[", 1)) this.error("decorators are written @name(...), not #[...]");
    }
    return [meta, attrs];
  }

  noTrailing(): void {
    if (this.atP("@")) this.error("a decorator goes on the line above what it describes, not after it");
  }

  // -- module --------------------------------------------------------------
  parseModule(): Module {
    this.skipNl();
    if (!this.atKw("wiret")) this.error("a .wiret file must start with 'wiret 1'");
    this.next();
    const version = this.expect("int", null, "version number").value[0] as bigint;
    if (version > 1n) throw new ParseError(`unsupported wiret version ${version}`, this.peek().line, 0);
    this.endStmt();
    let t0 = this.peek();
    let [meta, attrs] = this.decorators();
    if (!this.atKw("module")) this.error("expected 'module'");
    const mt = this.next();
    const mod = new Module(Number(version), this.qname(), attrs);
    mod.meta = meta;
    this.noTrailing();
    mod.comment = this.leadComments(t0.line, mt.line);
    this.endStmt();
    while (!this.at("eof")) {
      t0 = this.peek();
      [meta, attrs] = this.decorators();
      const st = this.peek();
      const it = this.item(attrs);
      it.meta = meta;
      it.comment = this.leadComments(t0.line, st.line);
      mod.items.push(it);
      if (it instanceof Class) {
        mod.items.push(...this.pending_methods);
        this.pending_methods = [];
      }
      this.skipNl();
    }
    mod.comments = this.attachComments();
    resolveEnumValues(mod);
    this.resolveDefaults(mod);
    resolveSelf(mod);
    return mod;
  }

  /** A node written without `.pin` feeds in its one data output (section 2.3). */
  resolveDefaults(mod: Module): void {
    if (!this.defaults.length) return;
    const idx = new ModuleIndex(mod);
    const graphs = new Map(mod.graphs().map((g) => [g.name, g]));
    for (let [gname, ref, n, tok] of this.defaults) {
      const what = n !== null ? `${n.kind}(...)` : ref.node;
      if (n === null) {
        n = graphs.get(gname)!.node(ref.node);
        if (n === null) {
          ref.pin = "";
          continue;
        }
      }
      const sig = signature(n, graphs.get(gname)!, idx);
      const outs = sig.data_outs;
      if (outs.length === 1) ref.pin = outs[0].name;
      else if (sig.error) ref.pin = "result";
      else if (!outs.length) throw new ParseError(`'${what}' has no output to feed into this input`, tok.line, tok.col);
      else {
        const names = outs.map((o) => o.name).join(", ");
        throw new ParseError(`'${what}' has several outputs (${names}); name the one this ` +
                             `input reads, as in '${what}.${outs[0].name}'`, tok.line, tok.col);
      }
    }
  }

  attachComments(): Comment[] {
    const out: Comment[] = [];
    const anchors = [...this.anchors].sort((a, b) => a[0] - b[0]);
    this.raw_comments.forEach(([line, , text, tokIndex, own], k) => {
      if (this.taken.has(k)) return;
      const before = anchors.filter(([idx]) => idx < tokIndex).map(([, a]) => a);
      const after = anchors.filter(([idx]) => idx >= tokIndex).map(([, a]) => a);
      let anchor: Anchor | null;
      if (!own && before.length) anchor = before[before.length - 1];
      else if (after.length) anchor = after[0];
      else if (before.length) anchor = ["graph", before[before.length - 1][1]];
      else anchor = null;
      out.push(new Comment(line, text, anchor));
    });
    return out;
  }

  item(attrs: Attr[]): Item {
    const t = this.peek();
    if (t.kind !== "id") this.error("expected a declaration");
    const kw = t.value as string;
    if (UNSUPPORTED_ITEMS.has(kw))
      throw new ParseError(`'${kw}' declarations are Tier 2 and not supported by this prototype`, t.line, t.col);
    const start = this.i;
    this.next();
    if (kw === "use") {
      const name = this.qname();
      let alias: string | null = null;
      if (this.atKw("as")) {
        this.next();
        alias = this.ident();
      }
      const it = new Use(name, alias, attrs);
      this.endStmt();
      return it;
    }
    if (kw === "extern") {
      let it: Extern;
      if (this.atKw("type")) {
        this.next();
        it = new Extern("type", this.qname(), [], null, attrs);
      } else {
        this.expect("id", "func");
        const name = this.qname();
        const params = this.params();
        let results: Param[] | null = null;
        if (this.atP("->")) {
          this.next();
          results = this.params();
        }
        it = new Extern("func", name, params, results, attrs);
      }
      this.endStmt();
      return it;
    }
    if (kw === "const") {
      const name = this.ident();
      this.expectP(":");
      const ty = this.type();
      this.expectP("=");
      const value = this.literal();
      const it = new Const(name, ty, value, attrs);
      this.endStmt();
      return it;
    }
    if (kw === "var") {
      const name = this.ident();
      this.expectP(":");
      const ty = this.type();
      let def: Lit | null = null;
      if (this.atP("=")) {
        this.next();
        def = this.literal();
      }
      const it = new Var(name, ty, def, attrs);
      this.endStmt();
      return it;
    }
    if (kw === "struct") return this.struct(attrs);
    if (kw === "enum") return this.enum(attrs);
    if (kw === "class") return this.classDecl(attrs);
    if (kw === "interface") return this.interface(attrs);
    if (kw === "func" || kw === "event" || kw === "macro") return this.graph(kw, start, attrs);
    this.error("expected a declaration");
  }

  graph(kw: string, start: number, attrs: Attr[], owner: string | null = null): Graph {
    const short = this.ident();
    const g = new Graph(kw, owner ? `${owner}.${short}` : short, { owner, attrs });
    this.anchors.push([start, ["graph", g.name]]);
    if (this.atP("#")) {
      if (owner) this.error("methods take no type parameters");
      g.tparams = this.genericArgs(() => this.ident());
    } else if (this.atP("<") || this.atP("::")) this.genericsHint();
    const hasSelf: boolean[] = [];
    g.params = this.params(owner !== null, hasSelf);
    g.static_ = owner !== null && !hasSelf.length;
    if (this.atP("->")) {
      this.next();
      g.results = this.params();
    }
    this.noTrailing();
    if (this.atP("=")) this.exprBody(g);
    else this.body(g);
    return g;
  }

  /** `func F(x: T) -> (r: U) = value` (section 2.3). */
  exprBody(g: Graph): void {
    const t = this.next();
    if (g.kind !== "func" || g.owner || g.results === null || g.results.length !== 1)
      throw new ParseError("only a function with exactly one result, outside a class, is " +
                           "written '= value'; give this one a body in braces", t.line, t.col);
    this.graph_name = g.name;
    const st = this.body_state = new Body(g);
    const res = g.results[0].name;
    this.skipNl();
    this.anchors.push([this.i, ["node", g.name, "1"]]);
    const [val, inline] = this.inputValue(`1.${res}`, []);
    g.nodes = [new Node("0", "Entry", null, [], [], [new ExecOut(null, "1")]),
               new Node("1", "Return", null, [], [new Binding(res, val)]), ...inline];
    this.finishBody(st);
    this.endStmt();
  }

  /** `class Name [: Base] [impl I, ...] { field | dispatcher | func | event ... }`. */
  classDecl(attrs: Attr[]): Class {
    const c = new Class(this.ident("class name"), attrs);
    if (this.atP("#") || this.atP("<")) this.error("classes take no type parameters");
    if (this.atP(":")) {
      this.next();
      c.base = this.qname();
    }
    if (this.atKw("impl")) {
      this.next();
      c.impls.push(this.qname());
      while (this.atP(",")) {
        this.next();
        c.impls.push(this.qname());
      }
    }
    this.noTrailing();
    this.expectP("{");
    this.skipNl();
    while (!this.atP("}")) {
      const t0 = this.peek();
      const [meta, attrs2] = this.decorators();
      const cm = this.leadComments(t0.line, this.peek().line);
      const named = this.atP(":", 1);
      if (!named && (this.atKw("func") || this.atKw("event"))) {
        const start = this.i;
        const kw = this.next().value;
        const g = this.graph(kw, start, attrs2, c.name);
        g.meta = meta;
        g.comment = cm;
        this.pending_methods.push(g);
        this.skipNl();
        continue;
      }
      if (!named && this.atKw("dispatcher")) {
        this.next();
        const d = new Dispatcher(this.ident("dispatcher name"), attrs2, meta, cm);
        d.params = this.params();
        if (this.atP("->")) this.error("a dispatcher has no results: its handlers' results would have nowhere to go");
        c.dispatchers.push(d);
        this.endStmt();
        continue;
      }
      if (!named && this.atKw("macro")) this.error("a class cannot declare a macro; declare it at module level");
      if (!this.at("id")) this.error("expected a field, func or event");
      const name = this.ident("field name");
      this.expectP(":");
      const ty = this.type();
      let def: Lit | null = null;
      if (this.atP("=")) {
        this.next();
        def = this.literal();
      }
      c.fields.push(new Field(name, ty, def, attrs2, meta, cm));
      this.endStmt();
    }
    this.next();
    this.endStmt();
    return c;
  }

  /** The `{ ... }` of a struct, enum or interface: one member per line. */
  members<T extends { meta: Attr[]; comment: string[]; attrs: Attr[] }>(what: string, member: () => T): T[] {
    this.expectP("{");
    this.skipNl();
    const out: T[] = [];
    while (!this.atP("}")) {
      const t0 = this.peek();
      const [meta, attrs] = this.decorators();
      if (!this.at("id")) this.error(`expected ${what}`);
      const cm = this.leadComments(t0.line, this.peek().line);
      const m = member();
      m.meta = meta;
      m.comment = cm;
      m.attrs = attrs;
      out.push(m);
      this.endStmt();
    }
    this.next();
    this.endStmt();
    return out;
  }

  struct(attrs: Attr[]): Struct {
    const st = new Struct(this.ident("struct name"), [], attrs);
    if (this.atP("#") || this.atP("<")) this.error("structs take no type parameters");
    st.fields = this.members("a field ('name: type')", () => {
      const name = this.ident("field name");
      this.expectP(":");
      const ty = this.type();
      let def: Lit | null = null;
      if (this.atP("=")) {
        this.next();
        def = this.literal();
      }
      return new Field(name, ty, def);
    });
    return st;
  }

  interface(attrs: Attr[]): Interface {
    const it = new Interface(this.ident("interface name"), attrs);
    if (this.atP("#") || this.atP("<")) this.error("interfaces take no type parameters");
    it.methods = this.members("an interface method", () => {
      if (!this.atKw("func")) this.error("an interface lists methods, written 'func Name(self, params) -> (results)'");
      this.next();
      const t = this.peek();
      const m = new IfaceMethod(this.ident("method name"));
      const hasSelf: boolean[] = [];
      m.params = this.params(true, hasSelf);
      if (!hasSelf.length)
        throw new ParseError(`an interface method is called on an object: write 'func ${m.name}(self, ...)'`, t.line, t.col);
      if (this.atP("->")) {
        this.next();
        m.results = this.params();
      }
      if (this.atP("{")) this.error("an interface method has no body; the classes that implement the interface give one");
      return m;
    });
    return it;
  }

  enum(attrs: Attr[]): Enum {
    const en = new Enum(this.ident("enum name"), attrs);
    if (this.atP(":")) {
      this.next();
      const t = this.peek();
      const base = this.ident("integer type");
      if (!INT_TYPES.has(base))
        throw new ParseError(`an enum's underlying type must be an integer type such as u8 or i32, not '${base}'`, t.line, t.col);
      en.base = base;
    }
    en.members = this.members("an enum member", () => {
      const m = new EnumMember(this.ident("enum member"));
      if (this.atP("=")) {
        this.next();
        const t = this.peek();
        if (t.kind !== "int" || t.value[1] !== null) this.error("an enum member's value is a plain integer, as in 'Idle = 0'");
        m.value = this.next().value[0];
      }
      return m;
    });
    return en;
  }

  /** `(name: type [= default], ...)`; a method's list may start with `self`. */
  params(selfOk = false, hasSelf: boolean[] | null = null): Param[] {
    this.expectP("(");
    const out: Param[] = [];
    this.skipNl();
    let first = true;
    while (!this.atP(")")) {
      if (first && this.atKw("self") && (this.atP(",", 1) || this.atP(")", 1) || this.at("nl", null, 1))) {
        const t = this.next();
        if (!selfOk) throw new ParseError("only a method takes 'self'", t.line, t.col);
        hasSelf!.push(true);
      } else {
        const [meta, attrs] = this.decorators(false);
        if (meta.length) this.error(`a parameter takes no metadata such as @${meta[0].name}`);
        const name = this.ident("parameter name");
        this.expectP(":");
        const ty = this.type();
        let def: Lit | null = null;
        if (this.atP("=")) {
          this.next();
          def = this.literal();
        }
        this.noTrailing();
        out.push(new Param(name, ty, def, attrs));
      }
      first = false;
      const nl = this.skipNl();
      if (this.atP(",")) {
        this.next();
        this.skipNl();
      } else if (!this.atP(")") && !nl) this.error("expected ',' or ')'");
    }
    this.next();
    return out;
  }

  /** A type. Generic types are written `array#<i32>`. */
  type(): string {
    if (this.atP("(")) return this.tlist();
    const name = this.qname();
    if (this.atP("<") || this.atP("::")) this.genericsHint();
    if (!this.atP("#")) return name;
    if (name === "array" || name === "set") {
      this.next();
      this.expectP("<");
      const inner = this.type();
      this.expectP(">");
      return `${name}#<${inner}>`;
    }
    if (name === "map") {
      this.next();
      this.expectP("<");
      const k = this.type();
      this.expectP(",");
      const v = this.type();
      this.expectP(">");
      return `map#<${k}, ${v}>`;
    }
    if (name === "delegate" || name === "dispatcher") {
      this.next();
      this.expectP("<");
      const a = this.tlist();
      let r = "";
      if (this.atP("->")) {
        this.next();
        r = " -> " + this.tlist();
        if (r === " -> ()") r = "";
      }
      this.expectP(">");
      return `${name}#<${a}${r}>`;
    }
    this.error(`'${name}' takes no type arguments`);
  }

  /** `#<a, b>`: the type arguments of a node, or the type parameters of a declaration. */
  genericArgs(item: () => string): string[] {
    this.expectP("#");
    this.expectP("<");
    const out = [item()];
    while (this.atP(",")) {
      this.next();
      out.push(item());
    }
    this.expectP(">");
    return out;
  }

  genericsHint(): never {
    this.error(GENERICS_HINT);
  }

  tlist(): string {
    this.expectP("(");
    const ts: string[] = [];
    while (!this.atP(")")) {
      ts.push(this.type());
      if (this.atP(",")) this.next();
    }
    this.next();
    return "(" + ts.join(", ") + ")";
  }

  // -- attributes and values -----------------------------------------------
  attrArgs(): [string | null, Lit][] {
    this.expectP("(");
    const args: [string | null, Lit][] = [];
    this.skipNl();
    while (!this.atP(")")) {
      let key: string | null = null;
      if (this.at("id") && this.atP(":", 1)) {
        key = this.ident();
        this.next();
      }
      args.push([key, this.value()]);
      const nl = this.skipNl();
      if (this.atP(",")) {
        this.next();
        this.skipNl();
      } else if (!this.atP(")") && !nl) this.error("expected ',' or ')'");
    }
    this.next();
    return args;
  }

  value(): Lit {
    if (this.atP("(")) return new Lit("tuple", this.seq("(", ")"));
    if (this.atP("[")) return new Lit("list", this.seq("[", "]"));
    if (this.atP("{")) {
      this.next();
      const pairs: [Lit, Lit][] = [];
      this.skipNl();
      while (!this.atP("}")) {
        const k = this.value();
        this.expectP(":");
        pairs.push([k, this.value()]);
        this.skipNl();
        if (this.atP(",")) {
          this.next();
          this.skipNl();
        }
      }
      this.next();
      return new Lit("map", pairs);
    }
    if (this.at("id") && this.atP("::", 1) && this.at("id", null, 2)) return this.enumValue();
    if (this.at("id") && !RESERVED.has(this.peek().value)) return new Lit("ident", this.qname());
    return this.literal();
  }

  private seq(open: string, close: string): Lit[] {
    this.expectP(open);
    const items: Lit[] = [];
    this.skipNl();
    while (!this.atP(close)) {
      items.push(this.value());
      this.skipNl();
      if (this.atP(",")) {
        this.next();
        this.skipNl();
      }
    }
    this.next();
    return items;
  }

  literal(): Lit {
    const t = this.peek();
    if (this.atP("(")) {
      const items = this.seq("(", ")");
      for (const x of items)
        if (!["int", "float", "tuple"].includes(x.kind))
          throw new ParseError("a vector literal holds numbers, as in (0, 1.5, 0)", t.line, t.col);
      return new Lit("tuple", items);
    }
    if (t.kind === "int") {
      this.next();
      return new Lit("int", t.value[0], t.value[1]);
    }
    if (t.kind === "float") {
      this.next();
      return new Lit("float", t.value[0], t.value[1]);
    }
    if (t.kind === "str") {
      this.next();
      return new Lit("string", t.value);
    }
    if (t.kind === "id" && (t.value === "true" || t.value === "false")) {
      this.next();
      return new Lit("bool", t.value === "true");
    }
    if (t.kind === "id" && t.value === "null") {
      this.next();
      return new Lit("null", null);
    }
    if (t.kind === "id" && this.atP("::", 1) && this.at("id", null, 2)) return this.enumValue();
    if (t.kind === "id" && this.atP(".", 1)) this.error("expected a literal; an enum value is written Enum::Member");
    this.error("expected a literal");
  }

  /** `Mode::Chase` (section 2.1). */
  enumValue(): Lit {
    const name = this.ident();
    this.expectP("::");
    return new Lit("enum", `${name}.${this.ident("enum member")}`);
  }

  // -- graph bodies --------------------------------------------------------
  /** `{ local/state ... box ... node ... exec ... }` (section 2.3). */
  body(g: Graph): void {
    this.graph_name = g.name;
    const st = this.body_state = new Body(g);
    this.expectP("{");
    this.skipNl();
    this.block(st, "", null, [], true, false);
    this.next();
    this.finishBody(st);
    this.endStmt();
  }

  /** Resolve what a body names before it is declared: bare names and goto targets. */
  finishBody(st: Body): void {
    const g = st.g;
    const entry = g.nodes.find((n) => n.kind === "Entry")?.id ?? null;
    const params = new Set(g.params.map((p) => p.name));
    if (g.receiver) params.add("self");
    for (const [ref, name, tok] of st.bare) {
      if (st.named.has(name)) {
        ref.node = name;
        ref.pin = null;
        this.defaults.push([g.name, ref, null, tok]);
      } else if (params.has(name) && entry !== null) {
        ref.node = entry;
        ref.pin = name;
      } else {
        ref.node = name;
        ref.pin = null;
        this.defaults.push([g.name, ref, null, tok]);
      }
    }
    for (const [src, pin, name, tpin, , cm] of st.gotos) src.execs.push(new ExecOut(pin, name, tpin, cm));
    this.body_state = null;
  }

  /** The statements of a body or of an exec output's block, up to its `}`. */
  block(st: Body, prefix: string, cur: [string, string | null] | null, scope: Scope, top: boolean, region: boolean): void {
    const g = st.g;
    let k = 0;
    while (!this.atP("}")) {
      const t0 = this.peek();
      const [meta, attrs] = this.decorators();
      const t = this.peek();
      const cm = this.leadComments(t0.line, t.line);
      if (this.atKw("flow") && this.atP("{", 1)) this.error(FLOW_HINT);
      if (this.atKw("layout") && this.atP("{", 1)) this.error(LAYOUT_HINT);
      if ((this.atKw("local") || this.atKw("state")) && this.at("id", null, 1)) {
        if (!top) this.error("a local is declared at the top of the function");
        this.next();
        const name = this.ident();
        this.expectP(":");
        const ty = this.type();
        let def: Lit | null = null;
        if (this.atP("=")) {
          this.next();
          def = this.literal();
        }
        (t.value === "local" ? g.locals : g.states).push(new Local(name, ty, def, attrs, meta, cm));
        this.endStmt();
      } else if (this.atKw("box") && this.atP("{", 1)) {
        if (!top) this.error("a box is declared at the top of the function");
        if (attrs.length) this.error(`a box takes no @${attrs[0].name}`);
        this.next();
        const props = this.attrBlock();
        g.boxes.push(this.makeBox(st, props, meta, t));
        this.endStmt();
      } else if (this.atKw("node") && this.at("id", null, 1) && this.atP("=", 2)) {
        if (!top || region) this.error("a named node is declared at the top of the function, with 'node name = ...'");
        this.next();
        const nt = this.peek();
        const name = this.ident("node name");
        if (st.named.has(name)) throw new ParseError(`two nodes are named '${name}'`, nt.line, nt.col);
        this.expectP("=");
        const at = this.anchors.length;
        this.anchors.push([this.i, ["node", g.name, name]]);
        const ns = this.nodeExpr(name, []);
        this.anchors[at] = [this.anchors[at][0], ["node", g.name, name]];
        const n = ns[0];
        n.named = true;
        n.comment = cm;
        n.meta.push(...meta);
        n.attrs.push(...attrs);
        st.named.set(name, n);
        g.nodes.push(...ns);
        if (this.atP(".")) this.error(`a named node's exec outputs are written where it runs: 'exec ${name}.pin -> { ... }'`);
        this.endStmt();
      } else if (this.atKw("goto")) {
        if (meta.length || attrs.length) this.error("a goto takes no decorators");
        const gt = this.next();
        if (cur === null)
          throw new ParseError("nothing runs before this goto: it must follow a node or open an exec output's block", gt.line, gt.col);
        const nt = this.peek();
        const name = this.ident("node name");
        let tpin: string | null = null;
        if (this.atP(".")) {
          this.next();
          tpin = this.ident("exec input");
        }
        const src = g.node(cur[0])!;
        const bound = Parser.lookup(scope, name);
        if (bound !== null && tpin === null) src.execs.push(new ExecOut(cur[1], bound[0], bound[1], cm));
        else st.gotos.push([src, cur[1], name, tpin, nt, cm]);
        cur = null;
        this.endStmt();
      } else if (this.atKw("exec")) {
        this.next();
        const first = cur === null && !region;
        const before = g.nodes.length;
        const ref = this.peek();
        cur = this.execStmt(st, prefix + String(k), cur, scope, meta, attrs, cm, t);
        const placed = g.nodes.length > before ? g.nodes[before] : st.named.get(ref.value) ?? null;
        this.endStmt();
        if (first && (placed === null || placed.kind !== "Entry"))
          throw new ParseError(
            "nothing continues to this node: the node before it ends with blocks " +
            "only, a goto or a Return. End the last block with '}.pin' to continue " +
            "from that output, or write '!exec' for a node that is not wired", t.line, t.col);
        k += 1;
        region = false;
      } else if (this.atP("!")) {
        this.next();
        const r = st.regions;
        st.regions += 1;
        if (this.atP("{")) {
          if (meta.length || attrs.length) this.error("decorators go on the statements inside a '!{ }' block");
          this.next();
          this.skipNl();
          this.block(st, `~${r}.`, null, [], false, true);
          this.next();
        } else if (this.atKw("exec")) {
          this.next();
          const after = this.execStmt(st, `~${r}`, null, scope, meta, attrs, cm, t);
          if (after !== null && after[1] !== null)
            throw new ParseError("'!exec' stands alone; write a chain that nothing reaches as a '!{ ... }' block", t.line, t.col);
        } else {
          this.anchors.push([this.i, ["node", g.name, `~${r}`]]);
          const ns = this.nodeExpr(`~${r}`, scope);
          ns[0].meta.push(...meta);
          ns[0].attrs.push(...attrs);
          ns[0].comment = cm;
          g.nodes.push(...ns);
        }
        this.endStmt();
      } else {
        this.error("expected 'exec', 'goto', 'node', 'local', 'state', 'box' or '!'");
      }
    }
  }

  static lookup(scope: Scope, name: string): [string, string] | null {
    for (let i = scope.length - 1; i >= 0; i--) if (scope[i].has(name)) return scope[i].get(name)!;
    return null;
  }

  /** `exec Kind(...)` or `exec name`, then its exec outputs. Returns the exec output the next
   * statement continues from. */
  execStmt(st: Body, pos: string, cur: [string, string | null] | null, scope: Scope, meta: Attr[], attrs: Attr[],
           cm: string[], _tok: Tok): [string, string | null] | null {
    const g = st.g;
    const namedRef = this.at("id") && !(
      this.atP("(", 1) || this.atP("{", 1) || this.atP("#", 1) || this.at("id", null, 1) ||
      this.at("str", null, 1) || this.atP("<", 1) || this.atP("::", 1));
    let x: Node;
    if (namedRef) {
      const nt = this.next();
      const found = st.named.get(nt.value) ?? null;
      if (found === null && /^\p{Lu}/u.test(nt.value))
        throw new ParseError(`expected '(' after the node; a node without inputs is written '${nt.value}()'`, nt.line, nt.col);
      if (found === null)
        throw new ParseError(`no node is named '${nt.value}'; declare it at the top of the function with 'node ${nt.value} = ...'`, nt.line, nt.col);
      x = found;
      if (st.placed.has(x.id))
        throw new ParseError(`'${nt.value}' already has its exec point; use 'goto ${nt.value}' to run it from here`, nt.line, nt.col);
      if (meta.length || cm.length)
        throw new ParseError(`decorators and comments of '${nt.value}' go above its 'node' statement`, nt.line, nt.col);
      x.attrs.push(...attrs);
    } else {
      this.anchors.push([this.i, ["node", g.name, pos]]);
      const ns = this.nodeExpr(pos, scope);
      x = ns[0];
      x.meta.push(...meta);
      x.attrs.push(...attrs);
      x.comment = cm;
      g.nodes.push(...ns);
    }
    st.placed.add(x.id);
    if (cur !== null) g.node(cur[0])!.execs.push(new ExecOut(cur[1], x.id));
    let outs = false;
    while (this.atP(".")) {
      this.next();
      const pt = this.peek();
      const pin = this.pinName("exec output");
      const nt = this.peek();
      if (this.atP("(") && nt.line === pt.line && nt.col === pt.col + pin.length)
        this.error(`an exec output's block binds names between bars: '.${pin}|name, ...| -> { ... }'`);
      if (!(this.atP("|") || this.atP("->") || this.atP("<-") || this.atP("}") || this.at("nl") || this.at("eof"))) {
        const [val, inline] = this.inputValue(`${x.id}.${pin}`, scope);
        x.bindings.push(new Binding(pin, val));
        g.nodes.push(...inline);
      }
      const names: string[] = [];
      if (this.atP("|")) {
        this.next();
        while (!this.atP("|")) {
          names.push(this.ident("output or exec input name"));
          if (this.atP(",")) this.next();
          else if (!this.atP("|")) this.error("expected ',' or '|'");
        }
        this.next();
      }
      if (!this.atP("->")) {
        if (names.length)
          this.error(`'.${pin}' continues in this block, so it binds no names; write '.${pin}|${names.join(", ")}| -> { ... }'`);
        if (!this.at("nl") && !this.atP("}"))
          this.error(`expected '-> {' after '.${pin}', or the end of the line to continue from it in this block`);
        x.flat = true;
        x.flat_pin = pin;
        return [x.id, pin];
      }
      this.next();
      this.expectP("{");
      this.skipNl();
      const bound = new Map(names.map((n) => [n, [x.id, n] as [string, string]]));
      this.block(st, `${x.id}.${pin}.`, [x.id, pin], [...scope, bound], false, false);
      this.next();
      outs = true;
    }
    if (outs) {
      x.flat = false;
      x.flat_pin = null;
      return null;
    }
    return [x.id, null];
  }

  /** `box {title="...", pos=(x, y), size=(w, h), ...}`: a visual frame (section 2.3). */
  makeBox(st: Body, props: [string, Lit][], meta: Attr[], tok: Tok): Box {
    const d = new Map(props);
    const pos = d.get("pos") ?? null, size = d.get("size") ?? null, title = d.get("title") ?? null;
    if (!intPair(pos) || !intPair(size)) throw new ParseError("a box needs pos=(x, y) and size=(w, h)", tok.line, tok.col);
    const rest = props.filter(([k]) => k !== "pos" && k !== "size" && k !== "title");
    const b = new Box(`box.${st.boxes}`, Number(pos!.value[0].value), Number(pos!.value[1].value), rest, {
      title: title !== null && title.kind === "string" ? title.value : "",
      w: Number(size!.value[0].value), h: Number(size!.value[1].value), meta,
    });
    st.boxes += 1;
    return b;
  }

  /** `{key=value, ...}`: a node's or box's attributes, for display only (section 2.3). */
  attrBlock(): [string, Lit][] {
    this.expectP("{");
    const out: [string, Lit][] = [];
    this.skipNl();
    while (!this.atP("}")) {
      if (!this.at("id")) this.error("expected an attribute, 'name=value'");
      const k = this.qname();
      this.expectP("=");
      out.push([k, this.value()]);
      const nl = this.skipNl();
      if (this.atP(",")) {
        this.next();
        this.skipNl();
      } else if (!this.atP("}") && !nl) this.error("expected ',' or '}'");
    }
    this.next();
    return out;
  }

  /** `Kind [symbol][#<targs>][#name<args>...][{attrs}](inputs)`: a node with the given id,
   * then the nodes written inline in its inputs. */
  nodeExpr(nid: string, scope: Scope): Node[] {
    const kind = this.ident("node kind");
    const n = new Node(nid, kind);
    if (this.at("id")) n.symbol = this.qname();
    else if (kind === "Format" && this.at("str")) n.symbol = this.next().value;
    if (this.atP("<") || this.atP("::")) this.genericsHint();
    if (this.atP("#") && this.atP("<", 1)) {
      n.targs = this.genericArgs(() => this.type());
      if (n.symbol === null && this.at("id")) n.symbol = this.qname();
    }
    while (this.atP("#") && this.at("id", null, 1)) {
      this.next();
      const gt = this.peek();
      const name = this.ident();
      if (!NODE_GENERICS.includes(name))
        throw new ParseError(`unknown named generic '#${name}'; a node takes ${NODE_GENERICS.map((x) => "#" + x).join(" or ")}`, gt.line, gt.col);
      this.expectP("<");
      const args: [string | null, Lit][] = [];
      while (!this.atP(">")) {
        args.push([null, this.value()]);
        if (this.atP(",")) this.next();
        else if (!this.atP(">")) this.error("expected ',' or '>'");
      }
      this.next();
      n.attrs.push(new Attr(name, args));
    }
    if (this.atP("{")) {
      const at = this.peek();
      const props = this.attrBlock();
      const pos = new Map(props).get("pos") ?? null;
      const rest = props.filter(([k]) => k !== "pos");
      if (pos === null) {
        if (rest.length) throw new ParseError("a node's attribute block needs its position, pos=(x, y)", at.line, at.col);
      } else if (!intPair(pos)) {
        throw new ParseError("a position is two integers, pos=(x, y)", at.line, at.col);
      } else {
        this.body_state!.g.places.push(new Place(nid, Number(pos.value[0].value), Number(pos.value[1].value), rest));
      }
    }
    if (!this.atP("(")) {
      let j = this.i;
      while (this.toks[j].kind === "nl") j += 1;
      if (this.toks[j].kind === "punct" && this.toks[j].value === ".")
        this.error("a node's inputs are written in parentheses after it: 'Kind(.pin <- value ...)'");
      this.error(`expected '(' after the node; a node without inputs is written '${kind}()'`);
    }
    this.next();
    const out = [n];
    this.skipNl();
    while (!this.atP(")")) {
      const t0 = this.peek();
      const [meta, attrs] = this.decorators();
      if (!this.atP(".")) this.error("expected an input, '.pin <- value', or ')'");
      const cm = this.leadComments(t0.line, this.peek().line);
      this.next();
      const pin = this.pinName("pin name");
      this.expectP("<-");
      this.skipNl();
      const [val, inline] = this.inputValue(`${nid}.${pin}`, scope);
      if ((meta.length || attrs.length) && !inline.length)
        throw new ParseError("a decorator above an input belongs to the node written in it; this input holds no node", t0.line, t0.col);
      if (inline.length) {
        inline[0].meta.unshift(...meta);
        inline[0].attrs.unshift(...attrs);
      }
      n.bindings.push(new Binding(pin, val, cm));
      out.push(...inline);
      const nl = this.skipNl();
      if (this.atP(",")) {
        this.next();
        this.skipNl();
      } else if (!this.atP(")") && !nl) this.error("expected ',', a new line or ')' after an input");
    }
    this.next();
    return out;
  }

  /** The value bound to an input. Returns [value, inline nodes]. */
  inputValue(path: string, scope: Scope): [PinRef | Lit, Node[]] {
    const t = this.peek();
    if (t.kind === "id" && this.atP("::", 1) && this.at("id", null, 2)) return [this.enumValue(), []];
    if (t.kind === "id" && !RESERVED.has(t.value)) {
      if (this.atP(".", 1) && this.at("id", null, 2)) {
        this.next();
        this.next();
        return [new PinRef(t.value, this.ident("pin name")), []];
      }
      if (!(this.atP("(", 1) || this.atP("#", 1) || this.atP("{", 1) || this.atP("<", 1) ||
            this.atP("::", 1) || this.at("id", null, 1) || this.at("str", null, 1))) {
        this.next();
        const bound = Parser.lookup(scope, t.value);
        if (bound !== null) return [new PinRef(bound[0], bound[1]), []];
        const ref = new PinRef(t.value, null);
        this.body_state!.bare.push([ref, t.value, t]);
        return [ref, []];
      }
      this.anchors.push([this.i, ["node", this.graph_name!, path]]);
      const inline = this.nodeExpr(path, scope);
      if (!(this.atP(".") && this.at("id", null, 1))) {
        const ref = new PinRef(path, null);
        this.defaults.push([this.graph_name!, ref, inline[0], t]);
        return [ref, inline];
      }
      this.next();
      return [new PinRef(path, this.ident("pin name")), inline];
    }
    return [this.literal(), []];
  }
}

function intPair(v: Lit | null): boolean {
  return v !== null && v.kind === "tuple" && v.value.length === 2 && v.value.every((x: Lit) => x.kind === "int");
}

/** Old-style `#cases<Mode::Idle, ...>` arguments written as bare dotted names become enum values. */
export function resolveEnumValues(mod: Module): void {
  const enums = new Set(mod.items.filter((it): it is Enum => it instanceof Enum).map((it) => it.name));
  if (!enums.size) return;
  for (const g of mod.graphs())
    for (const n of g.nodes)
      for (const a of n.attrs)
        if (a.name === "cases" && a.args)
          a.args = a.args.map(([k, v]) => [k, v.kind === "ident" && v.value.split(".").length === 2 &&
            enums.has(v.value.split(".")[0]) ? new Lit("enum", v.value) : v]);
}

/** Whether a `Call` in `g` takes `self` from the method it is in when its `self` input is
 * left out (section 2.2). */
export function selfReceiver(n: Node, g: Graph, idx: ModuleIndex): boolean {
  if (n.kind !== "Call" || !g.receiver || !n.symbol || !idx.classes.has(g.receiver)) return false;
  const callee = idx.callee(n.symbol, n.targs);
  if (callee === null || !callee.method_of) return false;
  const owner = callee.method_of;
  return idx.classChain(g.receiver).includes(owner) || idx.implements(g.receiver, owner);
}

/** Fill in `self` on the method calls that leave it out (section 2.2). */
export function resolveSelf(mod: Module): void {
  if (!mod.graphs().some((g) => g.receiver)) return;
  const idx = new ModuleIndex(mod);
  for (const g of mod.graphs()) {
    const entry = g.nodes.find((n) => n.kind === "Entry")?.id ?? null;
    if (!g.receiver || entry === null) continue;
    for (const n of g.nodes)
      if (n.binding("self") === null && selfReceiver(n, g, idx))
        n.bindings.unshift(new Binding("self", new PinRef(entry, "self")));
  }
}

export function parse(text: string): Module {
  return new Parser(text).parseModule();
}

/** Parse a single literal, as typed into an editor field. */
export function parseLiteral(text: string): Lit {
  const p = new Parser(text);
  p.skipNl();
  const lit = p.literal();
  p.skipNl();
  if (!p.at("eof")) p.error("unexpected text after literal");
  return lit;
}
