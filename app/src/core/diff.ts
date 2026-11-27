/** `wiretc diff a b`: a node-aware semantic diff in flow order (spec section 7).
 *
 * Changes to behaviour come first, per declaration and per graph. Metadata and layout-only
 * changes follow in sections of their own, so a reviewer can tell at a glance whether a
 * commit changed what the program does. */
import { GraphInfo } from "./checker.js";
import { declFields, declKind, keyOf, metaText, nodeFields, subFields, Fields } from "./merge.js";
import { Attr, Graph, Item, Module, Node, PinRef } from "./model.js";
import { fmtExpr, IND, printModule } from "./printer.js";
import { ModuleIndex, signature } from "./registry.js";
import { splitlinesKeep, unifiedDiff } from "./difflib.js";
import { key as tupleKey, sortedBy } from "./pyutil.js";

export function rawDiff(aText: string, bText: string, aName = "a", bName = "b"): string {
  return unifiedDiff(splitlinesKeep(aText), splitlinesKeep(bText), aName, bName).join("");
}

/** Depth-first from Entry along exec outputs in pin order; each pure node immediately before
 * its first consumer; unreachable nodes last, sorted by id. */
export function flowOrder(g: Graph, info: GraphInfo): string[] {
  const out: string[] = [], seen = new Set<string>();
  const emitPure = (nid: string): void => {
    for (const b of info.nodes.get(nid)!.bindings) {
      if (b.value instanceof PinRef) {
        const d = b.value.node;
        if (info.nodes.has(d) && !seen.has(d) && info.sigs.get(d)!.pure) {
          seen.add(d);
          emitPure(d);
          out.push(d);
        }
      }
    }
  };
  const visit = (nid: string): void => {
    if (seen.has(nid) || !info.nodes.has(nid)) return;
    seen.add(nid);
    emitPure(nid);
    out.push(nid);
    const n = info.nodes.get(nid)!;
    const sig = info.sigs.get(nid)!;
    const order = new Map(sig.exec_outs.map((p, i) => [p.name, i]));
    for (const e of sortedBy(n.execs, (e) => order.get(info.execPin(n, e)!) ?? 99)) visit(e.target);
  };
  const entry = info.entry();
  if (entry) visit(entry);
  out.push(...sortedBy([...info.nodes.keys()].filter((nid) => !seen.has(nid))));
  return out;
}

/** `wiretc view --flow`: the canonical text is already in flow order. */
export function viewFlow(m: Module): string {
  return printModule(m);
}

function match<T>(aItems: T[], bItems: T[], key: (x: T) => string, nameKey: (x: T) => string): [T | undefined, T | undefined][] {
  const ka = new Map(aItems.map((x) => [key(x), x]));
  const kb = new Map(bItems.map((x) => [key(x), x]));
  const isId = (k: string) => k.startsWith('[s"id",');
  for (const [side, other] of [[ka, kb], [kb, ka]]) {
    const names = new Map([...other].filter(([k]) => isId(k)).map(([k, x]) => [nameKey(x), k]));
    for (const [k, x] of [...side]) {
      const t = !isId(k) ? names.get(nameKey(x)) : undefined;
      if (t !== undefined && !side.has(t)) {
        side.set(t, x);
        side.delete(k);
      }
    }
  }
  const keys = [...ka.keys(), ...[...kb.keys()].filter((k) => !ka.has(k))];
  return keys.map((k) => [ka.get(k), kb.get(k)]);
}

function fieldChanges(fa: Fields, fb: Fields): string[] {
  const out: string[] = [];
  for (const k of sortedBy(new Set([...fa.keys(), ...fb.keys()]))) {
    const va = fa.get(k)?.[0] ?? null, vb = fb.get(k)?.[0] ?? null;
    if (va !== vb) {
      const label = k.replace("bind:", ".").replace("exec:", "exec ").replace("attr:", "@");
      out.push(`${label}: ${va === null ? "(none)" : va} -> ${vb === null ? "(none)" : vb}`);
    }
  }
  return out;
}

const SUBS: [string, string][] = [["params", "param"], ["results", "result"], ["fields", "field"], ["members", "member"],
  ["locals", "local"], ["states", "state"]];

export class Differ {
  ia: ModuleIndex;
  ib: ModuleIndex;
  semantic: string[] = [];
  meta: string[] = [];
  layout: string[] = [];

  constructor(public a: Module, public b: Module) {
    this.ia = new ModuleIndex(a);
    this.ib = new ModuleIndex(b);
  }

  run(): string {
    const { a, b } = this;
    if (a.name !== b.name) this.semantic.push(`module ${a.name} -> ${b.name}`);
    this.metaChanges("module", a.meta, b.meta);
    for (const [x, y] of match(a.items, b.items, (i) => keyOf(i, declKind(i)), (i) => tupleKey(declKind(i), i.name))) this.decl(x, y);
    return this.report();
  }

  decl(x: Item | undefined, y: Item | undefined): void {
    const it = (y ?? x)!;
    let head = `${declKind(it)} ${it.name}`;
    if (x === undefined) {
      this.semantic.push(`+ ${head}`);
      return;
    }
    if (y === undefined) {
      this.semantic.push(`- ${head}`);
      return;
    }
    const lines: string[] = [];
    if (x.name !== y.name) head = `${declKind(y)} ${x.name} -> ${y.name} (renamed)`;
    const fa = declFields(x), fb = declFields(y);
    fa.delete("name");
    fb.delete("name");
    lines.push(...fieldChanges(fa, fb).map((c) => `${IND}~ ${c}`));
    for (const [attr, kind] of SUBS) {
      const xs: any[] = (x as any)[attr] ?? [], ys: any[] = (y as any)[attr] ?? [];
      for (const [p, q] of match(xs, ys, (s) => keyOf(s), (s) => tupleKey("", s.name))) {
        if (p === undefined) lines.push(`${IND}+ ${kind} ${q.name}`);
        else if (q === undefined) lines.push(`${IND}- ${kind} ${p.name}`);
        else {
          const name = p.name === q.name ? p.name : `${p.name} -> ${q.name}`;
          const sa = subFields(p), sb = subFields(q);
          sa.delete("name");
          sb.delete("name");
          const changes = fieldChanges(sa, sb);
          if (changes.length || p.name !== q.name) lines.push(`${IND}~ ${kind} ${name}` + (changes.length ? `: ${changes.join("; ")}` : ""));
        }
      }
      const na = xs.map((s) => s.name), nb = ys.map((s) => s.name);
      if ((xs.length || ys.length) && na.join("\0") !== nb.join("\0") && sortedBy(new Set(na)).join("\0") === sortedBy(new Set(nb)).join("\0"))
        lines.push(`${IND}~ ${attr} reordered`);
    }
    this.metaChanges(y.name, x.meta, y.meta);
    if (x instanceof Graph && y instanceof Graph) lines.push(...this.graph(x, y));
    if (lines.length || head.endsWith("(renamed)")) {
      this.semantic.push(head);
      this.semantic.push(...lines);
    }
  }

  graph(x: Graph, y: Graph): string[] {
    const ia = new GraphInfo(x, this.ia), ib = new GraphInfo(y, this.ib);
    const order = [...flowOrder(y, ib), ...flowOrder(x, ia).filter((nid) => y.node(nid) === null)];
    const rank = new Map(order.map((nid, i) => [nid, i]));
    const out: string[] = [];
    const single = (n: Node, g: Graph, idx: ModuleIndex) => {
      const outs = signature(n, g, idx).exec_outs;
      return outs.length === 1 ? outs[0].name : null;
    };
    const ids = sortedBy(new Set([...x.nodes.map((n) => n.id), ...y.nodes.map((n) => n.id)]), (i) => [rank.get(i) ?? rank.size, i]);
    for (const nid of ids) {
      const p = x.node(nid), q = y.node(nid);
      if (p === null) {
        const text = fmtExpr(q!, signature(q!, y, this.ib), "").split("\n");
        out.push(`${IND}+ node ${nid} = ${text[0]}`);
        out.push(...text.slice(1).map((t) => `${IND}    ${t}`));
      } else if (q === null) {
        out.push(`${IND}- node ${nid} = ${p.kind}` + (p.symbol ? ` ${p.symbol}` : ""));
      } else {
        const changes = fieldChanges(nodeFields(p, single(p, x, this.ia)), nodeFields(q, single(q, y, this.ib)));
        if (changes.length) out.push(`${IND}~ node ${nid}: ${changes.join("; ")}`);
        this.metaChanges(`${y.name}.${nid}`, p.meta, q.meta);
      }
      if (p !== null && q !== null) {
        const pa = x.place(nid), pb = y.place(nid);
        if (pa && pb && JSON.stringify([pa.x, pa.y, pa.props]) !== JSON.stringify([pb.x, pb.y, pb.props], (_k, v) => (typeof v === "bigint" ? v.toString() : v)))
          this.layout.push(pa.x !== pb.x || pa.y !== pb.y ? `${y.name}.${nid}: (${pa.x}, ${pa.y}) -> (${pb.x}, ${pb.y})` : `${y.name}.${nid}: properties changed`);
      }
    }
    const ba = new Map(x.boxes.map((b) => [b.id, b])), bb = new Map(y.boxes.map((b) => [b.id, b]));
    for (const bid of sortedBy(new Set([...ba.keys(), ...bb.keys()]))) {
      const p = ba.get(bid), q = bb.get(bid);
      if (p === undefined || q === undefined) this.layout.push(`${y.name}: box '${(p ?? q)!.title}' ${p === undefined ? "added" : "removed"}`);
      else if (p.x !== q.x || p.y !== q.y || p.w !== q.w || p.h !== q.h || p.title !== q.title || propsText(p.props) !== propsText(q.props))
        this.layout.push(`${y.name}: box '${q.title}' changed`);
    }
    return out;
  }

  metaChanges(where: string, a: Attr[], b: Attr[]): void {
    const ta = a.map(metaText), tb = b.map(metaText);
    for (const t of ta) if (!tb.includes(t)) this.meta.push(`${where}: - ${t}`);
    for (const t of tb) if (!ta.includes(t)) this.meta.push(`${where}: + ${t}`);
  }

  report(): string {
    let out: string[] = [];
    if (this.semantic.length) out = [...this.semantic];
    if (this.meta.length) out.push("", "metadata (does not change behaviour):", ...this.meta.map((m) => `${IND}${m}`));
    if (this.layout.length) out.push("", "layout only:", ...this.layout.map((m) => `${IND}${m}`));
    return out.join("\n").replace(/^\n+/, "") + (out.length ? "\n" : "");
  }
}

const propsText = (props: [string, import("./model.js").Lit][]) => props.map(([k, v]) => `${k}=${JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x))}`).join(";");

export function semanticDiff(a: Module, b: Module): string {
  return new Differ(a, b).run();
}
