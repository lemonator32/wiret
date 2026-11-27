import { describe, expect, it } from "vitest";
import pako from "pako";
import golden from "./golden/check.json";
import { CONTENT } from "../src/core/content.gen.js";
import { parse } from "../src/core/parser.js";
import { compileModule } from "../src/core/compiler.js";
import { decodeModule, encodeModule } from "../src/core/wbc.js";

const G = golden as Record<string, { diags: [string, string, string][]; wbc?: string; wbc_debug?: string }>;

/** The module with `wr.graph` inflated: zlib and pako may compress the same text to
 * different (equally valid) bytes, so the comparison is of what they decompress to. */
function normal(b64: string | undefined): string | undefined {
  if (b64 === undefined) return undefined;
  const m = decodeModule(new Uint8Array(Buffer.from(b64, "base64")));
  m.customs = m.customs.map(([n, p]) => [n, n === "wr.graph" ? pako.inflate(p) : p]);
  return Buffer.from(encodeModule(m)).toString("base64");
}
const b64 = (b: Uint8Array | null) => (b ? Buffer.from(b).toString("base64") : undefined);

describe("checker and compiler match the Python prototype", () => {
  for (const [name, text] of Object.entries(CONTENT)) {
    it(name, () => {
      const r = compileModule(parse(text), text);
      expect(r.diags.map((d) => [d.severity, d.code, d.toString()])).toEqual(G[name].diags);
      expect(normal(b64(r.wbc))).toBe(normal(G[name].wbc));
      const rd = compileModule(parse(text), text, true, true, null, true);
      expect(normal(b64(rd.wbc))).toBe(normal(G[name].wbc_debug));
    });
  }
});
