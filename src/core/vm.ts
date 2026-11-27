/** The VM the editor and `wiretc` run programs on: the Rust runtime (runtime/, `libwiret`)
 * compiled to WebAssembly, behind the API the TypeScript VM used to have.
 *
 * Call `await init()` once before making a VM (the page's boot, `wiretc` and the tests do).
 * Values cross as the runtime's JSON (runtime/src/bridge.rs) and come back as the editor
 * expects them: i32 and floats as numbers, i64 as bigints, strings, arrays (also for structs
 * and lane values), maps and sets as `Map`s (a set's values are null), and `Obj`, `Delegate`,
 * `DispatcherObj`, `Signal` and `FaultValue` for the rest. */
import * as rt from "./runtime.js";
import { floatFromHex, floatHex } from "./pyutil.js";

export { init, initSync } from "./runtime.js";

export const STATUS_OK = "WR_OK";
export const STATUS_FAULT = "WR_ERR_FAULT";
export const STATUS_FUEL = "WR_ERR_FUEL";
export const STATUS_LOAD = "WR_ERR_LOAD";
export const STATUS_VERIFY = "WR_ERR_VERIFY";
export const STATUS_LINK = "WR_ERR_LINK";
export const STATUS_API = "WR_ERR_API";
export const STATUS_INTERRUPT = "WR_ERR_INTERRUPT";
export const STATUS_YIELD = "WR_YIELD";

export const FIBER_READY = "READY", FIBER_RUNNING = "RUNNING", FIBER_SUSPENDED = "SUSPENDED",
  FIBER_DONE = "DONE", FIBER_FAULTED = "FAULTED";

export const FAULT_DIVIDE = -1, FAULT_RANGE = -2, FAULT_NULL = -3, FAULT_CAST = -4, FAULT_STACK = -5,
  FAULT_NATIVE = -6, FAULT_UNREACHABLE = -7;

export class WiretError extends Error {
  constructor(public status: string, message: string, public traceback: [string, string | null][] = [],
              public code = 0) {
    super(message);
  }

  override toString(): string {
    let s = `${this.status}: ${this.message}`;
    for (const [fn, node] of this.traceback) s += `\n  at ${fn}` + (node ? ` node ${node}` : "");
    return s;
  }
}

export function wiretError(e: any): WiretError {
  return new WiretError(e.status, e.message, e.traceback ?? [], e.code ?? 0);
}

/** A reply's value, or its error thrown. */
function unwrap(reply: any): any {
  if ("err" in reply) throw wiretError(reply.err);
  return reply.ok;
}

// -- values from the runtime ---------------------------------------------------------------
/** A class as the host sees it: its name and field names. */
export interface ClassView { name: string; field_names: string[] }

/** A class instance. `fields` is what the runtime last reported. */
export class Obj {
  constructor(readonly id: number, public cls: ClassView, public fields: any[], readonly serial: number) {}
  get(name: string): any { return this.fields[this.cls.field_names.indexOf(name)]; }
  toString(): string { return `<${this.cls.name} ${this.serial.toString(16)}>`; }
}

export class Delegate {
  constructor(readonly id: number, public func: number, public bound: boolean, public recv: Obj | null) {}
  toString(): string { return `<delegate func ${this.func}${this.bound ? " bound" : ""}>`; }
}

export class DispatcherObj {
  constructor(readonly id: number, public count: number) {}
  toString(): string { return `<dispatcher, ${this.count} bound>`; }
}

export class Signal {
  constructor(readonly id: number) {}
}

/** A value of type `fault` (section 4.6). */
export class FaultValue {
  constructor(readonly message: string, readonly code: number) {}
}

/** Decodes the runtime's JSON values, keeping one JS object per runtime object. */
export class Decoder {
  objs = new Map<number, Obj>();
  handles = new Map<number, Delegate | DispatcherObj | Signal>();

  value(j: any): any {
    if (j === null || typeof j !== "object") return j;
    if (Array.isArray(j)) return j.map((x) => this.value(x));
    if ("f" in j) return floatFromHex(j.f);
    if ("i" in j) return BigInt(j.i);
    if ("m" in j) return new Map(j.m.map(([k, x]: [any, any]) => [this.value(k), this.value(x)]));
    if ("o" in j) {
      let o = this.objs.get(j.o);
      if (!o) this.objs.set(j.o, o = new Obj(j.o, { name: j.c ?? "", field_names: j.n ?? [] }, [], j.s ?? 0));
      if ("v" in j) {
        o.cls = { name: j.c, field_names: j.n };
        o.fields = j.v.map((x: any) => this.value(x));
      }
      return o;
    }
    if ("d" in j) return this.handle(j.d, () => new Delegate(j.d, j.func, j.bound, null), (d: Delegate) => {
      d.recv = this.value(j.recv);
    });
    if ("disp" in j) return this.handle(j.disp, () => new DispatcherObj(j.disp, j.n), (d: DispatcherObj) => { d.count = j.n; });
    if ("sig" in j) return this.handle(j.sig, () => new Signal(j.sig), () => {});
    if ("fault" in j) return new FaultValue(j.fault[0], j.fault[1]);
    throw new Error(`the runtime sent a value this page cannot read: ${JSON.stringify(j)}`);
  }

  private handle<T extends Delegate | DispatcherObj | Signal>(id: number, make: () => T, update: (x: T) => void): T {
    let h = this.handles.get(id) as T | undefined;
    if (!h) this.handles.set(id, h = make());
    update(h);
    return h;
  }
}

/** A host value as the runtime's JSON. */
export function encodeValue(v: any): any {
  if (v === null || v === undefined) return null;
  switch (typeof v) {
    case "boolean": return v ? 1 : 0;
    case "string": return v;
    case "bigint": return { i: BigInt.asIntN(64, v).toString() };
    case "number": return Number.isInteger(v) && !Object.is(v, -0) && Math.abs(v) < 2 ** 53 ? v : { f: floatHex(v) };
  }
  if (v instanceof Obj || v instanceof Delegate || v instanceof DispatcherObj || v instanceof Signal) return { h: v.id };
  if (v instanceof FaultValue) return { fault: [v.message, v.code] };
  if (v instanceof Map) return { m: [...v].map(([k, x]) => [encodeValue(k), encodeValue(x)]) };
  if (v instanceof Set) return { m: [...v].map((k) => [encodeValue(k), null]) };
  if (Array.isArray(v) || ArrayBuffer.isView(v)) return Array.from(v as ArrayLike<any>, encodeValue);
  throw new WiretError(STATUS_API, `cannot pass a ${v?.constructor?.name ?? typeof v} to the VM`);
}

// -- modules, fibers and frames ------------------------------------------------------------------
export interface FuncInfo { name: string; index: number; latent: boolean; nparams: number }

export class LoadedModule {
  /** exported function name -> function index */
  exports = new Map<string, number>();
  funcs = new Map<string, FuncInfo>();
  global_names: Map<string, number>;
  classes: Set<string>;
  capabilities: string[];
  name: string;

  constructor(readonly vm: VM, readonly index: number, info: any) {
    this.name = info.name;
    for (const [name, fi, latent, nparams] of info.exports) {
      this.exports.set(name, fi);
      this.funcs.set(name, { name, index: fi, latent, nparams });
    }
    this.global_names = new Map(Object.entries(info.globals));
    this.classes = new Set(info.classes);
    this.capabilities = info.capabilities;
  }

  /** The value of global `index` (also from inside a debug hook). */
  global(index: number): any {
    return this.vm._global(this, index);
  }
}

export class Fiber {
  constructor(readonly vm: VM, readonly id: number) {}
  private info(): any { return this.vm._command({ op: "fiber", fiber: this.id }); }
  get status(): string { return this.info().status; }
  get results(): any[] | null {
    const r = this.info().results;
    return r === null ? null : this.vm._decode(r);
  }
  get error(): WiretError | null {
    const e = this.info().error;
    return e === null ? null : wiretError(e);
  }
  get waiting(): string | null { return this.info().waiting; }
  get wake(): number { return this.info().wake; }
}

/** One frame of the call stack while a debug hook runs. */
export class FrameView {
  constructor(public func: { name: string }, public node: string | null, private locals: [string, any][],
              private pins: [string, string, any][]) {}

  /** "node\0pin" -> [node, pin, value] for every pin kept in a local (wr.pins). */
  pinValues(): Map<string, [string, string, any]> {
    return new Map(this.pins.map(([n, p, v]) => [`${n}\0${p}`, [n, p, v]]));
  }

  namedLocals(): Map<string, any> {
    return new Map(this.locals);
  }
}

export type Hook = (fname: string, node: string, pending: () => string[], depth: number, snapshot: () => FrameView[],
                    phase: string) => void;

export interface VMOptions {
  output?: (line: string) => void;
  fuel?: number;
  hook?: Hook | null;
  capabilities?: Iterable<string> | null;
  deterministic?: boolean;
}

const finalizer = new FinalizationRegistry<number>((id) => rt.vmFree(id));

export class VM {
  readonly deterministic: boolean;
  private id: number;
  private dec = new Decoder();
  private sink: (line: string) => void;

  constructor(opts: VMOptions = {}) {
    this.deterministic = opts.deterministic ?? false;
    this.sink = opts.output ?? ((line) => console.log(line));
    const hook = opts.hook ?? null;
    const caps = opts.capabilities ?? null;
    const cb: rt.Callbacks = { output: (line) => this.sink(line) };
    if (hook !== null) {
      cb.hook = (phase, func, node, depth) => hook(func, node, () => rt.hookView(2), depth,
        () => (rt.hookView(0) as any[]).map((f) => new FrameView(
          { name: f.func }, f.node, f.locals.map(([n, v]: [string, any]) => [n, this.dec.value(v)]),
          f.pins.map(([n, p, v]: [string, string, any]) => [n, p, this.dec.value(v)]))),
        phase === 0 ? "enter" : "ready");
    }
    this.id = rt.vmNew({
      deterministic: this.deterministic, fuel: opts.fuel ?? 50_000_000, hook: hook !== null,
      capabilities: caps === null ? null : [...caps],
    }, cb);
    finalizer.register(this, this.id, this);
  }

  /** Free the runtime's memory for this VM now, rather than when it is garbage-collected. */
  free(): void {
    finalizer.unregister(this);
    rt.vmFree(this.id);
  }

  _command(req: object): any {
    if (!rt.alive(this.id)) throw new WiretError(STATUS_API, "this VM has been freed, or the runtime stopped");
    try {
      return unwrap(rt.command(this.id, req));
    } catch (e) {
      if (e instanceof rt.RuntimeTrap) throw trapError(e);
      throw e;
    }
  }

  _decode(j: any): any {
    return this.dec.value(j);
  }

  _global(m: LoadedModule, index: number): any {
    return this.dec.value(rt.inHook() ? rt.hookView(1, index) : this._command({ op: "global", module: m.index, index }));
  }

  load(data: Uint8Array): LoadedModule {
    let reply: any;
    try {
      reply = rt.load(this.id, data);
    } catch (e) {
      if (e instanceof rt.RuntimeTrap) throw trapError(e);
      throw e;
    }
    const info = unwrap(reply);
    return new LoadedModule(this, info.module, info);
  }

  grant(capability: string): void {
    this._command({ op: "grant", capability });
  }

  private list(req: object): any[] {
    return this.dec.value(this._command(req));
  }

  /** wr_call on a function that cannot suspend: its results, or a WiretError. */
  call(m: LoadedModule, name: string, args: any[]): any[] {
    return this.list({ op: "call", module: m.index, name, args: encodeValue(args) });
  }

  /** Call `name` and return its results; a latent function runs as a fiber, with idle virtual
   * time skipped. A method called without its receiver gets a new instance of its class. */
  runFunction(m: LoadedModule, name: string, args: any[]): any[] {
    return this.list({ op: "run_function", module: m.index, name, args: encodeValue(args) });
  }

  start(m: LoadedModule, name: string, args: any[], now = false): Fiber {
    return new Fiber(this, this._command({ op: "start", module: m.index, name, args: encodeValue(args), now }));
  }

  advance(dt = 0.0): Fiber[] {
    return (this._command({ op: "advance", dt }) as number[]).map((id) => new Fiber(this, id));
  }

  fire(signal: Signal): void {
    this._command({ op: "fire", signal: encodeValue(signal) });
  }

  kill(fb: Fiber): void {
    this._command({ op: "kill", fiber: fb.id });
  }

  signal(): Signal {
    return this.dec.value(this._command({ op: "signal" }));
  }

  nextWake(): number | null {
    return this._command({ op: "next_wake" });
  }

  get time(): number {
    return this._command({ op: "time" });
  }

  new(m: LoadedModule, cls: string): Obj {
    return this.dec.value(this._command({ op: "new", module: m.index, class: cls }));
  }

  callMethod(m: LoadedModule, obj: Obj | null, method: string, args: any[]): any[] {
    return this.list({ op: "call_method", module: m.index, obj: encodeValue(obj), method, args: encodeValue(args) });
  }

  delegate(m: LoadedModule, func: string, obj: Obj | null = null): Delegate {
    return this.dec.value(this._command({ op: "delegate", module: m.index, func, obj: encodeValue(obj) }));
  }

  broadcast(m: LoadedModule, obj: Obj, dispatcher: string, args: any[]): void {
    this._command({ op: "broadcast", module: m.index, obj: encodeValue(obj), dispatcher, args: encodeValue(args) });
  }

  interrupt(): void {
    this._command({ op: "interrupt" });
  }

  get stats(): { instructions: number; calls: number; replayable: boolean; fuel: number } {
    return this._command({ op: "stats" });
  }

  get fuel(): number {
    return this.stats.fuel;
  }

  /** Every API call and its outcome, in deterministic mode (section 4.10). */
  get input_log(): any[] {
    return this._command({ op: "input_log" });
  }
}

function trapError(e: Error): WiretError {
  if (/stack|recursion/i.test(e.message)) return new WiretError(STATUS_FAULT, "stack overflow");
  return new WiretError(STATUS_API, `the runtime stopped: ${e.message}`);
}

/** Verify a module with the runtime's verifier: the highest the operand stack gets in each
 * defined function. Throws a WiretError (WR_ERR_VERIFY) for a module that fails. */
export function verifyModule(data: Uint8Array): number[] {
  const r = rt.verify(data);
  if ("err" in r) throw new WiretError(STATUS_VERIFY, r.err);
  return r.ok;
}

/** wr_module_each_capability before loading. */
export function moduleCapabilities(data: Uint8Array): string[] {
  return unwrap(rt.moduleCapabilities(data));
}

export class ReplayMismatch extends Error {}

/** Run an input log again on a new deterministic VM and check that every call gives the same
 * result or fault, instruction count, fuel and output (section 4.10). */
export function replay(data: Uint8Array, log: any[], _opts: VMOptions = {}): { stats: { instructions: number } } {
  const r = rt.replay(data, log);
  if ("mismatch" in r) throw new ReplayMismatch(r.mismatch);
  if ("err" in r) throw new WiretError(STATUS_API, r.err);
  return { stats: r.ok };
}
