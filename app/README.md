# Wiret app (TypeScript)

The Wiret editor, compiler, verifier, VM and `wiretc` toolchain in TypeScript. One codebase
serves three targets:

| Target | What runs it | Entry point |
| --- | --- | --- |
| Web page | any browser, as a static site (GitHub Pages) | `index.html` → `src/web/main.ts` |
| Desktop app | Tauri 2 (the system webview: WebView2, WKWebView, WebKitGTK) | the same page, in `src-tauri/` |
| Command line | Node 22+ | `src/cli/wiretc.ts` |

It is a port of the Python prototype in [`../prototype`](../prototype), and is tested against
it: for every lesson and example, the TypeScript gives the same canonical text, hashes,
diagnostics, bytecode, disassembly, program output, debugger recording, and the same result
for every canvas edit and context menu (see [Tests](#tests)).

## Running it

```sh
cd app
npm install
npm run dev                  # the editor at http://localhost:5173
npm test                     # the parity tests
npm run build                # the static site, in dist/
npm run wiretc -- run ../prototype/examples/demo.wiret Main
```

The desktop app needs [Rust](https://rustup.rs) and, on Linux, the WebKitGTK packages listed
in [Tauri's prerequisites](https://v2.tauri.app/start/prerequisites/):

```sh
npm run tauri dev            # the desktop app, with the page reloading as you edit
npm run tauri build          # installers in src-tauri/target/release/bundle/
```

Build on each OS you want installers for (Tauri does not cross-compile), or run the
**Desktop** workflow in GitHub Actions, which builds for Windows, macOS and Linux.

## Layout

```
src/core/      the language: parser, printer, checker, compiler, verifier, VM, and the
               editor's model (viewmodel, canvasedit, palette, webapi). No DOM, no Node APIs.
src/web/       the page: graphview.ts (the canvas), debugger.ts (steps a recorded run),
               syntax.ts (highlighting), main.ts (the page), host.ts (file open/save)
src/cli/       wiretc on Node: file system, git, the merge driver
src-tauri/     the desktop shell: a window, native file dialogs, file access and watching
content/       the std library, lessons and examples, embedded into the build by
               scripts/embed.mjs (src/core/content.gen.ts, made before dev/build/test)
test/          parity tests, and test/golden/: what the Python prototype produces
```

`src/core/*.ts` mirror `prototype/wiret/*.py` module for module; [`PORTING.md`](PORTING.md)
says how Python's semantics map onto TypeScript's (64-bit integers are `bigint`, Python's
float `repr` and `%g`, code-point string comparison, `difflib`, `decimal`).

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

## Tests

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
