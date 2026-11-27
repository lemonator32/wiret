import { describe, expect, it } from "vitest";
import golden from "./golden/print.json";
import { CONTENT } from "../src/core/content.gen.js";
import { parse } from "../src/core/parser.js";
import { layoutHash, printModule, semanticHash } from "../src/core/printer.js";

const G = golden as Record<string, { canonical: string; semantic_hash: string; layout_hash: string }>;

describe("canonical printer matches the Python prototype", () => {
  for (const [name, text] of Object.entries(CONTENT)) {
    it(name, () => {
      const m = parse(text);
      expect(printModule(m)).toBe(G[name].canonical);
      expect(semanticHash(parse(text))).toBe(G[name].semantic_hash);
      expect(layoutHash(parse(text))).toBe(G[name].layout_hash);
    });
  }
});
