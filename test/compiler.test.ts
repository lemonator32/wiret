import { describe, expect, it } from "vitest";
import pako from "pako";
import golden from "./golden/check.json";
import { CONTENT } from "../src/core/content.gen.js";
import { parse } from "../src/core/parser.js";
import { compileModule } from "../src/core/compiler.js";
const G = golden as Record<string, { diags: [string, string, string][]; wbc?: string; wbc_debug?: string }>;

/** An unsigned LEB128 at `p`: [value, next position]. */
function leb(b: Uint8Array, p: number): [number, number] {
  let v = 0, shift = 0;
  for (;;) {
    const x = b[p++];
    v += (x & 0x7F) * 2 ** shift;
    shift += 7;
    if (!(x & 0x80)) return [v, p];
  }
}

/** The module's sections, with the `wr.graph` custom section's payload inflated: zlib and
 * pako may compress the same text to different (equally valid) bytes, so the comparison is
 * of what they decompress to. Only the section container is read (spec section 5.1). */
function normal(b64: string | undefined): string[] | undefined {
  if (b64 === undefined) return undefined;
  const b = new Uint8Array(Buffer.from(b64, "base64"));
  const out = [Buffer.from(b.subarray(0, 12)).toString("hex")];
  let p = 12;
  while (p < b.length) {
    const id = b[p];
    const [size, start] = leb(b, p + 1);
    let body = b.subarray(start, start + size);
    if (id === 0) {
      const [n, q] = leb(body, 0);
      if (Buffer.from(body.subarray(q, q + n)).toString("utf8") === "wr.graph")
        body = new Uint8Array([...body.subarray(0, q + n), ...pako.inflate(body.subarray(q + n))]);
    }
    out.push(`${id}:${Buffer.from(body).toString("hex")}`);
    p = start + size;
  }
  return out;
}
const b64 = (b: Uint8Array | null) => (b ? Buffer.from(b).toString("base64") : undefined);

describe("checker and compiler match the Python prototype", () => {
  for (const [name, text] of Object.entries(CONTENT)) {
    it(name, () => {
      const r = compileModule(parse(text), text);
      expect(r.diags.map((d) => [d.severity, d.code, d.toString()])).toEqual(G[name].diags);
      expect(normal(b64(r.wbc))).toEqual(normal(G[name].wbc));
      const rd = compileModule(parse(text), text, true, true, null, true);
      expect(normal(b64(rd.wbc))).toEqual(normal(G[name].wbc_debug));
    });
  }
});
