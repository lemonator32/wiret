/** The calls the editor page makes into the compiler and VM, in the browser and in the Tauri
 * desktop app alike (src/web/main.ts).
 *
 * Each function takes plain values and returns plain, structured-cloneable data, so the calls
 * could move to a Web Worker without changing the page.
 *
 * A page has no thread to block at a breakpoint, so `debugRun` records instead: it runs the
 * program once and keeps every point where the debugger could pause, with the call stack,
 * variables and wire values there. The page then steps through that recording. */
import * as canvasedit from "./canvasedit.js";
import * as ops from "./ops.js";
import * as syn from "./syntax.js";
import * as textchanges from "./textchanges.js";
import * as pal from "./palette.js";
import { Diag, GraphInfo } from "./checker.js";
import { compileModule, CompileResult } from "./compiler.js";
import { disassemble } from "./disasm.js";
import { explain, explainRuntime } from "./explain.js";
import { ParseError, Parser } from "./parser.js";
import { GraphNames, printModule } from "./printer.js";
import { Graph, Module, noteText } from "./model.js";
import { enumValues, ModuleIndex } from "./registry.js";
import { formatResults, formatValue, runFunction, ValueError } from "./runner.js";
import { addPinLabel, graphJson, opens, positions } from "./viewmodel.js";
import { FrameView, LoadedModule, VM, WiretError } from "./vm.js";
import { Counter, jsonDumps, sortedBy } from "./pyutil.js";

export const MAX_STEPS = 5000;
/** "graph\0node" -> where the automatic layout put a node without a `pos`, so it stays put
 * while the text is edited */
const REMEMBERED: canvasedit.Remembered = new Map();

export interface DiagJson {
  severity: string; code: string; message: string; explain: string; graph?: string | null; node?: string | null;
  pin?: string | null; line?: number; col?: number;
}

function diagJson(d: Diag): DiagJson {
  return { severity: d.severity, code: d.code, message: d.toString(), explain: explain(d), graph: d.graph, node: d.top_node, pin: d.pin };
}

export interface RunResult {
  ok: boolean; output: string[]; result: string | null; diags: DiagJson[]; error: string | null; explain: string | null;
  fault: { graph: string; node: string } | null; nodes: Record<string, Record<string, { line: number; what: string }>>;
}

function newResult(): RunResult {
  return { ok: false, output: [], result: null, diags: [], error: null, explain: null, fault: null, nodes: {} };
}

/** The parsed module, or null with the parse error in `out`. Also fills `out.nodes`. */
function parseInto(source: string, out: RunResult): Module | null {
  const p = new Parser(source);
  let m: Module;
  try {
    m = p.parseModule();
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    out.diags.push({ severity: "error", code: "parse", message: e.msg, explain: e.msg, line: e.line, col: e.col });
    return null;
  }
  for (const [tokIndex, anchor] of p.anchors) {
    if (anchor && anchor[0] === "node") {
      const g = m.graph(anchor[1]);
      const n = g ? g.node(anchor[2]) : null;
      const what = n && n.symbol ? `${n.kind} ${n.symbol}` : n ? n.kind : "";
      (out.nodes[anchor[1]] ??= {})[anchor[2]] = { line: p.toks[tokIndex].line, what };
    }
  }
  return m;
}

function compileInto(source: string, out: RunResult, debug: boolean): [Module, CompileResult] | [null, null] {
  const m = parseInto(source, out);
  if (m === null) return [null, null];
  const r = compileModule(m, source, true, debug, null, true);
  out.diags = r.diags.map(diagJson);
  return r.ok ? [m, r] : [null, null];
}

const short = (name: string, prefix: string) => (name.startsWith(prefix) ? name.slice(prefix.length) : name);
/** The node id in the source graph (inner macro nodes map to their call node). */
const top = (node: string | null) => (node || "").split("/")[0].split("!")[0];

function faultInto(m: Module, err: WiretError, out: RunResult): void {
  out.error = err.toString();
  const prefix = m.name + ".";
  let where = "";
  for (const [fn, node] of [...(err.traceback ?? [])].reverse()) {
    const g = short(fn, prefix);
    if (node && m.graph(g)) {
      out.fault = { graph: g, node: top(node) };
      where = `node '${top(node)}' of ${g}`;
      break;
    }
  }
  out.explain = explainRuntime(err.status, err.message, where);
}

/** Parse and check without running: diags, nodes, and each graph as graphJson describes it
 * for drawing (also when it has problems). Cheap enough to call while typing. */
export function check(source: string) {
  const out = newResult();
  const m = parseInto(source, out);
  let graphs: ReturnType<typeof graphJson>[] = [];
  if (m !== null) {
    const r = compileModule(m, source);
    out.diags = r.diags.map(diagJson);
    const idx = new ModuleIndex(m);
    graphs = m.graphs().map((g) => graphJson(g, new GraphInfo(g, idx), idx, r.diags, REMEMBERED, m));
  }
  return { diags: out.diags, nodes: out.nodes, graphs };
}

function parseOrNull(source: string): Module | null {
  try {
    return new Parser(source).parseModule();
  } catch (e) {
    if (e instanceof ParseError) return null;
    throw e;
  }
}

/** What to ask when an input's value is edited on the canvas, or null. */
export function literalPrompt(source: string, graph: string, node: string, pin: string) {
  const m = parseOrNull(source);
  const g = m?.graph(graph) ?? null;
  if (m === null || g === null || g.node(node) === null) return null;
  const idx = new ModuleIndex(m);
  return canvasedit.literalPrompt(g, new GraphInfo(g, idx), idx, node, pin);
}

/** The node palette for `graph`, best matches for `query` first. null when there is nothing
 * to offer (a parse error, or no such pin). */
export function palette(source: string, graph: string, query = "", context: canvasedit.PinAt | null = null) {
  const m = parseOrNull(source);
  const g = m?.graph(graph) ?? null;
  if (m === null || g === null) return null;
  const idx = new ModuleIndex(m);
  const found = canvasedit.palette(g, new GraphInfo(g, idx), idx, context);
  if (found === null) return null;
  const [title, candidates] = found;
  const shown = pal.rank(candidates, query).slice(0, 200);
  return {
    title, total: candidates.length,
    items: shown.map((it) => ({ label: it.label, kind: it.kind, symbol: it.symbol, targs: it.targs, category: it.category, description: it.description })),
  };
}

export interface EditResult { ok: boolean; text?: string; message?: string; select?: string | null; comments?: number }

/** Make one canvas edit on `graph` and return the new text in canonical form. */
export function edit(source: string, graph: string, req: Record<string, any>): EditResult {
  const m = parseOrNull(source);
  if (m === null) return { ok: false, message: "Fix the parse error in the source before editing the graph." };
  const g = m.graph(graph);
  if (g === null) return { ok: false, message: `There is no graph ${graph}.` };
  if (m.comments.length && req.comments !== "convert") return { ok: false, comments: m.comments.length };
  const idx = new ModuleIndex(m);
  const info = new GraphInfo(g, idx);
  positions(g, info, REMEMBERED);
  const geoms: Record<string, [number, number, number]> = req.geoms || {};
  const geom: canvasedit.Geom = (nid) => geoms[nid] ?? null;
  const before = new Set(g.nodes.map((n) => n.id));
  const op = req.op;
  let reason: string | null;
  try {
    reason = applyEdit(g, info, idx, req, geom);
  } catch (e) {
    if (e instanceof canvasedit.Refused) return { ok: false, message: e.message };
    if (e instanceof UnknownEdit) return { ok: false, message: `unknown edit '${op}'` };
    throw e;
  }
  if (!reason) return { ok: false, message: "" };
  if (m.comments.length) {
    const dropped = ops.convertComments(m);
    if (dropped.length) reason += " (" + dropped.join("; ") + ")";
  }
  canvasedit.placeUnplaced(g, REMEMBERED);
  const added = g.nodes.filter((n) => !before.has(n.id)).map((n) => n.id);
  const select = added.length ? new GraphNames(g, new ModuleIndex(m)).name(added[0]) : null;
  if (select && select !== added[0]) reason = reason.split(added[0]).join(select);
  return { ok: true, text: printModule(m), message: reason, select };
}

class UnknownEdit extends Error {}

function applyEdit(g: Graph, info: GraphInfo, idx: ModuleIndex, req: Record<string, any>, geom: canvasedit.Geom): string | null {
  switch (req.op) {
    case "move":
      for (const [nid, x, y] of req.moves) if (g.node(nid) || g.box(nid)) ops.place(g, nid, Math.round(x), Math.round(y));
      return "Moved " + req.moves.map((x: any[]) => String(x[0])).join(", ");
    case "connect": return canvasedit.connect(g, info, idx, req.a, req.b, geom);
    case "connect_to_node": return canvasedit.connectToNode(g, info, idx, req.a, req.node, geom);
    case "disconnect": return canvasedit.disconnect(g, info, req.node, req.dir, req.pin);
    case "delete": {
      const nid = req.node;
      if (g.node(nid) !== null) {
        const removed = ops.deleteNode(g, nid);
        return `Deleted ${nid}` + (removed.length ? ` and ${removed.length} wire(s): ${removed.join(", ")}` : "");
      }
      if (g.box(nid) !== null) {
        ops.deleteBox(g, nid);
        return `Deleted box ${nid}`;
      }
      return null;
    }
    case "literal": return canvasedit.setLiteral(g, info, idx, req.node, req.pin, req.text, !!req.verbatim);
    case "toggle": return canvasedit.toggleBool(g, req.node, req.pin);
    case "set_enum": return canvasedit.setEnum(g, req.node, req.pin, req.type, req.member);
    case "make_struct": return canvasedit.makeForPin(g, req.node, req.pin, req.type, geom)[1];
    case "break_struct": return canvasedit.breakStruct(g, req.node, req.pin, req.type, geom)[1];
    case "rename": return canvasedit.renameNode(g, req.node, req.text);
    case "label": return canvasedit.setLabel(g, req.node, req.text, REMEMBERED);
    case "color": return canvasedit.setColor(g, req.node, req.text, REMEMBERED);
    case "toggle_attr": return canvasedit.toggleAttr(g, req.node, req.name);
    case "int_attr": return canvasedit.setIntAttr(g, req.node, req.name, req.text);
    case "add_pin": return canvasedit.addPin(g, idx, req.node);
    case "remove_pin": return canvasedit.removePin(g, req.node, req.pin);
    case "toggle_flat": return canvasedit.toggleFlat(g, info, req.node);
    case "add_note": return canvasedit.addNote(g, req.on ?? null, req.text);
    case "edit_note": return canvasedit.editNote(g, req.key, req.text);
    case "delete_note": return canvasedit.deleteNote(g, req.key);
    case "add_box": return canvasedit.addBox(g, req.x ?? 0, req.y ?? 0, req.text, req.member ?? null);
    case "resize": return canvasedit.resizeBox(g, req.box, req.text);
    case "retitle": return canvasedit.retitleBox(g, req.box, req.text);
    case "add_local": return canvasedit.addLocal(g, idx, req.kind ?? "local", req.text);
    case "add": {
      const it = new pal.Item("", req.kind, req.symbol ?? null, [...(req.targs ?? [])]);
      return canvasedit.addNode(g, idx, it, req.x ?? 0, req.y ?? 0, req.context ?? null, geom)[1];
    }
    default: throw new UnknownEdit();
  }
}

export type MenuEntry = Record<string, any>;

/** The context menu for something on the canvas. */
export function menu(source: string, graph: string, t: Record<string, any>): MenuEntry[] {
  const m = parseOrNull(source);
  const g = m?.graph(graph) ?? null;
  if (m === null || g === null) return [];
  const idx = new ModuleIndex(m);
  const info = new GraphInfo(g, idx);
  const out: MenuEntry[] = [];
  const sep = { sep: true };
  const choice = (label: string, op: string | null = null, ask: string | null = null, value = "",
                  extra: { client?: string; confirm?: string | null; [k: string]: any } = {}) => {
    const { client, confirm, ...req } = extra;
    const e: MenuEntry = { label };
    if (op) e.action = { op, ...req };
    if (ask !== null) e.ask = { label: ask, value };
    if (client) {
      e.client = client;
      Object.assign(e, req);
    }
    if (confirm) e.confirm = confirm;
    out.push(e);
  };
  const nodeMenu = (nid: string) => {
    const n = g.node(nid);
    if (n === null) return;
    out.push({ label: `${nid}  (${n.kind})`, header: true });
    const tg = opens(m, n);
    if (tg) choice(`Open ${n.symbol}`, null, null, "", { client: `open:${tg}` });
    choice("Breakpoint  (F9)", null, null, "", { client: "breakpoint", node: nid });
    choice("Name…", "rename", `Name for '${nid}' (a named node is declared at the top of the function, and every wire follows):`,
           n.named ? nid : "", { node: nid });
    choice("Label…", "label", `Display label for '${nid}' (layout only; empty to clear):`, canvasedit.currentProp(g, nid, "label"), { node: nid });
    choice("Colour…", "color", "Colour such as #C0392B (empty to clear):", canvasedit.currentProp(g, nid, "color"), { node: nid });
    choice("Add note…", "add_note", `Note text on '${nid}':`, "", { on: nid });
    if (n.kind === "Sequence")
      choice("Set output count (#count)…", "int_attr", "Number of outputs:", String(canvasedit.intAttr(g, nid, "count")), { node: nid, name: "count" });
    if (canvasedit.pinCount(n) !== null) choice(addPinLabel(n), "add_pin", null, "", { node: nid });
    if (n.kind !== "Entry") choice((n.attr("disabled") ? "Enable" : "Disable") + " (@disabled)", "toggle_attr", null, "", { node: nid, name: "disabled" });
    out.push(sep);
    choice("Delete node", "delete", null, "", { node: nid, confirm: n.kind === "Entry" ? "Delete the graph's Entry node?" : null });
  };
  const kind = t.kind;
  if (kind === "canvas") {
    choice("Search nodes…   (Tab)", null, null, "", { client: "palette" });
    out.push(sep);
    choice("Add box here…", "add_box", "Box title:", "", { x: t.x ?? 0, y: t.y ?? 0 });
    choice("Add graph note…", "add_note", "Note text for the whole graph:", "", { on: null });
    choice("Add local…", "add_local", "Add local: " + canvasedit.localPrompt(idx), "", { kind: "local" });
  } else if (kind === "node") {
    nodeMenu(t.node);
  } else if (kind === "pin") {
    const nid = t.node, d = t.dir, pin = t.pin;
    const sig = info.sigs.get(nid);
    const p = sig ? (d === "in" ? sig.input(pin) : sig.output(pin)) : null;
    if (p === null) return [];
    if (d === "in" && idx.enums.has(p.type)) {
      out.push({ label: `Set '${pin}' to`, header: true });
      for (const [member] of enumValues(idx.enums.get(p.type)!))
        out.push({ label: `${p.type}::${member}`, indent: true, action: { op: "set_enum", node: nid, pin, type: p.type, member } });
    } else if (d === "in" && idx.structs.has(p.type)) choice(`Make a ${p.type} for '${pin}'`, "make_struct", null, "", { node: nid, pin, type: p.type });
    else if (d === "in" && !p.is_exec) choice(`Set literal for '${pin}'…`, null, null, "", { client: "editPin", node: nid, pin });
    if (d === "out" && idx.structs.has(p.type)) choice(`Break '${pin}' into fields`, "break_struct", null, "", { node: nid, pin, type: p.type });
    choice("Disconnect", "disconnect", null, "", { node: nid, dir: d, pin });
    if (canvasedit.removablePin(g.node(nid), pin, d)) choice(`Remove pin '${pin}'`, "remove_pin", null, "", { node: nid, pin });
    out.push(sep);
    nodeMenu(nid);
  } else if (kind === "box") {
    const bid = t.box;
    const b = g.box(bid);
    if (b === null) return [];
    choice("Rename title…", "retitle", "Title:", b.title, { box: bid });
    choice("Resize…", "resize", "width, height:", `${b.w}, ${b.h}`, { box: bid });
    choice("Colour…", "color", "Colour such as #C0392B (empty to clear):", canvasedit.currentProp(g, bid, "color"), { node: bid });
    choice("Add note…", "add_note", `Note text on '${bid}':`, "", { on: bid });
    out.push(sep);
    choice("Delete box", "delete", null, "", { node: bid });
    out.push(sep);
    choice("Search nodes…   (Tab)", null, null, "", { client: "palette" });
  } else if (kind === "wire") {
    const [wkind, nid, pin] = t.wire.split("|");
    choice("Delete wire", "disconnect", null, "", { node: nid, dir: wkind === "d" ? "in" : "out", pin });
  } else if (kind === "note") {
    const [, nt] = ops.findNote(g, t.note);
    if (nt === null) return [];
    choice("Edit note…", "edit_note", "Text:", noteText(nt), { key: t.note });
    choice("Delete note", "delete_note", null, "", { key: t.note });
  }
  return out;
}

/** What an edit changed in the source, for the Source pane to flash. */
export function changes(old: string, nu: string) {
  return textchanges.changes(old, nu);
}

/** The Source pane's highlighting rules. */
export function syntax() {
  return syn.rules();
}

/** Parse, compile and run `func` (no arguments). */
export function run(source: string, func = "Main", deterministic = false, fuel = 50_000_000): RunResult {
  const out = newResult();
  const [m, r] = compileInto(source, out, false);
  if (m === null) return out;
  const vm = new VM({ output: (l) => out.output.push(l), fuel, deterministic });
  try {
    const lm = vm.load(r!.wbc!);
    const res = runFunction(vm, lm, func, []);
    out.result = formatResults(m, func, res);
    out.ok = true;
  } catch (e) {
    if (e instanceof WiretError) faultInto(m, e, out);
    else if (e instanceof ValueError) out.error = out.explain = e.message;
    else throw e;
  }
  return out;
}

export interface Frame { graph: string; node: string; vars: [string, string, string, string][]; pins: Record<string, string> }
export interface Step { phase: string; graph: string; node: string; depth: number; out: number; frames: number[]; globals: number }
export interface DebugResult extends RunResult {
  steps: Step[]; frame_table: Frame[]; globals_table: [string, string, string][][];
  counts: Record<string, Record<string, number>>; truncated: boolean;
  /** the disassembly of the compiled debug build (`wiretc dis`), or null if it did not compile */
  bytecode: string | null;
}

/** Run like `run`, recording the debugger's pause points in `steps`, in order. */
export function debugRun(source: string, func = "Main", deterministic = false, fuel = 50_000_000, maxSteps = MAX_STEPS): DebugResult {
  const out: DebugResult = { ...newResult(), steps: [], frame_table: [], globals_table: [], counts: {}, truncated: false, bytecode: null };
  const [m, r] = compileInto(source, out, true);
  if (m === null) return out;
  out.bytecode = disassemble(r.wbc!);
  const idx = new ModuleIndex(m);
  const prefix = m.name + ".";
  const graphNames = new Set(m.graphs().map((g) => g.name));
  const infos = new Map<string, GraphInfo | null>();
  const counts = new Counter<string>();
  const loaded: LoadedModule[] = [];
  const interned = new Map<string, number>();
  const intern = (table: "frame_table" | "globals_table", value: any): number => {
    const k = table + "\0" + jsonDumps(value, true);
    if (!interned.has(k)) {
      interned.set(k, out[table].length);
      (out[table] as any[]).push(value);
    }
    return interned.get(k)!;
  };
  const info = (g: string) => {
    if (!infos.has(g)) {
      const gdef = m.graph(g);
      infos.set(g, gdef ? new GraphInfo(gdef, idx) : null);
    }
    return infos.get(g)!;
  };
  const frame = (fr: FrameView): Frame => {
    const g = short(fr.func.name, prefix);
    const gdef = m.graph(g), gi = info(g);
    const values = fr.namedLocals();
    const vars: [string, string, string, string][] = [];
    if (gdef)
      for (const [kind, list] of [["parameter", gdef.params], ["local", gdef.locals]] as const)
        for (const p of list) if (values.has(p.name)) vars.push([p.name, kind, p.type, formatValue(p.type, values.get(p.name), idx)]);
    const pins: Record<string, string> = {};
    for (const [n, p, v] of fr.pinValues().values()) {
      if (n.includes("/") || n.includes("!")) continue;
      const sig = gi ? gi.sigs.get(n) : undefined;
      const pin = sig ? sig.output(p) : null;
      pins[`${n}.${p}`] = formatValue(pin ? pin.type : null, v, idx);
    }
    return { graph: g, node: top(fr.node), vars, pins };
  };
  const globals = (): [string, string, string][] => {
    if (!loaded.length) return [];
    const lm = loaded[0];
    const rows: [string, string, string][] = [];
    for (const v of sortedBy(idx.vars.values(), (v) => v.name)) {
      const gi = lm.global_names.get(v.name);
      if (gi !== undefined) rows.push([v.name, v.type, formatValue(v.type, lm.globals[gi], idx)]);
    }
    return rows;
  };
  const hook = (fname: string, node: string, _pending: string[], depth: number, snapshot: () => FrameView[], phase: string) => {
    const g = short(fname, prefix);
    if (node.includes("/") || !graphNames.has(g)) return;
    const t = top(node);
    if (phase === "enter") counts.add(`${g}\0${t}`);
    if (out.steps.length >= maxSteps) {
      out.truncated = true;
      return;
    }
    out.steps.push({ phase, graph: g, node: t, depth, out: out.output.length,
                     frames: snapshot().map((f) => intern("frame_table", frame(f))), globals: intern("globals_table", globals()) });
  };
  const vm = new VM({ output: (l) => out.output.push(l), fuel, deterministic, hook });
  try {
    const lm = vm.load(r!.wbc!);
    loaded.push(lm);
    const res = runFunction(vm, lm, func, []);
    out.result = formatResults(m, func, res);
    out.ok = true;
  } catch (e) {
    if (e instanceof WiretError) faultInto(m, e, out);
    else if (e instanceof ValueError) out.error = out.explain = e.message;
    else throw e;
  }
  for (const [k, c] of counts) {
    const [g, n] = k.split("\0");
    (out.counts[g] ??= {})[n] = c;
  }
  return out;
}

export const API = { check, literalPrompt, palette, edit, menu, changes, syntax, run, debugRun };
export type ApiName = keyof typeof API;
