/** Identity: `@id` generation, the project id registry `wiret.ids`, E0140 and W0202 (spec
 * sections 2.3, 2.4, 7.3 and 7.5).
 *
 * File access goes through a `FileSystem`, so this runs in the browser (no projects), in the
 * CLI (Node's fs) and in the desktop app. */
import { Attr, Class, Const, Enum, Extern, Graph, Interface, Item, Lit, Module, Struct, Use, Var } from "./model.js";
import { sortedBy } from "./pyutil.js";

export const ID_CHARS = "abcdefghijkmnpqrstuvwxyz23456789";

/** kind of element -> prefix of a generated @id */
export const PREFIX: Record<string, string> = {
  module: "mod", use: "use", extern: "ext", const: "const", var: "var", enum: "en", struct: "st",
  func: "fn", event: "ev", macro: "mac", param: "p", result: "r", field: "f", member: "m", local: "l",
  state: "s", class: "cls", interface: "if", method: "im", dispatcher: "dsp",
};

export function getId(attrs: Attr[]): string | null {
  for (const a of attrs) if (a.name === "id" && a.arg() !== null && a.arg()!.kind === "string") return a.arg()!.value;
  return null;
}

/** Something that may carry an `@id`. */
export class Element {
  constructor(public kind: string, public name: string, public owner: string | null, public obj: { attrs: Attr[] }) {}
  get id(): string | null { return getId(this.obj.attrs); }
}

export function declKind(it: Item): string {
  if (it instanceof Graph) return it.kind;
  if (it instanceof Use) return "use";
  if (it instanceof Extern) return "extern";
  if (it instanceof Const) return "const";
  if (it instanceof Var) return "var";
  if (it instanceof Enum) return "enum";
  if (it instanceof Struct) return "struct";
  if (it instanceof Class) return "class";
  if (it instanceof Interface) return "interface";
  throw new TypeError(String(it));
}

/** Every element that may carry an `@id`, in file order. */
export function* elements(m: Module): Generator<Element> {
  yield new Element("module", m.name, null, m);
  for (const it of m.items) {
    yield new Element(declKind(it), it.name, null, it);
    if (it instanceof Graph || it instanceof Extern) {
      for (const p of it.params) yield new Element("param", p.name, it.name, p);
      for (const r of it.results ?? []) yield new Element("result", r.name, it.name, r);
    }
    if (it instanceof Graph) {
      for (const l of it.locals) yield new Element("local", l.name, it.name, l);
      for (const st of it.states) yield new Element("state", st.name, it.name, st);
    }
    if (it instanceof Interface) for (const im of it.methods) yield new Element("method", im.name, it.name, im);
    if (it instanceof Class) for (const d of it.dispatchers) yield new Element("dispatcher", d.name, it.name, d);
    if (it instanceof Struct || it instanceof Class) for (const f of it.fields) yield new Element("field", f.name, it.name, f);
    if (it instanceof Enum) for (const mem of it.members) yield new Element("member", mem.name, it.name, mem);
  }
}

export type Rng = () => number;

export function newToken(taken: Set<string>, prefix: string, rng: Rng = Math.random): string {
  for (;;) {
    let tok = `${prefix}_`;
    for (let i = 0; i < 4; i++) tok += ID_CHARS[Math.floor(rng() * ID_CHARS.length)];
    if (!taken.has(tok)) {
      taken.add(tok);
      return tok;
    }
  }
}

/** Give an `@id` to every element that has none. Existing ids are never changed. */
export function assignIds(m: Module, rng: Rng = Math.random, retired: Iterable<string> | null = null): Element[] {
  const taken = new Set<string>([...elements(m)].map((e) => e.id).filter((x): x is string => !!x));
  for (const r of retired ?? []) taken.add(r);
  const changed: Element[] = [];
  for (const e of elements(m)) {
    if (e.id === null) {
      e.obj.attrs.push(new Attr("id", [[null, new Lit("string", newToken(taken, PREFIX[e.kind], rng))]]));
      changed.push(e);
    }
  }
  return changed;
}

/** Copy `@id`s from `src` to the elements of `dst` that have none, matching elements by kind,
 * owner and name. Returns how many. */
export function carryIds(src: Module, dst: Module): number {
  const known = new Map<string, string>();
  for (const e of elements(src)) if (e.id) known.set(`${e.kind}\0${e.owner}\0${e.name}`, e.id);
  const taken = new Set([...elements(dst)].map((e) => e.id).filter((x): x is string => !!x));
  let n = 0;
  for (const e of elements(dst)) {
    const tok = known.get(`${e.kind}\0${e.owner}\0${e.name}`);
    if (e.id === null && tok && !taken.has(tok)) {
      e.obj.attrs.push(new Attr("id", [[null, new Lit("string", tok)]]));
      taken.add(tok);
      n += 1;
    }
  }
  return n;
}

// -- the registry ----------------------------------------------------------------------
/** One line of `wiret.ids`: `module graph kind id`. */
export class Retired {
  constructor(readonly module: string, readonly graph: string, readonly kind: string, readonly id: string) {}
  line(): string { return `${this.module} ${this.graph} ${this.kind} ${this.id}`; }
  describe(): string { return this.kind === "id" ? `@id '${this.id}'` : `${this.kind} id '${this.id}' in ${this.graph}`; }
  static fromLine(s: string): Retired {
    const [a, b, c, d] = s.split(" ");
    return new Retired(a, b, c, d);
  }
}

/** Tell the printer which node names the project retired (section 2.3). */
export function attachRetired(m: Module, project: Project | null): Module {
  if (project !== null) {
    m.retired_nodes = new Set();
    for (const line of project.retired) {
      const r = Retired.fromLine(line);
      if (r.module === m.name && r.kind === "node") m.retired_nodes.add(`${r.graph}\0${r.id}`);
    }
  }
  return m;
}

/** Every id in a module as registry lines: named nodes per graph, and `@id`s. */
export function idsOf(m: Module): Set<string> {
  const out = new Set<string>();
  for (const e of elements(m)) if (e.id) out.add(new Retired(m.name, "-", "id", e.id).line());
  for (const g of m.graphs()) for (const n of g.nodes) if (n.named) out.add(new Retired(m.name, g.name, "node", n.id).line());
  return out;
}

/** The ids that `old` has and `new` does not: what deleting them retires. */
export function retiredBetween(old: Module | null, nu: Module | null): Retired[] {
  if (old === null) return [];
  const now = nu !== null ? idsOf(nu) : new Set<string>();
  const gone = [...idsOf(old)].filter((x) => !now.has(x)).map(Retired.fromLine);
  return sortedBy(gone, (r) => [r.graph, r.kind, r.id]);
}

/** What a project needs from the file system: synchronous, for the CLI and tests. */
export interface FileSystem {
  exists(path: string): boolean;
  readText(path: string): string;
  writeText(path: string, text: string): void;
  appendText(path: string, text: string): void;
  join(...parts: string[]): string;
  dirname(path: string): string;
  abspath(path: string): string;
}

/** A directory with a `wiret.toml` manifest (section 7.3), and its id registry. */
export class Project {
  retired = new Set<string>();
  capabilities: Set<string> | null = null;

  constructor(public root: string, public fs: FileSystem | null = null) {}

  get ids_path(): string { return this.fs ? this.fs.join(this.root, "wiret.ids") : `${this.root}/wiret.ids`; }

  load(): Project {
    if (!this.fs) return this;
    this.retired = new Set(readRegistry(this.fs, this.ids_path).map((r) => r.line()));
    const manifest = this.fs.join(this.root, "wiret.toml");
    if (this.fs.exists(manifest)) this.capabilities = readAllowedCapabilities(this.fs.readText(manifest));
    return this;
  }

  /** Append entries not yet in the registry. Returns the ones written. */
  retire(entries: Retired[]): Retired[] {
    const seen = new Set<string>();
    const nu = entries.filter((e) => !this.retired.has(e.line()) && !seen.has(e.line()) && (seen.add(e.line()), true));
    if (nu.length) {
      this.fs?.appendText(this.ids_path, nu.map((e) => e.line() + "\n").join(""));
      for (const e of nu) this.retired.add(e.line());
    }
    return nu;
  }

  /** Remove entries again (an undo of a delete in the same session). */
  unretire(entries: Retired[]): void {
    const drop = new Set(entries.map((e) => e.line()).filter((l) => this.retired.has(l)));
    if (!drop.size) return;
    if (this.fs) {
      const lines = readRegistry(this.fs, this.ids_path);
      this.fs.writeText(this.ids_path, lines.filter((e) => !drop.has(e.line())).map((e) => e.line() + "\n").join(""));
    }
    for (const l of drop) this.retired.delete(l);
  }
}

export function readRegistry(fs: FileSystem, path: string): Retired[] {
  if (!fs.exists(path)) return [];
  return parseRegistry(fs.readText(path));
}

export function parseRegistry(text: string): Retired[] {
  const out: Retired[] = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.split("#")[0].trim();
    const parts = line.split(/\s+/).filter(Boolean);
    if (parts.length === 4) out.push(new Retired(parts[0], parts[1], parts[2], parts[3]));
  }
  return out;
}

/** `allow = [...]` in the `[capabilities]` table of wiret.toml (section 7.3), or null when
 * there is no such table. A small reader for the subset of TOML a manifest uses. */
export function readAllowedCapabilities(text: string): Set<string> | null {
  let table: string | null = null, allow: Set<string> | null = null;
  let collecting = false, buf = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split("#")[0].trim();
    if (collecting) {
      buf += " " + line;
      if (line.includes("]")) {
        collecting = false;
        allow = parseList(buf);
      }
      continue;
    }
    if (line.startsWith("[")) {
      table = line.replace(/^[\[\] ]+|[\[\] ]+$/g, "");
      if (table === "capabilities" && allow === null) allow = new Set();
    } else if (table === "capabilities" && line.startsWith("allow") && line.includes("=")) {
      buf = line.slice(line.indexOf("=") + 1).trim();
      if (buf.startsWith("[") && !buf.includes("]")) collecting = true;
      else allow = parseList(buf);
    }
  }
  return allow;
}

function parseList(s: string): Set<string> {
  const items = s.trim().replace(/^\[|\]$/g, "");
  return new Set(items.split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean));
}

/** The project that contains a file: the nearest directory upwards with a wiret.toml. */
export function findProject(fs: FileSystem, path: string): Project | null {
  let d = fs.dirname(fs.abspath(path));
  for (;;) {
    if (fs.exists(fs.join(d, "wiret.toml"))) return new Project(d, fs).load();
    const parent = fs.dirname(d);
    if (parent === d) return null;
    d = parent;
  }
}

export type DiagFn = (code: string, msg: string, graph?: string | null, node?: string | null, pin?: string | null,
                      data?: Record<string, unknown>) => void;

/** E0140 for a reused retired id, E0102 for an `@id` used twice among siblings of the same
 * kind, and W0202 for an element without an `@id` (section 2.4). */
export function checkIds(m: Module, project: Project, D: DiagFn): void {
  for (const g of m.graphs())
    for (const n of g.nodes)
      if (n.named && project.retired.has(new Retired(m.name, g.name, "node", n.id).line()))
        D("E0140", `node id '${n.id}' was retired in wiret.ids and cannot be reused`, g.name, n.id);
  const seen = new Map<string, string>();
  for (const e of elements(m)) {
    const where = e.owner || (e.kind !== "module" ? e.name : null);
    if (e.id === null) {
      D("W0202", `${e.kind} '${e.name}' has no @id, so renaming it would merge as a deletion plus an addition`, where);
      continue;
    }
    if (project.retired.has(new Retired(m.name, "-", "id", e.id).line()))
      D("E0140", `@id '${e.id}' on ${e.kind} '${e.name}' was retired in wiret.ids and cannot be reused`, where);
    const k = ["param", "result", "field", "member", "local", "state"].includes(e.kind)
      ? `${e.owner}\0${e.kind === "param" || e.kind === "result"}\0${e.id}` : `\0decl\0${e.id}`;
    if (seen.has(k)) D("E0102", `@id '${e.id}' is used by both '${seen.get(k)}' and '${e.name}'`, where);
    seen.set(k, e.name);
  }
}
