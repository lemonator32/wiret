/** Model edit operations (spec section 7.2), used by the graph editor and the CLI.
 * Each operation changes only the model; callers re-print the canonical text afterwards. */
import { Attr, Box, ExecOut, Graph, Lit, Module, Node, note, notes, PinRef, Place, Binding } from "./model.js";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function slug(text: string): string {
  let s = text.replace(/(?<!^)(?=[A-Z])/g, "_").toLowerCase();
  s = s.replace(/[^a-z0-9_]/g, "_").replace(/^_+|_+$/g, "");
  return s || "node";
}

/** A readable slug plus a short random suffix, unique in the graph (section 2.3). */
export function freshId(g: Graph, base: string, rng: () => number = Math.random): string {
  const taken = new Set([...g.nodes.map((n) => n.id), ...g.boxes.map((b) => b.id)]);
  for (;;) {
    let suffix = "";
    for (let i = 0; i < 4; i++) suffix += ALPHABET[Math.floor(rng() * ALPHABET.length)];
    const cand = `${slug(base)}_${suffix}`;
    if (!taken.has(cand)) return cand;
  }
}

/** A new node. Given an id it is a named node; otherwise its id is a placeholder until the
 * text is read back (section 2.3). */
export function createNode(g: Graph, kind: string, symbol: string | null = null, targs: string[] | null = null,
                           x = 0, y = 0, nid: string | null = null): Node {
  const base = symbol && (kind === "Call" || kind === "Macro") ? symbol.split(".").pop()! : kind;
  const n = new Node(nid || freshId(g, base), kind, symbol, [...(targs ?? [])]);
  n.named = nid !== null;
  g.nodes.push(n);
  g.places.push(new Place(n.id, Math.trunc(x), Math.trunc(y)));
  return n;
}

export function bind(g: Graph, nodeId: string, pin: string, value: PinRef | Lit | null): void {
  const n = g.node(nodeId)!;
  n.bindings = n.bindings.filter((b) => b.pin !== pin);
  if (value !== null) n.bindings.push(new Binding(pin, value));
}

export function unbind(g: Graph, nodeId: string, pin: string): void {
  bind(g, nodeId, pin, null);
}

/** Connect an exec output. `singleOut` names the node's only exec output, if it has one. */
export function wireExec(g: Graph, nodeId: string, outPin: string, target: string, targetPin: string | null = null,
                         singleOut: string | null = null): void {
  const n = g.node(nodeId)!;
  n.execs = n.execs.filter((e) => (e.pin || singleOut) !== outPin);
  n.execs.push(new ExecOut(outPin, target, targetPin === null || targetPin === "in" ? null : targetPin));
}

export function unwireExec(g: Graph, nodeId: string, outPin: string, singleOut: string | null = null): void {
  const n = g.node(nodeId)!;
  n.execs = n.execs.filter((e) => (e.pin || singleOut) !== outPin);
}

/** Delete a node and every wire that names it. Its notes move to the graph, detached. */
export function deleteNode(g: Graph, nodeId: string): string[] {
  const removed: string[] = [];
  const n0 = g.node(nodeId);
  if (n0 !== null) detachNotes(g, n0);
  g.nodes = g.nodes.filter((n) => n.id !== nodeId);
  g.places = g.places.filter((p) => p.id !== nodeId);
  for (const n of g.nodes) {
    for (const b of [...n.bindings]) {
      if (b.value instanceof PinRef && b.value.node === nodeId) {
        n.bindings.splice(n.bindings.indexOf(b), 1);
        removed.push(`${nodeId}.${b.value.pin} -> ${n.id}.${b.pin}`);
      }
    }
    for (const e of [...n.execs]) {
      if (e.target === nodeId) {
        n.execs.splice(n.execs.indexOf(e), 1);
        removed.push(`${n.id}.${e.pin || "then"} -> ${nodeId}`);
      }
    }
  }
  return removed;
}

/** Delete a box (not the nodes inside it). Its notes move to the graph, detached. */
export function deleteBox(g: Graph, boxId: string): void {
  const b = g.box(boxId);
  if (b !== null) detachNotes(g, b);
  g.boxes = g.boxes.filter((x) => x.id !== boxId);
}

/** Move the notes of a node or box that is being deleted up to the graph (section 2.4). */
export function detachNotes(g: Graph, owner: Node | Box): void {
  for (const a of notes(owner.meta)) {
    const args = (a.args ?? []).filter(([k]) => k !== "detached");
    g.meta.push(new Attr("note", [...args, ["detached", new Lit("string", owner.id)]]));
  }
  owner.meta = owner.meta.filter((a) => a.name !== "note");
}

/** Name a node, or rename a named one (section 2.3). */
export function renameNode(g: Graph, old: string, nu: string): void {
  for (const n of [...g.nodes]) {
    if (n.id === old) {
      n.id = nu;
      if (!n.named) {
        n.named = true;
        g.nodes.splice(g.nodes.indexOf(n), 1);
        g.nodes.push(n);
      }
    }
    for (const b of n.bindings) if (b.value instanceof PinRef && b.value.node === old) b.value.node = nu;
    for (const e of n.execs) if (e.target === old) e.target = nu;
  }
  for (const p of g.places) if (p.id === old) p.id = nu;
}

export function inside(b: Box, p: Place): boolean {
  return b.x <= p.x && p.x <= b.x + b.w && b.y <= p.y && p.y <= b.y + b.h;
}

/** Move a node, or a box and every node that lies inside it (section 2.3). */
export function place(g: Graph, nid: string, x: number, y: number): void {
  const b = g.box(nid);
  if (b !== null) {
    const dx = Math.trunc(x) - b.x, dy = Math.trunc(y) - b.y;
    for (const p of g.places.filter((p) => inside(b, p))) {
      p.x += dx;
      p.y += dy;
    }
    b.x = Math.trunc(x);
    b.y = Math.trunc(y);
    return;
  }
  const p = g.place(nid);
  if (p === null) g.places.push(new Place(nid, Math.trunc(x), Math.trunc(y)));
  else {
    p.x = Math.trunc(x);
    p.y = Math.trunc(y);
  }
}

/** Add an `@note` to a node or box (`on`), or to the whole graph (`on` is null). */
export function addNote(g: Graph, on: string | null, text: string): Attr {
  const nt = note(text);
  g.noteOwner(on)!.meta.push(nt);
  return nt;
}

/** A name for one note in the editor: its target and its position among that target's notes. */
export function noteKey(on: string | null, index: number): string {
  return `${on || ""}|${index}`;
}

/** [owner, note] for a `noteKey`, or [null, null]. */
export function findNote(g: Graph, key: string): [Graph | Node | Box | null, Attr | null] {
  const cut = key.lastIndexOf("|");
  const on = cut < 0 ? "" : key.slice(0, cut), i = cut < 0 ? key : key.slice(cut + 1);
  const owner = g.noteOwner(on || null);
  const ns = owner !== null ? notes(owner.meta) : [];
  if (!/^\d+$/.test(i) || parseInt(i, 10) >= ns.length) return [null, null];
  return [owner, ns[parseInt(i, 10)]];
}

export function deleteNote(g: Graph, key: string): void {
  const [owner, nt] = findNote(g, key);
  if (owner !== null) owner.meta = owner.meta.filter((a) => a !== nt);
}

/** `--convert-comments`: turn each `//` comment into an `@note` above the next node or graph.
 * Returns messages for comments that had nothing to attach to and were dropped. */
export function convertComments(m: Module): string[] {
  const dropped: string[] = [];
  for (const c of m.comments) {
    const a = c.anchor;
    const g = a ? m.graph(a[1]) : null;
    if (g === null) {
      dropped.push(`line ${c.line}: comment outside any graph was dropped: ${c.text}`);
      continue;
    }
    const owner = (a![0] === "node" ? g.node(a![2]) : null) ?? g;
    owner.meta.push(note(c.text));
  }
  m.comments = [];
  return dropped;
}
