/** `wiret explain` (what a diagnostic code or runtime status means) and `wiret new` / `wiret init`
 * (a project skeleton, spec section 7.3). */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DIAGNOSTICS } from "../core/content.gen.js";
import { assignIds } from "../core/ids.js";
import { parse } from "../core/parser.js";
import { printModule } from "../core/printer.js";

export interface Out { out(s: string): void; err(s: string): void }

const RUNTIME: Record<string, string> = {
  WR_ERR_FAULT: "The program faulted while it ran: a division by zero, an array index out of range, a null " +
    "reference, a failed cast, a stack overflow and the like. A Try around the nodes that can fail handles the fault " +
    "(section 4.6).",
  WR_ERR_FUEL: "The program ran out of fuel, the instruction budget (section 5.7). It is usually a loop that never " +
    "ends; if the program is just long, give it more with --fuel N.",
  WR_ERR_LINK: "The module needs something the runtime does not provide: an extern no host registered, a function " +
    "that is not exported (a release build exports only @export functions; build with --export-all to run any), or " +
    "a capability that was not granted (run with --grant CAP).",
  WR_ERR_LOAD: "The file is not a valid WBC module: it is damaged, truncated or not bytecode (section 5.1).",
  WR_ERR_VERIFY: "The module failed verification, so the runtime will not run it (section 5.5). A module wiret build " +
    "wrote always verifies; this one was changed afterwards or made by another tool.",
  WR_ERR_INTERRUPT: "The host stopped the program (section 6.5).",
  WR_ERR_API: "The host called the runtime in a way it does not allow, such as using a VM after freeing it (section 6).",
  WR_YIELD: "The program is waiting, for a Delay or a signal, and nothing left running can wake it (section 4.5).",
};

/** Markdown from the spec as terminal text: no code backticks, a capital, a full stop. */
function plain(md: string): string {
  const t = md.replace(/`([^`]*)`/g, "$1").trim();
  const s = t[0].toUpperCase() + t.slice(1);
  return s.endsWith(".") ? s : s + ".";
}

/** `wiret explain [CODE...]`: each code's meaning, or every code when none is given. */
export function explain(codes: string[], io: Out): number {
  if (!codes.length) {
    for (const [c, m] of Object.entries(DIAGNOSTICS)) {
      const first = plain(m).split(/(?<=\.) /)[0];
      io.out(`${c}  ${first.length > 90 ? first.slice(0, 87) + "..." : first}\n`);
    }
    io.out(`\nRuntime statuses: ${Object.keys(RUNTIME).join(", ")}\nwiret explain CODE describes one.\n`);
    return 0;
  }
  let status = 0;
  for (const raw of codes) {
    const c = raw.toUpperCase();
    if (DIAGNOSTICS[c]) {
      const kind = c.startsWith("E") ? "error" : "warning";
      io.out(`${c} (${kind}): ${plain(DIAGNOSTICS[c])}\n`);
    } else if (RUNTIME[c] || RUNTIME[`WR_${c}`]) {
      const k = RUNTIME[c] ? c : `WR_${c}`;
      io.out(`${k} (runtime status): ${RUNTIME[k]}\n`);
    } else {
      const near = Object.keys(DIAGNOSTICS).filter((k) => k.slice(0, 3) === c.slice(0, 3));
      io.err(`wiret: no diagnostic ${raw}${near.length ? `; codes like it: ${near.join(", ")}` : ""}; wiret explain lists them all\n`);
      status = 2;
    }
    if (codes.length > 1) io.out("\n");
  }
  return status;
}

/** A module name from a directory name: `my-game` is `my_game`. */
export function moduleName(dir: string): string {
  let n = path.basename(path.resolve(dir)).toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  if (!n) n = "app";
  if (/^\d/.test(n)) n = "app_" + n;
  return n;
}

function mainSource(mod: string): string {
  const text = `wiret 1
module ${mod}.main

@capability("console.write")
extern func host.Log(message: string) -> ()

@doc("Where the program starts: wiret run src/${mod}/main.wiret")
func Main() {
  exec Entry()
  exec Call host.Log(
    .message <- "Hello from ${mod}!"
  )
}
`;
  const m = parse(text);
  assignIds(m);
  return printModule(m);
}

/** The files of a new project, relative to its directory. */
export function projectFiles(name: string): Record<string, string> {
  const mod = moduleName(name);
  return {
    "wiret.toml": `[project]
name     = "${mod}"
wiret    = "1"
registry = "wiret.core@1.0"
roots    = ["src"]

[dependencies]

[capabilities]
allow = ["console.write"]
`,
    [`src/${mod}/main.wiret`]: mainSource(mod),
    ".gitignore": "*.wbc\n",
  };
}

/** Write a project into `dir`. `fresh`: `wiret new`, which wants a new or empty directory.
 * Existing files are kept, never overwritten. Returns the files written, or null on refusal. */
export function scaffold(dir: string, fresh: boolean, io: Out): string[] | null {
  if (fresh && existsSync(dir) && readdirSync(dir).length) {
    io.err(`wiret: ${dir} already exists and is not empty; use wiret init in it instead\n`);
    return null;
  }
  if (existsSync(path.join(dir, "wiret.toml"))) {
    io.err(`wiret: ${path.join(dir, "wiret.toml")} already exists: this is already a project\n`);
    return null;
  }
  const written: string[] = [];
  for (const [rel, text] of Object.entries(projectFiles(dir))) {
    const p = path.join(dir, rel);
    if (existsSync(p)) {
      io.err(`  kept the existing ${rel}\n`);
      continue;
    }
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, text, "utf8");
    written.push(rel);
  }
  return written;
}
