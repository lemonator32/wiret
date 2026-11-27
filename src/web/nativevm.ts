/** The bytecode runtime running natively in the desktop app (src-tauri/src/runtime.rs), for
 * the page. It is the same `wiret-runtime` crate the page loads as WebAssembly (core/vm.ts),
 * but it runs in the app's process on its own thread, so a long program does not block the
 * page and `interrupt()` can stop it.
 *
 * Every call is async (it crosses Tauri's IPC). Values are decoded as core/vm.ts decodes them.
 * Only available in the desktop app: check `NativeVM.available` first.
 *
 *   const vm = await NativeVM.create({ deterministic: true }, (line) => console.log(line));
 *   const m = await vm.load(bytes);
 *   const results = await vm.runFunction(m, "Main", []);
 *   await vm.free(); */
import { Decoder, encodeValue, wiretError, WiretError } from "../core/vm.js";

export interface NativeModule {
  index: number;
  name: string;
  /** exported function name -> [function index, latent, parameter count] */
  exports: Map<string, [number, boolean, number]>;
  globals: Map<string, number>;
  classes: string[];
  capabilities: string[];
}

type Invoke = <T>(cmd: string, args: Record<string, unknown>) => Promise<T>;

let invokeFn: Invoke | null = null;
async function invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  if (invokeFn === null) invokeFn = (await import("@tauri-apps/api/core")).invoke as Invoke;
  return invokeFn<T>(cmd, args);
}

export class NativeVM {
  static readonly available = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

  private dec = new Decoder();
  private constructor(private id: number, private output: (line: string) => void) {}

  /** A new VM. Without `capabilities` it grants every capability the registered natives need. */
  static async create(opts: { deterministic?: boolean; fuel?: number; capabilities?: string[] | null } = {},
                      output: (line: string) => void = (l) => console.log(l)): Promise<NativeVM> {
    const id = await invoke<number>("runtime_new", {
      config: { deterministic: opts.deterministic ?? false, fuel: opts.fuel ?? 50_000_000, capabilities: opts.capabilities ?? null },
    });
    return new NativeVM(id, output);
  }

  /** A reply's value (after writing its output), or its error thrown. */
  private take(reply: any): any {
    for (const line of reply.output ?? []) this.output(line);
    if ("err" in reply) throw wiretError(reply.err);
    return reply.ok;
  }

  private async command(req: object): Promise<any> {
    return this.take(await invoke("runtime_command", { id: this.id, request: req }));
  }

  async load(bytes: Uint8Array): Promise<NativeModule> {
    const info = this.take(await invoke("runtime_load", { id: this.id, bytes: Array.from(bytes) }));
    return {
      index: info.module,
      name: info.name,
      exports: new Map(info.exports.map(([n, fi, latent, np]: [string, number, boolean, number]) => [n, [fi, latent, np]])),
      globals: new Map(Object.entries(info.globals)),
      classes: info.classes,
      capabilities: info.capabilities,
    };
  }

  /** A function that cannot suspend: its results. */
  async call(m: NativeModule, name: string, args: any[] = []): Promise<any[]> {
    return this.dec.value(await this.command({ op: "call", module: m.index, name, args: encodeValue(args) }));
  }

  /** Any function, latent ones too (idle virtual time is skipped): its results. */
  async runFunction(m: NativeModule, name: string, args: any[] = []): Promise<any[]> {
    return this.dec.value(await this.command({ op: "run_function", module: m.index, name, args: encodeValue(args) }));
  }

  /** Start a fiber; it runs on the next `advance` (or now). Its id. */
  async start(m: NativeModule, name: string, args: any[] = [], now = false): Promise<number> {
    return this.command({ op: "start", module: m.index, name, args: encodeValue(args), now });
  }

  /** Move virtual time forward by `dt` seconds and run what is due: the ids of the fibers that ran. */
  async advance(dt: number): Promise<number[]> {
    return this.command({ op: "advance", dt });
  }

  async fiber(id: number): Promise<{ status: string; results: any[] | null; error: WiretError | null; waiting: string | null; wake: number }> {
    const f = await this.command({ op: "fiber", fiber: id });
    return { ...f, results: f.results === null ? null : this.dec.value(f.results), error: f.error === null ? null : wiretError(f.error) };
  }

  async global(m: NativeModule, name: string): Promise<any> {
    const index = m.globals.get(name);
    if (index === undefined) throw new WiretError("WR_ERR_LINK", `no global '${name}'`);
    return this.dec.value(await this.command({ op: "global", module: m.index, index }));
  }

  /** Any other request of the runtime's protocol (runtime/src/bridge.rs), decoded. */
  async request(req: Record<string, unknown>): Promise<any> {
    return this.dec.value(await this.command(req));
  }

  /** Stop the code running now (from a Run that is taking too long). */
  async interrupt(): Promise<void> {
    await invoke("runtime_interrupt", { id: this.id });
  }

  async free(): Promise<void> {
    await invoke("runtime_free", { id: this.id });
  }
}
