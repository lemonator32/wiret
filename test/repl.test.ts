import { describe, expect, it } from "vitest";
import { incomplete, Session } from "../src/cli/repl.js";

function session() {
  const out: string[] = [], err: string[] = [];
  const s = new Session({ out: (l) => out.push(l), err: (l) => err.push(l) });
  const run = (...inputs: string[]) => {
    out.length = 0;
    err.length = 0;
    for (const i of inputs) s.submit(i);
    return { out: [...out], err: [...err] };
  };
  return { s, run };
}

describe("repl", () => {
  it("evaluates expressions", () => {
    const { run } = session();
    expect(run("Add#<i32>(.a <- 1, .b <- 2)").out).toEqual(["3"]);
    expect(run('"hi"').out).toEqual(["'hi'"]);
    expect(run("true").out).toEqual(["true"]);
  });

  it("runs statements, printing only new output", () => {
    const { run } = session();
    expect(run('Call host.Log(.message <- "one")').out).toEqual(["one"]);
    expect(run('exec Call host.Log(.message <- "two")').out).toEqual(["two"]);
    expect(run("Add#<i32>(.a <- 1, .b <- 1)").out).toEqual(["2"]);
  });

  it("declares and reads locals by assignment", () => {
    const { run } = session();
    run("score = 10");
    expect(run("score").out).toEqual(["10"]);
    run("score = Add#<i32>(.a <- GetLocal score(), .b <- 5)");
    expect(run("score").out).toEqual(["15"]);
    expect(run("Mul#<i32>(.a <- score, .b <- 2)").out).toEqual(["30"]);
    run("exec Branch(.cond <- true).then -> {\n  exec Call host.Log(.message <- \"in\")\n}");
    expect(run('Call host.Log(.message <- "after")').out).toEqual(["after"]);
    expect(run(":type score").out).toEqual(["i32"]);
  });

  it("adds and replaces declarations", () => {
    const { run } = session();
    run("@pure\nfunc Twice(x: i32) -> (result: i32) {\n  exec Entry()\n  exec Return(\n    .result <- Mul#<i32>(.a <- x, .b <- 2)\n  )\n}");
    expect(run("Call Twice(.x <- 4)").out).toEqual(["8"]);
    run("@pure\nfunc Twice(x: i32) -> (result: i32) {\n  exec Entry()\n  exec Return(\n    .result <- Add#<i32>(.a <- x, .b <- x)\n  )\n}");
    expect(run("Call Twice(.x <- 5)").out).toEqual(["10"]);
  });

  it("drops inputs that do not compile or fault, and can undo", () => {
    const { s, run } = session();
    const before = s.source();
    const r = run("exec Call nope.Missing()");
    expect(r.err.join("\n")).toMatch(/error/);
    expect(s.source()).toBe(before);
    expect(run("Div#<i32>(.a <- 1, .b <- 0)").err.join("\n")).toMatch(/WR_ERR_FAULT|divide/i);
    run('Call host.Log(.message <- "x")', ":undo");
    expect(s.source()).toBe(before);
  });

  it("prints the session as canonical text", () => {
    const { run } = session();
    run("n = 3");
    const text = run(":show").out.join("\n");
    expect(text).toContain("module repl");
    expect(text).toContain("local n: i32");
    expect(text).toContain("exec SetLocal n");
  });

  it("knows when an input continues", () => {
    expect(incomplete("exec Branch(")).toBe(true);
    expect(incomplete("@pure")).toBe(true);
    expect(incomplete('Call host.Log(.message <- "(")')).toBe(false);
    expect(incomplete("x = 1")).toBe(false);
  });
});
