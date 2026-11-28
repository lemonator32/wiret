import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { explain, moduleName, scaffold } from "../src/cli/project.js";
import { check, hasErrors } from "../src/core/checker.js";
import { DIAGNOSTICS } from "../src/core/content.gen.js";
import { findProject, FileSystem } from "../src/core/ids.js";
import { parse } from "../src/core/parser.js";

const fs: FileSystem = {
  exists: existsSync, readText: (p) => readFileSync(p, "utf8"), writeText: (p, t) => writeFileSync(p, t),
  appendText: (p, t) => appendFileSync(p, t), join: (...p) => path.join(...p), dirname: path.dirname,
  abspath: (p) => path.resolve(p),
};

function capture() {
  const o: string[] = [], e: string[] = [];
  return { io: { out: (s: string) => o.push(s), err: (s: string) => e.push(s) }, out: () => o.join(""), err: () => e.join("") };
}

describe("wiret explain", () => {
  it("has every code the spec lists, split where a row lists two", () => {
    expect(DIAGNOSTICS.E0310).toMatch(/dominate/);
    expect(DIAGNOSTICS.E0101).not.toMatch(/duplicate/);
    expect(DIAGNOSTICS.E0102).toMatch(/duplicate/);
    expect(DIAGNOSTICS.E0502).toMatch(/type argument/);
  });

  it("explains codes in any case, and runtime statuses", () => {
    const c = capture();
    expect(explain(["e0310", "WR_ERR_FUEL", "ERR_LINK"], c.io)).toBe(0);
    expect(c.out()).toMatch(/^E0310 \(error\): Read of an impure output/);
    expect(c.out()).toMatch(/WR_ERR_FUEL \(runtime status\)/);
    expect(c.out()).toMatch(/WR_ERR_LINK/);
  });

  it("rejects unknown codes and lists all without one", () => {
    const c = capture();
    expect(explain(["E0199"], c.io)).toBe(2);
    expect(c.err()).toMatch(/codes like it: E0101/);
    const all = capture();
    explain([], all.io);
    expect(all.out().split("\n").filter((l) => /^[EW]\d{4} /.test(l))).toHaveLength(Object.keys(DIAGNOSTICS).length);
  });
});

describe("wiret new", () => {
  it("names modules from directory names", () => {
    expect(moduleName("My-Game")).toBe("my_game");
    expect(moduleName("2d")).toBe("app_2d");
    expect(moduleName("/x/demo/")).toBe("demo");
  });

  it("writes a project whose starter file checks clean inside it", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wiret-new-"));
    try {
      const dir = path.join(root, "my-game");
      const c = capture();
      expect(scaffold(dir, true, c.io)).toEqual(["wiret.toml", "src/my_game/main.wiret", ".gitignore"]);
      const file = path.join(dir, "src/my_game/main.wiret");
      const project = findProject(fs, file);
      expect(project?.capabilities?.has("console.write")).toBe(true);
      const diags = check(parse(readFileSync(file, "utf8")), false, project);
      expect(diags.map(String)).toEqual([]);
      expect(hasErrors(diags)).toBe(false);
      // a second time is refused, and init keeps existing files
      expect(scaffold(dir, true, capture().io)).toBeNull();
      const other = path.join(root, "existing");
      scaffold(other, false, c.io);
      rmSync(path.join(other, "wiret.toml"));
      writeFileSync(path.join(other, ".gitignore"), "mine\n");
      expect(scaffold(other, false, c.io)).toEqual(["wiret.toml"]);
      expect(readFileSync(path.join(other, ".gitignore"), "utf8")).toBe("mine\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
