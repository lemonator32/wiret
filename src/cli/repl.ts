/** `wiret repl`: an interactive session in a virtual `Main`.
 *
 * The session is a module: the declarations entered so far, and a `Main` made of the locals and
 * exec statements entered so far. Each input rebuilds that module, compiles it and runs `Main`
 * again from the start, in deterministic mode, and prints only the output lines the earlier
 * inputs did not already print. An input that does not compile or that faults is dropped, so the
 * session always compiles. An expression is evaluated by a copy of `Main` that returns it.
 *
 * `Session` does the work and writes through two callbacks, so the tests drive it without a
 * terminal; `repl()` connects it to readline. */
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { Diag } from "../core/checker.js";
import { compileModule } from "../core/compiler.js";
import { disassemble } from "../core/disasm.js";
import { Graph, Lit, Module, PinRef } from "../core/model.js";
import { parse, ParseError } from "../core/parser.js";
import { fmtGraph, printModule } from "../core/printer.js";
import { ModuleIndex, placeType, signature } from "../core/registry.js";
import { formatValue, runFunction, ValueError } from "../core/runner.js";
import { VM, WiretError } from "../core/vm.js";
import { palette } from "../core/webapi.js";

const PRELUDE = "extern func host.Log(message: string) -> ()";
const DECL_WORDS = new Set(["func", "struct", "enum", "var", "const", "extern", "macro", "class", "interface", "impl",
  "use", "event"]);
const STMT_WORDS = new Set(["exec", "goto", "node", "!"]);

/** What the session holds; a snapshot of it is what `:undo` goes back to. */
interface State { decls: string[]; locals: string[]; stmts: string[]; shown: number }

export interface Io { out(line: string): void; err(line: string): void }

class InputError extends Error {}

const indent = (text: string, by: string) => text.split("\n").map((l) => (l ? by + l : l)).join("\n");

/** Whether `text` needs more lines: an open bracket, or only decorator lines so far. */
export function incomplete(text: string): boolean {
  let depth = 0, quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === "\\") i++;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
  }
  if (depth > 0 || quoted) return true;
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("//"));
  return lines.length > 0 && lines.every((l) => l.startsWith("@"));
}

/** The first word after any decorator and comment lines. */
function leadWord(text: string): string {
  for (const l of text.split("\n").map((x) => x.trim())) {
    if (!l || l.startsWith("@") || l.startsWith("//")) continue;
    if (l.startsWith("!")) return "!";
    return /^[A-Za-z_][\w]*/.exec(l)?.[0] ?? "";
  }
  return "";
}

/** `[kind, name]` of a declaration, so entering `func Square` again replaces the old one. */
function declKey(text: string): string | null {
  for (const l of text.split("\n").map((x) => x.trim())) {
    if (!l || l.startsWith("@") || l.startsWith("//")) continue;
    const m = /^(?:extern\s+)?(func|struct|enum|var|const|macro|class|interface|event)\s+([\w.]+)/.exec(l);
    return m ? `${m[1]} ${m[2]}` : null;
  }
  return null;
}

const localName = (decl: string) => /^local\s+([A-Za-z_]\w*)/.exec(decl)?.[1] ?? null;

export class Session {
  private s: State = { decls: [PRELUDE], locals: [], stmts: [], shown: 0 };
  private history: State[] = [];
  private warned = new Set<string>();

  constructor(private io: Io, private fuel = 50_000_000) {}

  /** The module text for `st`, with `Main` returning `result` (a type and an expression) if given.
   * Each input is one block of a Sequence, so an input that ends in blocks of its own (a Branch,
   * a loop) does not stop the inputs after it from running. */
  source(st: State = this.s, result: [string, string] | null = null): string {
    const body: string[] = [...st.locals.map((l) => indent(l, "  "))];
    if (body.length) body.push("");
    body.push("  exec Entry()");
    const blocks = [...st.stmts];
    if (result) blocks.push(`exec Return(\n  .value <- ${indent(result[1], "  ").trimStart()}\n)`);
    if (blocks.length) {
      const parts = blocks.map((b, i) => `${i ? "}" : ""}.then[${i}] -> {\n${indent(b, "    ")}\n  `);
      body.push(`  exec Sequence#count<${blocks.length}>()${parts.join("")}}`);
    }
    const results = result ? ` -> (value: ${result[0]})` : "";
    return `wiret 1\nmodule repl\n\n${st.decls.join("\n\n")}\n\nfunc Main()${results} {\n${body.join("\n")}\n}\n`;
  }

  /** Handle one complete input. Returns false for `:quit`. */
  submit(input: string): boolean {
    const text = input.replace(/\r\n/g, "\n").trim();
    if (!text) return true;
    try {
      if (text.startsWith(":")) return this.command(text);
      this.enter(text);
    } catch (e) {
      if (!(e instanceof InputError)) throw e;
      this.io.err(e.message);
    }
    return true;
  }

  private enter(text: string): void {
    const word = leadWord(text);
    const st = this.s;
    if (DECL_WORDS.has(word)) {
      const key = declKey(text);
      const at = key === null ? -1 : st.decls.findIndex((d) => declKey(d) === key);
      const decls = at < 0 ? [...st.decls, text] : st.decls.map((d, i) => (i === at ? text : d));
      this.attempt({ ...st, decls });
    } else if (word === "local") {
      const name = localName(text);
      if (name && this.localNames().includes(name)) throw new InputError(`local '${name}' already exists`);
      this.attempt({ ...st, locals: [...st.locals, text] });
    } else if (STMT_WORDS.has(word)) {
      this.attempt({ ...st, stmts: [...st.stmts, this.sugar(text)] });
    } else {
      const assign = /^([A-Za-z_]\w*)\s*=(?!=)\s*([\s\S]+)$/.exec(text);
      if (assign) this.assign(assign[1], assign[2]);
      else this.expression(text);
    }
  }

  private localNames(st: State = this.s): string[] {
    return st.locals.map(localName).filter((n): n is string => n !== null);
  }

  private varNames(): string[] {
    return this.s.decls.map((d) => /^var\s+([A-Za-z_]\w*)/m.exec(d)?.[1]).filter((n): n is string => !!n);
  }

  /** A bare local or variable name means its value: as the whole input, and as a node's input
   * (`.a <- score`). A name that is also a node or parameter in scope is left alone. */
  private sugar(expr: string): string {
    const locals = new Set(this.localNames()), vars = new Set(this.varNames());
    const read = (name: string) => (locals.has(name) ? `GetLocal ${name}()` : vars.has(name) ? `GetVar ${name}()` : null);
    const e = expr.trim();
    if (/^[A-Za-z_]\w*$/.test(e)) return read(e) ?? e;
    return e.replace(/(<-\s*)([A-Za-z_]\w*)(?=\s*(?:[,)]|$))/gm, (all, arrow: string, name: string) => {
      const r = read(name);
      return r ? arrow + r : all;
    });
  }

  /** `x = expr`: set a local or variable, declaring the local from the value's type if it is new. */
  private assign(name: string, rhs: string): void {
    const expr = this.sugar(rhs);
    const st = this.s;
    const set = (kind: string) => `exec ${kind} ${name}(\n  .value <- ${indent(expr, "  ").trimStart()}\n)`;
    if (this.localNames().includes(name)) return void this.attempt({ ...st, stmts: [...st.stmts, set("SetLocal")] });
    if (this.varNames().includes(name)) return void this.attempt({ ...st, stmts: [...st.stmts, set("SetVar")] });
    const [type] = this.typeOf(expr);
    this.attempt({ ...st, locals: [...st.locals, `local ${name}: ${type}`], stmts: [...st.stmts, set("SetLocal")] });
  }

  /** The type of `expr`, and whether it is a node with an exec input (a statement, not a value). */
  private typeOf(expr: string): [string, boolean] {
    let m: Module;
    try {
      m = parse(this.source(this.s, ["i32", expr]));
    } catch (e) {
      if (e instanceof ParseError) throw new InputError(`error: ${e.msg}`);
      throw e;
    }
    const g = m.graph("Main")!;
    const idx = new ModuleIndex(m);
    const ret = g.nodes.find((n) => n.kind === "Return");
    const v = ret?.binding("value")?.value;
    if (v instanceof Lit) {
      const ty = ({ int: v.suffix || "i32", float: v.suffix || "f64", bool: "bool", string: "string" } as Record<string, string>)[v.kind]
        ?? (v.kind === "enum" ? String(v.value).split(".").slice(0, -1).join(".") : null);
      if (ty) return [ty, false];
    } else if (v instanceof PinRef) {
      const n = g.node(v.node);
      if (n === null) {
        const ty = placeType(v.node, g, idx);
        if (ty) return [ty, false];
        throw new InputError(`error: '${v.node}' is not a local, variable or node`);
      }
      const sig = signature(n, g, idx);
      const outs = sig.data_outs;
      const pin = v.pin ? sig.output(v.pin) : outs.length === 1 ? outs[0] : null;
      if (pin) return [pin.type, sig.exec_ins.length > 0];
      if (!outs.length) return ["()", sig.exec_ins.length > 0];
      throw new InputError(`error: ${n.kind} has ${outs.length} outputs; name one, as in (...).${outs[0].name}`);
    }
    throw new InputError("error: cannot tell the type of this value; declare a local for it first, as in\n" +
      "  local v: vec3\n  v = (0, 1, 0)");
  }

  /** Evaluate and print an expression; a node with an exec input runs as a statement instead. */
  private expression(text: string): void {
    const expr = this.sugar(text);
    const stmt = `exec ${expr}`;
    let type: string, isStmt: boolean;
    try {
      [type, isStmt] = this.typeOf(expr);
    } catch (e) {
      // not a value: maybe a statement written without `exec`
      if (!(e instanceof InputError)) throw e;
      if (this.compiles({ ...this.s, stmts: [...this.s.stmts, stmt] })) {
        this.attempt({ ...this.s, stmts: [...this.s.stmts, stmt] });
        return;
      }
      throw e;
    }
    if (isStmt || type === "()") return void this.attempt({ ...this.s, stmts: [...this.s.stmts, stmt] });
    const res = this.execute(this.source(this.s, [type, expr]));
    if (res === null) return;
    this.io.out(formatValue(type, res.values[0], res.idx));
  }

  private compiles(st: State): boolean {
    try {
      return compileModule(parse(this.source(st)), null, false, false, null, true).ok;
    } catch (e) {
      if (e instanceof ParseError) return false;
      throw e;
    }
  }

  /** Compile and run `source`'s Main, printing diagnostics and the new output lines. Null on failure. */
  private execute(source: string): { values: any[]; idx: ModuleIndex; lines: number } | null {
    let m: Module;
    try {
      m = parse(source);
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      this.io.err(`error: ${e.msg}`);
      return null;
    }
    const r = compileModule(m, source, false, false, null, true);
    for (const d of r.diags) {
      const line = this.diagLine(d);
      if (d.severity === "error") this.io.err(line);
      else if (!this.warned.has(line)) {
        this.warned.add(line);
        this.io.err(line);
      }
    }
    if (!r.ok) return null;
    const output: string[] = [];
    const vm = new VM({ fuel: this.fuel, deterministic: true, output: (l) => output.push(l) });
    try {
      const values = runFunction(vm, vm.load(r.wbc!), "Main", []);
      for (const l of output.slice(this.s.shown)) this.io.out(l);
      return { values, idx: new ModuleIndex(m), lines: output.length };
    } catch (e) {
      if (!(e instanceof WiretError || e instanceof ValueError)) throw e;
      for (const l of output.slice(this.s.shown)) this.io.out(l);
      this.io.err(e.toString().replace(/^Error: /, ""));
      return null;
    } finally {
      vm.free();
    }
  }

  /** A diagnostic without the node ids of the generated Main, which mean nothing to the user. */
  private diagLine(d: Diag): string {
    if (d.graph !== "Main") return d.toString();
    return `${d.severity} ${d.code}: ${d.pin ? `.${d.pin}: ` : ""}${d.message}`;
  }

  /** Make `next` the session if it compiles and runs. */
  private attempt(next: State): boolean {
    const res = this.execute(this.source(next));
    if (res === null) return false;
    this.history.push(this.s);
    this.s = { ...next, shown: res.lines };
    return true;
  }

  /** The session as a canonical .wiret file. */
  text(): string {
    return printModule(parse(this.source()));
  }

  /** Add a file's declarations, and append its Main's body to this Main. */
  load(file: string): boolean {
    let m: Module;
    try {
      m = parse(readFileSync(file, "utf8"));
    } catch (e) {
      if (e instanceof ParseError) {
        this.io.err(`${file}:${e.line}:${e.col}: error: ${e.msg}`);
        return false;
      }
      throw e;
    }
    const idx = new ModuleIndex(m);
    const main = m.graph("Main");
    const locals: string[] = [], stmts: string[] = [];
    if (main && !main.owner) {
      const lines = fmtGraph(main, idx);
      const open = lines.findIndex((l) => /^func Main\(\)/.test(l));
      const body = lines.slice(open + 1, lines.lastIndexOf("}")).map((l) => l.slice(2));
      const entry = body.findIndex((l) => /^exec Entry(\{.*\})?\(\)$/.test(l));
      let from = entry;
      while (from > 0 && body[from - 1].startsWith("@")) from--;
      for (const l of body.slice(0, from)) if (l.startsWith("local ")) locals.push(l);
      const rest = body.slice(entry + 1).join("\n").trim();
      if (rest) stmts.push(rest);
      m.items = m.items.filter((it) => it !== main);
    }
    const printed = printModule(m).split("\n");
    const decl = printed.slice(printed.findIndex((l) => l.startsWith("module ")) + 1).join("\n").trim();
    const st = this.s;
    const have = new Set(decl.split("\n"));
    const decls = st.decls.filter((d) => !have.has(d));
    const clash = locals.map(localName).find((n) => n && this.localNames().includes(n));
    if (clash) {
      this.io.err(`${file}: Main's local '${clash}' is already a local of this session`);
      return false;
    }
    return this.attempt({ ...st, decls: decl ? [...decls, decl] : decls, locals: [...st.locals, ...locals],
      stmts: [...st.stmts, ...stmts] });
  }

  private command(text: string): boolean {
    const [cmd, ...rest] = text.split(/\s+/);
    const arg = text.slice(cmd.length).trim();
    switch (cmd) {
      case ":q": case ":quit": case ":exit":
        return false;
      case ":h": case ":help": case ":?":
        this.io.out(HELP);
        break;
      case ":show":
        this.io.out(this.text().trimEnd());
        break;
      case ":save":
        if (!arg) throw new InputError("usage: :save FILE");
        writeFileSync(arg, this.text(), "utf8");
        this.io.out(`wrote ${arg}`);
        break;
      case ":load":
        if (!arg) throw new InputError("usage: :load FILE");
        if (!existsSync(arg)) throw new InputError(`cannot open ${arg}`);
        this.load(arg);
        break;
      case ":type": {
        if (!arg) throw new InputError("usage: :type EXPR");
        const [ty, isStmt] = this.typeOf(this.sugar(arg));
        this.io.out(isStmt ? `${ty} (a statement: it has an exec input)` : ty);
        break;
      }
      case ":dis": {
        const r = compileModule(parse(this.source()), null, false, true, null, true);
        this.io.out(disassemble(r.wbc!).trimEnd());
        break;
      }
      case ":nodes": {
        const found = palette(this.source(), "Main", arg);
        const items = found?.items.slice(0, 20) ?? [];
        if (!items.length) this.io.out("(no nodes match)");
        for (const it of items) this.io.out(`${it.label}${it.description ? "  " + it.description.split("\n")[0] : ""}`);
        if (found && found.total > items.length && !arg) this.io.out(`... ${found.total - items.length} more; :nodes WORD narrows the list`);
        break;
      }
      case ":undo": {
        const prev = this.history.pop();
        if (!prev) throw new InputError("nothing to undo");
        this.s = prev;
        this.io.out("undone");
        break;
      }
      case ":reset":
        this.history.push(this.s);
        this.s = { decls: [PRELUDE], locals: [], stmts: [], shown: 0 };
        this.io.out("session cleared (:undo brings it back)");
        break;
      default:
        throw new InputError(`unknown command ${cmd}; :help lists them`);
    }
    void rest;
    return true;
  }
}

const HELP = `Each line runs in a virtual Main, after the lines before it. Main runs again from the
start each time, and only new output is printed.

  1 + 2 is not Wiret; values come from nodes:
    Add#<i32>(.a <- 1, .b <- 2)        an expression: prints its value
    Call host.Log(.message <- "hi")   a node with an exec input: runs as a statement
    exec Branch(.cond <- true).then -> { ... }
    score = 10                         set a local, declaring it on first use
    score                              a local's value
    local name: string                 declare a local
    @pure
    func Square(x: i32) -> (result: i32) { ... }
                                       a declaration (entering it again replaces it)

  :type EXPR     the type of an expression     :nodes [WORD]  search the node registry
  :show          the session as a .wiret file  :save FILE     write it to FILE
  :load FILE     add a file's declarations and run its Main
  :dis           disassemble the session       :undo          drop the last input
  :reset         start over                    :quit          leave (or Ctrl+D)

An open bracket continues on the next line; an empty line ends a stuck input.`;

/** The interactive loop. Returns the exit code. */
export async function repl(files: string[], fuel?: number): Promise<number> {
  const tty = !!process.stdin.isTTY;
  const io: Io = { out: (l) => process.stdout.write(l + "\n"), err: (l) => process.stderr.write(l + "\n") };
  const session = new Session(io, fuel);
  for (const f of files) if (!session.load(f)) return 1;
  const histFile = path.join(homedir(), ".wiret_history");
  let history: string[] = [];
  if (tty) {
    try {
      history = readFileSync(histFile, "utf8").split("\n").filter(Boolean).reverse().slice(0, 1000);
    } catch { /* no history yet */ }
    io.out(`wiret repl: type :help for help, :quit to leave`);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: tty, history, historySize: 1000 });
  let buf: string[] = [];
  const prompt = () => {
    if (!tty) return;
    rl.setPrompt(buf.length ? "...> " : "wiret> ");
    rl.prompt();
  };
  return new Promise((resolve) => {
    rl.on("line", (line) => {
      if (buf.length && !line.trim() && buf.at(-1)?.trim() === "") {
        // two empty lines: give up on the input
        buf = [];
        io.err("(input dropped)");
        return prompt();
      }
      buf.push(line);
      const text = buf.join("\n");
      if (incomplete(text)) return prompt();
      buf = [];
      if (tty && text.trim()) {
        try {
          appendFileSync(histFile, text.replace(/\n/g, " ") + "\n");
        } catch { /* history is a convenience */ }
      }
      if (!session.submit(text)) return rl.close();
      prompt();
    });
    rl.on("SIGINT", () => {
      if (buf.length) {
        buf = [];
        process.stdout.write("\n");
      } else process.stdout.write("\n(:quit or Ctrl+D to leave)\n");
      prompt();
    });
    rl.on("close", () => {
      if (buf.length && buf.join("").trim()) session.submit(buf.join("\n"));
      if (tty) process.stdout.write("\n");
      resolve(0);
    });
    prompt();
  });
}
