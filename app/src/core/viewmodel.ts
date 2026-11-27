/** What a graph looks like, without drawing it: node titles, pin labels, colors and the
 * automatic layout of nodes that have no `pos`. `graphJson` hands this to the web page. */
import { typeWords } from "./explain.js";
import { describe } from "./palette.js";
import { Graph, Lit, Module, Node, noteDetached, noteText, PinRef } from "./model.js";
import { noteKey } from "./ops.js";
import { fmtLit } from "./printer.js";
import {
  COUNTED_PINS, countedSide, flattenablePin, FLOAT_TYPES, INT_RANGES, INT_TYPES, isFlat, ModuleIndex, outputValues, Pin, pinCount,
  pinIndex, removablePin, Sig,
} from "./registry.js";
import { GraphInfo, Diag } from "./checker.js";
import { Counter, cpLen, sortedBy } from "./pyutil.js";
import type { Remembered } from "./canvasedit.js";

export const HEADER = 24;
export const ROW = 20;
export const RULE = 10;

export const HEADER_COLORS: Record<string, string> = {
  Arrays: "#b9770e", Flow: "#566573", Call: "#2471a3", Math: "#1e8449", Compare: "#138d75", Logic: "#9a7d0a", Bits: "#873600",
  Variables: "#6c3483", Macro: "#7d3c98", Structs: "#1f618d", Time: "#a04000", Classes: "#1a5276", Delegates: "#6e2c00", Other: "#566573",
};
export const ENTRY_RETURN_COLOR = "#a93226";
export const DISABLED_COLOR = "#4d4d4d";
export const BOX_COLOR = "#7f8c8d";

export function typeColor(ty: string, idx: ModuleIndex | null = null): string {
  if (idx !== null && idx.structs.has(ty)) return "#5dade2";
  if (idx !== null && idx.enums.has(ty)) return "#af7ac5";
  if (ty === "exec") return "#ffffff";
  if (ty === "bool") return "#e74c3c";
  if (ty === "i64" || ty === "u64") return "#48c9b0";
  if (INT_TYPES.includes(ty)) return "#1abc9c";
  if (FLOAT_TYPES.includes(ty)) return "#a3d65c";
  if (ty === "string") return "#e056fd";
  if (ty.startsWith("map#<")) return "#dc7633";
  if (ty.startsWith("set#<")) return "#f8c471";
  if (ty.startsWith("array#<")) return "#f0a830";
  return "#95a5a6";
}

/** `text` with its type arguments in single guillemets: `array#<i32>` reads `array‹i32›`. */
export function angled(text: string): string {
  let out = "";
  const opens: boolean[] = [];
  let i = 0;
  while (i < text.length) {
    let c = text[i];
    if (text.startsWith("#<", i)) {
      out += "‹";
      opens.push(true);
      i += 2;
      continue;
    }
    if (c === "<") opens.push(false);
    else if (c === ">" && !(i && text[i - 1] === "-") && opens.length) {
      if (opens.pop()) c = "›";
    }
    out += c;
    i += 1;
  }
  return out;
}

export function pinType(ty: string): string {
  return angled(typeWords(ty));
}

export function nodeTitle(n: Node): string {
  let t = n.kind;
  if (n.symbol) t += n.kind === "Call" && n.symbol.startsWith("std.") ? " " + n.symbol.split(".").pop() : " " + n.symbol;
  if (n.targs.length) t += "‹" + n.targs.map(angled).join(", ") + "›";
  return t;
}

/** The node's `label` from its attribute block, or its title. */
export function displayTitle(g: Graph, n: Node): string {
  const place = g.place(n.id);
  const label = place ? place.prop("label") : null;
  return label !== null && label.kind === "string" ? label.value : nodeTitle(n);
}

export function inputLabel(n: Node, pin: Pin): string {
  if (pin.is_exec) return pin.name === "in" ? "" : pin.name;
  if (pinIndex(pin.name) && countedSide(n) === "out") return "";
  const b = n.binding(pin.name);
  if (b !== null && b.value instanceof Lit) {
    let text = fmtLit(b.value);
    if (cpLen(text) > 22) text = Array.from(text).slice(0, 20).join("") + "…\"";
    return `${pin.name} = ${text}`;
  }
  if (b === null && pin.default_ !== null && n.kind !== "Exit" && n.kind !== "Leave") return `${pin.name} (${fmtLit(pin.defaultLit()!)})`;
  return pin.name;
}

export interface Editor {
  kind: "text" | "int" | "float" | "bool" | "enum";
  value: string | boolean | null;
  placeholder: string | boolean | null;
  min?: number;
  max?: number;
  options?: string[];
}

/** The form control the canvas shows on an input that nothing is wired to, or null. */
export function inputEditor(n: Node, pin: Pin, idx: ModuleIndex | null = null): Editor | null {
  if (pin.is_exec) return null;
  const b = n.binding(pin.name);
  if (b !== null && !(b.value instanceof Lit)) return null;
  const ty = pin.type;
  const en = idx !== null ? idx.enums.get(ty) ?? null : null;
  let kind: Editor["kind"];
  if (ty === "string") kind = "text";
  else if (ty === "bool") kind = "bool";
  else if (INT_TYPES.includes(ty)) kind = "int";
  else if (FLOAT_TYPES.includes(ty)) kind = "float";
  else if (en !== null) kind = "enum";
  else return null;
  const shown = (lit: Lit | null): string | boolean | null => {
    if (lit === null) return null;
    if (kind === "text" && lit.kind === "string") return lit.value;
    if (kind === "bool" && lit.kind === "bool") return !!lit.value;
    if (kind === "enum" && lit.kind === "enum") return lit.value.split(".").slice(1).join(".");
    return fmtLit(lit);
  };
  const def = n.kind !== "Exit" && n.kind !== "Leave" ? pin.defaultLit() : null;
  const ed: Editor = { kind, value: b !== null ? shown(b.value as Lit) : null, placeholder: shown(def) };
  if (kind === "int" && ty in INT_RANGES) {
    // numbers, as the page has always read them (a 64-bit bound rounds, as it did through JSON)
    ed.min = Number(INT_RANGES[ty][0]);
    ed.max = Number(INT_RANGES[ty][1]);
  }
  if (en !== null) ed.options = en.members.map((m) => m.name);
  return ed;
}

export function hasAddPin(n: Node): boolean {
  return pinCount(n) !== null && n.attr("disabled") === null;
}

export function addPinSide(n: Node): string | null {
  if (!hasAddPin(n)) return null;
  return countedSide(n) === "in" ? "left" : "right";
}

export function addPinLabel(n: Node): string {
  return `Add ${COUNTED_PINS[n.kind][1]}`;
}

export function canRemove(n: Node, pin: string, d = "out"): boolean {
  return hasAddPin(n) && removablePin(n, pin, d);
}

function layout(n: Node, sig: Sig) {
  const r = pinRows(n, sig);
  return {
    rows: r.rows.map(([p, o, y]) => [p ? p.name : null, o ? o.name : null, y]),
    rule: r.rule, addPin: r.add, addSide: addPinSide(n), addLabel: r.add !== null ? addPinLabel(n) : null,
    flatPin: flatToggle(n, sig), flat: isFlat(n, sig), height: r.height,
  };
}

export function flatToggle(n: Node, sig: Sig): string | null {
  if (n.attr("disabled") !== null) return null;
  return flattenablePin(n, sig);
}

export interface PinRows { rows: [Pin | null, Pin | null, number][]; rule: number | null; add: number | null; height: number }

function zipLongest<A, B>(a: A[], b: B[]): [A | null, B | null][] {
  const n = Math.max(a.length, b.length);
  return Array.from({ length: n }, (_, i) => [a[i] ?? null, b[i] ?? null]);
}

/** Where a node's pins sit, top to bottom, in graph units from the node's top. */
export function pinRows(n: Node, sig: Sig): PinRows {
  let ins = [...sig.exec_ins, ...sig.data_ins];
  let outs = [...sig.exec_outs, ...sig.data_outs];
  let top: [Pin | null, Pin | null] | null = null;
  if (isFlat(n, sig)) {
    const fpin = sig.output(flattenablePin(n, sig));
    top = [sig.exec_ins.length ? sig.exec_ins[0] : null, fpin];
    ins = ins.filter((p) => p !== top![0]);
    outs = outs.filter((p) => p !== fpin);
  }
  const valued = outputValues(sig);
  let pairs: [Pin | null, Pin | null][];
  if (valued.length) {
    const first = outs.findIndex((p) => p.name === valued[0]);
    const lead = ins.filter((p) => !valued.includes(p.name));
    pairs = zipLongest(lead, outs.slice(0, first));
    for (const v of valued) pairs.push([sig.input(v), sig.output(v)]);
    for (const p of outs.slice(first)) if (!valued.includes(p.name)) pairs.push([null, p]);
  } else pairs = zipLongest(ins, outs);
  if (!pairs.length && !sig.pure && top === null) pairs = [[null, null]];
  let ruleAt: number | null = null, seen = false;
  if (top !== null) {
    pairs.unshift(top);
    ruleAt = pairs.length > 1 ? 1 : null;
  } else {
    for (let i = 0; i < pairs.length; i++) {
      const o = pairs[i][1];
      if (o !== null && o.is_exec) {
        if (pinIndex(o.name)) seen = true;
        else if (seen) {
          ruleAt = i;
          break;
        }
      }
    }
  }
  let y = HEADER + 3;
  const rows: [Pin | null, Pin | null, number][] = [];
  let rule: number | null = null;
  pairs.forEach(([p, o], i) => {
    if (i === ruleAt) {
      rule = y + RULE / 2;
      y += RULE;
    }
    rows.push([p, o, y + ROW / 2]);
    y += ROW;
  });
  let add: number | null = null;
  if (hasAddPin(n)) {
    add = y + ROW / 2;
    y += ROW;
  }
  return { rows, rule, add, height: y + 3 };
}

export function outputLabel(sig: Sig, pin: Pin): string {
  return pin.name === "then" && pin.is_exec && sig.exec_outs.length === 1 ? "" : pin.name;
}

export function headerColor(g: Graph, n: Node, sig: Sig): string {
  if (n.attr("disabled") !== null) return DISABLED_COLOR;
  const place = g.place(n.id);
  const c = place ? place.prop("color") : null;
  if (c !== null && c.kind === "string") return c.value;
  if (n.kind === "Entry" || n.kind === "Return") return ENTRY_RETURN_COLOR;
  return HEADER_COLORS[sig.category] ?? HEADER_COLORS.Other;
}

const pk = (a: string, b: string | null) => `${a}\0${b}`;

export function execTargets(g: Graph): Set<string> {
  const out = new Set<string>();
  for (const n of g.nodes) for (const e of n.execs) out.add(pk(e.target, e.target_pin || "in"));
  return out;
}

export function usedOutputs(g: Graph, info: GraphInfo): Set<string> {
  const used = new Set<string>();
  for (const n of g.nodes) {
    for (const b of n.bindings) if (b.value instanceof PinRef) used.add(pk(b.value.node, b.value.pin));
    for (const e of n.execs) used.add(pk(n.id, info.execPin(n, e)));
  }
  return used;
}

/** node id -> [x, y]: from their attribute blocks, and for nodes without one, from
 * `remembered` or the automatic layout (section 7.5). */
export function positions(g: Graph, info: GraphInfo, remembered: Remembered): Map<string, [number, number]> {
  const pos = new Map<string, [number, number]>(g.places.map((p) => [p.id, [p.x, p.y]]));
  if (g.nodes.some((n) => !pos.has(n.id))) autoLayout(g, info, pos, remembered);
  return pos;
}

/** Place nodes without a `pos`. */
export function autoLayout(g: Graph, info: GraphInfo, pos: Map<string, [number, number]>, remembered: Remembered): void {
  const rk = (nid: string) => `${g.name}\0${nid}`;
  for (const n of g.nodes) if (!pos.has(n.id) && remembered.has(rk(n.id))) pos.set(n.id, remembered.get(rk(n.id))!);
  const depth = new Map<string, number>();
  const entry = info.entry();
  if (entry) {
    const todo: [string, number][] = [[entry, 0]];
    while (todo.length) {
      const [nid, d] = todo.shift()!;
      if (depth.has(nid)) continue;
      depth.set(nid, d);
      for (const s of info.successors(nid)) todo.push([s, d + 1]);
    }
  }
  const maxd = depth.size ? Math.max(...depth.values()) : 0;
  const colRows = new Counter<number>();
  for (const n of sortedBy(g.nodes, (n) => [depth.get(n.id) ?? maxd + 1, n.id])) {
    if (pos.has(n.id) || info.sigs.get(n.id)!.pure) continue;
    const d = depth.get(n.id) ?? maxd + 1;
    pos.set(n.id, [d * 250, colRows.count(d) * 200]);
    colRows.add(d);
  }
  const stacked = new Counter<string>();
  const placePure = (consumer: string): void => {
    const [cx, cy] = pos.get(consumer)!;
    for (const b of info.nodes.get(consumer)!.bindings) {
      if (b.value instanceof PinRef) {
        const src = b.value.node;
        if (info.nodes.has(src) && !pos.has(src) && info.sigs.get(src)!.pure) {
          const k = stacked.count(consumer);
          stacked.add(consumer);
          pos.set(src, [cx - 200, cy + 110 + k * 90]);
          placePure(src);
        }
      }
    }
  };
  for (const n of sortedBy(g.nodes, (n) => n.id)) if (pos.has(n.id)) placePure(n.id);
  let y = 400;
  for (const n of sortedBy(g.nodes, (n) => n.id)) {
    if (!pos.has(n.id)) {
      pos.set(n.id, [-250, y]);
      y += 90;
    }
  }
  for (const [nid, p] of pos) if (g.place(nid) === null) remembered.set(rk(nid), p);
}

/** The graph of this module that a Call or Macro node runs, if any. */
export function opens(module: Module | null, n: Node): string | null {
  if (module === null || (n.kind !== "Call" && n.kind !== "Macro") || !n.symbol) return null;
  const prefix = module.name + ".";
  const target = n.symbol.startsWith(prefix) ? n.symbol.slice(prefix.length) : n.symbol;
  return module.graph(target) ? target : null;
}

/** One graph as plain data for the web page to draw. */
export function graphJson(g: Graph, info: GraphInfo, idx: ModuleIndex, diags: Diag[] = [], remembered: Remembered = new Map(),
                          module: Module | null = null) {
  const pos = positions(g, info, remembered);
  const targets = execTargets(g), used = usedOutputs(g, info);
  const marks = new Map<string, string>();
  for (const d of diags) if (d.graph === g.name && d.top_node && marks.get(d.top_node) !== "error") marks.set(d.top_node, d.severity);
  const nodes: any[] = [], wires: any[] = [];
  for (const n of g.nodes) {
    const sig = info.sigs.get(n.id);
    if (sig === undefined) continue;
    const connected = new Set(n.bindings.filter((b) => b.value instanceof PinRef).map((b) => b.pin));
    const [x, y] = pos.get(n.id) ?? [0, 0];
    nodes.push({
      id: n.id, title: displayTitle(g, n), x, y, header: headerColor(g, n, sig), pure: sig.pure,
      disabled: n.attr("disabled") !== null, diag: marks.get(n.id) ?? null, opens: opens(module, n),
      description: describe(n.kind, n.symbol, idx, n.targs),
      ins: [...sig.exec_ins, ...sig.data_ins].map((p) => ({
        name: p.name, exec: p.is_exec, type: pinType(p.type), color: typeColor(p.type, idx), label: inputLabel(n, p),
        bound: n.binding(p.name) !== null, removable: canRemove(n, p.name, "in"), editor: inputEditor(n, p, idx),
        filled: connected.has(p.name) || (p.is_exec && targets.has(pk(n.id, p.name))),
      })),
      outs: [...sig.exec_outs, ...sig.data_outs].map((p) => ({
        name: p.name, exec: p.is_exec, type: pinType(p.type), color: typeColor(p.type, idx), label: outputLabel(sig, p),
        filled: used.has(pk(n.id, p.name)), removable: canRemove(n, p.name, "out"),
      })),
      ...layout(n, sig),
    });
    for (const b of n.bindings) {
      if (b.value instanceof PinRef) {
        const pin = sig.input(b.pin);
        wires.push({ exec: false, from: [b.value.node, b.value.pin], to: [n.id, b.pin], color: typeColor(pin ? pin.type : "", idx) });
      }
    }
    for (const e of n.execs) {
      const out = info.execPin(n, e);
      if (out) wires.push({ exec: true, from: [n.id, out], to: [e.target, e.target_pin || "in"], color: "#f0f0f0" });
    }
  }
  const notesOut = g.allNotes().map(([on, i, nt]) => ({
    on: on && g.node(on) ? on : null, text: noteText(nt), detached: noteDetached(nt), key: noteKey(on, i),
  }));
  const boxes = g.boxes.map((b) => {
    const c = b.prop("color");
    return { id: b.id, title: b.title, x: b.x, y: b.y, w: b.w, h: b.h, color: c !== null && c.kind === "string" ? c.value : BOX_COLOR };
  });
  return { name: g.name, kind: g.kind, nodes, wires, notes: notesOut, boxes };
}
