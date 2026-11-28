/** wiret: the Wiret command-line toolchain (spec section 7), on Node. `bin.ts` starts it;
 * `COMMANDS` below is the command list `wiret --help` prints. */
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { check, hasErrors } from "../core/checker.js";
import { compileModule } from "../core/compiler.js";
import { disassemble } from "../core/disasm.js";
import { rawDiff, semanticDiff, viewFlow } from "../core/diff.js";
import { applyRequest } from "../core/edit.js";
import { assignIds, attachRetired, FileSystem, findProject as findProjectFs, idsOf, parseRegistry, Project, Retired, retiredBetween } from "../core/ids.js";
import { Conflict, mergeModules, MergeResult } from "../core/merge.js";
import { Module } from "../core/model.js";
import { convertComments } from "../core/ops.js";
import { parse, ParseError } from "../core/parser.js";
import { layoutHash, printModule, semanticHash } from "../core/printer.js";
import { registryJson } from "../core/registry.js";
import { formatResults, parseArgsFor, runFunction, ValueError } from "../core/runner.js";
import { init as initRuntime, moduleCapabilities, replay, ReplayMismatch, VM, WiretError } from "../core/vm.js";
import { sortedBy } from "../core/pyutil.js";
import pkg from "../../package.json" with { type: "json" };
import { repl } from "./repl.js";
import { explain, projectFiles, scaffold } from "./project.js";

export const VERSION: string = pkg.version;

/** [name, synopsis after the name, what it does], in the order `wiret --help` lists them. */
const COMMANDS: [string, string, string][] = [
  ["run", "[--grant CAP]... [--sandbox] [--deterministic [--record LOG.json]] [--fuel N] FILE [FUNC [ARGS...]]",
    "compile FILE.wiret (or load FILE.wbc) and run FUNC, Main by default"],
  ["repl", "[--fuel N] [FILE...]", "interactive session: each line runs in a virtual Main (:help inside)"],
  ["build", "FILE [-o OUT.wbc] [--no-source] [--export-all]", "compile and verify to bytecode"],
  ["check", "[--json] FILE", "diagnostics (with E0140/W0202 inside a project)"],
  ["fmt", "[--check] [--assign-ids] [--convert-comments | --drop-comments] FILE", "rewrite in canonical form"],
  ["explain", "[CODE...]", "what a diagnostic code (E0310) or runtime status (WR_ERR_FUEL) means; all codes without one"],
  ["new", "DIR [--no-git]", "create a project: wiret.toml, src/NAME/main.wiret, and the Git setup"],
  ["init", "[DIR] [--no-git]", "make an existing directory a project, keeping files already there"],
  ["dis", "FILE.wbc", "disassemble with node ids"],
  ["verify", "FILE.wbc", "run only the verifier"],
  ["replay", "FILE LOG.json", "rerun a recorded deterministic run and compare"],
  ["caps", "FILE", "the capabilities a module needs (wr.caps)"],
  ["hash", "FILE", "semantic and layout hashes"],
  ["view", "--flow FILE", "reading view in flow order"],
  ["schema", "--json", "the node registry"],
  ["diff", "[--raw] A B", "node-aware semantic diff in flow order"],
  ["merge", "BASE OURS THEIRS [-o OUT]", "keyed three-way merge (the Git merge driver)"],
  ["init-git", "", "set up the merge driver, textconv and wiret.ids union"],
  ["edit", "FILE REQUEST.json|- [--dry-run]", "apply an editing-protocol request (section 7.2)"],
  ["ids", "--check BASE[..HEAD] [--record] [--project DIR]", "check that deleted ids are retired and never reused"],
];

const nodeFs: FileSystem = {
  exists: (p) => existsSync(p),
  readText: (p) => readFileSync(p, "utf8"),
  writeText: (p, t) => writeFileSync(p, t, "utf8"),
  appendText: (p, t) => appendFileSync(p, t, "utf8"),
  join: (...parts) => path.join(...parts),
  dirname: (p) => path.dirname(p),
  abspath: (p) => path.resolve(p),
};
const findProject = (p: string) => findProjectFs(nodeFs, p);

const out = (s: string) => process.stdout.write(s);
const err = (s: string) => process.stderr.write(s + "\n");

class Exit extends Error {
  constructor(public code: number) {
    super(`exit ${code}`);
  }
}

function load(file: string): [Module, string] {
  const text = readFileSync(file, "utf8");
  try {
    return [parse(text), text];
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    err(`${file}:${e.line}:${e.col}: error: ${e.msg}`);
    throw new Exit(2);
  }
}

function build(file: string, output: string | null = null, embed = true, exportAll = false): [Module, string, Uint8Array] {
  const [m, text] = load(file);
  const r = compileModule(m, text, embed, false, findProject(file), exportAll);
  for (const d of r.diags) err(d.toString());
  if (!r.ok) throw new Exit(1);
  const o = output || file.replace(/\.[^./\\]*$/, "") + ".wbc";
  writeFileSync(o, r.wbc!);
  return [m, o, r.wbc!];
}

function git(args: string[], cwd: string, okFail = false): string | null {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.error || r.status !== 0) {
    if (okFail) return null;
    throw new GitError(r.stderr?.trim() || `git ${args.join(" ")} failed`);
  }
  return r.stdout;
}

class GitError extends Error {}

function initGit(dir = process.cwd()): number {
  let top: string;
  try {
    top = git(["rev-parse", "--show-toplevel"], dir)!.trim();
  } catch {
    err("not inside a Git repository");
    return 2;
  }
  // The script node started: cli/wiret.js when installed, src/cli/bin.ts from source.
  const me = `"${process.execPath}" "${path.resolve(process.argv[1])}"`.replace(/\\/g, "/");
  const runner = me.endsWith('.ts"') ? `npx tsx ${me.split(" ").slice(1).join(" ")}` : me;
  for (const [k, v] of [["merge.wiret.name", "Wiret keyed merge (wiret merge)"], ["merge.wiret.driver", `${runner} merge %O %A %B`],
                        ["diff.wiret.textconv", `${runner} view --flow`]])
    git(["config", k, v], top);
  const p = path.join(top, ".gitattributes");
  const have = existsSync(p) ? readFileSync(p, "utf8") : "";
  const want = ["*.wiret merge=wiret diff=wiret", "wiret.ids merge=union"];
  const add = want.filter((w) => !have.split(/\r?\n/).includes(w));
  if (add.length) appendFileSync(p, (!have || have.endsWith("\n") ? "" : "\n") + add.join("\n") + "\n");
  out(`configured the wiret merge driver and diff textconv in ${top}\n`);
  for (const w of add) out(`  .gitattributes: ${w}\n`);
  return 0;
}

/** A side does not parse: fall back to a plain line merge (`git merge-file`). */
function textMerge(base: string, ours: string, theirs: string): MergeResult {
  const d = mkdtempSync(path.join(tmpdir(), "wiret-merge-"));
  try {
    const paths = (["ours", "base", "theirs"] as const).map((name, i) => {
      const p = path.join(d, name);
      writeFileSync(p, [ours, base, theirs][i], "utf8");
      return p;
    });
    const r = spawnSync("git", ["merge-file", "-p", "-L", "ours", "-L", "base", "-L", "theirs", ...paths], { encoding: "utf8" });
    if (r.error) return new MergeResult(ours, [new Conflict("file", "a side does not parse and git is not available for a text merge", () => {})], [], [], true);
    const conflicts = r.status === 0 ? [] : [new Conflict("file", `${r.status} text conflict(s) in a plain line merge`, () => {})];
    return new MergeResult(r.stdout, conflicts, [], [], true);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

/** `wiret ids --check`: every deleted id was retired in wiret.ids, none reused. */
function checkRange(project: Project, spec: string, record: boolean): number {
  const [base, headRaw] = spec.includes("..") ? spec.split("..") : [spec, ""];
  const head = headRaw || null;
  const top = git(["rev-parse", "--show-toplevel"], project.root)!.trim();
  const realRoot = path.resolve(project.root);
  let rootRel = path.relative(path.resolve(top), realRoot).split(path.sep).join("/") || ".";
  const idsRel = rootRel === "." ? "wiret.ids" : `${rootRel}/wiret.ids`;
  const files = git(["diff", "--name-only", base, ...(head ? [head] : []), "--", "*.wiret"], top)!.split(/\r?\n/)
    .filter((f) => f && (rootRel === "." || f.startsWith(rootRel + "/")));
  const fileAt = (rev: string | null, rel: string): string | null => {
    if (rev === null) {
      const p = path.join(top, rel);
      return existsSync(p) ? readFileSync(p, "utf8") : null;
    }
    return git(["show", `${rev}:${rel}`], top, true);
  };
  const registry = new Set(parseRegistry(fileAt(head, idsRel) ?? "").map((r) => r.line()));
  const missing: Retired[] = [];
  let problems = 0;
  for (const rel of files) {
    const models: (Module | null)[] = [];
    for (const rev of [base, head]) {
      const text = fileAt(rev, rel);
      try {
        models.push(text !== null ? parse(text) : null);
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        out(`${rel}: error: does not parse at ${rev || "the working tree"}: ${e.message}\n`);
        models.push(null);
        problems += 1;
      }
    }
    const [old, nu] = models;
    for (const r of retiredBetween(old, nu)) {
      if (!registry.has(r.line())) {
        missing.push(r);
        if (!record) out(`${rel}: error: ${r.describe()} was deleted without being retired in wiret.ids (run with --record to add it)\n`);
      }
    }
    if (nu !== null) {
      const reused = sortedBy([...idsOf(nu)].filter((l) => registry.has(l)).map(Retired.fromLine), (r) => [r.graph, r.id]);
      for (const r of reused) {
        problems += 1;
        out(`${rel}: error E0140: ${r.describe()} is retired in wiret.ids but used again\n`);
      }
    }
  }
  if (missing.length && record) {
    const written = project.retire(missing);
    out(`recorded ${written.length} retired id(s) in ${project.ids_path}\n`);
    for (const r of written) out(`  ${r.line()}\n`);
    missing.length = 0;
  }
  if (!missing.length && !problems) out(`ok: ${files.length} file(s) checked\n`);
  return missing.length || problems ? 1 : 0;
}

// -- arguments -------------------------------------------------------------------------
interface Args { _: string[]; flags: Set<string>; opts: Map<string, string[]> }

const VALUE_OPTS = new Set(["-o", "--output", "--fuel", "--grant", "--record", "--check", "--project"]);
const BOOL_OPTS = new Set(["--json", "--check", "--assign-ids", "--convert-comments", "--drop-comments", "--no-source", "--export-all",
  "--sandbox", "--deterministic", "--flow", "--raw", "--dry-run", "--record", "--no-git"]);

function parseArgs(cmd: string, argv: string[]): Args {
  const a: Args = { _: [], flags: new Set(), opts: new Map() };
  // --check and --record take a value only for `ids`
  const takesValue = (o: string) => VALUE_OPTS.has(o) && !(o === "--check" && cmd !== "ids") && !(o === "--record" && cmd === "ids");
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--") {
      a._.push(...argv.slice(i + 1));
      break;
    }
    const eq = x.startsWith("--") ? x.indexOf("=") : -1;
    const name = eq > 0 ? x.slice(0, eq) : x;
    if (takesValue(name)) {
      const v = eq > 0 ? x.slice(eq + 1) : argv[++i];
      if (v === undefined) usage(`${name} needs a value`);
      a.opts.set(name, [...(a.opts.get(name) ?? []), v]);
    } else if (BOOL_OPTS.has(name) || (name === "-h" || name === "--help")) a.flags.add(name);
    else if (x.startsWith("--") && x.length > 2) usage(`unknown option ${x}`);
    else a._.push(x);
  }
  return a;
}

/** The help for one command, or for all of them; `msg` makes it an error (exit 2, on stderr). */
function usage(msg?: string, cmd?: string): never {
  const one = COMMANDS.find(([n]) => n === cmd);
  const text = one
    ? `usage: wiret ${one[0]} ${one[1]}\n\n${one[2]}`
    : `wiret ${VERSION}: the Wiret toolchain\n\nusage: wiret COMMAND [OPTIONS] ARGS\n\n` +
      COMMANDS.map(([n, , what]) => `  ${n.padEnd(9)} ${what}`).join("\n") +
      `\n\nwiret COMMAND --help shows a command's options; wiret --version prints the version.`;
  if (msg) err(`wiret: ${msg}`);
  (msg ? err : (s: string) => out(s + "\n"))(text);
  throw new Exit(msg ? 2 : 0);
}

const opt = (a: Args, ...names: string[]) => names.map((n) => a.opts.get(n)?.at(-1)).find((v) => v !== undefined) ?? null;
let current = "";
const pos = (a: Args, n: number, what: string) => {
  if (a._.length < n) usage(`missing ${what}`, current);
  return a._;
};

export function main(argv: string[]): number {
  const cmd = argv[0];
  if (!cmd || cmd === "-h" || cmd === "--help") usage();
  if (cmd === "-V" || cmd === "--version") {
    out(`wiret ${VERSION}\n`);
    return 0;
  }
  if (cmd === "help") usage(undefined, argv[1]);
  current = cmd;
  const a = parseArgs(cmd, argv.slice(1));
  if (a.flags.has("-h") || a.flags.has("--help")) usage(undefined, cmd);
  switch (cmd) {
    case "check": {
      const [file] = pos(a, 1, "FILE");
      const [m] = load(file);
      const diags = check(m, false, findProject(file));
      for (const d of diags) out((a.flags.has("--json") ? d.toJson() : d.toString()) + "\n");
      if (diags.length && !a.flags.has("--json") && process.stdout.isTTY)
        err(`(wiret explain ${diags[0].code} says more about a code)`);
      return hasErrors(diags) ? 1 : 0;
    }
    case "fmt": {
      const [file] = pos(a, 1, "FILE");
      const [m, text] = load(file);
      if (m.comments.length) {
        if (a.flags.has("--convert-comments")) for (const msg of convertComments(m)) err(`warning W0603: ${msg}`);
        else if (a.flags.has("--drop-comments")) m.comments = [];
        else {
          for (const c of m.comments)
            err(`${file}:${c.line}: warning W0603: formatting would drop this comment; use --convert-comments or --drop-comments`);
          return 1;
        }
      }
      const proj = findProject(file);
      attachRetired(m, proj);
      if (a.flags.has("--assign-ids")) {
        const retired = proj ? [...proj.retired].map((l) => Retired.fromLine(l).id) : [];
        for (const e of assignIds(m, Math.random, retired)) err(`${e.kind} '${e.name}': @id("${e.id}")`);
      }
      const o = printModule(m);
      if (a.flags.has("--check")) {
        if (o !== text) {
          err(`${file} is not in canonical form`);
          return 1;
        }
        return 0;
      }
      if (o !== text) writeFileSync(file, o, "utf8");
      return 0;
    }
    case "diff": {
      const [fa, fb] = pos(a, 2, "A and B");
      const [ma] = load(fa), [mb] = load(fb);
      const o = a.flags.has("--raw") ? rawDiff(printModule(ma), printModule(mb), fa, fb) : semanticDiff(ma, mb);
      out(o);
      return o ? 1 : 0;
    }
    case "merge": {
      const [base, ours, theirs] = pos(a, 3, "BASE OURS THEIRS");
      const texts = [base, ours, theirs].map((p) => readFileSync(p, "utf8")) as [string, string, string];
      let r: MergeResult;
      try {
        r = mergeModules(...texts);
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        r = textMerge(...texts);
      }
      writeFileSync(opt(a, "-o", "--output") || ours, r.text, "utf8");
      if (r.fallback) err("wiret merge: a side does not parse; used a plain line merge");
      for (const n of r.notices) err(`notice: layout ${n}`);
      for (const c of r.conflicts) err(`conflict: ${c.where}: ${c.what}`);
      for (const d of r.semantic) err(`semantic conflict: ${d}`);
      return r.clean ? 0 : 1;
    }
    case "init-git":
      return initGit();
    case "explain":
      return explain(a._, { out, err: (s) => process.stderr.write(s) });
    case "new":
    case "init": {
      const dir = cmd === "new" ? pos(a, 1, "DIR")[0] : a._[0] ?? ".";
      const io = { out, err: (s: string) => process.stderr.write(s) };
      const written = scaffold(dir, cmd === "new", io);
      if (written === null) return 2;
      const shown = path.relative(process.cwd(), path.resolve(dir)) || ".";
      out(`created a Wiret project in ${shown}\n`);
      for (const f of written) out(`  ${f}\n`);
      if (!a.flags.has("--no-git")) {
        const inRepo = git(["rev-parse", "--show-toplevel"], dir, true) !== null;
        if (!inRepo && git(["init", "-q"], dir, true) === null) err("git is not available; skipped the Git setup (run wiret init-git later)");
        else {
          if (!inRepo) out("  initialized a Git repository\n");
          initGit(dir);
        }
      }
      const main = Object.keys(projectFiles(dir)).find((f) => f.endsWith(".wiret"))!;
      out(`\nnext:\n${shown === "." ? "" : `  cd ${shown}\n`}  wiret run ${main}\n`);
      return 0;
    }
    case "edit": {
      const [file, reqPath] = pos(a, 2, "FILE and REQUEST");
      const reqText = reqPath === "-" ? readFileSync(0, "utf8") : readFileSync(reqPath, "utf8");
      let request: any;
      try {
        request = JSON.parse(reqText);
      } catch (e) {
        out(JSON.stringify({ ok: false, error: { code: "request", message: `not JSON: ${(e as Error).message}` } }) + "\n");
        return 2;
      }
      const text = readFileSync(file, "utf8");
      const dry = a.flags.has("--dry-run");
      const r = applyRequest(text, request, dry ? null : findProject(file));
      if (r.ok && !dry && r.text !== text) writeFileSync(file, r.text, "utf8");
      out(JSON.stringify(r.toJson(), null, 2) + "\n");
      return r.ok ? 0 : 1;
    }
    case "ids": {
      const spec = opt(a, "--check");
      if (!spec) usage("ids needs --check BASE[..HEAD]");
      const proj = findProject(path.join(opt(a, "--project") ?? ".", "x.wiret"));
      if (proj === null) {
        err(`no wiret.toml in ${path.resolve(opt(a, "--project") ?? ".")} or above it; wiret.ids belongs to a project (section 7.3)`);
        return 2;
      }
      try {
        return checkRange(proj, spec, a.flags.has("--record"));
      } catch (e) {
        if (!(e instanceof GitError)) throw e;
        err(`git: ${e.message}`);
        return 2;
      }
    }
    case "build": {
      const [file] = pos(a, 1, "FILE");
      const [, o, data] = build(file, opt(a, "-o", "--output"), !a.flags.has("--no-source"), a.flags.has("--export-all"));
      out(`wrote ${o} (${data.length} bytes)\n`);
      return 0;
    }
    case "dis":
      out(disassemble(new Uint8Array(readFileSync(pos(a, 1, "FILE")[0]))));
      return 0;
    case "verify":
      try {
        new VM().load(new Uint8Array(readFileSync(pos(a, 1, "FILE")[0])));
      } catch (e) {
        if (!(e instanceof WiretError)) throw e;
        err(e.toString());
        return 1;
      }
      out("ok\n");
      return 0;
    case "run": {
      const [file, func = "Main", ...args] = pos(a, 1, "FILE");
      let data: Uint8Array, m: Module | null;
      if (file.endsWith(".wbc")) {
        data = new Uint8Array(readFileSync(file));
        m = null;
      } else [m, , data] = build(file, null, true, true);
      const record = opt(a, "--record");
      const deterministic = a.flags.has("--deterministic");
      if (record && !deterministic) {
        err("--record needs --deterministic: only a deterministic run can be replayed");
        return 2;
      }
      const fuel = opt(a, "--fuel");
      const vm = new VM({ fuel: fuel ? parseInt(fuel, 10) : 50_000_000, capabilities: a.flags.has("--sandbox") ? [] : null, deterministic,
                          output: (l) => out(l + "\n") });
      for (const cap of a.opts.get("--grant") ?? []) vm.grant(cap);
      let status = 0;
      try {
        const lm = vm.load(data);
        const values = m ? parseArgsFor(m, func, args) : args.map((x) => parseInt(x, 10));
        const res = runFunction(vm, lm, func, values);
        out(formatResults(m, func, res) + "\n");
        if (vm.time) out(`(finished at ${+vm.time.toPrecision(6)} s of virtual time)\n`);
      } catch (e) {
        if (!(e instanceof WiretError || e instanceof ValueError)) throw e;
        const msg = e.toString().replace(/^Error: /, "");
        err(msg);
        if (!m && msg.includes("no exported function"))
          err(`hint: a release build exports only @export functions; mark ${func} @export, or build with --export-all`);
        status = 1;
      }
      if (record) {
        writeFileSync(record, JSON.stringify(vm.input_log, null, 1), "utf8");
        err(`(input log: ${vm.input_log.length} calls written to ${record})`);
      }
      return status;
    }
    case "replay": {
      const [file, logPath] = pos(a, 2, "FILE and LOG");
      const data = file.endsWith(".wbc") ? new Uint8Array(readFileSync(file)) : build(file, null, true, true)[2];
      const log = JSON.parse(readFileSync(logPath, "utf8"));
      try {
        const vm = replay(data, log, { output: () => {} });
        out(`replayed ${log.length} calls: same results, faults, instructions, fuel and output (${vm.stats.instructions} instructions)\n`);
        return 0;
      } catch (e) {
        if (!(e instanceof ReplayMismatch)) throw e;
        err(`replay differs: ${e.message}`);
        return 1;
      }
    }
    case "caps": {
      const [file] = pos(a, 1, "FILE");
      const data = file.endsWith(".wbc") ? new Uint8Array(readFileSync(file)) : build(file)[2];
      try {
        for (const cap of moduleCapabilities(data)) out(cap + "\n");
      } catch (e) {
        if (!(e instanceof WiretError)) throw e;
        err(e.toString());
        return 1;
      }
      return 0;
    }
    case "hash": {
      const [m] = load(pos(a, 1, "FILE")[0]);
      out(`semantic ${semanticHash(m)}\nlayout   ${layoutHash(m)}\n`);
      return 0;
    }
    case "view": {
      if (!a.flags.has("--flow")) usage("view needs --flow");
      const [m] = load(pos(a, 1, "FILE")[0]);
      out(viewFlow(m));
      return 0;
    }
    case "schema":
      if (!a.flags.has("--json")) usage("schema needs --json");
      out(JSON.stringify(registryJson(), null, 2) + "\n");
      return 0;
    default:
      usage(`unknown command '${cmd}'`);
  }
}

/** Load the runtime and run one command line; returns the exit code. A file that cannot be
 * read is an error message, not a stack trace. */
export async function cli(argv: string[]): Promise<number> {
  try {
    if (argv[0] && !["-h", "--help", "-V", "--version", "help"].includes(argv[0])) await initRuntime();
    if (argv[0] === "repl") {
      current = "repl";
      const a = parseArgs("repl", argv.slice(1));
      if (a.flags.has("-h") || a.flags.has("--help")) usage(undefined, "repl");
      const fuel = opt(a, "--fuel");
      return await repl(a._, fuel ? parseInt(fuel, 10) : undefined);
    }
    return main(argv);
  } catch (e) {
    if (e instanceof Exit) return e.code;
    const fe = e as NodeJS.ErrnoException;
    if (fe.code === "ENOENT" || fe.code === "EISDIR" || fe.code === "EACCES") {
      err(`wiret: cannot ${fe.syscall === "open" && fe.code !== "EISDIR" ? "open" : "read"} ${fe.path ?? "file"}: ${fe.code}`);
      return 2;
    }
    throw e;
  }
}
