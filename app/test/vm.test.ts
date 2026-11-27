import { describe, expect, it } from "vitest";
import runGolden from "./golden/run.json";
import disGolden from "./golden/disasm.json";
import { CONTENT } from "../src/core/content.gen.js";
import { parse } from "../src/core/parser.js";
import { compileModule } from "../src/core/compiler.js";
import { VM, WiretError } from "../src/core/vm.js";
import { formatResults, runFunction } from "../src/core/runner.js";
import { disassemble } from "../src/core/disasm.js";

type Run = { ok: boolean; output: string[]; result: string | null; error: string | null };
const R = runGolden as unknown as Record<string, { run: Run; run_det: Run }>;
const DIS = disGolden as unknown as Record<string, { disasm?: string }>;

function run(text: string, deterministic: boolean) {
  const m = parse(text);
  const r = compileModule(m, text, true, false, null, true);
  const output: string[] = [];
  if (!r.ok) return { ok: false, output, result: null, error: null };
  const vm = new VM({ output: (l) => output.push(l), deterministic });
  try {
    const lm = vm.load(r.wbc!);
    const res = runFunction(vm, lm, "Main", []);
    return { ok: true, output, result: formatResults(m, "Main", res), error: null };
  } catch (e) {
    if (!(e instanceof WiretError)) throw e;
    return { ok: false, output, result: null, error: e.toString() };
  }
}

describe("the VM runs every program as the Python prototype does", () => {
  for (const [name, text] of Object.entries(CONTENT)) {
    if (name.startsWith("std/")) continue;
    it(name, () => {
      for (const [det, g] of [[false, R[name].run], [true, R[name].run_det]] as const) {
        const got = run(text, det);
        expect(got.output).toEqual(g.output);
        expect(got.result).toBe(g.result);
        expect(got.ok).toBe(g.ok);
        if (g.error) expect(got.error).toBe(g.error);
      }
    });
  }
});

describe("the disassembler matches", () => {
  for (const [name, text] of Object.entries(CONTENT)) {
    if (!DIS[name]?.disasm) continue;
    it(name, () => {
      const r = compileModule(parse(text), text);
      expect(disassemble(r.wbc!)).toBe(DIS[name].disasm);
    });
  }
});
