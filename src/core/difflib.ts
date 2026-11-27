/** A port of the parts of Python's difflib the prototype uses: SequenceMatcher (with the
 * same junk heuristic, so it finds the same matches) and unified_diff. */

export type Opcode = ["replace" | "delete" | "insert" | "equal", number, number, number, number];
type Match = [number, number, number];

export class SequenceMatcher<T = string> {
  private a: readonly T[] = [];
  private b: readonly T[] = [];
  private b2j = new Map<T, number[]>();
  private bjunk = new Set<T>();
  private bpopular = new Set<T>();
  private matchingBlocks: Match[] | null = null;
  private opcodes: Opcode[] | null = null;

  constructor(isjunk: ((x: T) => boolean) | null = null, a: readonly T[] | string = [],
              b: readonly T[] | string = [], private autojunk = true) {
    this.isjunk = isjunk;
    this.setSeqs(a, b);
  }
  private isjunk: ((x: T) => boolean) | null;

  setSeqs(a: readonly T[] | string, b: readonly T[] | string): void {
    this.setSeq1(a);
    this.setSeq2(b);
  }

  setSeq1(a: readonly T[] | string): void {
    this.a = (typeof a === "string" ? Array.from(a) : a) as readonly T[];
    this.matchingBlocks = this.opcodes = null;
  }

  setSeq2(b: readonly T[] | string): void {
    this.b = (typeof b === "string" ? Array.from(b) : b) as readonly T[];
    this.matchingBlocks = this.opcodes = null;
    this.chainB();
  }

  private chainB(): void {
    const b = this.b;
    const b2j = new Map<T, number[]>();
    b.forEach((elt, i) => {
      let idx = b2j.get(elt);
      if (!idx) b2j.set(elt, idx = []);
      idx.push(i);
    });
    const junk = new Set<T>();
    if (this.isjunk) {
      for (const elt of b2j.keys()) if (this.isjunk(elt)) junk.add(elt);
      for (const elt of junk) b2j.delete(elt);
    }
    const popular = new Set<T>();
    const n = b.length;
    if (this.autojunk && n >= 200) {
      const ntest = Math.floor(n / 100) + 1;
      for (const [elt, idxs] of b2j) if (idxs.length > ntest) popular.add(elt);
      for (const elt of popular) b2j.delete(elt);
    }
    this.b2j = b2j;
    this.bjunk = junk;
    this.bpopular = popular;
  }

  findLongestMatch(alo = 0, ahi: number | null = null, blo = 0, bhi: number | null = null): Match {
    const a = this.a, b = this.b, b2j = this.b2j, isbjunk = (x: T) => this.bjunk.has(x);
    if (ahi === null) ahi = a.length;
    if (bhi === null) bhi = b.length;
    let besti = alo, bestj = blo, bestsize = 0;
    let j2len = new Map<number, number>();
    const nothing: number[] = [];
    for (let i = alo; i < ahi; i++) {
      const newj2len = new Map<number, number>();
      for (const j of b2j.get(a[i]) ?? nothing) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) { besti = i - k + 1; bestj = j - k + 1; bestsize = k; }
      }
      j2len = newj2len;
    }
    while (besti > alo && bestj > blo && !isbjunk(b[bestj - 1]) && a[besti - 1] === b[bestj - 1]) {
      besti--; bestj--; bestsize++;
    }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && !isbjunk(b[bestj + bestsize]) &&
           a[besti + bestsize] === b[bestj + bestsize]) bestsize++;
    while (besti > alo && bestj > blo && isbjunk(b[bestj - 1]) && a[besti - 1] === b[bestj - 1]) {
      besti--; bestj--; bestsize++;
    }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && isbjunk(b[bestj + bestsize]) &&
           a[besti + bestsize] === b[bestj + bestsize]) bestsize++;
    return [besti, bestj, bestsize];
  }

  getMatchingBlocks(): Match[] {
    if (this.matchingBlocks) return this.matchingBlocks;
    const la = this.a.length, lb = this.b.length;
    const queue: [number, number, number, number][] = [[0, la, 0, lb]];
    const blocks: Match[] = [];
    while (queue.length) {
      const [alo, ahi, blo, bhi] = queue.pop()!;
      const x = this.findLongestMatch(alo, ahi, blo, bhi);
      const [i, j, k] = x;
      if (k) {
        blocks.push(x);
        if (alo < i && blo < j) queue.push([alo, i, blo, j]);
        if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
      }
    }
    blocks.sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2]);
    let i1 = 0, j1 = 0, k1 = 0;
    const nonAdjacent: Match[] = [];
    for (const [i2, j2, k2] of blocks) {
      if (i1 + k1 === i2 && j1 + k1 === j2) k1 += k2;
      else {
        if (k1) nonAdjacent.push([i1, j1, k1]);
        i1 = i2; j1 = j2; k1 = k2;
      }
    }
    if (k1) nonAdjacent.push([i1, j1, k1]);
    nonAdjacent.push([la, lb, 0]);
    return this.matchingBlocks = nonAdjacent;
  }

  getOpcodes(): Opcode[] {
    if (this.opcodes) return this.opcodes;
    let i = 0, j = 0;
    const answer: Opcode[] = [];
    for (const [ai, bj, size] of this.getMatchingBlocks()) {
      let tag: Opcode[0] | "" = "";
      if (i < ai && j < bj) tag = "replace";
      else if (i < ai) tag = "delete";
      else if (j < bj) tag = "insert";
      if (tag) answer.push([tag, i, ai, j, bj]);
      i = ai + size;
      j = bj + size;
      if (size) answer.push(["equal", ai, i, bj, j]);
    }
    return this.opcodes = answer;
  }

  getGroupedOpcodes(n = 3): Opcode[][] {
    let codes = this.getOpcodes().map((c) => [...c] as Opcode);
    if (!codes.length) codes = [["equal", 0, 1, 0, 1]];
    if (codes[0][0] === "equal") {
      const [tag, i1, i2, j1, j2] = codes[0];
      codes[0] = [tag, Math.max(i1, i2 - n), i2, Math.max(j1, j2 - n), j2];
    }
    const last = codes.length - 1;
    if (codes[last][0] === "equal") {
      const [tag, i1, i2, j1, j2] = codes[last];
      codes[last] = [tag, i1, Math.min(i2, i1 + n), j1, Math.min(j2, j1 + n)];
    }
    const nn = n + n;
    const groups: Opcode[][] = [];
    let group: Opcode[] = [];
    for (let [tag, i1, i2, j1, j2] of codes) {
      if (tag === "equal" && i2 - i1 > nn) {
        group.push([tag, i1, Math.min(i2, i1 + n), j1, Math.min(j2, j1 + n)]);
        groups.push(group);
        group = [];
        i1 = Math.max(i1, i2 - n);
        j1 = Math.max(j1, j2 - n);
      }
      group.push([tag, i1, i2, j1, j2]);
    }
    if (group.length && !(group.length === 1 && group[0][0] === "equal")) groups.push(group);
    return groups;
  }

  ratio(): number {
    const matches = this.getMatchingBlocks().reduce((s, m) => s + m[2], 0);
    const len = this.a.length + this.b.length;
    return len ? 2.0 * matches / len : 1.0;
  }
}

function formatRange(start: number, stop: number): string {
  let beginning = start + 1;
  const length = stop - start;
  if (length === 1) return `${beginning}`;
  if (!length) beginning -= 1;
  return `${beginning},${length}`;
}

/** difflib.unified_diff over lists of lines (each keeping its "\n"). */
export function unifiedDiff(a: string[], b: string[], fromfile = "", tofile = "",
                            fromfiledate = "", tofiledate = "", n = 3, lineterm = "\n"): string[] {
  const out: string[] = [];
  let started = false;
  for (const group of new SequenceMatcher<string>(null, a, b).getGroupedOpcodes(n)) {
    if (!started) {
      started = true;
      const fromdate = fromfiledate ? `\t${fromfiledate}` : "";
      const todate = tofiledate ? `\t${tofiledate}` : "";
      out.push(`--- ${fromfile}${fromdate}${lineterm}`);
      out.push(`+++ ${tofile}${todate}${lineterm}`);
    }
    const first = group[0], last = group[group.length - 1];
    const file1 = formatRange(first[1], last[2]);
    const file2 = formatRange(first[3], last[4]);
    out.push(`@@ -${file1} +${file2} @@${lineterm}`);
    for (const [tag, i1, i2, j1, j2] of group) {
      if (tag === "equal") {
        for (const line of a.slice(i1, i2)) out.push(" " + line);
        continue;
      }
      if (tag === "replace" || tag === "delete") for (const line of a.slice(i1, i2)) out.push("-" + line);
      if (tag === "replace" || tag === "insert") for (const line of b.slice(j1, j2)) out.push("+" + line);
    }
  }
  return out;
}

/** str.splitlines(keepends=True) for "\n", "\r\n" and "\r" line ends. */
export function splitlinesKeep(s: string): string[] {
  const out: string[] = [];
  const re = /[^\n\r]*(\r\n|\n|\r|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) && m[0] !== "") {
    out.push(m[0]);
    if (re.lastIndex >= s.length) break;
  }
  return out;
}
