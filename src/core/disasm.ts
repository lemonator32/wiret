/** Disassembler (`wiret dis`, spec section 5.8): bytecode with node ids from `wr.debug`. The
 * runtime does it (runtime/src/disasm.rs), from the same decoder that loads modules. */
import * as rt from "./runtime.js";
import { STATUS_LOAD, WiretError } from "./vm.js";

export function disassemble(data: Uint8Array): string {
  const r = rt.disassemble(data);
  if ("err" in r) throw new WiretError(STATUS_LOAD, r.err);
  return r.ok;
}
