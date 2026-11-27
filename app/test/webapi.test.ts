import { describe, expect, it } from "vitest";
import golden from "./golden/web.json";
import { CONTENT } from "../src/core/content.gen.js";
import { check, debugRun } from "../src/core/webapi.js";

const G = golden as unknown as Record<string, { check_json: any; debug_run: any }>;
/** JSON as Python wrote it, so the comparison is of data (TS keeps -0, bigints, etc.). */
const norm = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? Number(x) : x)));

describe("webapi.check matches", () => {
  for (const [name, text] of Object.entries(CONTENT)) {
    it(name, () => expect(norm(check(text))).toEqual(G[name].check_json));
  }
});

describe("webapi.debugRun matches", () => {
  for (const [name, text] of Object.entries(CONTENT)) {
    if (name.startsWith("std/")) continue;
    // The prototype shows an unset interface or delegate as Python's "None"; the port shows
    // "null", as it does for a class. That one difference is accepted here.
    const expected = JSON.parse(JSON.stringify(G[name]?.debug_run ?? null).replace(/"None"/g, '"null"'));
    // `bytecode` is the page's Bytecode tab; the prototype's web API has no such field, and
    // compiler.test.ts checks the disassembly itself.
    it(name, () => {
      const { bytecode: _bytecode, ...got } = debugRun(text, "Main");
      expect(norm(got)).toEqual(expected);
    });
  }
});
