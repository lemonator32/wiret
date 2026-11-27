/** The natives the runtime provides (spec sections 3.4 and 6.6), as the compiler and editor
 * see them: name, signature, purity and documentation. The implementations, and this table,
 * live in the Rust runtime (runtime/src/natives.rs); the tables here are read from it, so the
 * runtime must be loaded (`init()` in vm.ts) before they are used. */
import * as rt from "./runtime.js";

export interface NativeSpec {
  params: [string, string][];
  results: [string, string][];
  purity: string;
  doc: string;
  capability: string | null;
}

/** The `std.*` library a program calls. */
export const stdNatives = (): Record<string, NativeSpec> => rt.natives().std;

/** Natives the compiler calls on its own to lower `Convert<X, string>`, float `Rem`, faults and
 * container `Eq`. */
export const internalNatives = (): Record<string, NativeSpec> => rt.natives().internal;

/** Culture-independent, shortest round-tripping text (section 3.2). */
export const floatToText = (x: number, single = false): string => rt.floatText(x, single);
