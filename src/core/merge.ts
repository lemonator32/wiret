/** `wiretc merge base ours theirs`: the keyed three-way merge of section 7.1.
 *
 * Every element is matched by key across the three versions and merged per field: a field
 * changed on one side takes that change, the same change on both sides is no change, and
 * different changes are a conflict. Layout never blocks a merge; notes merge as a list.
 * Conflicts are written as markers around the lines concerned, and the result is validated.
 * A side that does not parse cannot be merged by key; the CLI then falls back to a line
 * merge (src/cli). */
import { check, Diag } from "./checker.js";
import { declKind, elements, Element, getId } from "./ids.js";
import {
  Attr, Binding, Box, Class, Const, Dispatcher, Enum, EnumMember, ExecOut, Extern, Graph, IfaceMethod, Interface, Item, Lit, Module,
  Node, Param, PinRef, Place, Struct, Use, Var,
} from "./model.js";
import { parse, ParseError } from "./parser.js";
import { fmtAttr, fmtLit, fmtParams, printModule } from "./printer.js";
import { ModuleIndex, signature } from "./registry.js";
import { renameElement, RenameError } from "./rename.js";
import { SequenceMatcher, splitlinesKeep } from "./difflib.js";
import { deepcopy, key as tupleKey, sortedBy } from "./pyutil.js";

export class Conflict {
  constructor(public where: string, public what: string, public setTheirs: (m: Module) => void) {}
}

export class MergeResult {
  constructor(public text: string, public conflicts: Conflict[] = [], public semantic: (Diag | string)[] = [],
              public notices: string[] = [], public fallback = false) {}
  get clean(): boolean { return !this.conflicts.length && !this.semantic.length; }
}

/** A field: [text it compares by, the value it sets]. */
export type FieldVal = [string, any];
export type Fields = Map<string, FieldVal>;
export type Key = string;

export const valText = (v: PinRef | Lit) => (v instanceof PinRef ? `${v.node}.${v.pin}` : fmtLit(v));
export const metaText = (a: Attr) => fmtAttr(a);

/** A named node is matched by its name; an anonymous one by what it is and where it is written. */
export function nodeKey(n: Node): Key {
  return n.named ? tupleKey("name", n.id) : tupleKey("at", n.kind, n.symbol || "", n.id);
}

export function attrFields(attrs: Attr[], prefix = "attr"): Fields {
  const out: Fields = new Map();
  for (const a of attrs) {
    const k = `${prefix}:${a.name}`;
    const prev = out.get(k);
    out.set(k, prev ? [prev[0] + " " + fmtAttr(a), [...prev[1], a]] : [fmtAttr(a), [a]]);
  }
  return out;
}

function commentField(out: Fields, k: string, lines: string[]): void {
  if (lines.length) out.set(k, [lines.join("\n"), [...lines]]);
}

export function nodeFields(n: Node, singleOut: string | null, comments = false): Fields {
  const out: Fields = new Map([["kind", [n.kind, n.kind]], ["symbol", [n.symbol || "", n.symbol]], ["named", [n.named ? "True" : "False", n.named]]]);
  n.targs.forEach((t, i) => out.set(`targ:${i}`, [t, t]));
  for (const [k, v] of attrFields(n.attrs)) out.set(k, v);
  for (const b of n.bindings) out.set(`bind:${b.pin}`, [valText(b.value), b]);
  for (const x of n.execs) {
    const pin = x.pin || singleOut || "then";
    const target = x.target + (x.target_pin ? `.${x.target_pin}` : "");
    out.set(`exec:${pin}`, [target, new ExecOut(pin, x.target, x.target_pin)]);
    if (comments) commentField(out, `cmt:exec:${pin}`, x.comment);
  }
  if (comments) {
    commentField(out, "cmt", n.comment);
    for (const b of n.bindings) commentField(out, `cmt:bind:${b.pin}`, b.comment);
  }
  return out;
}

const sortedEntries = (f: Fields) => sortedBy([...f], (e) => e[0]);

export function buildNode(proto: Node, f: Fields): Node {
  const n = deepcopy(proto);
  n.kind = f.get("kind")![1];
  n.symbol = f.has("symbol") ? f.get("symbol")![1] : null;
  n.named = f.has("named") ? f.get("named")![1] : n.named;
  n.targs = sortedBy([...f].filter(([k]) => k.startsWith("targ:")).map(([k, v]) => [parseInt(k.split(":")[1], 10), v[1]] as [number, string]))
    .map(([, t]) => t);
  n.attrs = sortedEntries(f).filter(([k]) => k.startsWith("attr:")).flatMap(([, v]) => v[1]);
  n.bindings = sortedEntries(f).filter(([k]) => k.startsWith("bind:")).map(([, v]) => deepcopy(v[1] as Binding));
  n.execs = sortedEntries(f).filter(([k]) => k.startsWith("exec:")).map(([, v]) => deepcopy(v[1] as ExecOut));
  n.comment = [...(f.get("cmt")?.[1] ?? [])];
  for (const b of n.bindings) b.comment = [...(f.get(`cmt:bind:${b.pin}`)?.[1] ?? [])];
  for (const e of n.execs) e.comment = [...(f.get(`cmt:exec:${e.pin}`)?.[1] ?? [])];
  return n;
}

/** A parameter, result, field, enum member, local or state slot. */
export function subFields(x: any, comments = false): Fields {
  const out: Fields = new Map([["name", [x.name, x.name]]]);
  if (comments) commentField(out, "cmt", x.comment ?? []);
  if (typeof x.type === "string") out.set("type", [x.type, x.type]);
  const d = x.default_ ?? null;
  if (d !== null) out.set("default", [fmtLit(d), d]);
  if (x instanceof EnumMember && x.value !== null) out.set("value", [String(x.value), x.value]);
  if (x instanceof IfaceMethod || x instanceof Dispatcher) {
    const text = fmtParams(x.params) + (x.results !== null ? " -> " + fmtParams(x.results) : "");
    out.set("sig", [text, [x.params, x.results]]);
  }
  for (const [k, v] of attrFields(x.attrs)) out.set(k, v);
  return out;
}

export function buildSub(proto: any, f: Fields): any {
  const x = deepcopy(proto);
  x.name = f.get("name")![1];
  if (f.has("type")) x.type = f.get("type")![1];
  if ("default_" in x) x.default_ = f.has("default") ? f.get("default")![1] : null;
  if (x instanceof EnumMember) x.value = f.has("value") ? f.get("value")![1] : null;
  if (x instanceof IfaceMethod) [x.params, x.results] = deepcopy(f.get("sig")![1]);
  if (x instanceof Dispatcher) x.params = deepcopy(f.get("sig")![1][0]);
  x.attrs = sortedEntries(f).filter(([k]) => k.startsWith("attr:")).flatMap(([, v]) => v[1]);
  if ("comment" in x) x.comment = [...(f.get("cmt")?.[1] ?? [])];
  return x;
}

/** Declarations, parameters, fields, members and locals: by @id, else by name. */
export function keyOf(x: { attrs?: Attr[]; name: string }, kind = ""): Key {
  const i = getId(x.attrs ?? []);
  return i ? tupleKey("id", i) : tupleKey(kind, x.name);
}
const isIdKey = (k: Key) => k.startsWith('[s"id",');

export { declKind };

export function declFields(it: Item, comments = false): Fields {
  const out: Fields = new Map([["name", [it.name, it.name]]]);
  if (comments) commentField(out, "cmt", it.comment);
  for (const [k, v] of attrFields(it.attrs)) out.set(k, v);
  if (it instanceof Use) out.set("alias", [it.alias || "", it.alias]);
  if (it instanceof Extern) {
    out.set("kind", [it.kind, it.kind]);
    out.set("arrow", [it.results !== null ? "True" : "False", it.results !== null]);
  }
  if (it instanceof Const || it instanceof Var) {
    out.set("type", [it.type, it.type]);
    const v = it instanceof Const ? it.value : it.default_;
    if (v !== null) out.set("value", [fmtLit(v), v]);
  }
  if (it instanceof Enum || it instanceof Class) out.set("base", [it.base || "", it.base]);
  if (it instanceof Class) out.set("impls", [it.impls.join(", "), [...it.impls]]);
  if (it instanceof Graph) {
    out.set("tparams", [it.tparams.join(","), [...it.tparams]]);
    out.set("arrow", [it.results !== null ? "True" : "False", it.results !== null]);
  }
  return out;
}

export function buildDecl(proto: Item, f: Fields): Item {
  const it: any = deepcopy(proto);
  it.name = f.get("name")![1];
  it.attrs = sortedEntries(f).filter(([k]) => k.startsWith("attr:")).flatMap(([, v]) => v[1]);
  if (it instanceof Use) it.alias = f.get("alias")![1];
  if (it instanceof Const || it instanceof Var) {
    it.type = f.get("type")![1];
    const v = f.has("value") ? f.get("value")![1] : null;
    if (it instanceof Const) it.value = v;
    else it.default_ = v;
  }
  if (it instanceof Enum || it instanceof Class) it.base = f.get("base")![1];
  if (it instanceof Class) it.impls = [...f.get("impls")![1]];
  if (it instanceof Graph) it.tparams = f.get("tparams")![1];
  it.comment = [...(f.get("cmt")?.[1] ?? [])];
  return it;
}

const fieldsEqual = (a: Fields, b: Fields) => a.size === b.size && [...a].every(([k, v]) => b.has(k) && b.get(k)![0] === v[0]);

// -- the merger --------------------------------------------------------------------------
export class Merger {
  conflicts: Conflict[] = [];
  notices: string[] = [];
  private idx = new Map<Module, ModuleIndex>();

  constructor(public b: Module, public o: Module, public t: Module) {
    for (const m of [b, o, t]) this.idx.set(m, new ModuleIndex(m));
  }

  mergeFields(b: Fields | null, o: Fields | null, t: Fields | null, where: string,
              setter: (m: Module, k: string, theirs: FieldVal | undefined) => void): Fields {
    b ??= new Map();
    o ??= new Map();
    t ??= new Map();
    const out: Fields = new Map();
    for (const k of sortedBy(new Set([...b.keys(), ...o.keys(), ...t.keys()]))) {
      const vb = b.get(k), vo = o.get(k), vt = t.get(k);
      const tb = vb?.[0], to = vo?.[0], tt = vt?.[0];
      let pick: FieldVal | undefined;
      if (to === tt) pick = vo;
      else if (to === tb) pick = vt;
      else if (tt === tb) pick = vo;
      else {
        pick = vo;
        const theirs = vt;
        this.conflicts.push(new Conflict(k.includes(":") ? `${where}.${k.split(":").pop()}` : `${where}.${k}`,
          `changed differently on both sides (${k})`, (m) => setter(m, k, theirs)));
      }
      if (pick !== undefined) out.set(k, pick);
    }
    return out;
  }

  mergeKeyed<T>(b: T[], o: T[], t: T[], key: (x: T) => Key, _where: string, mergeOne: (xb: T | undefined, xo: T, xt: T) => T,
                changed: (x: T, y: T) => boolean, onConflict: (kept: T | null, side: T | null, k: Key, deleter: string) => void,
                nameKey: ((x: T) => Key) | null = null): T[] {
    const sides = [b, o, t].map((lst) => new Map(lst.map((x) => [key(x), x])));
    if (nameKey !== null) {
      const byName = new Map<Key, Key>();
      for (const side of sides) for (const [k, x] of side) if (isIdKey(k) && !byName.has(nameKey(x))) byName.set(nameKey(x), k);
      for (const side of sides) {
        for (const [k, x] of [...side]) {
          const target = !isIdKey(k) ? byName.get(nameKey(x)) : undefined;
          if (target !== undefined && !side.has(target)) {
            side.delete(k);
            side.set(target, x);
          }
        }
      }
    }
    const [mb, mo, mt] = sides;
    const result = new Map<Key, T>();
    for (const k of [...mo.keys(), ...[...mt.keys()].filter((x) => !mo.has(x))]) {
      const xb = mb.get(k), xo = mo.get(k), xt = mt.get(k);
      if (xo !== undefined && xt !== undefined) result.set(k, mergeOne(xb, xo, xt));
      else if (xb === undefined) result.set(k, deepcopy((xo ?? xt)!));
      else if (xo === undefined && xt !== undefined) {
        if (changed(xb, xt)) onConflict(null, xt, k, "ours");
      } else if (xt === undefined && xo !== undefined) {
        if (changed(xb, xo)) {
          result.set(k, deepcopy(xo));
          onConflict(xo, null, k, "theirs");
        }
      }
    }
    const orderO = [...mo.keys()].filter((k) => result.has(k));
    const orderT = [...mt.keys()].filter((k) => result.has(k));
    const commonB = [...mb.keys()].filter((k) => mo.has(k) && mt.has(k));
    const ourCommon = [...mo.keys()].filter((k) => commonB.includes(k));
    const useT = ourCommon.length === commonB.length && ourCommon.every((k, i) => k === commonB[i]);
    const baseOrder = useT ? orderT : orderO;
    const other = useT ? orderO : orderT;
    const order = [...baseOrder];
    other.forEach((k, i) => {
      if (order.includes(k)) return;
      let prev: Key | null = null;
      for (let j = i - 1; j >= 0; j--) if (order.includes(other[j])) { prev = other[j]; break; }
      order.splice(prev !== null ? order.indexOf(prev) + 1 : 0, 0, k);
    });
    for (const k of result.keys()) if (!order.includes(k)) order.push(k);
    return order.map((k) => result.get(k)!);
  }

  // metadata --------------------------------------------------------------------------
  mergeMeta(b: Attr[], o: Attr[], t: Attr[], where: string, ownerPath: (m: Module) => { meta: Attr[] } | null): Attr[] {
    const plain = (meta: Attr[]): Fields => {
      const out: Fields = new Map();
      for (const a of meta) {
        if (a.name === "note") continue;
        const k = `meta:${a.name}`;
        const prev = out.get(k);
        out.set(k, [(prev ? prev[0] + "\n" : "") + metaText(a), [...(prev ? prev[1] : []), a]]);
      }
      return out;
    };
    const setter = (m: Module, k: string, theirs: FieldVal | undefined) => {
      const owner = ownerPath(m);
      if (owner === null) return;
      const name = k.slice(k.indexOf(":") + 1);
      owner.meta = [...owner.meta.filter((a) => a.name !== name), ...(theirs ? theirs[1] : [])];
    };
    const merged = this.mergeFields(plain(b), plain(o), plain(t), where, setter);
    const out: Attr[] = sortedEntries(merged).flatMap(([, v]) => v[1]);
    const nb = b.filter((a) => a.name === "note").map(metaText);
    const no = o.filter((a) => a.name === "note").map(metaText);
    const nt = t.filter((a) => a.name === "note").map(metaText);
    const byText = new Map([...b, ...o, ...t].filter((a) => a.name === "note").map((a) => [metaText(a), a]));
    const goneO = nb.filter((x) => !no.includes(x)), goneT = nb.filter((x) => !nt.includes(x));
    const newO = no.filter((x) => !nb.includes(x)), newT = nt.filter((x) => !nb.includes(x) && !no.includes(x));
    let keep = [...no.filter((x) => !goneT.includes(x)), ...newT];
    if (goneO.some((x) => goneT.includes(x)) && newO.length && newT.length) {
      keep = keep.filter((x) => !newT.includes(x));
      this.conflicts.push(new Conflict(`${where} note`, "a note was replaced differently on both sides", (m) => {
        const owner = ownerPath(m);
        if (owner !== null) owner.meta = [...owner.meta.filter((a) => a.name !== "note"), ...nt.map((x) => deepcopy(byText.get(x)!))];
      }));
    }
    out.push(...keep.map((x) => deepcopy(byText.get(x)!)));
    return out;
  }

  // module ----------------------------------------------------------------------------
  merge(): Module {
    const { b, o, t } = this;
    const m = deepcopy(o);
    const mf = (x: Module): Fields => new Map([["name", [x.name, x.name] as FieldVal], ...attrFields(x.attrs)]);
    const fields = this.mergeFields(mf(b), mf(o), mf(t), "module", (mm, k, theirs) => this.setModule(mm, k, theirs));
    m.name = fields.get("name")![1];
    m.attrs = sortedEntries(fields).filter(([k]) => k.startsWith("attr:")).flatMap(([, v]) => v[1]);
    m.meta = this.mergeMeta(b.meta, o.meta, t.meta, "module", (mm) => mm);
    m.comment = [...(o.comment.join("\n") === b.comment.join("\n") ? t.comment : o.comment)];
    m.comments = [];
    const changed = (x: Item, y: Item) => this.declText(x) !== this.declText(y);
    const conflict = (kept: Item | null, side: Item | null, _k: Key, deleter: string) => {
      const name = (kept ?? side)!.name;
      const apply = deleter === "ours" ? (mm: Module) => { mm.items.push(deepcopy(side!)); }
        : (mm: Module) => { mm.items = mm.items.filter((x) => x.name !== name); };
      this.conflicts.push(new Conflict(name, `deleted in ${deleter}, changed in the other`, apply));
    };
    m.items = this.mergeKeyed(b.items, o.items, t.items, (x) => keyOf(x, declKind(x)), "module",
      (xb, xo, xt) => this.mergeDecl(xb ?? null, xo, xt), changed, conflict, (x) => tupleKey(declKind(x), x.name));
    this.carryRenames(m);
    return m;
  }

  private setModule(m: Module, k: string, theirs: FieldVal | undefined): void {
    if (k === "name") m.name = theirs![1];
    else m.attrs = [...m.attrs.filter((a) => `attr:${a.name}` !== k), ...(theirs ? theirs[1] : [])];
  }

  declText(it: Item): string {
    const mm = new Module(1, "x");
    mm.items = [it];
    return printModule(mm);
  }

  findDecl(m: Module, k: Key): Item | null {
    return m.items.find((x) => keyOf(x, declKind(x)) === k) ?? null;
  }

  mergeDecl(b: Item | null, o: Item, t: Item): Item {
    let kref = keyOf(o, declKind(o));
    const where = o.name;
    const setter = (m: Module, fk: string, theirs: FieldVal | undefined) => {
      const it = this.findDecl(m, kref);
      if (it === null) return;
      const f = declFields(it, true);
      if (theirs === undefined) f.delete(fk);
      else f.set(fk, theirs);
      m.items[m.items.indexOf(it)] = buildDecl(it, f);
    };
    const df = (x: Item | null) => (x !== null ? declFields(x, true) : null);
    const fields = this.mergeFields(df(b), df(o), df(t), where, setter);
    const it: any = buildDecl(o, fields);
    kref = keyOf(it, declKind(it));
    const k = kref;
    it.meta = this.mergeMeta(b ? b.meta : [], o.meta, t.meta, where, (m) => this.findDecl(m, kref));
    const subs: [string, string][] = [];
    if (it instanceof Graph || it instanceof Extern) subs.push(["params", "param"], ["results", "result"]);
    if (it instanceof Graph) subs.push(["locals", "local"], ["states", "state"]);
    if (it instanceof Struct || it instanceof Class) subs.push(["fields", "field"]);
    if (it instanceof Interface) subs.push(["methods", "method"]);
    if (it instanceof Class) subs.push(["dispatchers", "dispatcher"]);
    if (it instanceof Enum) subs.push(["members", "member"]);
    for (const [attr] of subs) {
      const vb = b ? ((b as any)[attr] ?? []) : [];
      let merged: any[] | null = this.mergeSubs(vb, (o as any)[attr] ?? [], (t as any)[attr] ?? [], `${where}.${attr}`, k, attr);
      if (attr === "results" && !fields.get("arrow")?.[1]) merged = merged.length ? merged : null;
      it[attr] = merged;
    }
    if (it instanceof Graph) this.mergeBody(b as Graph | null, o as Graph, t as Graph, it);
    return it;
  }

  mergeSubs(b: any[], o: any[], t: any[], where: string, declKey: Key, attr: string): any[] {
    const mergeOne = (xb: any, xo: any, xt: any) => {
      const sk = keyOf(xo);
      const setter = (m: Module, fk: string, theirs: FieldVal | undefined) => {
        const it: any = this.findDecl(m, declKey);
        const lst: any[] | null = it !== null ? it[attr] ?? null : null;
        const x = (lst ?? []).find((y) => keyOf(y) === sk);
        if (x === undefined) return;
        const f = subFields(x, true);
        if (theirs === undefined) f.delete(fk);
        else f.set(fk, theirs);
        lst![lst!.indexOf(x)] = buildSub(x, f);
      };
      const sf = (x: any) => (x !== undefined && x !== null ? subFields(x, true) : null);
      const f = this.mergeFields(sf(xb), sf(xo), sf(xt), `${where}.${xo.name}`, setter);
      const x = buildSub(xo, f);
      if ("meta" in x) x.meta = this.mergeMeta(xb?.meta ?? [], xo.meta, xt.meta, `${where}.${xo.name}`, () => null);
      return x;
    };
    const changed = (x: any, y: any) => !fieldsEqual(subFields(x, true), subFields(y, true));
    const conflict = (kept: any, side: any, _k: Key, deleter: string) => {
      this.conflicts.push(new Conflict(`${where}.${(kept ?? side).name}`, `deleted in ${deleter}, changed in the other`, () => {}));
    };
    return this.mergeKeyed(b, o, t, (x) => keyOf(x), where, mergeOne, changed, conflict, (x) => tupleKey("", x.name));
  }

  // graph bodies ----------------------------------------------------------------------
  singleOuts(m: Module, g: Graph | null): Map<string, string | null> {
    if (g === null) return new Map();
    const idx = this.idx.get(m) ?? new ModuleIndex(m);
    return new Map(g.nodes.map((n) => {
      const outs = signature(n, g, idx).exec_outs;
      return [n.id, outs.length === 1 ? outs[0].name : null];
    }));
  }

  mergeBody(b: Graph | null, o: Graph, t: Graph, g: Graph): void {
    const name = g.name;
    const so = this.singleOuts(this.o, o), st = this.singleOuts(this.t, t), sb = this.singleOuts(this.b, b);
    const gk = keyOf(g, g.kind);
    const graphIn = (m: Module): Graph | null => {
      const it = this.findDecl(m, gk);
      return it instanceof Graph ? it : null;
    };
    const nf = (n: Node, singles: Map<string, string | null>) => nodeFields(n, singles.get(n.id) ?? null, true);
    const mergeOne = (nb: Node | undefined, no: Node, nt: Node) => {
      const nid = no.id;
      const setter = (m: Module, fk: string, theirs: FieldVal | undefined) => {
        const gg = graphIn(m);
        const n = gg ? gg.node(nid) : null;
        if (n === null) return;
        const f = nodeFields(n, null, true);
        if (theirs === undefined) f.delete(fk);
        else f.set(fk, theirs);
        gg!.nodes[gg!.nodes.indexOf(n)] = buildNode(n, f);
      };
      const f = this.mergeFields(nb ? nf(nb, sb) : null, nf(no, so), nf(nt, st), `${name}.${nid}`, setter);
      const n = buildNode(no, f);
      n.meta = this.mergeMeta(nb ? nb.meta : [], no.meta, nt.meta, `${name}.${nid}`, (m) => graphIn(m)?.node(nid) ?? null);
      return n;
    };
    const singlesFor = (x: Node) => (o.nodes.includes(x) ? so : t.nodes.includes(x) ? st : sb);
    const changed = (x: Node, y: Node) => !fieldsEqual(nf(x, singlesFor(x)), nf(y, singlesFor(y))) ||
      x.meta.map(metaText).join("\0") !== y.meta.map(metaText).join("\0");
    const conflict = (kept: Node | null, side: Node | null, _k: Key, deleter: string) => {
      const nid = (kept ?? side)!.id;
      const apply = deleter === "ours" ? (m: Module) => {
        const gg = graphIn(m);
        if (gg !== null) {
          gg.nodes.push(deepcopy(side!));
          const p = t.place(side!.id);
          if (p !== null && gg.place(side!.id) === null) gg.places.push(deepcopy(p));
        }
      } : (m: Module) => {
        const gg = graphIn(m);
        if (gg !== null) gg.nodes = gg.nodes.filter((n) => n.id !== nid);
      };
      this.conflicts.push(new Conflict(`${name}.${nid}`, `node deleted in ${deleter}, changed in the other`, apply));
    };
    g.nodes = this.mergeKeyed(b ? b.nodes : [], o.nodes, t.nodes, nodeKey, name, mergeOne, changed, conflict);
    g.meta = this.mergeMeta(b ? b.meta : [], o.meta, t.meta, name, graphIn);
    this.mergeLayout(b, o, t, g);
  }

  /** Places and boxes merge per property; a disagreement never blocks: theirs wins. */
  mergeLayout(b: Graph | null, o: Graph, t: Graph, g: Graph): void {
    const name = g.name;
    const ids = new Set(g.nodes.map((n) => n.id));
    const pfields = (p: Place): Fields => {
      const out: Fields = new Map([["at", [`${p.x},${p.y}`, [p.x, p.y]]]]);
      for (const [k, v] of p.props) out.set(`prop:${k}`, [fmtLit(v), v]);
      if (p instanceof Box) {
        out.set("title", [p.title, p.title]);
        out.set("size", [`${p.w},${p.h}`, [p.w, p.h]]);
      }
      return out;
    };
    const merge3 = (fb: Fields, fo: Fields, ft: Fields, where: string): Fields => {
      const out: Fields = new Map();
      for (const k of sortedBy(new Set([...fb.keys(), ...fo.keys(), ...ft.keys()]))) {
        const vb = fb.get(k), vo = fo.get(k), vt = ft.get(k);
        const tb = vb?.[0], to = vo?.[0], tt = vt?.[0];
        let pick: FieldVal | undefined;
        if (to === tt || to === tb) pick = to === tb ? vt : vo;
        else if (tt === tb) pick = vo;
        else {
          pick = vt;
          this.notices.push(`${where}: ${k.split(":").pop()} changed on both sides; theirs is kept`);
        }
        if (pick !== undefined) out.set(k, pick);
      }
      return out;
    };
    const build = <P extends Place>(proto: P, f: Fields): P => {
      const p = deepcopy(proto);
      [p.x, p.y] = f.get("at")![1];
      p.props = [...f].filter(([k]) => k.startsWith("prop:")).map(([k, v]) => [k.slice(k.indexOf(":") + 1), v[1]] as [string, Lit]);
      if (p instanceof Box) {
        p.title = f.get("title")![1];
        [p.w, p.h] = f.get("size")![1];
      }
      return p;
    };
    const bp = new Map((b ? b.places : []).map((p) => [p.id, p]));
    const op = new Map(o.places.map((p) => [p.id, p]));
    const tp = new Map(t.places.map((p) => [p.id, p]));
    const places: Place[] = [];
    for (const nid of sortedBy(ids)) {
      const pb = bp.get(nid), po = op.get(nid), pt = tp.get(nid);
      if (po === undefined && pt === undefined) continue;
      const f = merge3(pb ? pfields(pb) : new Map(), po ? pfields(po) : new Map(), pt ? pfields(pt) : new Map(), `${name}.${nid}`);
      if (f.has("at")) places.push(build((po ?? pt)!, f));
    }
    g.places = places;
    const bb = new Map((b ? b.boxes : []).map((x) => [x.id, x]));
    const ob = new Map(o.boxes.map((x) => [x.id, x]));
    const tb = new Map(t.boxes.map((x) => [x.id, x]));
    const boxes: Box[] = [];
    for (const bid of [...ob.keys(), ...[...tb.keys()].filter((x) => !ob.has(x))]) {
      const xb = bb.get(bid), xo = ob.get(bid), xt = tb.get(bid);
      if (xb !== undefined && (xo === undefined || xt === undefined)) continue;
      const f = merge3(xb ? pfields(xb) : new Map(), xo ? pfields(xo) : new Map(), xt ? pfields(xt) : new Map(), `${name}.box ${bid}`);
      const box = build((xo ?? xt)!, f);
      box.meta = this.mergeMeta(xb ? xb.meta : [], xo ? xo.meta : [], xt ? xt.meta : [], `${name}.box ${bid}`, () => null);
      boxes.push(box);
    }
    g.boxes = boxes;
  }

  /** An element renamed on one side, matched by @id, keeps its new name; references the
   * other side added under the old name are rewritten (section 7.4). */
  carryRenames(m: Module): void {
    const base = new Map([...elements(this.b)].filter((e) => e.id).map((e) => [e.id!, e]));
    for (const e of [...elements(m)]) {
      const old = base.get(e.id ?? "");
      if (old === undefined || old.name === e.name || e.kind === "module") continue;
      const nu = e.name;
      (e.obj as any).name = old.name;
      try {
        renameElement(m, new Element(e.kind, old.name, e.owner, e.obj), nu);
      } catch (err) {
        if (!(err instanceof RenameError)) throw err;
        (e.obj as any).name = nu;
      }
    }
  }
}

/** Merge three texts that parse. Throws ParseError when one does not (the caller then falls
 * back to a line merge). */
export function mergeModules(base: string, ours: string, theirs: string): MergeResult {
  const mb = parse(base), mo = parse(ours), mt = parse(theirs);
  const mg = new Merger(mb, mo, mt);
  const merged = mg.merge();
  let text = printModule(merged);
  let semantic: (Diag | string)[] = [];
  try {
    const reparsed = parse(text);
    const k = (d: Diag) => tupleKey(d.code, d.graph, d.node, d.pin);
    const seen = new Set([mo, mt].flatMap((side) => check(side).map(k)));
    semantic = check(reparsed).filter((d) => d.severity === "error" && !seen.has(k(d)));
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    semantic = [`the merged text does not parse: ${e.message}`];
  }
  if (mg.conflicts.length) text = withMarkers(merged, mg.conflicts);
  return new MergeResult(text, mg.conflicts, semantic, mg.notices);
}

/** Write each conflict as markers around the lines where ours and theirs differ. */
export function withMarkers(merged: Module, conflicts: Conflict[]): string {
  const lines = splitlinesKeep(printModule(merged));
  const regions: [number, number, string[], Conflict][] = [];
  for (const c of conflicts) {
    const alt = deepcopy(merged);
    c.setTheirs(alt);
    const altLines = splitlinesKeep(printModule(alt));
    const ops = new SequenceMatcher<string>(null, lines, altLines, false).getOpcodes().filter((op) => op[0] !== "equal");
    if (!ops.length) continue;
    const i1 = ops[0][1], i2 = ops[ops.length - 1][2];
    const j1 = ops[0][3], j2 = ops[ops.length - 1][4];
    regions.push([i1, i2, altLines.slice(j1, j2), c]);
  }
  const out = [...lines];
  let last: number | null = null;
  for (const [i1, i2, theirs, c] of sortedBy(regions, (r) => [r[0], r[1]]).reverse()) {
    if (last !== null && i2 > last) continue;
    out.splice(i1, i2 - i1, `<<<<<<< ours (${c.where})\n`, ...lines.slice(i1, i2), "=======\n", ...theirs, ">>>>>>> theirs\n");
    last = i1;
  }
  return out.join("");
}

export type { Param, Struct, Var };
