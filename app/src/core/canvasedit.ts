/** The edits the graph canvas makes, without the canvas: wiring two pins, dropping a wire on a
 * node, disconnecting a pin and setting an input's value. webapi.edit makes its canvas edits
 * through these.
 *
 * Each function changes the graph and returns a short description of the edit, returns null
 * when there is nothing to do, or throws Refused with the reason to show. */
import * as ops from "./ops.js";
import * as pal from "./palette.js";
import { GraphInfo } from "./checker.js";
import { typeWords } from "./explain.js";
import { Attr, Box, Graph, Lit, Local, Node, PinRef, setNoteText } from "./model.js";
import { ParseError, parseLiteral, RESERVED } from "./parser.js";
import { fmtLit, fmtString } from "./printer.js";
import {
  canConvert, COUNTED_PINS, enumValues, flattenablePin, indexedName, isFlat, litFits, ModuleIndex, pinCount, pinIndex, PRIM_TYPES,
  typeOk,
} from "./registry.js";
import { pyRepr, sortedBy } from "./pyutil.js";

/** geom(node id) -> [x, y, width] of a node as drawn, or null; used to place an inserted node */
export type Geom = (nid: string) => [number, number, number] | null;
export type PinAt = [string, string, string];          // [node, "in" | "out", pin]
export type Remembered = Map<string, [number, number]>;   // "graph\0node" -> position

/** An edit the canvas does not make. The message says why, in plain words. */
export class Refused extends Error {}

/** Wire pin `a` to pin `b`, in either order. A data wire between different types that
 * convert gets a visible Convert node in between. */
export function connect(g: Graph, info: GraphInfo, idx: ModuleIndex, a: PinAt, b: PinAt, geom: Geom): string | null {
  let [na, da, pa] = a, [nb, db, pb] = b;
  if (da === db) throw new Refused("Connect an output pin to an input pin.");
  if (da === "in") [na, da, pa, nb, db, pb] = [nb, db, pb, na, da, pa];
  if (na === nb) throw new Refused("A node cannot be wired to itself.");
  const sigA = info.sigs.get(na), sigB = info.sigs.get(nb);
  const out = sigA ? sigA.output(pa) : null;
  const inp = sigB ? sigB.input(pb) : null;
  if (out === null || inp === null) return null;
  if (out.is_exec !== inp.is_exec) throw new Refused("Exec pins connect only to exec pins (E0120).");
  if (out.is_exec) {
    const single = sigA!.exec_outs.length === 1 ? sigA!.exec_outs[0].name : null;
    ops.wireExec(g, na, pa, nb, pb, single);
    return `Wired ${na}.${pa} -> ${nb}` + (pb === "in" ? "" : `.${pb}`);
  }
  const target = g.node(nb);
  if (out.type === inp.type || (target !== null && target.kind === "Format" && PRIM_TYPES.includes(out.type))) {
    ops.bind(g, nb, pb, new PinRef(na, pa));
    return `Bound ${nb}.${pb} = ${na}.${pa}`;
  }
  if (canConvert(out.type, inp.type, idx)) {
    const ga = geom(na) ?? [0, 0, 0], gb = geom(nb) ?? [0, 0, 0];
    const conv = ops.createNode(g, "Convert", null, [out.type, inp.type], (ga[0] + ga[2] + gb[0]) / 2 - 60, (ga[1] + gb[1]) / 2 + 40);
    ops.bind(g, conv.id, "value", new PinRef(na, pa));
    ops.bind(g, nb, pb, new PinRef(conv.id, "result"));
    return `Inserted ${conv.id} = Convert#<${out.type}, ${inp.type}>`;
  }
  throw new Refused(`Cannot connect ${out.type} to ${inp.type}: no conversion exists (E0110).`);
}

/** A wire from pin `a` dropped on a node: connect it to the first pin there that fits. */
export function connectToNode(g: Graph, info: GraphInfo, idx: ModuleIndex, a: PinAt, nid: string, geom: Geom): string | null {
  const [na, da, pa] = a;
  const sig = info.sigs.get(nid), srcSig = info.sigs.get(na);
  if (sig === undefined || srcSig === undefined) return null;
  const pin = da === "out" ? srcSig.output(pa) : srcSig.input(pa);
  if (pin === null) return null;
  if (da === "out") {
    const cands = sig.inputs.filter((p) => p.is_exec === pin.is_exec && (pin.is_exec || p.type === pin.type) &&
      (pin.is_exec || g.node(nid)!.binding(p.name) === null));
    if (cands.length) return connect(g, info, idx, a, [nid, "in", cands[0].name], geom);
  } else {
    const cands = sig.outputs.filter((p) => p.is_exec === pin.is_exec && (pin.is_exec || p.type === pin.type));
    if (cands.length) return connect(g, info, idx, a, [nid, "out", cands[0].name], geom);
  }
  return null;
}

/** Remove the wires at one pin: what feeds an input, or everything an output feeds. */
export function disconnect(g: Graph, info: GraphInfo, nid: string, d: string, pin: string): string {
  const sig = info.sigs.get(nid)!;
  if (d === "in") {
    const p = sig.input(pin);
    if (p !== null && p.is_exec) {
      for (const m of g.nodes) m.execs = m.execs.filter((e) => !(e.target === nid && (e.target_pin || "in") === pin));
    } else ops.unbind(g, nid, pin);
  } else {
    const p = sig.output(pin);
    if (p !== null && p.is_exec) {
      const single = sig.exec_outs.length === 1 ? sig.exec_outs[0].name : null;
      ops.unwireExec(g, nid, pin, single);
    } else {
      for (const m of g.nodes) m.bindings = m.bindings.filter((b) => !(b.value instanceof PinRef && b.value.node === nid && b.value.pin === pin));
    }
  }
  return `Disconnected ${nid}.${pin}`;
}

/** Flip a bool input's value (true when it has none yet). */
export function toggleBool(g: Graph, nid: string, pin: string): string {
  const b = g.node(nid)!.binding(pin);
  const nu = new Lit("bool", !(b !== null && b.value instanceof Lit && b.value.value));
  ops.bind(g, nid, pin, nu);
  return `Set ${nid}.${pin} = ${nu.value ? "true" : "false"}`;
}

/** What to ask when an input's value is edited: {type, current, hint}, or null. */
export function literalPrompt(g: Graph, info: GraphInfo, idx: ModuleIndex, nid: string, pin: string):
    { type: string; current: string; hint: string } | null {
  const p = info.sigs.get(nid)!.input(pin);
  if (p === null || p.is_exec) return null;
  const b = g.node(nid)!.binding(pin);
  const current = b !== null && b.value instanceof Lit ? fmtLit(b.value) : "";
  let hint = "";
  if (idx.enums.has(p.type)) hint = "One of: " + enumValues(idx.enums.get(p.type)!).map(([m]) => m).join(", ");
  return { type: p.type, current, hint };
}

/** Set an input to the value typed for it. Empty text unbinds it. */
export function setLiteral(g: Graph, info: GraphInfo, idx: ModuleIndex, nid: string, pin: string, text: string, verbatim = false): string {
  const p = info.sigs.get(nid)!.input(pin);
  if (p === null || p.is_exec) throw new Refused(`${nid}.${pin} takes no value.`);
  if (idx.structs.has(p.type)) throw new Refused(`A ${p.type} has no typed value. Wire a 'Make ${p.type}' node into ${nid}.${pin}.`);
  const b = g.node(nid)!.binding(pin);
  if (verbatim && b !== null && !(b.value instanceof Lit)) throw new Refused(`${nid}.${pin} is wired. Disconnect it to type a value.`);
  if (verbatim && p.type === "string" && text) {
    ops.bind(g, nid, pin, new Lit("string", text));
    return `Set ${nid}.${pin} = ${fmtString(text)}`;
  }
  text = text.trim();
  if (!text) {
    ops.unbind(g, nid, pin);
    return `Unbound ${nid}.${pin}`;
  }
  if (p.type === "string" && !text.startsWith('"')) text = '"' + text.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
  const isEnum = idx.enums.has(p.type);
  if (isEnum && !text.includes(".") && !text.includes("::")) text = `${p.type}::${text}`;
  let lit: Lit | null;
  try {
    lit = parseLiteral(text);
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    if (!isEnum) throw new Refused(e.msg);
    lit = null;
  }
  if (isEnum && (lit === null || !litFits(lit, p.type) || idx.enums.get(p.type)!.member(lit.value.split(".")[1]) === null)) {
    const names = enumValues(idx.enums.get(p.type)!).map(([m]) => m).join(", ");
    throw new Refused(`${text} is not a member of ${p.type}. Choose one of: ${names}`);
  }
  if (!litFits(lit!, p.type)) throw new Refused(`${text} is not a valid ${p.type}`);
  ops.bind(g, nid, pin, lit);
  return `Set ${nid}.${pin} = ${text}`;
}

/** The node palette: [title, items]. With a pin `context`, only nodes with a pin that fits. */
export function palette(g: Graph, info: GraphInfo, idx: ModuleIndex, context: PinAt | null = null): [string, pal.Item[]] | null {
  let candidates = pal.items(g, idx);
  let title = "Add node — type to search (↑↓, Enter)";
  if (context) {
    const [nid, d, pin] = context;
    const sig = info.sigs.get(nid);
    const p = sig ? (d === "out" ? sig.output(pin) : sig.input(pin)) : null;
    if (p === null) return null;
    candidates = candidates.filter((it) => pal.compatible(it, g, idx, d, p.type) !== null);
    title = `Add a node for ${nid}.${pin} (${typeWords(p.type)})`;
  }
  return [title, candidates];
}

/** Add the palette item at (x, y): [its id, a description of the edit]. */
export function addNode(g: Graph, idx: ModuleIndex, item: pal.Item, x: number, y: number, context: PinAt | null = null,
                        geom: Geom | null = null): [string, string] {
  if (context && context[1] === "in") x -= 200;
  const n = ops.createNode(g, item.kind, item.symbol, item.targs, x, y);
  if (!context) return [n.id, `Added ${n.id}`];
  const info = new GraphInfo(g, idx);
  const [nid, d, pin] = context;
  const sig = info.sigs.get(nid)!;
  const p = d === "out" ? sig.output(pin)! : sig.input(pin)!;
  const other = pal.compatible(item, g, idx, d, p.type)!;
  const reason = connect(g, info, idx, context, [n.id, d === "out" ? "in" : "out", other], geom ?? (() => null));
  return [n.id, reason || `Added ${n.id}`];
}

const rk = (g: Graph, nid: string) => `${g.name}\0${nid}`;

/** Give every node without a `pos` one, where the automatic layout put it. */
export function placeUnplaced(g: Graph, remembered: Remembered): void {
  for (const n of g.nodes) {
    if (g.place(n.id) === null) {
      const [x, y] = remembered.get(rk(g, n.id)) ?? [0, 0];
      ops.place(g, n.id, x, y);
    }
  }
}

// -- the context menu's edits ------------------------------------------------------------
export function setEnum(g: Graph, nid: string, pin: string, ty: string, member: string): string {
  ops.bind(g, nid, pin, new Lit("enum", `${ty}.${member}`));
  return `Set ${nid}.${pin} = ${ty}.${member}`;
}

/** A BreakStruct to the right of a struct output, wired to it. */
export function breakStruct(g: Graph, nid: string, pin: string, ty: string, geom: Geom): [string, string] {
  const gm = geom(nid);
  const [x, y] = gm ? [gm[0] + gm[2] + 60, gm[1]] : [0, 0];
  const n = ops.createNode(g, "BreakStruct", ty, [], x, y);
  ops.bind(g, n.id, "obj", new PinRef(nid, pin));
  return [n.id, `Added ${n.id}: ${nid}.${pin} split into fields`];
}

/** A MakeStruct to the left of a struct input, wired into it. */
export function makeForPin(g: Graph, nid: string, pin: string, ty: string, geom: Geom): [string, string] {
  const gm = geom(nid);
  const [x, y] = gm ? [gm[0] - 220, gm[1]] : [0, 0];
  const n = ops.createNode(g, "MakeStruct", ty, [], x, y);
  ops.bind(g, nid, pin, new PinRef(n.id, "result"));
  return [n.id, `Added ${n.id}: a ${ty} for ${nid}.${pin}`];
}

/** Name a node, or rename a named one; every wire follows. */
export function renameNode(g: Graph, nid: string, nu: string): string | null {
  if (!nu || nu === nid) return null;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(nu) || RESERVED.has(nu) || nu === "self") throw new Refused("Not a valid name.");
  if (g.node(nu) || g.box(nu)) throw new Refused(`'${nu}' is already used in this graph (E0102).`);
  ops.renameNode(g, nid, nu);
  return `Renamed ${nid} to ${nu}`;
}

function placeOf(g: Graph, nid: string, remembered: Remembered) {
  let p = g.place(nid);
  if (p === null) {
    const [x, y] = remembered.get(rk(g, nid)) ?? [0, 0];
    ops.place(g, nid, x, y);
    p = g.place(nid)!;
  }
  return p;
}

/** A node's or box's `label` or `color`, as text ("" when it has none). */
export function currentProp(g: Graph, nid: string, k: string): string {
  const p = g.place(nid) ?? g.box(nid);
  const v = p ? p.prop(k) : null;
  return v !== null ? v.value : "";
}

export function setLabel(g: Graph, nid: string, text: string, remembered: Remembered): string {
  placeOf(g, nid, remembered).setProp("label", text ? new Lit("string", text) : null);
  return `Labelled ${nid}`;
}

export function setColor(g: Graph, nid: string, text: string, remembered: Remembered): string {
  if (text && !/^#[0-9A-Fa-f]{6}$/.test(text)) throw new Refused("Use the form #RRGGBB.");
  const p = g.box(nid) ?? placeOf(g, nid, remembered);
  p.setProp("color", text ? new Lit("string", text.toUpperCase()) : null);
  return `Coloured ${nid}`;
}

export function toggleAttr(g: Graph, nid: string, name: string): string {
  const n = g.node(nid)!;
  if (n.attr(name)) n.attrs = n.attrs.filter((a) => a.name !== name);
  else n.attrs.push(new Attr(name));
  return `Toggled @${name} on ${nid}`;
}

export function intAttr(g: Graph, nid: string, name: string, def = 2): number {
  const a = g.node(nid)!.attr(name);
  return a && a.args && a.args.length ? Number(a.args[0][1].value) : def;
}

const setCount = (n: Node, name: string, v: number) => {
  n.attrs = [...n.attrs.filter((x) => x.name !== name), new Attr(name, [[null, new Lit("int", BigInt(v))]])];
};

/** #name<value> on a node, value a whole number from 1 to 64. */
export function setIntAttr(g: Graph, nid: string, name: string, value: unknown): string {
  const s = String(value).trim();
  if (!/^[+-]?\d+$/.test(s)) throw new Refused("Enter a whole number from 1 to 64.");
  const v = parseInt(s, 10);
  if (!(1 <= v && v <= 64)) throw new Refused("Enter a whole number from 1 to 64.");
  setCount(g.node(nid)!, name, v);
  return `Set #${name}<${v}> on ${nid}`;
}

export const MAX_PINS = 64;

function nextCase(_g: Graph, idx: ModuleIndex, n: Node): Lit | null {
  const ty = n.targs.length ? n.targs[0] : null;
  const have = n.bindings.filter((b) => pinIndex(b.pin) && b.value instanceof Lit).map((b) => b.value as Lit);
  if (ty !== null && idx.enums.has(ty)) {
    const used = new Set(have.filter((v) => v.kind === "enum").map((v) => v.value));
    for (const [member] of enumValues(idx.enums.get(ty)!)) if (!used.has(`${ty}.${member}`)) return new Lit("enum", `${ty}.${member}`);
    return null;
  }
  if (ty !== null && ["i8", "i16", "i32", "i64", "u8", "u16", "u32", "u64"].includes(ty)) {
    const nums = have.filter((v) => v.kind === "int").map((v) => BigInt(v.value));
    return new Lit("int", nums.length ? nums.reduce((a, b) => (a > b ? a : b)) + 1n : 0n);
  }
  return null;
}

/** The "Add pin" button: one more indexed pin on a Sequence, a Switch or a MakeArray. */
export function addPin(g: Graph, idx: ModuleIndex, nid: string): string {
  const n = g.node(nid);
  const count = n !== null ? pinCount(n) : null;
  if (count === null) throw new Refused("Only a Sequence, a Switch or a MakeArray has pins to add.");
  const [name, base, side] = COUNTED_PINS[n!.kind];
  const what = side === "in" ? "inputs" : "outputs";
  if (count >= MAX_PINS) throw new Refused(`A ${n!.kind} has at most ${MAX_PINS} ${what}.`);
  setCount(n!, name, count + 1);
  const pin = indexedName(base, count);
  if (n!.kind === "Switch") {
    const lit = nextCase(g, idx, n!);
    if (lit !== null) ops.bind(g, nid, pin, lit);
  }
  return `Added ${nid}.${pin}`;
}

/** Remove one indexed pin of a Sequence, Switch or MakeArray, with its wire and its value. */
export function removePin(g: Graph, nid: string, pin: string): string {
  const n = g.node(nid);
  const count = n !== null ? pinCount(n) : null;
  if (count === null) throw new Refused("Only a Sequence, a Switch or a MakeArray has pins to remove.");
  const [name, base, side, , least] = COUNTED_PINS[n!.kind];
  const what = side === "in" ? "input" : "output";
  const ix = pinIndex(pin);
  if (ix === null || ix[0] !== base || ix[1] >= count) throw new Refused(`'${pin}' is not one of the ${n!.kind}'s indexed ${what}s.`);
  if (count <= least) throw new Refused(`A ${n!.kind} needs at least ${least} ${what}${least !== 1 ? "s" : ""}.`);
  const k = ix[1];
  const shift = (p: string | null) => {
    const i = pinIndex(p);
    if (i === null || i[0] !== base) return p;
    return i[1] < k ? p : indexedName(base, i[1] - 1);
  };
  n!.execs = n!.execs.filter((e) => e.pin !== pin);
  for (const e of n!.execs) e.pin = shift(e.pin);
  n!.bindings = n!.bindings.filter((b) => b.pin !== pin);
  for (const b of n!.bindings) b.pin = shift(b.pin)!;
  setCount(n!, name, count - 1);
  return `Removed ${nid}.${pin}`;
}

/** The small triangle beside a node's bottom exec output: flatten or unflatten it. */
export function toggleFlat(g: Graph, info: GraphInfo, nid: string): string {
  const n = g.node(nid);
  const sig = n !== null ? info.sigs.get(nid) ?? null : null;
  const pin = flattenablePin(n, sig);
  if (pin === null) throw new Refused("Only the bottom exec output of a node, one that gives no values, can be flattened.");
  if (isFlat(n!, sig)) {
    n!.flat = false;
    n!.flat_pin = null;
    return `Unflattened ${nid}.${pin}`;
  }
  n!.flat = true;
  n!.flat_pin = pin;
  return `Flattened ${nid}.${pin}`;
}

export function addNote(g: Graph, on: string | null, text: string): string | null {
  if (!text) return null;
  ops.addNote(g, on, text);
  return "Added note";
}

export function editNote(g: Graph, k: string, text: string): string | null {
  const [, nt] = ops.findNote(g, k);
  if (nt === null || !text) return null;
  setNoteText(nt, text);
  return "Edited note";
}

export function deleteNote(g: Graph, k: string): string {
  ops.deleteNote(g, k);
  return "Deleted note";
}

/** A box at (x, y) titled `title`, drawn around the selected node (`member`) if there is one. */
export function addBox(g: Graph, x: number, y: number, title: string, member: string | null = null): string | null {
  if (!title) return null;
  const p = member ? g.place(member) : null;
  if (p !== null) {
    x = p.x - 20;
    y = p.y - 40;
  }
  g.boxes.push(new Box(`box.${g.boxes.length}`, Math.trunc(x), Math.trunc(y), [], { title, w: 360, h: 220 }));
  return `Added box ${pyRepr(title)}`;
}

/** A box's size from "width, height" (at least 40 each). */
export function resizeBox(g: Graph, bid: string, text: string): string {
  const parts = (text || "").split(",");
  if (parts.length !== 2 || !parts.every((v) => /^\s*[+-]?\d+\s*$/.test(v))) throw new Refused("Enter the width and height, as in 360, 220.");
  const [w, h] = parts.map((v) => parseInt(v, 10));
  const b = g.box(bid)!;
  b.w = Math.max(40, w);
  b.h = Math.max(40, h);
  return `Resized ${bid}`;
}

export function retitleBox(g: Graph, bid: string, text: string): string | null {
  if (!text) return null;
  g.box(bid)!.title = text;
  return `Retitled ${bid}`;
}

export function localPrompt(idx: ModuleIndex, _kw = "local"): string {
  const own = [...sortedBy(idx.structs.keys()), ...sortedBy(idx.enums.keys())];
  const example = own.length ? `  or  pos: ${own[0]}` : "";
  return `name: type   (e.g.  count: i32  or  scores: array#<i32>${example})`;
}

/** A local (or state) variable from "name: type". */
export function addLocal(g: Graph, idx: ModuleIndex, kw: string, text: string): string | null {
  if (!text || !text.includes(":")) return null;
  const i = text.indexOf(":");
  const name = text.slice(0, i).trim(), ty = text.slice(i + 1).trim();
  if (!/^[A-Za-z_]\w*$/.test(name) || !typeOk(ty, idx)) {
    const own = [...sortedBy(idx.structs.keys()), ...sortedBy(idx.enums.keys())];
    const extra = own.length ? `, or one of this module's types: ${own.join(", ")}` : "";
    throw new Refused(`Use a valid name and a type such as i32, string or array#<i32>${extra}.`);
  }
  (kw === "local" ? g.locals : g.states).push(new Local(name, ty));
  return `Added ${kw} ${name}`;
}

export { pinCount, removablePin } from "./registry.js";
