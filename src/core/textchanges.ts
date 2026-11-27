/** Where a graph edit changed the source text, so the Source pane can flash it. */
import { SequenceMatcher } from "./difflib.js";
import { sortedBy } from "./pyutil.js";

/** changed runs on a line this close together are shown as one */
const MERGE_GAP = 2;

export interface Changes { lines: number[]; spans: [number, number, number][] }

const isSpace = (s: string) => s.trim() === "";
const lstripLen = (s: string) => s.length - s.replace(/^\s+/, "").length;

/** The lines of `nu` that changed and, on those lines, the columns that changed: 1-based
 * lines, 0-based end-exclusive columns. */
export function changes(old: string, nu: string): Changes {
  const a = old.split("\n"), b = nu.split("\n");
  const lines = new Set<number>();
  const spans: [number, number, number][] = [];
  for (const [op, i1, i2, j1, j2] of new SequenceMatcher<string>(null, a, b, false).getOpcodes()) {
    if (op === "equal") continue;
    if (op === "delete") {
      const at = Math.min(j1, b.length - 1);
      if (at >= 0 && !isSpace(b[at])) lines.add(at + 1);
      else if (at > 0) lines.add(at);
      continue;
    }
    if (op === "insert") {
      for (let j = j1; j < j2; j++) {
        const text = b[j];
        if (!isSpace(text)) {
          spans.push([j + 1, lstripLen(text), text.replace(/\s+$/, "").length]);
          lines.add(j + 1);
        }
      }
      continue;
    }
    const found = blockSpans(a.slice(i1, i2), b.slice(j1, j2), j1);
    spans.push(...found);
    for (const s of found) lines.add(s[0]);
    if (!found.length) lines.add(j1 + 1);
  }
  return { lines: sortedBy(lines), spans: merged(spans.map((s) => wholeWords(b[s[0] - 1], ...s))) };
}

const word = (ch: string | undefined) => ch !== undefined && /^[\p{L}\p{N}_]$/u.test(ch);

function wholeWords(text: string, line: number, start: number, end: number): [number, number, number] {
  while (start > 0 && word(text[start - 1]) && word(text[start])) start -= 1;
  while (end < text.length && word(text[end]) && word(text[end - 1])) end += 1;
  return [line, start, end];
}

function blockSpans(oldLines: string[], newLines: string[], first: number): [number, number, number][] {
  const a = oldLines.join("\n"), b = newLines.join("\n");
  const starts = [0];
  for (const text of newLines) starts.push(starts[starts.length - 1] + text.length + 1);
  const out: [number, number, number][] = [];
  for (const [op, , , j1, j2] of new SequenceMatcher<string>(null, a, b, false).getOpcodes()) {
    if (op === "equal" || j1 === j2) continue;
    newLines.forEach((text, k) => {
      const lo = Math.max(j1, starts[k]), hi = Math.min(j2, starts[k] + text.length);
      if (lo < hi && !isSpace(b.slice(lo, hi))) out.push([first + k + 1, lo - starts[k], hi - starts[k]]);
    });
  }
  return out;
}

function merged(spans: [number, number, number][]): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (const [line, start, end] of sortedBy(spans)) {
    const last = out[out.length - 1];
    if (last && last[0] === line && start - last[2] <= MERGE_GAP) last[2] = Math.max(last[2], end);
    else out.push([line, start, end]);
  }
  return out;
}
