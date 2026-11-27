import { describe, expect, it } from "vitest";
import golden from "./golden/edits.json";
import { CONTENT } from "../src/core/content.gen.js";
import { edit, literalPrompt, menu } from "../src/core/webapi.js";
import { sha256Hex } from "../src/core/pyutil.js";

type Case = [[string, string, any], any];
const G = golden as unknown as Record<string, { edits?: Case[] }>;

describe("canvas edits, menus and prompts match the Python prototype", () => {
  for (const [name, text] of Object.entries(CONTENT)) {
    const cases = G[name]?.edits;
    if (!cases) continue;
    it(`${name} (${cases.length} cases)`, () => {
      for (const [[graph, kind, req], want] of cases) {
        let got: any = kind === "menu" ? menu(text, graph, req)
          : kind === "prompt" ? literalPrompt(text, graph, req[0], req[1])
          : edit(text, graph, structuredClone(req));
        if (kind === "edit" && got.text !== undefined) got = { ...got, text: sha256Hex(got.text) };
        expect(JSON.parse(JSON.stringify(got)), `${kind} ${JSON.stringify(req)}`).toEqual(want);
      }
    });
  }
});
