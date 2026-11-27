/** The custom sections of a WBC module the disassembler reads (spec section 5.4): names,
 * node ids (`wr.debug`), build metadata (`wr.meta`) and capabilities (`wr.caps`). The VM
 * (runtime/, in Rust) reads the same sections when it loads a module. */
import * as wbc from "./wbc.js";
import { WbcError, WbcModule } from "./wbc.js";

type DebugTable = Map<number, [string | null, [number, string][], string[]]>;

/** wr.caps: the capabilities the module declares it needs. */
export function parseCaps(m: WbcModule): string[] {
  const p = m.custom("wr.caps");
  if (!p) return [];
  const r = new wbc.Reader(p);
  const out: string[] = [];
  for (let n = r.u32(); n > 0; n--) out.push(r.name());
  return out;
}

export type Customs = [Map<number, string>, Map<number, Map<number, string>>, DebugTable, Map<string, any>];

/** Function names, local names, the node table of each function, and metadata (with each
 * class's name and field names under "class\0<type index>"). */
export function parseCustoms(m: WbcModule): Customs {
  const names = new Map<number, string>(), localNames = new Map<number, Map<number, string>>();
  const debug: DebugTable = new Map(), meta = new Map<string, any>();
  let p = m.custom("name");
  if (p) {
    const r = new wbc.Reader(p);
    for (let n = r.u32(); n > 0; n--) {
      const i = r.u32();
      names.set(i, r.name());
    }
    for (let n = r.u32(); n > 0; n--) {
      const fi = r.u32();
      const ln = new Map<number, string>();
      localNames.set(fi, ln);
      for (let k = r.u32(); k > 0; k--) {
        const li = r.u32();
        ln.set(li, r.name());
      }
    }
    for (let n = r.u32(); n > 0; n--) { r.u32(); r.name(); }
    if (!r.eof()) {
      for (let n = r.u32(); n > 0; n--) {
        const ti = r.u32();
        const cname = r.name();
        const fields: string[] = [];
        for (let k = r.u32(); k > 0; k--) fields.push(r.name());
        meta.set(`class\0${ti}`, [cname, fields]);
      }
    }
  }
  p = m.custom("wr.debug");
  if (p) {
    const r = new wbc.Reader(p);
    for (let n = r.u32(); n > 0; n--) {
      const fi = r.u32();
      const graph = r.name();
      const table: string[] = [];
      for (let k = r.u32(); k > 0; k--) table.push(r.name());
      const entries: [number, string][] = [];
      let pc = 0;
      for (let k = r.u32(); k > 0; k--) {
        pc += r.u32();
        const ni = r.u32();
        if (ni >= table.length) throw new WbcError("wr.debug node index out of range");
        entries.push([pc, table[ni]]);
      }
      debug.set(fi, [graph, entries, table]);
    }
  }
  p = m.custom("wr.meta");
  if (p) {
    const r = new wbc.Reader(p);
    for (const k of ["module", "id", "compiler", "registry", "semantic_hash", "layout_hash", "source_hash", "exports"]) {
      if (r.eof()) break;
      meta.set(k, r.name());
    }
  }
  return [names, localNames, debug, meta];
}
