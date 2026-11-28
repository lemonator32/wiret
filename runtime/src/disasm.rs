//! The disassembler (`wiret dis`, spec section 5.8): a module's bytecode as text, with the
//! node ids from `wr.debug` as labels. The format is the one the Python prototype wrote.
use std::collections::{HashMap, HashSet};

use crate::fmt::{float_repr, py_repr_str};
use crate::lanes;
use crate::vm::{parse_caps, parse_customs, parse_global_names};
use crate::wbc::{self, decode_code, vt_name_with, TypeEntry, Vt, WbcError, FN_EVENT, FN_LATENT, FN_PURE};

pub fn disassemble(data: &[u8]) -> Result<String, WbcError> {
    let m = wbc::decode_module(data)?;
    let cu = parse_customs(&m)?;
    let classes: HashMap<u32, (String, Vec<String>)> = cu.class_names.clone();
    let class_names: HashMap<u32, String> = classes.iter().map(|(k, (n, _))| (*k, n.clone())).collect();
    let vtn = |vt: Vt| vt_name_with(vt, &m.types, &class_names);
    let vts = |xs: &[Vt]| xs.iter().map(|v| vtn(*v)).collect::<Vec<_>>().join(", ");
    let fname = |i: usize| cu.names.get(&i).cloned().unwrap_or_else(|| format!("func{i}"));
    let mut out: Vec<String> = vec![];
    if !cu.meta.is_empty() || !classes.is_empty() {
        let g = |k: &str| cu.meta.get(k).cloned().unwrap_or_default();
        let mut head = format!("; module {}  compiler {}", g("module"), g("compiler"));
        if let Some(e) = cu.meta.get("exports") {
            head += &format!("  exports {e}");
        }
        out.push(head);
        let short = |s: String| s.chars().take(16).collect::<String>();
        out.push(format!("; semantic hash {}  layout hash {}", short(g("semantic_hash")), short(g("layout_hash"))));
    }
    for (i, imp) in m.imports.iter().enumerate() {
        let (params, results) = match m.types.get(imp.ty as usize) {
            Some(TypeEntry::Func(p, r)) => (p.as_slice(), r.as_slice()),
            _ => (&[][..], &[][..]),
        };
        out.push(format!(
            "import {i} {}.{} ({}) -> ({}){}",
            imp.module,
            imp.field,
            vts(params),
            vts(results),
            if imp.flags & 1 != 0 { " pure" } else { "" }
        ));
    }
    for cap in parse_caps(&m)? {
        out.push(format!("capability {cap}"));
    }
    let nimp = m.imports.len();
    let gnames: HashMap<usize, String> = parse_global_names(&m).into_iter().map(|(n, i)| (i, n)).collect();
    for (gi, g) in m.globals.iter().enumerate() {
        out.push(format!("global {gi} {} {}", vtn(g.vt), gnames.get(&gi).map(String::as_str).unwrap_or("")).trim_end().to_string());
    }
    let empty = indexmap::IndexMap::new();
    for (i, &(t, flags)) in m.funcs.iter().enumerate() {
        let body = &m.bodies[i];
        let fi = nimp + i;
        let (params, results) = match m.types.get(t as usize) {
            Some(TypeEntry::Func(p, r)) => (p.as_slice(), r.as_slice()),
            _ => (&[][..], &[][..]),
        };
        let lnames = cu.local_names.get(&fi).unwrap_or(&empty);
        let lname = |li: i64| lnames.get(&(li as u32)).cloned().unwrap_or_default();
        let tags: Vec<&str> =
            [(FN_PURE, "pure"), (FN_EVENT, "event"), (FN_LATENT, "latent")].iter().filter(|(b, _)| flags & b != 0).map(|(_, s)| *s).collect();
        out.push(String::new());
        out.push(format!(
            "func {} ({}) -> ({}){}",
            fname(fi),
            vts(params),
            vts(results),
            if tags.is_empty() { String::new() } else { format!("  [{}]", tags.join(", ")) }
        ));
        let locs: Vec<String> = body
            .locals
            .iter()
            .enumerate()
            .map(|(k, vt)| format!("{}:{} {}", params.len() + k, vtn(*vt), lname((params.len() + k) as i64)).trim_end().to_string())
            .collect();
        if !locs.is_empty() {
            out.push(format!("  locals: {}", locs.join(", ")));
        }
        out.push(format!("  max_stack: {}", body.max_stack));
        let instrs = decode_code(&body.code)?;
        let labels: HashMap<i64, String> =
            cu.debug.get(&fi).map(|d| d.1.iter().map(|(pc, n)| (*pc as i64, n.clone())).collect()).unwrap_or_default();
        let branchy = ["br", "br_if", "cont.push", "try.push"];
        let targets: HashSet<i64> = instrs.iter().filter(|x| branchy.contains(&x.name)).map(|x| x.target()).collect();
        for ins in &instrs {
            let pc = ins.pc as i64;
            if let Some(l) = labels.get(&pc) {
                out.push(format!(".{l}:"));
            } else if targets.contains(&pc) {
                out.push(format!(".pc{pc}:"));
            }
            let n = ins.name;
            let mut text = n.to_string();
            let mut comment = String::new();
            let joined = || ins.imms.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(" ");
            if branchy.contains(&n) {
                let tg = ins.target();
                text += &format!(" .{}", labels.get(&tg).cloned().unwrap_or_else(|| format!("pc{tg}")));
                if n == "try.push" {
                    text += &format!(" {}", ins.imm(1));
                    comment = lname(ins.imm(1));
                }
            } else if n == "call" {
                text += &format!(" {}", cu.names.get(&ins.uimm(0)).cloned().unwrap_or_else(|| ins.imm(0).to_string()));
            } else if n == "call_virtual" && ins.uimm(0) < m.types.len() {
                let (tt, slot) = (ins.imm(0), ins.uimm(1));
                text += &format!(" {tt} {slot}");
                if let Some(TypeEntry::Class(c)) = m.types.get(tt as usize) {
                    if slot < c.vtable.len() {
                        let cname = classes.get(&(tt as u32)).map(|c| c.0.clone()).unwrap_or_else(|| format!("class {tt}"));
                        let f = c.vtable[slot] as usize;
                        comment = format!("{cname} slot {slot}: {}", cu.names.get(&f).cloned().unwrap_or_else(|| f.to_string()));
                    }
                }
            } else if n == "delegate.new" {
                let (f, fl) = (ins.uimm(0), ins.imm(1));
                text += &format!(" {f} {fl}");
                comment = format!(
                    "{}{}{}",
                    cu.names.get(&f).cloned().unwrap_or_else(|| f.to_string()),
                    if fl & 1 != 0 { " + receiver" } else { "" },
                    if fl & 2 != 0 { ", its override" } else { "" }
                );
            } else if n == "call_interface" {
                let (tt, k) = (ins.imm(0), ins.imm(1));
                text += &format!(" {tt} {k}");
                let cname = classes.get(&(tt as u32)).map(|c| c.0.clone()).unwrap_or_else(|| format!("interface {tt}"));
                comment = format!("{cname} method {k}");
            } else if (n.starts_with("class.") || n.starts_with("ref.")) && !ins.imms.is_empty() {
                let tt = ins.imm(0) as u32;
                text += &format!(" {}", joined());
                let (cname, fnames) = classes.get(&tt).cloned().unwrap_or_else(|| (format!("class {tt}"), vec![]));
                comment = cname.clone();
                if (n == "class.get" || n == "class.set") && ins.uimm(1) < fnames.len() {
                    comment = format!("{cname}.{}", fnames[ins.uimm(1)]);
                }
            } else if n.starts_with("local.") {
                text += &format!(" {}", ins.imm(0));
                comment = lname(ins.imm(0));
            } else if n.starts_with("global.") {
                text += &format!(" {}", ins.imm(0));
                comment = gnames.get(&ins.uimm(0)).cloned().unwrap_or_default();
            } else if n == "string.const" {
                text += &format!(" {}", ins.imm(0));
                let s = m.data.get(ins.uimm(0)).map(String::as_str).unwrap_or("");
                let shown = if s.chars().count() < 40 { s.to_string() } else { s.chars().take(37).collect::<String>() + "..." };
                comment = py_repr_str(&shown);
            } else if n.starts_with("array.") && !ins.imms.is_empty() {
                let tt = ins.uimm(0);
                text += &format!(" {tt}");
                if let Some(TypeEntry::Array(e)) = m.types.get(tt) {
                    comment = format!("array#<{}>", vtn(*e));
                }
            } else if ins.op > 0xFF && !ins.imms.is_empty() {
                text += &format!(" {}", ins.imm(0));
                let ty = lanes::block_type(n.split('.').next().unwrap_or("")).unwrap_or("vec2");
                if let Some((f, _)) = lanes::fields(ty).get(ins.uimm(0)) {
                    comment = format!("{ty}.{f}");
                }
            } else if n == "f32.const" || n == "f64.const" {
                text += &format!(" {}", float_repr(ins.fimm));
            } else if !ins.imms.is_empty() {
                text += &format!(" {}", joined());
            }
            let mut line = format!("  {text}");
            if !comment.is_empty() {
                let pad = 26usize.saturating_sub(line.encode_utf16().count());
                line = format!("{line}{}; {comment}", " ".repeat(pad));
            }
            out.push(line);
        }
    }
    Ok(out.join("\n") + "\n")
}
