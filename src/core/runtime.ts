/** The Rust runtime (runtime/) as WebAssembly: loading it, and the raw calls into it.
 *
 * `scripts/runtime.mjs` builds `wiret_runtime.wasm` next to this file. Call `init()` once (it
 * is async: it fetches and compiles the module); after that every call is synchronous. The
 * protocol is JSON, as `runtime/src/bridge.rs` describes; `vm.ts` wraps it in the VM API the
 * rest of the editor uses. */

const WASM_URL = new URL("./wiret_runtime.wasm", import.meta.url);

/** What the runtime calls back into: a line of output, and (when hooked) a node reached. */
export interface Callbacks {
  output(line: string): void;
  hook?(phase: number, func: string, node: string, depth: number): void;
}

interface Exports {
  memory: WebAssembly.Memory;
  wr_alloc(len: number): number;
  wr_free(ptr: number, len: number): void;
  wr_result_ptr(): number;
  wr_vm_new(ptr: number, len: number): number;
  wr_vm_free(id: number): void;
  wr_load(id: number, ptr: number, len: number): number;
  wr_command(id: number, ptr: number, len: number): number;
  wr_hook_view(kind: number, arg: number): number;
  wr_module_capabilities(ptr: number, len: number): number;
  wr_replay(dp: number, dl: number, lp: number, ll: number): number;
  wr_verify(ptr: number, len: number): number;
  wr_disassemble(ptr: number, len: number): number;
  wr_natives(): number;
  wr_float_text(x: number, single: number): number;
}

let compiled: WebAssembly.Module | null = null;
let instance: Exports | null = null;
/** callbacks by VM id, and each VM's cache of strings the runtime keeps at fixed addresses */
const vms = new Map<number, { cb: Callbacks; strings: Map<number, string> }>();
const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function readWasm(): Promise<BufferSource> {
  if (WASM_URL.protocol === "file:") {
    const fsName = "node:fs/promises";                 // not bundled for the browser
    const fs = await import(/* @vite-ignore */ fsName);
    return fs.readFile(WASM_URL);
  }
  const r = await fetch(WASM_URL);
  if (!r.ok) throw new Error(`could not load the Wiret runtime (${WASM_URL}): HTTP ${r.status}`);
  return r.arrayBuffer();
}

/** Fetch and compile the runtime. Safe to call more than once. */
export async function init(): Promise<void> {
  if (compiled === null) compiled = await WebAssembly.compile(await readWasm());
}

/** Compile the runtime from bytes already in hand, synchronously. */
export function initSync(bytes: BufferSource): void {
  if (compiled === null) compiled = new WebAssembly.Module(bytes);
}

export const ready = (): boolean => compiled !== null;

function str(ptr: number, len: number): string {
  return decoder.decode(new Uint8Array(rt().memory.buffer, ptr, len));
}

function rt(): Exports {
  if (instance !== null) return instance;
  if (compiled === null) throw new Error("the Wiret runtime is not loaded: call init() from runtime.ts first");
  const env = {
    wr_host_output(vm: number, ptr: number, len: number) {
      vms.get(vm)?.cb.output(str(ptr, len));
    },
    wr_host_hook(vm: number, phase: number, fp: number, fl: number, np: number, nl: number, depth: number) {
      const v = vms.get(vm);
      if (!v?.cb.hook) return;
      const s = v.strings;
      let func = s.get(fp), node = s.get(np);
      if (func === undefined) s.set(fp, func = str(fp, fl));
      if (node === undefined) s.set(np, node = str(np, nl));
      hooking += 1;
      try {
        v.cb.hook(phase, func, node, depth);
      } finally {
        hooking -= 1;
      }
    },
  };
  instance = new WebAssembly.Instance(compiled, { env }).exports as unknown as Exports;
  return instance;
}

let hooking = 0;
/** True while a hook runs: then only `hookView` may call into the runtime. */
export const inHook = (): boolean => hooking > 0;

/** A WebAssembly trap (a Rust panic or a stack overflow) leaves the runtime's state unknown, so
 * the instance is dropped and the next VM gets a new one. */
export class RuntimeTrap extends Error {}

function guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof WebAssembly.RuntimeError) {
      instance = null;
      vms.clear();
      throw new RuntimeTrap(e.message);
    }
    throw e;
  }
}

function withBytes<T>(bytes: Uint8Array, fn: (ptr: number, len: number) => T): T {
  const r = rt();
  const ptr = r.wr_alloc(bytes.length);
  new Uint8Array(r.memory.buffer, ptr, bytes.length).set(bytes);
  try {
    return fn(ptr, bytes.length);
  } finally {
    if (instance === r) r.wr_free(ptr, bytes.length);
  }
}

function result(len: number): any {
  return JSON.parse(str(rt().wr_result_ptr(), len));
}

export function vmNew(config: object, cb: Callbacks): number {
  return guard(() => {
    const id = withBytes(encoder.encode(JSON.stringify(config)), (p, l) => rt().wr_vm_new(p, l));
    vms.set(id, { cb, strings: new Map() });
    return id;
  });
}

export function vmFree(id: number): void {
  if (!vms.delete(id) || instance === null) return;
  guard(() => rt().wr_vm_free(id));
}

export const alive = (id: number): boolean => vms.has(id);

export function load(id: number, bytes: Uint8Array): any {
  return guard(() => result(withBytes(bytes, (p, l) => rt().wr_load(id, p, l))));
}

export function command(id: number, req: object): any {
  return guard(() => result(withBytes(encoder.encode(JSON.stringify(req)), (p, l) => rt().wr_command(id, p, l))));
}

/** While a hook runs: the call stack (0), a global (1) or the pending nodes (2). */
export function hookView(kind: number, arg = 0): any {
  return result(rt().wr_hook_view(kind, arg));
}

export function moduleCapabilities(bytes: Uint8Array): any {
  return guard(() => result(withBytes(bytes, (p, l) => rt().wr_module_capabilities(p, l))));
}

/** Verify a module: `{ok: max stack height per defined function}` or `{err: message}`. */
export function verify(bytes: Uint8Array): any {
  return guard(() => result(withBytes(bytes, (p, l) => rt().wr_verify(p, l))));
}

/** A module's disassembly: `{ok: text}` or `{err: message}`. */
export function disassemble(bytes: Uint8Array): any {
  return guard(() => result(withBytes(bytes, (p, l) => rt().wr_disassemble(p, l))));
}

let nativeTable: any = null;
/** The signature of every native the runtime provides, by group (std, internal, host). */
export function natives(): any {
  if (nativeTable === null) nativeTable = guard(() => result(rt().wr_natives()));
  return nativeTable;
}

/** A float as Wiret writes it (section 3.2). */
export function floatText(x: number, single: boolean): string {
  return guard(() => result(rt().wr_float_text(x, single ? 1 : 0)));
}

export function replay(bytes: Uint8Array, log: unknown): any {
  return guard(() => withBytes(bytes, (dp, dl) =>
    withBytes(encoder.encode(JSON.stringify(log)), (lp, ll) => result(rt().wr_replay(dp, dl, lp, ll)))));
}
