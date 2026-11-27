/** Disassembler (`wiretc dis`, spec section 5.8): bytecode with node ids from `wr.debug`. */
import * as lanes from "./lanes.js";
import * as wbc from "./wbc.js";
import { parseCaps, parseCustoms } from "./customs.js";
import { ArrayType, ClassType, decodeCode, FuncType, vtName } from "./wbc.js";
import { cpLen, floatRepr, pyRepr } from "./pyutil.js";

/** An immediate as Python's str() writes it: floats with repr, bigints plainly. */
function imm(x: any): string {
  if (typeof x === "number" && !Number.isInteger(x)) return floatRepr(x);
  if (typeof x === "number" && Object.is(x, -0)) return "-0.0";
  return String(x);
}

export function disassemble(data: Uint8Array): string {
  const m = wbc.decodeModule(data);
  const [names, localNames, debug, meta] = parseCustoms(m);
  const classes = new Map<number, [string, string[]]>();
  for (const [k, v] of meta) if (k.startsWith("class\0")) classes.set(parseInt(k.split("\0")[1], 10), v);
  wbc.CLASS_NAMES.clear();
  for (const [ti, [name]] of classes) wbc.CLASS_NAMES.set(ti, name);
  const out: string[] = [];
  if (meta.size) {
    out.push(`; module ${meta.get("module") ?? ""}  compiler ${meta.get("compiler") ?? ""}` +
             (meta.has("exports") ? `  exports ${meta.get("exports")}` : ""));
    out.push(`; semantic hash ${(meta.get("semantic_hash") ?? "").slice(0, 16)}  layout hash ${(meta.get("layout_hash") ?? "").slice(0, 16)}`);
  }
  const vts = (xs: wbc.VT[]) => xs.map((p) => vtName(p, m.types)).join(", ");
  m.imports.forEach(([mod, fld, t, flags], i) => {
    const [params, results] = m.types[t] as FuncType;
    out.push(`import ${i} ${mod}.${fld} (${vts(params)}) -> (${vts(results)})` + (flags & 1 ? " pure" : ""));
  });
  for (const cap of parseCaps(m)) out.push(`capability ${cap}`);
  const nimp = m.imports.length;
  const gnames = new Map<number, string>();
  const p = m.custom("name");
  if (p) {
    const r = new wbc.Reader(p);
    for (let n = r.u32(); n > 0; n--) { r.u32(); r.name(); }
    for (let n = r.u32(); n > 0; n--) {
      r.u32();
      for (let k = r.u32(); k > 0; k--) { r.u32(); r.name(); }
    }
    for (let n = r.u32(); n > 0; n--) {
      const gi = r.u32();
      gnames.set(gi, r.name());
    }
  }
  m.globals.forEach(([vt], gi) => out.push(`global ${gi} ${vtName(vt, m.types)} ${gnames.get(gi) ?? ""}`.trimEnd()));
  m.funcs.forEach(([t, flags], i) => {
    const body = m.bodies[i];
    const fi = nimp + i;
    const [params, results] = m.types[t] as FuncType;
    const lnames = localNames.get(fi) ?? new Map<number, string>();
    const tags = ([[wbc.FN_PURE, "pure"], [wbc.FN_EVENT, "event"], [wbc.FN_LATENT, "latent"]] as [number, string][])
      .filter(([b]) => flags & b).map(([, s]) => s);
    out.push("");
    out.push(`func ${names.get(fi) ?? `func${fi}`} (${vts(params)}) -> (${vts(results)})` + (tags.length ? `  [${tags.join(", ")}]` : ""));
    const locs = body.locals.map((vt, k) => `${params.length + k}:${vtName(vt, m.types)} ${lnames.get(params.length + k) ?? ""}`.trimEnd());
    if (locs.length) out.push("  locals: " + locs.join(", "));
    out.push(`  max_stack: ${body.max_stack}`);
    const instrs = decodeCode(body.code);
    const labels = new Map((debug.get(fi)?.[1] ?? []).map(([pc, node]) => [pc, node]));
    const branchy = ["br", "br_if", "cont.push", "try.push"];
    const targets = new Set(instrs.filter((ins) => branchy.includes(ins.name)).map((ins) => ins.target()));
    for (const ins of instrs) {
      if (labels.has(ins.pc)) out.push(`.${labels.get(ins.pc)}:`);
      else if (targets.has(ins.pc)) out.push(`.pc${ins.pc}:`);
      let text = ins.name;
      let comment = "";
      const n = ins.name;
      if (branchy.includes(n)) {
        const tg = ins.target();
        text += " ." + (labels.get(tg) ?? `pc${tg}`);
        if (n === "try.push") {
          text += ` ${ins.imms[1]}`;
          comment = lnames.get(ins.imms[1]) ?? "";
        }
      } else if (n === "call") text += ` ${names.get(ins.imms[0]) ?? ins.imms[0]}`;
      else if (n === "call_virtual" && ins.imms[0] < m.types.length) {
        const [tt, slot] = ins.imms;
        text += ` ${tt} ${slot}`;
        const e = m.types[tt];
        const vt = e instanceof ClassType ? e.vtable : [];
        if (slot < vt.length) comment = `${classes.get(tt)?.[0] ?? "class " + tt} slot ${slot}: ${names.get(vt[slot]) ?? vt[slot]}`;
      } else if (n === "delegate.new") {
        const [f, fl] = ins.imms;
        text += ` ${f} ${fl}`;
        comment = String(names.get(f) ?? f) + (fl & 1 ? " + receiver" : "") + (fl & 2 ? ", its override" : "");
      } else if (n === "call_interface") {
        const [tt, k] = ins.imms;
        text += ` ${tt} ${k}`;
        comment = `${classes.get(tt)?.[0] ?? "interface " + tt} method ${k}`;
      } else if ((n.startsWith("class.") || n.startsWith("ref.")) && ins.imms.length) {
        const tt = ins.imms[0];
        text += " " + ins.imms.map(imm).join(" ");
        const [cname, fnames] = classes.get(tt) ?? [`class ${tt}`, []];
        comment = cname;
        if ((n === "class.get" || n === "class.set") && ins.imms[1] < fnames.length) comment = `${cname}.${fnames[ins.imms[1]]}`;
      } else if (n.startsWith("local.")) {
        text += ` ${ins.imms[0]}`;
        comment = lnames.get(ins.imms[0]) ?? "";
      } else if (n.startsWith("global.")) {
        text += ` ${ins.imms[0]}`;
        comment = gnames.get(ins.imms[0]) ?? "";
      } else if (n === "string.const") {
        text += ` ${ins.imms[0]}`;
        const s = m.data[ins.imms[0]];
        comment = pyRepr(cpLen(s) < 40 ? s : Array.from(s).slice(0, 37).join("") + "...");
      } else if (n.startsWith("array.") && ins.imms.length) {
        const tt = ins.imms[0];
        text += ` ${tt}`;
        const e = tt < m.types.length ? m.types[tt] : null;
        if (e instanceof ArrayType) comment = `array#<${vtName(e.elem, m.types)}>`;
      } else if (ins.op > 0xFF && ins.imms.length) {
        text += ` ${ins.imms[0]}`;
        const ty = lanes.BLOCKS[n.split(".")[0]][1];
        comment = `${ty}.${lanes.LANE_FIELDS[ty][ins.imms[0]][0]}`;
      } else if (n === "f32.const" || n === "f64.const") text += " " + floatRepr(ins.imms[0]);
      else if (ins.imms.length) text += " " + ins.imms.map(imm).join(" ");
      let line = `  ${text}`;
      if (comment) line = `${line.padEnd(26)}; ${comment}`;
      out.push(line);
    }
  });
  return out.join("\n") + "\n";
}
