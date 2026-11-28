/** Syntax highlighting for .wiret text: which spans of a line are keywords, strings,
 * attributes, comments, numbers or node kinds. The web page applies these rules as you type. */
import { KEYWORDS } from "./parser.js";
import { STATIC_KINDS } from "./registry.js";
import { sortedBy } from "./pyutil.js";

export const TOKEN = String.raw`"(?:[^"\\]|\\.)*"|//.*$|@[A-Za-z_.]+|#[A-Za-z_]+|\b[A-Za-z_]\w*\b|-?\b\d[\w.]*`;

export const OTHER_KINDS = ["Entry", "Return", "Call", "Macro", "Exit", "Leave", "Sequence", "Switch", "Reroute",
  "GetLocal", "SetLocal", "GetVar", "SetVar", "GetState", "SetState"];
export const KINDS = new Set([...Object.keys(STATIC_KINDS), ...OTHER_KINDS]);

/** The Source pane's colours (One Dark), by tag. */
export const COLORS = { kw: "#c678dd", str: "#98c379", attr: "#e5c07b", comment: "#7f848e", num: "#d19a66", kind: "#61afef" };
export type Tag = keyof typeof COLORS;

export function tagOf(token: string): Tag | null {
  if (token.startsWith('"')) return "str";
  if (token.startsWith("//")) return "comment";
  if (token.startsWith("@") || token.startsWith("#")) return "attr";
  if (/^\d/.test(token) || token[0] === "-") return "num";
  if (KEYWORDS.has(token)) return "kw";
  if (KINDS.has(token)) return "kind";
  return null;
}

const LEAD = /^\s*!?\s*$/;

/** Keywords are contextual (section 2.1): a keyword is one only where a statement starts. */
export function isName(line: string, start: number, end: number): boolean {
  const before = line.slice(0, start), after = line.slice(end);
  const word = line.slice(start, end);
  const rest = after.replace(/^\s+/, "");
  if (after.startsWith(".") || after.startsWith("(") || (rest.startsWith(":") && !rest.startsWith("::")) || rest.startsWith("="))
    return true;
  if (LEAD.test(before)) return false;
  const prev = before.split(/\s+/).filter(Boolean);
  return !((prev.length && prev[prev.length - 1] === "extern" && (word === "func" || word === "type")) ||
           (word === "impl" && prev.length && prev[0] === "class"));
}

/** [start, end, tag] for each coloured token in one line. */
export function spans(line: string): [number, number, Tag][] {
  const out: [number, number, Tag][] = [];
  for (const m of line.matchAll(new RegExp(TOKEN, "g"))) {
    let tag = tagOf(m[0]);
    const s = m.index!, e = s + m[0].length;
    if (tag === "kw" && isName(line, s, e)) tag = null;
    if (tag) out.push([s, e, tag]);
  }
  return out;
}

/** The last line (1-based) of the node written on `line`: where its input block closes. */
export function blockEnd(lines: string[], line: number): number {
  let depth = 0, braces = 0;
  for (let i = line - 1; i < lines.length; i++) {
    const s = lines[i];
    let j = 0;
    while (j < s.length) {
      const c = s[j];
      if (c === "/" && s[j + 1] === "/") break;
      if (c === '"') {
        j += 1;
        while (j < s.length && s[j] !== '"') j += s[j] === "\\" ? 2 : 1;
      } else if (c === "{") braces += 1;
      else if (c === "}") braces -= 1;
      else if (braces === 0 && c === "(") depth += 1;
      else if (braces === 0 && c === ")") {
        depth -= 1;
        if (depth === 0) return i + 1;
      }
      j += 1;
    }
    if (depth <= 0) return line;
  }
  return line;
}

/** Everything a highlighter needs: the token pattern, the word lists and the colours. */
export function rules(): { pattern: string; keywords: string[]; kinds: string[]; colors: typeof COLORS } {
  return { pattern: TOKEN, keywords: sortedBy(KEYWORDS), kinds: sortedBy(KINDS), colors: COLORS };
}
