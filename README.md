# Wiret

Wiret is a text-first visual programming language designed to keep the strengths of graph-based authoring while making programs readable, reviewable, and tool-friendly.

Instead of treating a visual editor as the source of truth, Wiret stores graphs as canonical text. That means you get the benefits of visual workflows without sacrificing version control, static validation, compiler tooling, and AI-friendly authoring.

Example:

![Screenshot 2026-11-26 001343](https://github.com/user-attachments/assets/cea2be92-b4a2-49a2-aef7-19c7949aa34f)

```wiret
wiret 1
module lessons.variables

extern func host.Log(message: string) -> ()

@note("Lesson 2: Variables. A local variable (here: score) is a named box that holds one value. SetLocal puts a value in the box. GetLocal reads what is in the box right now.")
@note("Try it: (1) Step through (F11) and watch the Variables panel in the Debugger tab: score changes from 0 to 10 to 15. (2) Change the bonus: type 100 in the b box on the Add node.")
func Main() {
  local score: i32

  exec Entry{pos=(0, 0)}()
  exec SetLocal score{pos=(200, 0)}(
    .value <- 10
  )
  exec SetLocal score{pos=(560, 0)}(
    @note("Add reads the score (10) and adds 5.")
    .value <- Add#<i32>{pos=(360, 160)}(
      .a <- GetLocal score{pos=(180, 260)}()
      .b <- 5
    )
  )
  exec Call host.Log{pos=(980, 0)}(
    .message <- Call std.string.Concat{pos=(780, 180)}(
      .a <- "Your score is "
      @note("Log needs text, so Convert turns the number into text.")
      .b <- Convert#<i32, string>{pos=(600, 320)}(
        .value <- GetLocal score{pos=(440, 420)}()
      )
    )
  )
}
```

[Try out the graph editor in the browser!](https://lemonator32.github.io/wiret/)

## Why Wiret?

Most visual scripting systems are excellent for authoring, but awkward for:

- code review and diffs in Git
- automated validation and CI
- canonical serialization
- editor portability
- LLM-assisted generation and editing
- compiler verification and runtime safety

Wiret was designed to address exactly that gap. It keeps the graph model, but makes the underlying representation explicit, deterministic, and human-readable.

## Core ideas

- Text is the source of truth
- Graph semantics are explicit
- Types, pins, conversion rules, and execution wiring are all visible
- A function reads in the order it runs, and layout and notes never change runtime meaning
- Serialization is canonical, stable, and diff-friendly
- The language is meant to compile, verify, and run, not just draw boxes

## Features

- Graph-based programming with a text representation
- Strongly typed semantics
- Explicit data and execution flow
- Deterministic canonical formatting
- Compiler and verifier pipeline
- Graph editor and debugger for the web and desktop
- Support for standard-library-style macros and reusable graph logic
- Bytecode generation and interpreter runtime

## The app (TypeScript)

The Wiret editor, compiler, verifier, VM and `wiretc` toolchain in TypeScript. One codebase
serves three targets:

| Target | What runs it | Entry point |
| --- | --- | --- |
| Web page | any browser, as a static site (GitHub Pages) | `index.html` → `src/web/main.ts` |
| Desktop app | Tauri 2 (the system webview: WebView2, WKWebView, WebKitGTK) | the same page, in `src-tauri/` |
| Command line | Node 22+ | `src/cli/wiretc.ts` |

It is a port of the Python prototype (removed in d8008eb), and is tested against it: for every lesson and example, the TypeScript gives the same canonical text, hashes,
diagnostics, bytecode, disassembly, program output, debugger recording, and the same result
for every canvas edit and context menu (see [Tests](#tests)).

### Running it

The bytecode runtime is Rust (see [The runtime](#the-runtime-rust)), so every target needs
[Rust](https://rustup.rs) with the WebAssembly target:

```sh
rustup target add wasm32-unknown-unknown
npm install
npm run dev                  # the editor at http://localhost:5173
npm test                     # the parity tests
npm run build                # the static site, in dist/
npm run wiretc -- run content/examples/demo.wiret Main
```

The desktop app also needs, on Linux, the WebKitGTK packages listed in
[Tauri's prerequisites](https://v2.tauri.app/start/prerequisites/):

```sh
npm run tauri dev            # the desktop app, with the page reloading as you edit
npm run tauri build          # installers in src-tauri/target/release/bundle/
```

Build on each OS you want installers for (Tauri does not cross-compile), or run the
**Desktop** workflow in GitHub Actions, which builds for Windows, macOS and Linux.

### Layout

```
src/core/      the language: parser, printer, checker, compiler, verifier, and the
               editor's model (viewmodel, canvasedit, palette, webapi). No DOM, no Node APIs.
               vm.ts and runtime.ts load the Rust runtime as WebAssembly.
src/web/       the page: graphview.ts (the canvas), debugger.ts (steps a recorded run),
               syntax.ts (highlighting), main.ts (the page), host.ts (file open/save),
               nativevm.ts (the desktop app's native runtime, over Tauri IPC)
src/cli/       wiretc on Node: file system, git, the merge driver
runtime/       the bytecode runtime in Rust: decoder, verifier, VM, natives, replay
src-tauri/     the desktop shell: a window, native file dialogs, file access and watching,
               and the runtime as Tauri commands (src/runtime.rs)
content/       the std library, lessons and examples, embedded into the build by
               scripts/embed.mjs (src/core/content.gen.ts, made before dev/build/test)
test/          parity tests, and test/golden/: what the Python prototype produces
```

`src/core/*.ts` mirror `prototype/wiret/*.py` module for module; [`PORTING.md`](PORTING.md)
says how Python's semantics map onto TypeScript's (64-bit integers are `bigint`, Python's
float `repr` and `%g`, code-point string comparison, `difflib`, `decimal`).

### The runtime (Rust)

[`runtime/`](runtime/) is the `.wbc` runtime as a Rust crate, `wiret-runtime`: it decodes,
verifies, links and runs WBC 1 modules, with fibers and virtual time, fuel, faults with node
tracebacks, deterministic mode (bundled math, in integer arithmetic) and input-log replay. It
is a port of the TypeScript VM, and gives the same output, results, faults, instruction counts
and fuel for every lesson and example. It is what a game engine embeds. It is used three ways:

| Host | How |
| --- | --- |
| Rust (the desktop app, an engine in Rust) | `wiret_runtime::Vm` directly; `cargo run --example run -- FILE.wbc Main` in `runtime/` shows a host and a host native |
| The web page, `wiretc` and the tests | built for `wasm32-unknown-unknown` by `scripts/runtime.mjs` (before dev, build, test and wiretc); `src/core/vm.ts` wraps it |
| The desktop page | the Tauri commands in `src-tauri/src/runtime.rs`, which run VMs natively on their own thread; `src/web/nativevm.ts` is the page's async client |

The WebAssembly build and the Tauri commands speak the same JSON protocol, described in
[`runtime/src/bridge.rs`](runtime/src/bridge.rs). `cargo test` in `runtime/` runs its unit tests.

### Web and desktop

The page is identical in both; only [`src/web/host.ts`](src/web/host.ts) differs:

- **Browser**: Open/Save use the File System Access API where the browser has it, else a file
  picker and a download.
- **Desktop**: native Open/Save dialogs, and the open file is watched, so a change made by
  another program (an LLM, `git checkout`, another editor) is loaded at once, as the Python
  desktop editor did. A `.wiret` file given on the command line, or opened from the file
  manager (the installer registers the extension), opens at start.

The Tauri capability file ([`src-tauri/capabilities/default.json`](src-tauri/capabilities/default.json))
gives the page only the dialogs, and reading, writing and watching files the user picked.

### Tests

`npm test` runs the parity tests in `test/`. Each compares the TypeScript with fixtures that
the Python prototype wrote (`test/golden/*.json`):

| Test | Checks, for every lesson and example |
| --- | --- |
| `printer.test.ts` | canonical text, semantic and layout hashes |
| `compiler.test.ts` | diagnostics, release and debug bytecode (byte for byte, with `wr.graph` decompressed) |
| `vm.test.ts` | program output and results, normal and deterministic; disassembly |
| `webapi.test.ts` | the graph view data and the debugger's recording |
| `edits.test.ts` | every canvas edit, context menu and value prompt on every node and pin |

After changing the prototype, write the fixtures again with `npm run golden` (needs Python 3.10+).

`wiretc` was also compared with `prototype/wiretc.py` command by command (check, fmt, build,
dis, verify, run, replay, caps, hash, view, schema, diff, merge, edit).

### Known differences from the prototype

- The debugger shows an unset interface or delegate value as `null` (the prototype showed
  Python's `None`).
- `wr.graph` (the compressed source in a `.wbc`) is compressed by pako, not zlib, so its bytes
  can differ; it decompresses to the same text.
- The desktop app is the web editor in a native window, with file open, save and watching
  added. It is not a port of the Tkinter editor (`prototype/wiret/editor.py`), so not
  everything that editor had is in it. Its Bytecode tab is: after a run, the Bytecode tab
  shows the debug build's disassembly, as `wiretc dis` prints it.

## Design principles

Wiret intentionally favors explicitness over implicit behavior:

- explicit types instead of hidden inference
- explicit conversions instead of magical coercion
- stable IDs and metadata instead of editor-only assumptions
- deterministic output instead of ad hoc formatting
- verification and toolability instead of permissive ambiguity

This makes the source form more reliable in code review, testing, and long-term engineering workflows.

## Contribution areas

Good places to contribute include:

- grammar and parser improvements
- formatter and canonicalization fixes
- validation and diagnostics
- type-checking rules
- bytecode verifier enhancements
- standard library macro definitions
- editor integration and source export tooling
- debugger and runtime experiences

## License

This project is licensed under the MIT License. See the `LICENSE` file for details.

## Summary

Wiret is a practical experiment in making visual programming behave like a real software artifact: readable, reviewable, robust, and compiler-friendly.

It aims to be the textual representation of a graph language without sacrificing the discipline required for serious engineering.
