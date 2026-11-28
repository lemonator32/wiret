// @ts-nocheck: the page script, ported from the prototype; checked by its behaviour in the browser
import { Session, nodeKey } from "./debugger.js";
import { GraphView } from "./graphview.js";
import { makeHighlighter } from "./syntax.js";
import { API as api } from "../core/webapi.js";
import { init as initRuntime } from "../core/vm.js";
import { CONTENT } from "../core/content.gen.js";
import { host } from "./host.js";

const $ = (id) => document.getElementById(id);
const FUEL = 5_000_000;       // a runaway loop stops in seconds instead of freezing the tab
const LH = 20, PAD = 10;      // line height and padding of the source, as in the CSS
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

let highlighter = null;       // syntax.js, with the desktop's rules
let nodes = {};               // graph -> node -> {line, what}, from the last good parse
let lineNodes = new Map();    // line -> [graph, node]
let graphs = [];              // from the last good parse, as webapi.check describes them
let graphName = null;         // the graph on the canvas
let selected = null;          // the selected node of that graph
let problems = [];
const breakpoints = new Set();  // "graph\tnode"
let counts = null;            // graph -> node -> runs, after a run
let trace = null, session = null, frameSel = -1, timer = null;
let fault = null;
let busy = false;             // a run is being recorded; the controls wait for it
let shownDebugger = false;    // the Debugger tab was brought forward in this session
const undoStack = [], redoStack = [];   // texts before (after) each graph edit

const gv = new GraphView($("graph"), {
  select: (id) => {
    selectNode(id, "graph");
    if (!id && gv.selWire) say("Wire selected. Press Delete to remove it.");
  },
  open: (name) => showGraph(name),
  toggleBreakpoint: (id) => toggleBreakpoint(`${graphName}\t${id}`),
  canEdit: () => canEdit(),
  message: (text) => say(text, true),
  move: (id, x, y) => { selected = id; applyEdit({ op: "move", moves: [[id, x, y]] }); },
  connect: (a, b) => applyEdit({ op: "connect", a, b, geoms: gv.geomsFor([a[0], b[0]]) }),
  connectToNode: (a, node) => applyEdit({ op: "connect_to_node", a, node, geoms: gv.geomsFor([a[0], node]) }),
  disconnect: (node, dir, pin) => { gv.selWire = null; applyEdit({ op: "disconnect", node, dir, pin }); },
  deleteNode: (id) => {
    const n = graph()?.nodes.find((x) => x.id === id);
    if (n?.title === "Entry" && !confirm("Delete the graph's Entry node?")) return;
    if (applyEdit({ op: "delete", node: id })) selected = null;
  },
  editPin: (node, pin, at) => editPin(node, pin, at),
  setPin: (node, pin, text) => applyEdit({ op: "literal", node, pin, text, verbatim: true }),
  addPin: (node) => { if (canEdit() === true) applyEdit({ op: "add_pin", node }); else say(canEdit(), true); },
  removePin: (node, pin) => { if (canEdit() === true) applyEdit({ op: "remove_pin", node, pin }); else say(canEdit(), true); },
  toggleFlat: (node) => { if (canEdit() === true) applyEdit({ op: "toggle_flat", node }); else say(canEdit(), true); },
  palette: (world, at, context) => openPalette(world, at, context),
  menu: (target, at, world) => openMenu(target, at, world),
});

// ---------- editing on the canvas ----------
/** true, or why the graph cannot be edited now (as the desktop editor's can_edit). */
function canEdit() {
  if (busy) return "Wait for the page to finish.";
  if (session && !session.finished) return "The program is running. Stop it (■) before editing the graph.";
  if (problems.some((d) => d.code === "parse")) return "Fix the parse error in the source pane before editing the graph.";
  return graph() ? true : "There is no graph to edit.";
}

/** Make one canvas edit (webapi.edit) and take its canonical text. Returns true if it applied. */
function applyEdit(req) {
  const ok = canEdit();
  if (ok !== true) { say(ok, true); recheck(); return false; }
  const before = $("src").value;
  let r = api.edit(before, graphName, req);
  if (r.comments) {
    if (!confirm(`The source has ${r.comments} '//' comment(s) that are not directly above a statement, ` +
                 "so editing the graph cannot keep them (W0603).\n\nOK: convert them to notes\nCancel: undo this edit")) {
      recheck();
      return false;
    }
    r = api.edit(before, graphName, { ...req, comments: "convert" });
  }
  if (!r.ok) {
    if (r.message) say(r.message, true);
    recheck();                                         // put back what a drag changed
    return false;
  }
  if (r.text !== before) {
    undoStack.push(before);
    redoStack.length = 0;
  }
  setText(r.text);
  if (r.select) selected = r.select;
  updateGraph();
  renderHighlights();
  say(r.message);
  return true;
}

/** Replace the source text after a graph edit, undo or redo; the last run is now stale. */
function setText(text) {
  const ta = $("src"), top = ta.scrollTop, before = ta.value;
  if (trace) stop();
  counts = fault = null;
  ta.value = text;
  ta.scrollTop = top;
  recheck();
  setButtons();
  flashChanges(before, text);
}

/** Mark what an edit changed in the source: the lines in grey, the changed columns in yellow,
 *  fading as #flash's CSS says. Typing or the next edit clears it. */
function flashChanges(before, after) {
  const box = $("flash");
  box.replaceChildren();
  if (before === after) return;
  const ch = api.changes(before, after);
  const strip = (cls, line, start, end) => {
    const d = el("div", cls);
    d.dataset.line = line;
    if (cls === "col") { d.dataset.start = start; d.dataset.end = end; }
    return d;
  };
  box.append(...ch.lines.map((l) => strip("line", l)),
             ...ch.spans.map(([l, s, e]) => strip("col", l, s, e)));
  if (ch.lines.length) scrollToLine(ch.lines[0]);
  syncScroll();
}

/** The width of one character of the source, for placing the column strips. It is measured
 *  in #paint, which draws the text in the same font as the textarea: the computed `font`
 *  shorthand cannot be used, since browsers leave it empty when font-variant-ligatures is set. */
let charW = 0;
function charWidth() {
  if (!charW) {
    const probe = el("span", null, "x".repeat(100));
    probe.style.cssText = "position: absolute; visibility: hidden; white-space: pre";
    $("paint").append(probe);
    charW = probe.getBoundingClientRect().width / 100;
    probe.remove();
  }
  return charW;
}

function undo() {
  if (!undoStack.length) return say("Nothing to undo.");
  const ok = canEdit();
  if (ok !== true) return say(ok, true);
  redoStack.push($("src").value);
  setText(undoStack.pop());
  say("Undone.");
}

function redo() {
  if (!redoStack.length) return;
  const ok = canEdit();
  if (ok !== true) return say(ok, true);
  undoStack.push($("src").value);
  setText(redoStack.pop());
  say("Redone.");
}

/** The node palette: search, pick, and add the node at `world` (wired to `context`, the pin
 *  a wire was dragged from, if any). */
async function openPalette(world, at, context) {
  const ok = canEdit();
  if (ok !== true) return say(ok, true);
  const text = $("src").value, ctx = context ?? null;
  const first = api.palette(text, graphName, "", ctx);
  if (!first) return;
  if (!first.total) return say(`No node has a pin that fits ${context[0]}.${context[2]}.`, true);
  const item = await gv.pick(at, {
    title: first.title,
    search: (q) => (q ? api.palette(text, graphName, q, ctx) : first),
  });
  if (!item) return;
  applyEdit({ op: "add", kind: item.kind, symbol: item.symbol, targs: item.targs,
              x: Math.round(world[0]), y: Math.round(world[1]), context,
              geoms: context ? gv.geomsFor([context[0]]) : {} });
}

/** The context menu for `target` (webapi.menu builds it, as the desktop editor's), then
 *  what was chosen: an edit (asking for text first if it needs some), or something the page
 *  does itself. */
async function openMenu(target, at, world) {
  const entries = api.menu($("src").value, graphName, target);
  if (!entries.length) return;
  for (const e of entries) {
    if (e.client === "breakpoint") {
      e.label = (breakpoints.has(`${graphName}\t${e.node}`) ? "Remove breakpoint" : "Set breakpoint") + "  (F9)";
    }
  }
  const e = await gv.menu(at, entries);
  if (!e) return;
  if (e.client === "palette") return openPalette(world, at, null);
  if (e.client === "breakpoint") return toggleBreakpoint(`${graphName}\t${e.node}`);
  if (e.client === "editPin") return editPin(e.node, e.pin, at);
  if (e.client?.startsWith("open:")) return showGraph(e.client.slice(5));
  const ok = canEdit();
  if (ok !== true) return say(ok, true);
  const req = { ...e.action };
  if (e.ask) {
    const text = await gv.ask(at, { label: e.ask.label, value: e.ask.value });
    if (text === null) return;
    req.text = text;
  }
  if (e.confirm && !confirm(e.confirm)) return;
  if (req.op === "add_box") req.member = selected;
  if (req.node) req.geoms = gv.geomsFor([req.node]);
  if (applyEdit(req) && req.op === "delete" && selected === req.node) selected = null;
}

/** Double-click on an input: flip a bool, or type a value in a box over the canvas. */
async function editPin(node, pin, at) {
  const ok = canEdit();
  if (ok !== true) return say(ok, true);
  const prompt = api.literalPrompt($("src").value, graphName, node, pin);
  if (!prompt) return;
  if (prompt.type === "bool") return applyEdit({ op: "toggle", node, pin });
  const text = await gv.ask(at, {
    label: `${node}.${pin} : ${prompt.type} (Enter to set; empty: use the default)`,
    value: prompt.current, placeholder: prompt.hint || prompt.type,
  });
  if (text !== null) applyEdit({ op: "literal", node, pin, text });
}

// ---------- start ----------
/** The lessons and examples, as the lesson menu lists them: [path, text]. */
const FILES = Object.entries(CONTENT).filter(([f]) => !f.startsWith("std/"))
  .sort(([a], [b]) => (a.startsWith("examples/") ? 1 : 0) - (b.startsWith("examples/") ? 1 : 0) || (a < b ? -1 : a > b ? 1 : 0));

async function boot() {
  const t0 = performance.now();
  await initRuntime();
  const rules = api.syntax();
  highlighter = makeHighlighter(rules);
  for (const [tag, color] of Object.entries(rules.colors)) {
    document.documentElement.style.setProperty(`--desk-${tag}`, color);
  }
  for (const [f] of FILES) {
    const name = f.split("/").pop().replace(".wiret", "").replace(/^(\d+)_/, "$1. ").replace(/_/g, " ");
    $("lesson").add(new Option(name, f));
  }
  if (host.lessons) {
    const line = new Option("────────────", "");
    line.disabled = true;
    $("lesson").add(line);
    $("lesson").add(new Option("Start this lesson over…", RESTART_ONE));
    $("lesson").add(new Option("Start all lessons over…", RESTART_ALL));
  }
  $("lesson").onchange = () => {
    if ($("lesson").value === RESTART_ONE) return restartLesson();
    if ($("lesson").value === RESTART_ALL) return restartAllLessons();
    picked = $("lesson").value;
    openLesson(picked);
  };
  addEventListener("pagehide", keepLesson);
  $("lesson").disabled = false;
  await host.init({ getText: () => $("src").value, setText: (text, path) => { loadText(text, path); }, say });
  $("ready").textContent = `${host.name} · ready in ${((performance.now() - t0) / 1000).toFixed(2)} s`;
  $("lesson").onchange();
  setButtons();
}

// ---------- the student's copies of the lessons ----------
/* The desktop app keeps each lesson the student changes in ~/Documents/Wiret/my_lessons (the
 * folder the desktop prototype uses), so their work is there the next time they pick it. */
const RESTART_ONE = "\0restart-one";
const RESTART_ALL = "\0restart-all";
let lesson = null;            // the open lesson (its CONTENT key), or null for a file
let lessonSaved = null;       // its text as last loaded or kept
let lessonWrites = Promise.resolve();
let picked = "";              // the menu entry last picked, which the menu goes back to

/** The name a lesson's copy has in my_lessons: its file name, as the prototype names it. */
const copyName = (key) => key.split("/").pop();

/** Show a lesson: the student's copy if they have changed it, else the original. */
async function openLesson(key) {
  let text = CONTENT[key], mine = null;
  if (host.lessons) {
    await lessonWrites;
    mine = await host.lessons.read(copyName(key)).catch((e) => {
      say(`Could not read your copy of this lesson, so the original is shown: ${e}`, true);
      return null;
    });
  }
  if ($("lesson").value !== key) return;              // another was picked while reading
  const continued = mine !== null && mine !== text;
  if (continued) text = mine;
  loadText(text, null, key);
  if (continued) say("You have worked on this lesson before, so your changes are back. " +
                     "To start it again from the beginning, pick \"Start this lesson over…\" at the bottom of the lesson menu.");
}

/** Keep the open lesson's text in my_lessons if it changed since it was loaded or last kept. */
function keepLesson() {
  if (!host.lessons || lesson === null) return;
  const text = $("src").value;
  if (text === lessonSaved) return;
  lessonSaved = text;
  const name = copyName(lesson);
  lessonWrites = lessonWrites.then(() => host.lessons.write(name, text))
    .catch((e) => say(`Could not keep your changes to this lesson: ${e}`, true));
}

/** Throw away the copy of the open lesson and show its original. */
async function restartLesson() {
  const back = lesson;
  $("lesson").value = picked;                         // the menu shows what is open, not this entry
  if (back === null) return say("The open program is not a lesson, so there is nothing to start over.");
  const title = $("lesson").selectedOptions[0]?.textContent ?? copyName(back);
  if (!confirm(`Throw away your changes to ${title} and start it again from the beginning?\n\n` +
               "This cannot be undone.")) return;
  lesson = null;                                      // nothing of the open lesson is kept now
  await lessonWrites;
  try {
    await host.lessons.remove([copyName(back)]);
  } catch (e) {
    lesson = back;
    return say(`Could not start the lesson over: ${e}`, true);
  }
  loadText(CONTENT[back], null, back);
  say(`Started ${title} over.`);
}

/** Throw away the copies of every lesson in the menu and show the open lesson's original. */
async function restartAllLessons() {
  const back = lesson;
  $("lesson").value = picked;                         // the menu shows what is open, not this entry
  if (!confirm("Throw away your changes to all the lessons and start them again from the " +
               "originals?\n\nThis cannot be undone.")) return;
  lesson = null;                                      // nothing of the open lesson is kept now
  await lessonWrites;
  let removed;
  try {
    removed = await host.lessons.remove(FILES.map(([f]) => copyName(f)));
  } catch (e) {
    lesson = back;
    return say(`Could not start the lessons over: ${e}`, true);
  }
  if (back) loadText(CONTENT[back], null, back);
  say(removed ? `Started ${removed} lesson${removed === 1 ? "" : "s"} over.`
              : "No lesson had been changed, so there was nothing to start over.");
}

/** Show `text` as the program, fresh: a lesson picked from the menu (`key`), or a file opened. */
function loadText(text, path, key = null) {
  stop();
  keepLesson();                                       // what was typed in the last moment
  lesson = key;
  lessonSaved = text;
  host.opened(path);
  $("src").value = text;
  $("src").scrollTop = 0;
  $("flash").replaceChildren();                      // the last edit's changes were in the old text
  breakpoints.clear();
  undoStack.length = redoStack.length = 0;
  counts = fault = null;
  graphName = selected = null;
  showTab("source");
  showOutput([]);
  recheck();
  say("Press Run (F5) to run the program, or Step (F11) to go through it one node at a time. " +
      "To set a breakpoint, click the circle at a node's top-left corner or beside its line number.");
}

function recheck() {
  keepLesson();                                       // every change of the text comes here
  const r = api.check($("src").value);
  const parsed = !r.diags.some((d) => d.code === "parse");
  if (parsed) { nodes = r.nodes; graphs = r.graphs; }
  lineNodes = new Map();
  for (const [g, ns] of Object.entries(nodes)) for (const [n, i] of Object.entries(ns)) lineNodes.set(i.line, [g, n]);
  problems = r.diags;
  renderProblems();
  renderGutter();
  renderHighlights();
  renderGraphList();
  if (graphName && graphs.some((g) => g.name === graphName)) {
    if (parsed) gv.setGraph(graph(), true);            // same graph, edited: keep the view
    updateGraph();
  } else {
    showGraph(graphs.find((g) => g.name === "Main")?.name ?? graphs[0]?.name ?? null);
  }
}

// ---------- the graph ----------
const graph = () => graphs.find((g) => g.name === graphName) ?? null;

function renderGraphList() {
  const sel = $("graphsel");
  const want = graphs.map((g) => `${g.kind} ${g.name}`).join("\n");
  if (sel.dataset.list === want) return;
  sel.dataset.list = want;
  sel.replaceChildren(...graphs.map((g) => new Option(`${g.kind} ${g.name}`, g.name)));
  if (graphName) sel.value = graphName;
}

function showGraph(name) {
  if (!name || !graphs.some((g) => g.name === name)) return;
  if (name !== graphName) selected = null;
  graphName = name;
  $("graphsel").value = name;
  gv.setGraph(graph());
  updateGraph();
}

/** Redraw the canvas's marks: selection, breakpoints, run counts, the fault, and at a pause
 *  the node that runs next and the values on the wires. */
function updateGraph() {
  const st = { selected, breakpoints: new Set(), counts: counts?.[graphName] ?? null,
               fault: fault?.graph === graphName ? fault.node : null };
  for (const k of breakpoints) {
    const [g, n] = k.split("\t");
    if (g === graphName) st.breakpoints.add(n);
  }
  const f = selectedFrame();
  if (f && f.graph === graphName) { st.current = f.node; st.values = f.pins; }
  gv.setState(st);
}

function selectNode(id, from) {
  selected = id;
  updateGraph();
  renderHighlights();
  if (!id) return;
  const info = nodes[graphName]?.[id];
  if (from === "graph" && info) scrollToLine(info.line);
  const n = graph()?.nodes.find((x) => x.id === id);
  const issues = problems.filter((d) => d.graph === graphName && d.node === id).map((d) => d.explain || d.message);
  const opens = n?.opens ? ` Double-click it to open ${n.opens}.` : "";
  const what = n?.description ? ` ${n.description}` : "";
  say(issues.length ? `${id}: ${issues.join(" ")}` :
      `${id}${info?.what ? ` (${info.what})` : ""}${info ? `, line ${info.line}` : ""}.${what}${opens}`, issues.length > 0);
}

$("graphsel").onchange = () => showGraph($("graphsel").value);
$("fit").onclick = () => gv.fit(true);
$("zoomin").onclick = () => gv.zoom(1.25);
$("zoomout").onclick = () => gv.zoom(1 / 1.25);
$("undo").onclick = undo;
$("addnode").onclick = () => { const [w, a] = gv.middle(); openPalette(w, a, null); };
$("redo").onclick = redo;

// ---------- tabs ----------
const TABS = ["source", "debugger", "problems", "bytecode"];
function showTab(name) {
  for (const t of TABS) {
    $(`tab-${t}`).setAttribute("aria-selected", t === name);
    $(`pane-${t}`).hidden = t !== name;
  }
  if (name === "source") syncScroll();
}
for (const t of TABS) $(`tab-${t}`).onclick = () => showTab(t);

// ---------- running and stepping ----------
async function start(mode) {
  if (busy) return;
  stop();
  setBusy(true);
  try {
    await record(mode);
  } finally {
    setBusy(false);
  }
}

function setBusy(on) {
  busy = on;
  document.body.dataset.busy = on ? "1" : "";
  setButtons();
}

async function record(mode) {
  const animate = mode === "run" && $("animate").checked;
  const debugging = mode !== "run" || animate || breakpoints.size > 0;
  say(debugging ? "Recording the run…" : "Running…");
  await new Promise((r) => setTimeout(r, 20));          // let the message paint
  const t0 = performance.now();
  const r = api.debugRun($("src").value, "Main", $("det").checked, FUEL, debugging ? 5000 : 0);
  const ms = Math.round(performance.now() - t0);
  problems = r.diags; renderProblems();
  if (r.diags.some((d) => d.severity === "error")) {   // did not compile
    showOutput([["err", "The program has problems, so it did not run. See Problems."]]);
    say("The program has problems, so it did not run. Their nodes are marked with a red !.", true);
    showTab("problems");
    return;
  }
  $("bytecode").textContent = r.bytecode;       // like the prototype, kept until the next build
  nodes = r.nodes;
  trace = r; trace.ms = ms;
  counts = null; fault = null;
  shownDebugger = false;
  if (!debugging) return finish();
  setReadOnly(true);                            // the recording is of this text
  session = new Session(trace, breakpoints);
  if (animate) return animateNext();
  move(mode);
}

function move(mode) {
  if (!session) return;
  clearTimeout(timer); timer = null;
  const r = session.advance(mode);
  if (!r) return finish();
  frameSel = -1;
  show(r);
}

function animateNext() {
  const r = session.advance("animate");
  if (!r) return finish();
  frameSel = -1;
  show(r);
  if (!r.paused) timer = setTimeout(animateNext, +$("speed").value);
}

function back() {
  if (!session) return;
  clearTimeout(timer); timer = null;
  if (!session.back()) return;
  counts = fault = null;
  setReadOnly(true);
  renderGutter();
  frameSel = -1;
  show({ paused: true, breakpoint: false });
}

function finish() {
  clearTimeout(timer); timer = null;
  const r = trace;
  counts = r.counts; fault = r.fault;
  const lines = r.output.map((l) => ["", l]);
  if (r.ok) {
    if (r.result && r.result !== "(no results)") lines.push(["okc", `Finished: ${r.result}`]);
    lines.push(["note", `(finished in ${r.ms} ms)`]);
    say("The program finished. Green outlines show which nodes ran, and how often." +
        (r.truncated ? " The run was too long to record all of it, so stepping stopped early." : ""));
  } else {
    lines.push(["err", r.explain || r.error]);
    if (r.explain && r.error && r.explain !== r.error) lines.push(["note", r.error]);
    say(r.explain || r.error, true);
  }
  showOutput(lines);
  setReadOnly(false);
  renderDebugger();
  renderGutter();
  renderHighlights();
  if (fault && fault.graph !== graphName) showGraph(fault.graph);
  updateGraph();
  if (fault) { gv.reveal(fault.node); scrollToLine(lineOf(fault.graph, fault.node)); }
  setButtons();
}

function stop() {
  clearTimeout(timer); timer = null;
  session = null; trace = null; frameSel = -1;
  setReadOnly(false);
  renderDebugger();
  renderHighlights();
  updateGraph();
  setButtons();
}

// ---------- showing a pause ----------
function show(r) {
  const s = session.current;
  showOutput(trace.output.slice(0, s.out).map((l) => ["", l]));
  const what = nodes[s.graph]?.[s.node]?.what;
  if (r.paused) {
    const why = breakpoints.has(nodeKey(s)) ? " (breakpoint)" : "";
    const inputs = s.phase === "ready" ? "Its inputs are shown on the wires."
                                       : "Its inputs haven't been worked out yet; Step to compute them.";
    say(`Paused${why} just before ${s.node}${what ? ` (${what})` : ""} in ${s.graph} runs. ${inputs} ` +
        "Step runs one node; Over runs calls in one go; Run continues.");
    if (!shownDebugger) { shownDebugger = true; showTab("debugger"); }
  } else {
    say(`Animating: ${s.node}${what ? ` (${what})` : ""} in ${s.graph}.`);
  }
  renderDebugger();
  showFrame();
  setButtons();
}

/** Bring the selected frame's graph and node into view, on the canvas and in the source. */
function showFrame() {
  const f = selectedFrame();
  if (!f) return;
  if (f.graph !== graphName) showGraph(f.graph);
  updateGraph();
  gv.reveal(f.node);
  renderHighlights();
  const line = lineOf(f.graph, f.node);
  if (line) scrollToLine(line);
}

const lineOf = (g, n) => nodes[g]?.[n]?.line ?? null;
const selectedFrame = () => {
  const s = session?.current;
  if (!s) return null;
  const i = frameSel < 0 ? s.frames.length - 1 : frameSel;
  return trace.frame_table[s.frames[i]];
};

function renderDebugger() {
  const body = $("dbg-body");
  const s = session?.current;
  if (!s) {
    body.replaceChildren(el("div", "empty", "Step through a program (F11) to see its call stack, variables and wire values here."));
    return;
  }
  const frames = s.frames.map((i) => trace.frame_table[i]);
  const sel = frameSel < 0 ? frames.length - 1 : frameSel;
  const f = frames[sel];
  const stack = el("ul"); stack.id = "stack";
  for (let i = frames.length - 1; i >= 0; i--) {
    const li = el("li", i === sel ? "sel" : "", `${frames[i].graph}  ·  ${frames[i].node}`);
    li.onclick = () => { frameSel = i; renderDebugger(); showFrame(); };
    stack.append(li);
  }
  const table = (rows, empty) => {
    if (!rows.length) return el("div", "empty", empty);
    const t = el("table");
    for (const [k, v, title] of rows) {
      const tr = el("tr");
      const kc = el("td", "k", k); if (title) kc.title = title;
      tr.append(kc, el("td", "v", v));
      t.append(tr);
    }
    return t;
  };
  const vars = f.vars.map(([n, kind, ty, v]) => [n, v, `${kind} ${ty}`])
    .concat(trace.globals_table[s.globals].map(([n, ty, v]) => [n, v, `variable ${ty}`]));
  const order = (k) => lineOf(f.graph, k.split(".")[0]) ?? 1e9;
  const pins = Object.entries(f.pins).sort((a, b) => order(a[0]) - order(b[0]) || a[0].localeCompare(b[0]));
  body.replaceChildren(
    el("h3", "", "Call stack"), stack,
    el("h3", "", "Variables"), table(vars, "none"),
    el("h3", "", "Wire values"), table(pins, "none"));
}

function showOutput(lines) {
  if (!lines.length) { $("out").replaceChildren(el("div", "empty", "Nothing yet.")); return; }
  $("out").replaceChildren(...lines.map(([cls, t]) => el("div", cls, t)));
  $("out").scrollTop = $("out").scrollHeight;
}

function say(text, error = false) {
  $("msg").textContent = text;
  $("msg").className = error ? "err" : "";
}

function setButtons() {
  const ready = !!api && !busy, live = !!session && !session.finished;
  $("run").disabled = $("step").disabled = $("over").disabled = $("lesson").disabled = !ready;
  $("run").textContent = live ? "▶ Continue" : "▶ Run";
  $("back").disabled = busy || !session || session.history.length === 0 || session.history.at(-1)[0] < 0;
  $("stop").disabled = busy || !trace;
  $("undo").disabled = busy || !undoStack.length;
  $("redo").disabled = busy || !redoStack.length;
}

// ---------- the source editor ----------
/** The coloured copy of the source behind the textarea. */
function paintSource() {
  if (!highlighter) return;
  $("paint").firstElementChild.innerHTML = highlighter.html($("src").value) + "\n";
}

/** The source cannot be edited while a recording of it is being stepped through. */
function setReadOnly(on) {
  $("src").readOnly = on;
  $("code").classList.toggle("readonly", on);
}

function renderGutter() {
  paintSource();
  const n = $("src").value.split("\n").length;
  const rows = [];
  for (let line = 1; line <= n; line++) {
    const row = el("div", "gl");
    const gn = lineNodes.get(line);
    const dot = el("span", "dot");
    const count = el("span", "count");
    if (gn) {
      const key = `${gn[0]}\t${gn[1]}`;
      row.classList.add("node");
      if (breakpoints.has(key)) row.classList.add("bp");
      row.title = `${gn[1]} in ${gn[0]}: click to ${breakpoints.has(key) ? "remove the" : "set a"} breakpoint`;
      row.onclick = () => toggleBreakpoint(key);
      const c = counts?.[gn[0]]?.[gn[1]];
      if (c) { count.textContent = c > 999 ? "1k+" : c; count.title = `ran ${c} time${c === 1 ? "" : "s"}`; }
    }
    row.append(dot, el("span", "num", line), count);
    rows.push(row);
  }
  $("gutter").replaceChildren(...rows);
  syncScroll();
}

function toggleBreakpoint(key) {
  breakpoints.has(key) ? breakpoints.delete(key) : breakpoints.add(key);
  renderGutter();
  updateGraph();
}

/** The strips behind the source: problems, the fault, the selected node and the pause. */
function renderHighlights() {
  const strips = [];
  for (const d of problems) {
    const line = d.line ?? (d.graph && d.node ? lineOf(d.graph, d.node) : null);
    if (line && d.severity === "error") strips.push([line, "bad"]);
  }
  if (fault && !(session && !session.finished)) {
    const line = lineOf(fault.graph, fault.node);
    if (line) strips.push([line, "bad"]);
  }
  const sl = selected ? lineOf(graphName, selected) : null;
  if (sl) strips.push([sl, "sel", blockEnd(sl) - sl + 1]);
  const f = selectedFrame();
  const cl = f ? lineOf(f.graph, f.node) : null;
  if (cl) strips.push([cl, frameSel < 0 || frameSel === session.current.frames.length - 1 ? "cur" : "frame"]);
  $("hl").replaceChildren(...strips.map(([line, cls, span = 1]) => {
    const d = el("div", cls);
    d.dataset.line = line;
    d.style.height = `${span * LH}px`;
    return d;
  }));
  syncScroll();
}

/** The last line of the node written on `line`: where its parenthesised input block closes.
 *  Parentheses inside its {…} attributes, strings and comments do not count. */
function blockEnd(line) {
  const lines = $("src").value.split("\n");
  let depth = 0, braces = 0;
  for (let i = line - 1; i < lines.length; i++) {
    const s = lines[i];
    for (let j = 0; j < s.length; j++) {
      const c = s[j];
      if (c === "/" && s[j + 1] === "/") break;
      if (c === '"') {
        for (j++; j < s.length && s[j] !== '"'; j++) if (s[j] === "\\") j++;
      } else if (c === "{") braces++;
      else if (c === "}") braces--;
      else if (braces === 0 && c === "(") depth++;
      else if (braces === 0 && c === ")" && --depth === 0) return i + 1;
    }
    if (depth <= 0) return line;                       // no input block opened on the node's line
  }
  return line;
}

function syncScroll() {
  const top = $("src").scrollTop;
  $("gutter").style.transform = `translateY(${-top}px)`;
  $("paint").firstElementChild.style.transform = `translate(${-$("src").scrollLeft}px, ${-top}px)`;
  for (const d of $("hl").children) d.style.top = `${PAD + (d.dataset.line - 1) * LH - top}px`;
  const left = PAD - $("src").scrollLeft;
  for (const d of $("flash").children) {
    d.style.top = `${PAD + (d.dataset.line - 1) * LH - top}px`;
    if (d.dataset.start !== undefined) {
      d.style.left = `${left + d.dataset.start * charWidth()}px`;
      d.style.width = `${(d.dataset.end - d.dataset.start) * charWidth()}px`;
    }
  }
}

function scrollToLine(line) {
  if (!line) return;
  const ta = $("src"), y = PAD + (line - 1) * LH;
  if (y < ta.scrollTop + LH || y > ta.scrollTop + ta.clientHeight - 2 * LH) {
    ta.scrollTop = Math.max(0, y - ta.clientHeight / 3);
  }
}

function renderProblems() {
  const ul = $("problems");
  const errors = problems.filter((d) => d.severity === "error").length;
  $("tab-problems").textContent = problems.length ? `Problems (${problems.length})` : "Problems";
  $("tab-problems").classList.toggle("err", errors > 0);
  if (!problems.length) { ul.replaceChildren(el("li", "empty", "No problems.")); return; }
  ul.replaceChildren(...problems.map((d) => {
    const line = d.line ?? (d.graph && d.node ? lineOf(d.graph, d.node) : null);
    const li = el("li", d.severity === "error" ? "err" : "warn",
                  `${line ? `Line ${line}: ` : ""}${d.explain || d.message}`);
    li.title = d.message;
    li.onclick = () => {
      if (d.graph && d.node) { showGraph(d.graph); selectNode(d.node); gv.reveal(d.node); }
      if (line) { showTab("source"); scrollToLine(line); placeCaret(line); }
    };
    return li;
  }));
}

function placeCaret(line) {
  const ta = $("src");
  const lines = ta.value.split("\n");
  const pos = lines.slice(0, line - 1).reduce((a, l) => a + l.length + 1, 0);
  ta.focus();
  ta.setSelectionRange(pos, pos);
}

/** Moving the text cursor onto a node's line selects that node on the canvas. */
function caretMoved() {
  const ta = $("src");
  const gn = lineNodes.get(ta.value.slice(0, ta.selectionStart).split("\n").length);
  if (!gn) return;
  if (gn[0] !== graphName) showGraph(gn[0]);
  if (selected !== gn[1]) { selectNode(gn[1], "text"); gv.reveal(gn[1]); }
}

let checkJob = null;
$("src").addEventListener("input", () => {
  if (trace) stop();                                   // the last run was of other text
  counts = fault = null;
  $("flash").replaceChildren();
  renderGutter();
  clearTimeout(checkJob);
  checkJob = setTimeout(recheck, 350);
});
$("src").addEventListener("scroll", syncScroll);
$("src").addEventListener("click", caretMoved);
$("src").addEventListener("keyup", (e) => { if (e.key.startsWith("Arrow") || e.key.startsWith("Page")) caretMoved(); });
$("src").addEventListener("keydown", (e) => {
  if (e.key === "Tab" && !$("src").readOnly) {
    e.preventDefault();
    document.execCommand("insertText", false, "  ");
  }
});

// ---------- controls ----------
function runOrContinue() { session && !session.finished ? move("run") : start("run"); }
function stepMode(mode) { session && !session.finished ? move(mode) : start(mode); }
$("run").onclick = runOrContinue;
$("step").onclick = () => stepMode("step");
$("over").onclick = () => stepMode("over");
$("back").onclick = back;
$("stop").onclick = () => { stop(); say("Stopped. You can edit the program again."); };

document.addEventListener("keydown", (e) => {
  if (!api || busy) return;
  const k = e.key;
  let act = null;
  if (k === "F5" && e.shiftKey) act = () => $("stop").click();
  else if (k === "F5" || (k === "Enter" && (e.ctrlKey || e.metaKey))) act = runOrContinue;
  else if (k === "F10") act = () => stepMode("over");
  else if (k === "F11" && e.shiftKey) act = back;
  else if (k === "F11") act = () => stepMode("step");
  else if ((e.ctrlKey || e.metaKey) && !["TEXTAREA", "INPUT"].includes(document.activeElement?.tagName)
           && (k === "z" || k === "Z" || k === "y")) {
    act = (k === "y" || e.shiftKey) ? redo : undo;
  }
  else if (k === "F9") act = () => {
    const ta = $("src");
    if (document.activeElement === ta) {
      const gn = lineNodes.get(ta.value.slice(0, ta.selectionStart).split("\n").length);
      if (gn) toggleBreakpoint(`${gn[0]}\t${gn[1]}`);
    } else if (selected) {
      toggleBreakpoint(`${graphName}\t${selected}`);
    }
  };
  if (act) { e.preventDefault(); act(); }
});

boot().catch((e) => {
  $("ready").textContent = "failed to load";
  say(`The page could not start: ${e}`, true);
  console.error(e);
});
