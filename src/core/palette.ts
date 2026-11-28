/** The searchable node palette: what can be added to a graph, with beginner descriptions. */
import { Graph, metaValue, Node } from "./model.js";
import { stdNatives } from "./natives.js";
import {
  arrayElem, canConvert, isContainer, MAP_MUTATORS, MAP_PURE, mapTypes, ModuleIndex, SET_MUTATORS, SET_PURE, setElem,
  signature, STATIC_KINDS, typeChoices,
} from "./registry.js";
import { key, sortedBy } from "./pyutil.js";

/** kind or symbol -> [description, extra search words] */
export const DESCRIBE: Record<string, [string | null, string]> = {
  Entry: ["Where the function starts.", "start begin"],
  Return: ["Finishes the function and hands back its results.", "end exit result output"],
  Branch: ["If/else: follows 'then' when the condition is true, otherwise 'else'.", "if else condition when check decide"],
  Sequence: ["Does several things in order: everything after then[0] first, then then[1], …", "order steps first then do"],
  Switch: ["Chooses a path by comparing a value with several cases.", "case match choose which"],
  Select: ["Picks value a when the condition is true, otherwise value b.", "choose pick ternary if"],
  Reroute: ["A bend point that tidies up wires. It does nothing else.", "tidy bend"],
  Try: ["Runs 'body'. If something goes wrong inside it, such as dividing by zero, runs 'fault' instead of stopping the program. " +
        "Afterwards, runs 'then'.", "catch error fault exception handle recover"],
  Throw: ["Stops with an error that a Try around it can catch, with your message and code.", "raise error fault exception fail"],
  New: ["Makes a new object of a class.", "create object instance make class"],
  CallParent: ["Runs the parent class's version of this method, on the same object. Use it in an override to add to what the " +
               "parent does instead of replacing it.", "super base parent inherited override call"],
  CreateDelegate: ["Wraps a function (and, for a method, its object) into a value you can store, pass around and call later.",
                   "callback function pointer handler event bind reference"],
  Invoke: ["Calls the function a delegate holds.", "call run callback delegate"],
  Bind: ["Adds a handler to an object's dispatcher, so it runs on every Broadcast.", "subscribe listen add handler event dispatcher on"],
  Unbind: ["Removes a handler from an object's dispatcher.", "unsubscribe remove handler stop listening"],
  Broadcast: ["Runs every handler bound to an object's dispatcher, in the order they were bound.",
              "fire notify raise event call all handlers dispatcher"],
  IsValid: ["True when an object reference is not null.", "null check exists valid none"],
  Cast: ["Checks whether an object is of a given class.", "is type check downcast as"],
  Delay: ["Waits for some seconds of game time, then carries on. Only in an event or a @latent function.", "wait sleep pause timer seconds later"],
  Yield: ["Waits until the next frame (the next time step), then carries on.", "wait next frame tick later"],
  Await: ["Waits until a signal is fired, then carries on.", "wait signal event until notify"],
  "std.signal.New": ["Makes a new signal for Await to wait on.", "signal create make"],
  "std.signal.Fire": ["Wakes everything waiting on a signal.", "signal fire notify wake"],
  Format: ["Builds text from a template: each {name} in it becomes an input, and a number or true/false given to it is written as text.",
           "string text template concat join interpolate message number to text"],
  Convert: ["Turns a value into another type, for example a number into text.", "cast change type to string text number"],
  Add: ["Adds two numbers: a + b.", "+ plus sum total"],
  Sub: ["Subtracts: a − b.", "- minus subtract difference"],
  Mul: ["Multiplies: a × b.", "* times multiply product combine compose rotation"],
  Scale: ["Multiplies every component of a vector by one number: v × s.", "* times scale vector stretch speed"],
  Div: ["Divides: a ÷ b. Whole numbers drop the remainder.", "/ divide quotient"],
  Rem: ["The remainder after dividing a by b (a mod b). Handy for even/odd checks.", "% mod modulo remainder even odd"],
  Min: ["The smaller of a and b.", "smallest minimum lower"],
  Max: ["The larger of a and b.", "largest maximum bigger"],
  Neg: ["Flips the sign: −value.", "negative minus opposite"],
  Abs: ["Distance from zero (absolute value).", "absolute positive"],
  Eq: ["True when a equals b.", "== equal same is"],
  Ne: ["True when a is different from b.", "!= not equal different"],
  Lt: ["True when a is less than b (a < b).", "< less smaller below"],
  Le: ["True when a is less than or equal to b (a ≤ b).", "<= at most"],
  Gt: ["True when a is greater than b (a > b).", "> greater bigger more above"],
  Ge: ["True when a is greater than or equal to b (a ≥ b).", ">= at least"],
  And: ["True only when a and b are both true.", "&& both"],
  Or: ["True when a or b (or both) is true.", "|| either"],
  Xor: ["True when exactly one of a and b is true.", "exclusive"],
  Not: ["Flips true to false and false to true.", "! opposite invert"],
  BitAnd: ["Bitwise AND of two whole numbers.", "& bits mask"],
  BitOr: ["Bitwise OR of two whole numbers.", "| bits"],
  BitXor: ["Bitwise XOR of two whole numbers.", "^ bits"],
  BitNot: ["Flips every bit of a whole number.", "~ bits"],
  Shl: ["Shifts bits left (multiplies by 2 for each step).", "<< shift bits"],
  Shr: ["Shifts bits right (divides by 2 for each step).", ">> shift bits"],
  GetLocal: ["Reads a local variable.", "variable get read value"],
  SetLocal: ["Stores a value in a local variable.", "variable set assign store save ="],
  GetVar: ["Reads a module variable, shared by every function.", "global variable get read"],
  SetVar: ["Stores a value in a module variable.", "global variable set assign store"],
  GetState: ["Reads a value this graph remembers between runs.", "state remember"],
  SetState: ["Stores a value this graph remembers between runs.", "state remember"],
  Exit: ["Leaves the macro through this output.", "exit leave"],
  Leave: ["Leaves the macro through this output at once, dropping everything the macro was still going to do, such as a loop's next pass.",
          "break leave stop exit early"],
  MakeArray: ["Makes a new array from the items wired into it.", "list array new create collection make"],
  ArrayGet: ["The item at a position in the array. Positions start at 0.", "list array item element index at get read"],
  ArrayLength: ["How many items the array holds.", "list array size count length"],
  ArrayAdd: ["Adds an item to the end of an array variable.", "list array append push add"],
  ArraySet: ["Replaces the item at a position in an array variable.", "list array replace change set"],
  ArrayInsert: ["Inserts an item at a position in an array variable.", "list array insert"],
  ArrayRemove: ["Removes the item at a position from an array variable.", "list array remove delete"],
  ArrayClear: ["Empties an array variable.", "list array clear empty reset"],
  MakeStruct: ["Builds a struct from a value for each of its fields.", "struct make build new create record fields"],
  BreakStruct: ["Splits a struct into its fields, one output per field.", "struct break split fields unpack parts"],
  GetField: ["Reads one field of a struct.", "struct field get read part member ."],
  WithField: ["A copy of a struct with one field changed. The original stays as it was.", "struct field set change update with copy"],
  MapFind: ["Looks a key up in a map: its value, and whether it was there.", "map dictionary lookup find get key value"],
  MapHas: ["True when the map has the key.", "map dictionary contains has key"],
  MapLength: ["How many entries the map holds.", "map dictionary size count length"],
  MapKeyAt: ["The key at a position, in the order keys were first added.", "map dictionary key index at"],
  MapValueAt: ["The value at a position, in the order keys were first added.", "map dictionary value index at"],
  MapSet: ["Stores a value under a key in a map variable, adding the key if it is new.", "map dictionary set put store add key value"],
  MapRemove: ["Removes a key from a map variable. 'removed' says whether it was there.", "map dictionary remove delete key"],
  MapClear: ["Empties a map variable.", "map dictionary clear empty reset"],
  SetHas: ["True when the set holds the item.", "set contains has member"],
  SetLength: ["How many items the set holds.", "set size count length"],
  SetAt: ["The item at a position, in the order items were added.", "set item index at"],
  SetAdd: ["Adds an item to a set variable. 'added' is false when it was already there.", "set add insert unique"],
  SetRemove: ["Removes an item from a set variable. 'removed' says whether it was there.", "set remove delete"],
  SetClear: ["Empties a set variable.", "set clear empty reset"],
  "std.flow.ForEach": [null, "each every item list array for"],
  "std.flow.ForEachMap": [null, "each every entry key value map dictionary for loop"],
  "host.Log": ["Prints a line of text in the console.", "print output say write console show"],
  "std.string.Concat": ["Joins two texts together.", "join append combine + text string"],
  "std.string.Length": ["How many bytes a text has.", "size count text string"],
  "std.string.Substring": ["Part of a text, from a start position for a length.", "slice part cut text"],
  "std.string.Find": ["Where a text appears inside another (−1 if it doesn't).", "search index position text"],
  "std.string.ToUpper": ["The text in CAPITAL letters.", "upper caps text"],
  "std.string.ToLower": ["The text in small letters.", "lower text"],
  "std.string.Repeat": ["The text repeated a number of times.", "repeat text"],
  "std.math.Sqrt": ["Square root.", "root √"],
  "std.math.Pow": ["a to the power of b.", "power exponent ^"],
  "std.math.Floor": ["Rounds down to a whole number.", "round down"],
  "std.math.Ceil": ["Rounds up to a whole number.", "round up"],
  "std.math.Round": ["Rounds to the nearest whole number.", "round nearest"],
  "std.math.Sin": ["Sine of an angle in radians.", "trig angle"],
  "std.math.Cos": ["Cosine of an angle in radians.", "trig angle"],
  "std.math.Tan": ["Tangent of an angle in radians.", "trig angle"],
  "std.math.Atan2": ["The angle (in radians) of the point (x, y).", "trig angle"],
  "std.math.Exp": ["e to the power of x.", "exponential"],
  "std.math.Log": ["Natural logarithm.", "ln logarithm"],
  "std.math.Lerp": ["Blends from a to b: t = 0 gives a, t = 1 gives b.", "blend mix interpolate"],
  "std.math.Pi": ["The number π.", "pi circle"],
  "std.flow.ForRange": [null, "loop for count each repeat range"],
  "std.flow.Repeat": [null, "loop times do again"],
  "std.flow.DoOnce": [null, "once first only"],
  "std.flow.DoN": [null, "limit times count"],
  "std.flow.FlipFlop": [null, "toggle alternate switch"],
};

export const CATEGORY_ORDER = ["Flow", "Time", "Call", "Variables", "Classes", "Delegates", "Structs", "Arrays", "Maps", "Sets", "Macro",
  "Math", "Compare", "Logic", "Bits"];

const has = (o: object, k: string | null | undefined) => k != null && Object.prototype.hasOwnProperty.call(o, k);

export class Item {
  constructor(public label: string, public kind: string, public symbol: string | null = null, public targs: string[] = [],
              public category = "Other", public description = "", public keywords = "") {}
  text(): string {
    return `${this.label} ${this.category} ${this.description} ${this.keywords}`.toLowerCase();
  }
}

const rpart = (s: string): [string, string] => {
  const i = s.lastIndexOf(".");
  return i < 0 ? ["", s] : [s.slice(0, i), s.slice(i + 1)];
};
const article = (name: string) => ("aeiou".includes(name.slice(0, 1).toLowerCase()) && name ? "an" : "a");

/** A one-sentence, beginner-level description of a node kind or call. */
export function describe(kind: string, symbol: string | null = null, idx: ModuleIndex | null = null, targs: string[] | null = null): string {
  if (symbol && idx !== null) {
    const g = idx.graphs.get(symbol) ?? idx.macros.get(symbol) ?? null;
    if (g !== null) {
      const doc = metaValue(g.meta, "doc");
      if (doc) return doc;
      if (kind === "Call") return `Runs the function ${symbol}.`;
    }
  }
  if (["New", "GetField", "SetField", "Cast"].includes(kind) && idx !== null) {
    const s = symbol || (targs && targs.length ? targs[0] : "");
    let [cls, fname] = rpart(s);
    cls = cls || symbol || (targs && targs.length ? targs[0] : "");
    if (idx.interfaces.has(cls) && kind === "Cast")
      return `Checks whether an object implements ${cls}: 'ok' says if it does, and 'result' is the object as a ${cls} (null when it does not).`;
    if (idx.classes.has(cls)) {
      const a = article(cls);
      return ({
        New: `Makes a new ${cls} object, with every field at its starting value.`,
        GetField: `Reads the field '${fname}' of ${a} ${cls} object.`,
        SetField: `Changes the field '${fname}' of ${a} ${cls} object. Everything that refers to the object sees the change.`,
        Cast: `Checks whether an object is ${a} ${cls}: 'ok' says if it is, and 'result' is the object as ${a} ${cls} (null when it is not).`,
      } as Record<string, string>)[kind];
    }
  }
  if (["MakeStruct", "BreakStruct", "GetField", "WithField"].includes(kind) && symbol) return describeStructNode(kind, symbol, idx);
  if (symbol && has(DESCRIBE, symbol) && DESCRIBE[symbol][0]) return DESCRIBE[symbol][0]!;
  if (kind === "Call" && symbol && idx !== null && idx.interfaces.has(rpart(symbol)[0]))
    return `Calls ${symbol} on any object that implements ${rpart(symbol)[0]}; the object's own class decides what runs.`;
  if (kind === "Call" && symbol) {
    const k = targs && targs.length ? `${symbol}#<${targs.join(", ")}>` : symbol;
    const spec = has(stdNatives(), k) ? stdNatives()[k] : undefined;
    return spec !== undefined && spec.doc ? spec.doc : `Calls ${symbol}.`;
  }
  return (has(DESCRIBE, kind) ? DESCRIBE[kind][0] : "") ?? "";
}

export function describeStructNode(kind: string, symbol: string, idx: ModuleIndex | null): string {
  const i = symbol.indexOf(".");
  const name = i < 0 ? symbol : symbol.slice(0, i), fname = i < 0 ? "" : symbol.slice(i + 1);
  const st = idx !== null ? idx.structs.get(name) ?? null : null;
  const doc = st !== null ? metaValue(st.meta, "doc") : null;
  const f = st !== null && fname ? st.field(fname) : null;
  const fdoc = f !== null ? metaValue(f.meta, "doc") : null;
  const a = article(name);
  const text = ({
    MakeStruct: `Builds ${a} ${name} from a value for each of its fields.`,
    BreakStruct: `Splits ${a} ${name} into its fields, one output per field.`,
    GetField: `Reads the field '${fname}' of ${a} ${name}.`,
    WithField: `A copy of ${a} ${name} with '${fname}' changed. The original stays as it was.`,
  } as Record<string, string>)[kind];
  const extra = (kind === "GetField" || kind === "WithField") && fdoc ? fdoc : doc;
  return extra ? `${text} ${extra}` : text;
}

function item(kind: string, label: string, cat: string, symbol: string | null = null, targs: string[] | null = null,
              idx: ModuleIndex | null = null): Item {
  const k = symbol !== null && has(DESCRIBE, symbol) ? symbol : kind;
  const words = has(DESCRIBE, k) ? DESCRIBE[k][1] : "";
  return new Item(label, kind, symbol, [...(targs ?? [])], cat, describe(kind, symbol, idx, targs), words);
}

/** The map and set types the module uses: [[K, V][], T[], every container type]. */
export function containerTypes(g: Graph, idx: ModuleIndex): [[string, string][], string[], string[]] {
  const seen: string[] = [];
  const tys: string[] = [];
  for (const x of [g, ...idx.graphs.values()])
    for (const p of [...x.params, ...x.result_list, ...x.locals, ...x.states]) tys.push(p.type);
  for (const v of idx.vars.values()) tys.push(v.type);
  for (const st of idx.structs.values()) for (const f of st.fields) tys.push(f.type);
  const maps: [string, string][] = [], sets: string[] = [];
  const walk = (ty: string): void => {
    if (seen.includes(ty)) return;
    seen.push(ty);
    const kv = mapTypes(ty), el = setElem(ty), ar = arrayElem(ty);
    if (kv !== null) {
      maps.push(kv);
      walk(kv[1]);
    } else if (el !== null) sets.push(el);
    else if (ar !== null) walk(ar);
  };
  for (const ty of tys) walk(ty);
  const uniq = <T>(xs: T[]) => [...new Map(xs.map((x) => [key(x), x])).values()];
  return [sortedBy(uniq(maps)), sortedBy(new Set(sets)), sortedBy(seen.filter(isContainer))];
}

export function items(g: Graph, idx: ModuleIndex): Item[] {
  const out: Item[] = [];
  out.push(item("Branch", "Branch (if / else)", "Flow"));
  out.push(item("Sequence", "Sequence (do in order)", "Flow"));
  if (g.kind !== "macro") out.push(item("Return", "Return", "Flow"));
  if (!g.nodes.some((n) => n.kind === "Entry")) out.push(item("Entry", "Entry", "Flow"));
  const values = typeChoices("any", idx);
  for (const t of values) out.push(item("Select", `Select#<${t}>`, "Flow", null, [t]));
  for (const t of typeChoices("switch", idx)) out.push(item("Switch", `Switch#<${t}>`, "Flow", null, [t]));
  for (const t of ["exec", ...values]) out.push(item("Reroute", `Reroute#<${t}>`, "Flow", null, [t]));
  for (const k of sortedBy(Object.keys(STATIC_KINDS))) {
    const [cat, , tps] = STATIC_KINDS[k];
    if (k === "Convert" || k === "Select" || k === "Branch") continue;
    if (tps.length) for (const t of typeChoices(tps[0], idx)) out.push(item(k, `${k}#<${t}>`, cat, null, [t]));
    else out.push(item(k, k, cat));
  }
  const convertible = typeChoices("convertible", idx);
  for (const f of convertible)
    for (const t of convertible)
      if (canConvert(f, t, idx)) {
        const to = t === "string" ? "text" : t === "f32" || t === "f64" ? "decimal" : t === "bool" ? "true/false"
          : idx.enums.has(t) || t === "vec2" || t === "vec3" ? `a ${t}` : "whole number";
        out.push(item("Convert", `Convert#<${f}, ${t}> (to ${to})`, "Math", null, [f, t]));
      }
  out.push(item("Format", 'Format "{value}" (text from a template)', "Text", "{value}"));
  for (const l of sortedBy(g.locals, (l) => l.name)) {
    out.push(item("GetLocal", `Get ${l.name}`, "Variables", l.name));
    out.push(item("SetLocal", `Set ${l.name}`, "Variables", l.name));
  }
  for (const st of sortedBy(g.states, (s) => s.name)) {
    out.push(item("GetState", `Get state ${st.name}`, "Variables", st.name));
    out.push(item("SetState", `Set state ${st.name}`, "Variables", st.name));
  }
  for (const v of sortedBy(idx.vars.keys())) {
    out.push(item("GetVar", `Get ${v}`, "Variables", v));
    out.push(item("SetVar", `Set ${v}`, "Variables", v));
  }
  for (const c of sortedBy(idx.consts.keys())) out.push(item("GetVar", `Get ${c} (const)`, "Variables", c));
  for (const [name, fg] of sortedBy(idx.graphs, (e) => e[0])) if (fg.kind === "func") out.push(item("Call", `Call ${name}`, "Call", name, null, idx));
  if (g.owner && idx.classes.has(g.owner) && idx.classes.get(g.owner)!.base &&
      idx.findMethod(idx.classes.get(g.owner)!.base!, g.short_name) !== null)
    out.push(item("CallParent", `CallParent ${g.short_name}`, "Call", g.short_name, null, idx));
  for (const q of sortedBy(idx.externs.keys())) out.push(item("Call", `Call ${q}`, "Call", q, null, idx));
  for (const q of sortedBy(Object.keys(stdNatives()))) {
    const at = q.indexOf("#<");
    const sym = at < 0 ? q : q.slice(0, at), targs = at < 0 ? "" : q.slice(at + 2);
    out.push(item("Call", `Call ${q}`, "Call", sym, targs ? targs.slice(0, -1).split(",").map((t) => t.trim()) : null, idx));
  }
  for (const name of sortedBy(idx.classes.keys())) {
    out.push(item("New", `New ${name}`, "Classes", name, null, idx));
    out.push(item("Cast", `Cast to ${name}`, "Classes", name, null, idx));
    for (const [, f] of idx.classFields(name)) {
      const sym = `${name}.${f.name}`;
      out.push(item("GetField", `Get ${sym}`, "Classes", sym, null, idx));
      out.push(item("SetField", `Set ${sym}`, "Classes", sym, null, idx));
    }
  }
  for (const name of sortedBy(idx.interfaces.keys())) {
    out.push(item("Cast", `Cast to ${name}`, "Classes", name, null, idx));
    for (const m of idx.interfaces.get(name)!.methods) out.push(item("Call", `Call ${name}.${m.name}`, "Call", `${name}.${m.name}`, null, idx));
  }
  if (idx.classes.size) out.push(item("IsValid", "IsValid (not null)", "Classes", null, null, idx));
  for (const name of sortedBy(idx.classes.keys()))
    for (const d of idx.classes.get(name)!.dispatchers)
      for (const k of ["Bind", "Unbind", "Broadcast"]) out.push(item(k, `${k} ${name}.${d.name}`, "Delegates", `${name}.${d.name}`, null, idx));
  for (const [name, fg] of sortedBy(idx.graphs, (e) => e[0]))
    if (fg.kind === "event" || !fg.hasAttr("latent")) out.push(item("CreateDelegate", `Delegate of ${name}`, "Delegates", name, null, idx));
  const dtypes = new Set<string>();
  for (const gr of [...idx.graphs.values(), g])
    for (const p of [...gr.params, ...gr.result_list, ...gr.locals]) if (p.type.startsWith("delegate#<")) dtypes.add(p.type);
  for (const t of sortedBy(dtypes)) out.push(item("Invoke", `Invoke#<${t}>`, "Delegates", null, [t], idx));
  for (const name of sortedBy(idx.structs.keys())) {
    out.push(item("MakeStruct", `Make ${name}`, "Structs", name, null, idx));
    out.push(item("BreakStruct", `Break ${name}`, "Structs", name, null, idx));
    for (const f of idx.structs.get(name)!.fields) {
      const sym = `${name}.${f.name}`;
      out.push(item("GetField", `Get ${sym}`, "Structs", sym, null, idx));
      out.push(item("WithField", `With ${sym} (changed copy)`, "Structs", sym, null, idx));
    }
  }
  for (const t of values) {
    out.push(item("MakeArray", `MakeArray#<${t}>`, "Arrays", null, [t]));
    out.push(item("ArrayGet", `ArrayGet#<${t}>`, "Arrays", null, [t]));
    out.push(item("ArrayLength", `ArrayLength#<${t}>`, "Arrays", null, [t]));
  }
  let places: [string, string][] = [...g.locals.map((l) => [l.name, l.type] as [string, string]),
    ...[...idx.vars.values()].map((v) => [v.name, v.type] as [string, string])];
  for (const c of sortedBy(idx.classes.keys()))
    for (const [owner, f] of idx.classFields(c)) if (owner === c) places.push([`${c}.${f.name}`, f.type]);
  places = sortedBy(places);
  for (const [name, ty] of places) {
    const elem = arrayElem(ty);
    if (elem === null) continue;
    for (const kind of ["ArrayAdd", "ArraySet", "ArrayInsert", "ArrayRemove", "ArrayClear"]) out.push(item(kind, `${kind} ${name}`, "Arrays", name, [elem]));
  }
  const [maps, sets, containers] = containerTypes(g, idx);
  for (const t of containers) for (const kind of ["Eq", "Ne"]) out.push(item(kind, `${kind}#<${t}>`, STATIC_KINDS[kind][0], null, [t]));
  for (const [k, v] of maps) {
    for (const kind of Object.keys(MAP_PURE)) out.push(item(kind, `${kind}#<${k}, ${v}>`, "Maps", null, [k, v]));
    if (idx.macros.has("std.flow.ForEachMap"))
      out.push(item("Macro", `Macro std.flow.ForEachMap#<${k}, ${v}>`, "Macro", "std.flow.ForEachMap", [k, v], idx));
  }
  for (const t of sets) for (const kind of Object.keys(SET_PURE)) out.push(item(kind, `${kind}#<${t}>`, "Sets", null, [t]));
  for (const [name, ty] of places) {
    const kv = mapTypes(ty), el = setElem(ty);
    if (kv !== null) for (const kind of Object.keys(MAP_MUTATORS)) out.push(item(kind, `${kind} ${name}`, "Maps", name, [...kv]));
    else if (el !== null) for (const kind of Object.keys(SET_MUTATORS)) out.push(item(kind, `${kind} ${name}`, "Sets", name, [el]));
  }
  for (const name of sortedBy(idx.macros.keys())) {
    if (name === g.name) continue;
    const tps = idx.macros.get(name)!.tparams;
    if (tps.length > 1) continue;
    if (tps.length) for (const t of values) out.push(item("Macro", `Macro ${name}#<${t}>`, "Macro", name, tps.map(() => t), idx));
    else out.push(item("Macro", `Macro ${name}`, "Macro", name, null, idx));
  }
  if (g.kind === "macro")
    for (const r of g.result_list)
      if (r.type === "exec") {
        out.push(item("Exit", `Exit ${r.name}`, "Macro", r.name));
        out.push(item("Leave", `Leave ${r.name}`, "Macro", r.name));
      }
  return out;
}

/** The pin of `it` that a wire from (direction, ptype) would connect to, or null. */
export function compatible(it: Item, g: Graph, idx: ModuleIndex, direction: string, ptype: string): string | null {
  const sig = signature(new Node("__probe", it.kind, it.symbol, it.targs), g, idx);
  if (sig.error) return null;
  for (const p of direction === "out" ? sig.inputs : sig.outputs) if (p.type === ptype) return p.name;
  return null;
}

export function rank(allItems: Item[], query: string): Item[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const scored: [number, number, string, Item][] = [];
  for (const it of allItems) {
    const text = it.text();
    if (!words.every((w) => text.includes(w))) continue;
    const label = it.label.toLowerCase();
    let score = 0;
    if (words.length) {
      const q = query.toLowerCase().trim();
      if (label.startsWith(q)) score += 100;
      else if (label.split(/[^a-z0-9]+/).some((part) => part.startsWith(words[0]))) score += 50;
      const kw = it.keywords.split(/\s+/);
      score += words.filter((w) => kw.includes(w)).length * 10;
    }
    if (it.label.includes("<i32>")) score += 3;
    const cat = CATEGORY_ORDER.includes(it.category) ? CATEGORY_ORDER.indexOf(it.category) : 99;
    scored.push([-score, cat, it.label, it]);
  }
  return sortedBy(scored, (x) => [x[0], x[1], x[2]]).map((x) => x[3]);
}
