//! Single-pass bytecode verifier (spec section 5.5), a port of `src/core/verifier.ts`. The
//! messages are the same, so a module the editor rejects is rejected the same way here.
use std::collections::HashSet;
use std::fmt;

use crate::lanes;
use crate::wbc::{
    decode_code, vt_name, Const, Instr, TypeEntry, Vt, WbcModule, ANYREF, F32, F64, FAULT, FLAG_LANES, FN_EVENT,
    FN_LATENT, FN_PURE, I32, I64, SIGNAL, STRING,
};

#[derive(Clone, Debug)]
pub struct VerifyError(pub String);

impl fmt::Display for VerifyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

fn verr(msg: impl Into<String>, func: Option<usize>, pc: Option<usize>) -> VerifyError {
    let mut wh = match func {
        Some(f) => format!("function {f}"),
        None => "module".into(),
    };
    if let Some(pc) = pc {
        wh += &format!(", pc {pc}");
    }
    VerifyError(format!("{wh}: {}", msg.into()))
}

fn module_err<T>(msg: impl Into<String>) -> Result<T, VerifyError> {
    Err(verr(msg, None, None))
}

const VALTYPES: [Vt; 5] = [I32, I64, F32, F64, STRING];

fn prefix_vt(p: &str) -> Option<Vt> {
    match p {
        "i32" => Some(I32),
        "i64" => Some(I64),
        "f32" => Some(F32),
        "f64" => Some(F64),
        _ => None,
    }
}

fn lane_vt(name: &str) -> Vt {
    match name {
        "f32" => F32,
        "bool" => I32,
        other => Vt::of_lane(other).unwrap_or(F32),
    }
}

/// (pops, pushes) of a lane instruction (section 5.6).
pub fn lane_effect(name: &str, field: usize) -> (Vec<Vt>, Vec<Vt>) {
    let (ins, out) = lanes::effect(name, field);
    (ins.into_iter().map(lane_vt).collect(), vec![lane_vt(out)])
}

/// (pops, pushes) for instructions whose typing depends only on the opcode.
pub fn simple_effect(name: &str) -> Option<(Vec<Vt>, Vec<Vt>)> {
    match name {
        "string.concat" => return Some((vec![STRING, STRING], vec![STRING])),
        "string.len" => return Some((vec![STRING], vec![I32])),
        "string.eq" | "string.cmp" => return Some((vec![STRING, STRING], vec![I32])),
        _ => {}
    }
    let (pre, op) = name.split_once('.').unwrap_or((name, ""));
    let t = prefix_vt(pre)?;
    let parts: Vec<&str> = op.split('_').collect();
    if parts.len() >= 2
        && ["wrap", "extend", "trunc", "convert", "demote", "promote", "reinterpret"].contains(&parts[0])
    {
        if let Some(src) = prefix_vt(parts[1]) {
            return Some((vec![src], vec![t]));
        }
    }
    if pre == "i32" || pre == "i64" {
        if op == "eqz" {
            return Some((vec![t], vec![I32]));
        }
        if ["eq", "ne", "lt_s", "lt_u", "gt_s", "gt_u", "le_s", "le_u", "ge_s", "ge_u"].contains(&op) {
            return Some((vec![t, t], vec![I32]));
        }
        if ["add", "sub", "mul", "div_s", "div_u", "rem_s", "rem_u", "and", "or", "xor", "shl", "shr_s", "shr_u"]
            .contains(&op)
        {
            return Some((vec![t, t], vec![t]));
        }
        if ["neg", "not", "extend8_s", "extend16_s", "extend32_s"].contains(&op) {
            return Some((vec![t], vec![t]));
        }
    } else {
        if ["eq", "ne", "lt", "gt", "le", "ge"].contains(&op) {
            return Some((vec![t, t], vec![I32]));
        }
        if ["add", "sub", "mul", "div", "min", "max", "copysign"].contains(&op) {
            return Some((vec![t, t], vec![t]));
        }
        if ["neg", "abs", "sqrt", "ceil", "floor", "trunc", "nearest"].contains(&op) {
            return Some((vec![t], vec![t]));
        }
    }
    None
}

pub fn valid_vt(m: &WbcModule, vt: Vt) -> bool {
    match vt {
        Vt::Ref(t) => m.types.get(t as usize).is_some_and(|e| e.is_ref_entry()),
        _ if vt.lane().is_some() => m.flags & FLAG_LANES != 0,
        _ => VALTYPES.contains(&vt),
    }
}

fn key_vt_ok(m: &WbcModule, vt: Vt, depth: usize) -> bool {
    match vt {
        Vt::Ref(t) => match m.types.get(t as usize) {
            Some(TypeEntry::Struct(fields)) if depth <= 64 => fields.iter().all(|(f, _)| key_vt_ok(m, *f, depth + 1)),
            _ => false,
        },
        _ => VALTYPES.contains(&vt) || (vt.lane().is_some() && m.flags & FLAG_LANES != 0),
    }
}

fn class(m: &WbcModule, t: u32) -> Option<&crate::wbc::ClassType> {
    match m.types.get(t as usize) {
        Some(TypeEntry::Class(c)) => Some(c),
        _ => None,
    }
}

/// A class type index and its superclasses, nearest first.
pub fn class_chain(m: &WbcModule, t: Option<u32>) -> Vec<u32> {
    let mut out = Vec::new();
    let mut t = t;
    while let Some(c) = t {
        if out.contains(&c) {
            break;
        }
        out.push(c);
        t = class(m, c).and_then(|c| c.sup);
    }
    out
}

/// Reference subtyping (section 5.5).
pub fn is_sub(m: &WbcModule, got: Vt, expected: Vt) -> bool {
    if got == expected {
        return true;
    }
    if expected == ANYREF {
        return got.is_ref();
    }
    let (Vt::Ref(g), Vt::Ref(e)) = (got, expected) else { return false };
    let Some(gc) = class(m, g) else { return false };
    match m.types.get(e as usize) {
        Some(TypeEntry::Class(_)) => class_chain(m, Some(g)).contains(&e),
        Some(TypeEntry::Interface(_)) => gc.interfaces.iter().any(|(i, _)| *i == e),
        _ => false,
    }
}

fn common_ref(m: &WbcModule, a: Vt, b: Vt) -> Vt {
    if is_sub(m, a, b) {
        b
    } else if is_sub(m, b, a) {
        a
    } else {
        ANYREF
    }
}

fn is_func_type_idx(m: &WbcModule, t: u32) -> bool {
    matches!(m.types.get(t as usize), Some(TypeEntry::Func(..)))
}

fn func_type(m: &WbcModule, t: u32) -> (&[Vt], &[Vt]) {
    match m.types.get(t as usize) {
        Some(TypeEntry::Func(p, r)) => (p, r),
        _ => (&[], &[]),
    }
}

fn check_classes(m: &WbcModule, nfuncs: usize) -> Result<(), VerifyError> {
    for (t, entry) in m.types.iter().enumerate() {
        if let TypeEntry::Class(c) = entry {
            if let Some(s) = c.sup {
                if class(m, s).is_none() {
                    return module_err(format!("class type {t} has a superclass that is not a class type"));
                }
            }
        }
    }
    for (t, entry) in m.types.iter().enumerate() {
        if !matches!(entry, TypeEntry::Class(_)) {
            continue;
        }
        let mut seen = HashSet::new();
        let mut cur = Some(t as u32);
        while let Some(c) = cur {
            if !seen.insert(c) {
                return module_err(format!("class type {t} inherits from itself"));
            }
            cur = class(m, c).and_then(|c| c.sup);
        }
    }
    for (t, entry) in m.types.iter().enumerate() {
        let TypeEntry::Class(entry) = entry else { continue };
        let chain = class_chain(m, Some(t as u32));
        let sup = entry.sup.and_then(|s| class(m, s));
        if let Some(sup) = sup {
            if entry.vtable.len() < sup.vtable.len() {
                return module_err(format!("class type {t} drops slots of its superclass's vtable"));
            }
        }
        let mine: Vec<u32> = entry.interfaces.iter().map(|(i, _)| *i).collect();
        if mine.iter().collect::<HashSet<_>>().len() != mine.len() {
            return module_err(format!("class type {t} lists an interface twice"));
        }
        if let Some(sup) = sup {
            if !sup.interfaces.iter().all(|(i, _)| mine.contains(i)) {
                return module_err(format!("class type {t} drops an interface of its superclass"));
            }
        }
        for (iface, imp) in &entry.interfaces {
            let Some(TypeEntry::Interface(methods)) = m.types.get(*iface as usize) else {
                return module_err(format!("class type {t} implements type {iface}, not an interface"));
            };
            if imp.len() != methods.len() {
                return module_err(format!(
                    "class type {t} gives {} methods for interface {iface}, which has {}",
                    imp.len(),
                    methods.len()
                ));
            }
            for (k, (&fi, &ft)) in imp.iter().zip(methods.iter()).enumerate() {
                if fi as usize >= nfuncs || !is_func_type_idx(m, ft) {
                    return module_err(format!("class type {t}: interface {iface} method {k} is out of range"));
                }
                let (params, results, flags) = m.func_type(fi as usize);
                let recv_ok = matches!(params.first(), Some(Vt::Ref(r)) if chain.contains(r));
                if !recv_ok {
                    return module_err(format!(
                        "class type {t}: interface {iface} method {k} does not take this class or a superclass as its receiver"
                    ));
                }
                let (fp, fr) = func_type(m, ft);
                if &params[1..] != fp || results != fr {
                    return module_err(format!(
                        "class type {t}: interface {iface} method {k} does not have the interface's signature"
                    ));
                }
                if flags & FN_LATENT != 0 {
                    return module_err(format!("class type {t}: interface {iface} method {k} is latent"));
                }
            }
        }
        for (slot, &fi) in entry.vtable.iter().enumerate() {
            if fi as usize >= nfuncs {
                return module_err(format!("class type {t} slot {slot} names function {fi}, out of range"));
            }
            let (params, results, _) = m.func_type(fi as usize);
            let recv_ok = matches!(params.first(), Some(Vt::Ref(r)) if chain.contains(r));
            if !recv_ok {
                return module_err(format!(
                    "class type {t} slot {slot}: the function does not take this class or a superclass as its receiver"
                ));
            }
            if let Some(sup) = sup {
                if slot < sup.vtable.len() {
                    let (bp, br, _) = m.func_type(sup.vtable[slot] as usize);
                    if bp.get(1..).unwrap_or(&[]) != &params[1..] || br != results {
                        return module_err(format!(
                            "class type {t} slot {slot} does not have the signature of the slot it overrides"
                        ));
                    }
                }
            }
        }
    }
    Ok(())
}

/// Every field's value type, inherited ones first: the layout `class.get` indexes.
pub fn class_fields(m: &WbcModule, t: u32) -> Vec<Vt> {
    let mut out = Vec::new();
    for c in class_chain(m, Some(t)).iter().rev() {
        if let Some(ct) = class(m, *c) {
            out.extend(ct.fields.iter().map(|(vt, _)| *vt));
        }
    }
    out
}

fn check_struct_cycles(m: &WbcModule) -> Result<(), VerifyError> {
    fn visit(m: &WbcModule, t: usize, state: &mut Vec<u8>) -> Result<(), VerifyError> {
        if state[t] == 2 {
            return Ok(());
        }
        if state[t] == 1 {
            return module_err(format!("struct type {t} contains itself by value"));
        }
        state[t] = 1;
        if let TypeEntry::Struct(fields) = &m.types[t] {
            for (vt, _) in fields {
                if let Vt::Ref(r) = vt {
                    if matches!(m.types.get(*r as usize), Some(TypeEntry::Struct(_))) {
                        visit(m, *r as usize, state)?;
                    }
                }
            }
        }
        state[t] = 2;
        Ok(())
    }
    let mut state = vec![0u8; m.types.len()];
    for (t, e) in m.types.iter().enumerate() {
        if matches!(e, TypeEntry::Struct(_)) {
            visit(m, t, &mut state)?;
        }
    }
    Ok(())
}

/// Verify a decoded module. Returns, per defined function, its instructions and the highest
/// the operand stack gets.
pub fn verify(m: &WbcModule) -> Result<Vec<(Vec<Instr>, usize)>, VerifyError> {
    for (i, entry) in m.types.iter().enumerate() {
        let vts: Vec<Vt> = match entry {
            TypeEntry::Array(e) | TypeEntry::Set(e) => vec![*e],
            TypeEntry::Map(k, v) => vec![*k, *v],
            TypeEntry::Delegate(ft) | TypeEntry::Dispatcher(ft) => {
                if !is_func_type_idx(m, *ft) {
                    return module_err(format!("type {i} names {ft}, not a function type"));
                }
                if matches!(entry, TypeEntry::Dispatcher(_)) && !func_type(m, *ft).1.is_empty() {
                    return module_err(format!("dispatcher type {i} has results"));
                }
                vec![]
            }
            TypeEntry::Interface(methods) => {
                for ft in methods {
                    if !is_func_type_idx(m, *ft) {
                        return module_err(format!("interface type {i} names {ft}, not a function type"));
                    }
                }
                vec![]
            }
            TypeEntry::Struct(fields) | TypeEntry::Class(crate::wbc::ClassType { fields, .. }) => {
                for (vt, def) in fields {
                    if *vt == STRING {
                        if let Some(Const::Data(d)) = def {
                            if *d as usize >= m.data.len() {
                                return module_err(format!("type {i} has a field default naming missing data"));
                            }
                        }
                    }
                }
                fields.iter().map(|(vt, _)| *vt).collect()
            }
            TypeEntry::Func(p, r) => {
                p.iter().chain(r.iter()).copied().filter(|vt| *vt != ANYREF && *vt != FAULT && *vt != SIGNAL).collect()
            }
        };
        for vt in vts {
            if !valid_vt(m, vt) {
                return module_err(format!("type {i} uses an unsupported value type"));
            }
        }
    }
    check_struct_cycles(m)?;
    for (i, entry) in m.types.iter().enumerate() {
        let k = match entry {
            TypeEntry::Map(k, _) => *k,
            TypeEntry::Set(e) => *e,
            _ => continue,
        };
        if !key_vt_ok(m, k, 0) {
            return module_err(format!("type {i}: a map key or set item must be a number, a string or a struct of those"));
        }
    }
    for imp in &m.imports {
        if !is_func_type_idx(m, imp.ty) {
            return module_err(format!("import {}.{} has bad type index {}", imp.module, imp.field, imp.ty));
        }
    }
    for (i, &(t, flags)) in m.funcs.iter().enumerate() {
        if !is_func_type_idx(m, t) {
            return Err(verr(format!("function has bad type index {t}"), Some(i), None));
        }
        if flags & !(FN_PURE | FN_LATENT | FN_EVENT) != 0 {
            return Err(verr(format!("function has unknown flag bits 0x{flags:02x}"), Some(i), None));
        }
        if flags & FN_PURE != 0 && flags & FN_LATENT != 0 {
            return Err(verr("a pure function is never latent", Some(i), None));
        }
        if flags & FN_EVENT != 0 && (!func_type(m, t).1.is_empty() || flags & FN_LATENT == 0) {
            return Err(verr("an event is latent and has no results", Some(i), None));
        }
    }
    if m.bodies.len() != m.funcs.len() {
        return module_err("function and code section counts differ");
    }
    let nfuncs = m.nfuncs();
    check_classes(m, nfuncs)?;
    let mut names = HashSet::new();
    for ex in &m.exports {
        if !names.insert(ex.name.clone()) {
            return module_err(format!("duplicate export '{}'", ex.name));
        }
        let n = &ex.name;
        if ex.kind == 0 && ex.index as usize >= nfuncs {
            return module_err(format!("export '{n}' names function {}, out of range", ex.index));
        }
        if ex.kind == 1 && ex.index as usize >= m.globals.len() {
            return module_err(format!("export '{n}' names global {}, out of range", ex.index));
        }
        if ex.kind == 2 && ex.index as usize >= m.types.len() {
            return module_err(format!("export '{n}' names type {}, out of range", ex.index));
        }
        if ex.kind > 2 {
            return module_err(format!("export '{n}' has unsupported kind {}", ex.kind));
        }
    }
    for (gi, g) in m.globals.iter().enumerate() {
        if g.vt != SIGNAL && !valid_vt(m, g.vt) {
            return module_err(format!("global {gi} has unsupported type"));
        }
        if g.vt == STRING {
            if let Const::Data(d) = g.init {
                if d as usize >= m.data.len() {
                    return module_err(format!("global {gi} initialiser names missing data {d}"));
                }
            }
        }
    }
    (0..m.funcs.len()).map(|i| verify_function(m, i)).collect()
}

struct Fv<'a> {
    m: &'a WbcModule,
    fidx: usize,
    stack: Vec<Vt>,
}

impl<'a> Fv<'a> {
    fn err(&self, msg: impl Into<String>, ins: &Instr) -> VerifyError {
        verr(msg, Some(self.fidx), Some(ins.pc))
    }
    fn pop(&mut self, expected: Option<Vt>, ins: &Instr) -> Result<Vt, VerifyError> {
        let Some(got) = self.stack.pop() else {
            return Err(self.err(format!("{}: operand stack underflow", ins.name), ins));
        };
        if let Some(e) = expected {
            if is_sub(self.m, got, e) {
                return Ok(got);
            }
            if got != e {
                return Err(self.err(
                    format!("{}: expected {}, found {}", ins.name, vt_name(e, &self.m.types), vt_name(got, &self.m.types)),
                    ins,
                ));
            }
        }
        Ok(got)
    }
    fn pop_all(&mut self, vts: &[Vt], ins: &Instr) -> Result<(), VerifyError> {
        for vt in vts.iter().rev() {
            self.pop(Some(*vt), ins)?;
        }
        Ok(())
    }
}

pub fn verify_function(m: &WbcModule, i: usize) -> Result<(Vec<Instr>, usize), VerifyError> {
    let fidx = m.imports.len() + i;
    let (params, results, flags) = m.func_type(fidx);
    let body = &m.bodies[i];
    for vt in &body.locals {
        if *vt != FAULT && *vt != SIGNAL && *vt != ANYREF && !valid_vt(m, *vt) {
            return Err(verr("local of unsupported type", Some(fidx), None));
        }
    }
    let local_types: Vec<Vt> = params.iter().chain(body.locals.iter()).copied().collect();
    let instrs = decode_code(&body.code).map_err(|e| verr(e.0, Some(fidx), None))?;
    if instrs.is_empty() {
        return Err(verr("empty function body", Some(fidx), None));
    }
    let starts: HashSet<i64> = instrs.iter().map(|x| x.pc as i64).collect();
    let mut labels = HashSet::new();
    for ins in &instrs {
        if ["br", "br_if", "cont.push", "try.push"].contains(&ins.name) {
            let t = ins.target();
            if !starts.contains(&t) {
                return Err(verr(format!("branch target {t} is not an instruction boundary"), Some(fidx), Some(ins.pc)));
            }
            labels.insert(t);
        }
    }
    let mut v = Fv { m, fidx, stack: Vec::new() };
    let mut reachable = true;
    let mut max_h = 0usize;
    let types = &m.types;
    for ins in &instrs {
        if labels.contains(&(ins.pc as i64)) {
            if reachable && !v.stack.is_empty() {
                return Err(v.err("operand stack is not empty at a label", ins));
            }
            reachable = true;
        }
        if !reachable {
            return Err(v.err("unreachable instruction without a label", ins));
        }
        let n = ins.name;
        let mut eff = simple_effect(n);
        if ins.op > 0xFF {
            if m.flags & FLAG_LANES == 0 {
                return Err(v.err(format!("{n}: lane instructions need feature flag bit 1"), ins));
            }
            let field = ins.uimm(0);
            let ty = lanes::block_type(n.split('.').next().unwrap_or("")).unwrap_or("vec2");
            if !ins.imms.is_empty() && field >= lanes::fields(ty).len() {
                return Err(v.err(format!("{n}: {ty} has no field {field}"), ins));
            }
            eff = Some(lane_effect(n, field));
        }
        let struct_type = |v: &Fv, ins: &Instr| -> Result<(Vt, Vec<Vt>), VerifyError> {
            let t = ins.imm(0);
            let Some(TypeEntry::Struct(fields)) = types.get(t as usize) else {
                return Err(v.err(format!("{}: type {t} is not a struct type", ins.name), ins));
            };
            let fields: Vec<Vt> = fields.iter().map(|(vt, _)| *vt).collect();
            if ins.imms.len() > 1 && ins.uimm(1) >= fields.len() {
                return Err(v.err(format!("{}: struct type {t} has no field {}", ins.name, ins.imm(1)), ins));
            }
            Ok((Vt::Ref(t as u32), fields))
        };
        if let Some((pops, pushes)) = eff {
            v.pop_all(&pops, ins)?;
            v.stack.extend(pushes);
        } else if n == "nop" || n == "cont.push" {
        } else if n == "br" || n == "unreachable" {
            if n == "br" && !v.stack.is_empty() {
                return Err(v.err("br with a non-empty operand stack", ins));
            }
            v.stack.clear();
            reachable = false;
        } else if n == "br_if" {
            if !(v.stack.len() == 1 && v.stack[0] == I32) {
                return Err(v.err("br_if needs exactly one i32 on the stack", ins));
            }
            v.stack.clear();
        } else if n == "try.push" {
            let li = ins.uimm(1);
            if li >= local_types.len() || local_types[li] != FAULT {
                return Err(v.err("try.push must name a local of type fault", ins));
            }
        } else if n == "suspend" {
            let kind = ins.imm(0);
            if flags & FN_LATENT == 0 {
                return Err(v.err("suspend in a function that is not latent", ins));
            }
            if kind > 2 {
                return Err(v.err(format!("suspend kind {kind} is not 0, 1 or 2"), ins));
            }
            if kind != 0 {
                v.pop(Some(if kind == 1 { F64 } else { SIGNAL }), ins)?;
            }
            if !v.stack.is_empty() {
                return Err(v.err("suspend with more than its operand on the stack", ins));
            }
        } else if n == "throw" {
            v.pop(Some(FAULT), ins)?;
            v.stack.clear();
            reachable = false;
        } else if n == "cont.pop" {
            if !v.stack.is_empty() {
                return Err(v.err("cont.pop with a non-empty operand stack", ins));
            }
        } else if n == "cont.depth" {
            v.stack.push(I32);
        } else if n == "cont.trunc" {
            v.pop(Some(I32), ins)?;
        } else if n == "return" {
            let ok = v.stack.len() == results.len() && v.stack.iter().zip(results.iter()).all(|(g, r)| is_sub(m, *g, *r));
            if !ok {
                return Err(v.err("stack does not match the function's results at return", ins));
            }
            v.stack.clear();
            reachable = false;
        } else if n == "call_interface" {
            let (ti, k) = (ins.imm(0), ins.uimm(1));
            let Some(TypeEntry::Interface(methods)) = types.get(ti as usize) else {
                return Err(v.err(format!("call_interface: type {ti} is not an interface"), ins));
            };
            if k >= methods.len() {
                return Err(v.err(format!("call_interface: interface {ti} has no method {k}"), ins));
            }
            let ft = methods[k];
            if !is_func_type_idx(m, ft) {
                return Err(v.err(format!("call_interface: bad function type {ft}"), ins));
            }
            let (fp, fr) = func_type(m, ft);
            v.pop_all(fp, ins)?;
            v.pop(Some(Vt::Ref(ti as u32)), ins)?;
            v.stack.extend_from_slice(fr);
        } else if n == "call" || n == "call_virtual" {
            let callee;
            let mut recv = None;
            if n == "call" {
                callee = ins.uimm(0);
                if callee >= m.nfuncs() {
                    return Err(v.err(format!("call to unknown function {callee}"), ins));
                }
            } else {
                let (ti, slot) = (ins.imm(0), ins.uimm(1));
                let Some(TypeEntry::Class(ct)) = types.get(ti as usize) else {
                    return Err(v.err(format!("call_virtual: type {ti} is not a class type"), ins));
                };
                if slot >= ct.vtable.len() {
                    return Err(v.err(format!("call_virtual: class type {ti} has no slot {slot}"), ins));
                }
                callee = ct.vtable[slot] as usize;
                recv = Some(Vt::Ref(ti as u32));
            }
            let (cp, cr, cflags) = m.func_type(callee);
            let mut cp = cp.to_vec();
            if let (Some(r), false) = (recv, cp.is_empty()) {
                cp[0] = r;
            }
            if cflags & FN_LATENT != 0 && flags & FN_LATENT == 0 && callee >= m.imports.len() {
                return Err(v.err("non-latent function calls a latent function", ins));
            }
            v.pop_all(&cp, ins)?;
            v.stack.extend_from_slice(cr);
        } else if n == "drop" {
            v.pop(None, ins)?;
        } else if n == "select" {
            v.pop(Some(I32), ins)?;
            let b = v.pop(None, ins)?;
            if b.is_ref() || b == ANYREF {
                let a = v.pop(None, ins)?;
                if !(a.is_ref() || a == ANYREF) {
                    return Err(v.err("select: a reference and a non-reference", ins));
                }
                v.stack.push(common_ref(m, a, b));
            } else {
                v.pop(Some(b), ins)?;
                v.stack.push(b);
            }
        } else if n == "local.get" || n == "local.set" || n == "local.tee" {
            let li = ins.uimm(0);
            if li >= local_types.len() {
                return Err(v.err(format!("local {li} out of range"), ins));
            }
            let t = local_types[li];
            if n == "local.get" {
                v.stack.push(t);
            } else {
                v.pop(Some(t), ins)?;
                if n == "local.tee" {
                    v.stack.push(t);
                }
            }
        } else if n == "global.get" || n == "global.set" {
            let gi = ins.uimm(0);
            let Some(g) = m.globals.get(gi) else {
                return Err(v.err(format!("global {gi} out of range"), ins));
            };
            if n == "global.get" {
                v.stack.push(g.vt);
            } else {
                if !g.mutable {
                    return Err(v.err(format!("global {gi} is immutable"), ins));
                }
                v.pop(Some(g.vt), ins)?;
            }
        } else if n == "i32.const" {
            let x = ins.imm(0);
            if !(-(1i64 << 31) <= x && x < (1i64 << 31)) {
                return Err(v.err("i32.const out of range", ins));
            }
            v.stack.push(I32);
        } else if n == "i64.const" {
            v.stack.push(I64);
        } else if n == "f32.const" {
            v.stack.push(F32);
        } else if n == "f64.const" {
            v.stack.push(F64);
        } else if n == "array.len" {
            let got = v.pop(None, ins)?;
            if !matches!(got, Vt::Ref(t) if matches!(types.get(t as usize), Some(TypeEntry::Array(_)))) {
                return Err(v.err("array.len needs an array", ins));
            }
            v.stack.push(I32);
        } else if let Some(op) = n.strip_prefix("array.") {
            let t = ins.imm(0);
            let Some(TypeEntry::Array(elem)) = types.get(t as usize) else {
                return Err(v.err(format!("{n}: type {t} is not an array type"), ins));
            };
            let (r, e) = (Vt::Ref(t as u32), *elem);
            let operands: Vec<Vt> = match op {
                "new" => vec![I32],
                "get" | "remove" => vec![r, I32],
                "set" | "insert" => vec![r, I32, e],
                "push" => vec![r, e],
                _ => vec![r],
            };
            v.pop_all(&operands, ins)?;
            v.stack.push(if op == "get" { e } else { r });
        } else if n == "struct.new" {
            let (r, fields) = struct_type(&v, ins)?;
            v.pop_all(&fields, ins)?;
            v.stack.push(r);
        } else if n == "struct.get" {
            let (r, fields) = struct_type(&v, ins)?;
            v.pop(Some(r), ins)?;
            v.stack.push(fields[ins.uimm(1)]);
        } else if n == "struct.with" {
            let (r, fields) = struct_type(&v, ins)?;
            v.pop(Some(fields[ins.uimm(1)]), ins)?;
            v.pop(Some(r), ins)?;
            v.stack.push(r);
        } else if let Some(op) = n.strip_prefix("map.") {
            let t = ins.imm(0);
            let Some(TypeEntry::Map(k, val)) = types.get(t as usize) else {
                return Err(v.err(format!("{n}: type {t} is not a map type"), ins));
            };
            let (r, k, val) = (Vt::Ref(t as u32), *k, *val);
            let (pops, outs): (Vec<Vt>, Vec<Vt>) = match op {
                "new" => (vec![], vec![r]),
                "find" => (vec![r, k], vec![val, I32]),
                "set" => (vec![r, k, val], vec![r]),
                "remove" => (vec![r, k], vec![r, I32]),
                "has" => (vec![r, k], vec![I32]),
                "len" => (vec![r], vec![I32]),
                "key_at" => (vec![r, I32], vec![k]),
                "value_at" => (vec![r, I32], vec![val]),
                _ => (vec![r], vec![r]),
            };
            v.pop_all(&pops, ins)?;
            v.stack.extend(outs);
        } else if let Some(op) = n.strip_prefix("set.") {
            let t = ins.imm(0);
            let Some(TypeEntry::Set(el)) = types.get(t as usize) else {
                return Err(v.err(format!("{n}: type {t} is not a set type"), ins));
            };
            let (r, el) = (Vt::Ref(t as u32), *el);
            let (pops, outs): (Vec<Vt>, Vec<Vt>) = match op {
                "new" => (vec![], vec![r]),
                "add" | "remove" => (vec![r, el], vec![r, I32]),
                "has" => (vec![r, el], vec![I32]),
                "len" => (vec![r], vec![I32]),
                "at" => (vec![r, I32], vec![el]),
                _ => (vec![r], vec![r]),
            };
            v.pop_all(&pops, ins)?;
            v.stack.extend(outs);
        } else if n.starts_with("class.") || n == "ref.null" || n == "ref.cast" || n == "ref.test" {
            let t = ins.imm(0);
            let entry = types.get(t as usize);
            let ok = if n.starts_with("class.") {
                matches!(entry, Some(TypeEntry::Class(_)))
            } else {
                matches!(entry, Some(TypeEntry::Class(_) | TypeEntry::Interface(_)))
            };
            if !ok {
                return Err(v.err(format!("{n}: type {t} is not a class type"), ins));
            }
            let r = Vt::Ref(t as u32);
            if n == "class.new" || n == "ref.null" {
                v.stack.push(r);
            } else if n == "class.get" || n == "class.set" {
                let fields = class_fields(m, t as u32);
                let fi = ins.uimm(1);
                if fi >= fields.len() {
                    return Err(v.err(format!("{n}: class type {t} has no field {fi}"), ins));
                }
                if n == "class.set" {
                    v.pop(Some(fields[fi]), ins)?;
                }
                v.pop(Some(r), ins)?;
                if n == "class.get" {
                    v.stack.push(fields[fi]);
                }
            } else {
                v.pop(Some(ANYREF), ins)?;
                v.stack.push(if n == "ref.cast" { r } else { I32 });
            }
        } else if n == "ref.share" {
            let got = v.pop(None, ins)?;
            let ok = matches!(got, Vt::Ref(t) if matches!(types.get(t as usize), Some(TypeEntry::Array(_) | TypeEntry::Map(..) | TypeEntry::Set(_))));
            if !ok {
                return Err(v.err("ref.share needs an array, a map or a set", ins));
            }
            v.stack.push(got);
        } else if n == "ref.is_null" || n == "ref.valid" {
            v.pop(Some(ANYREF), ins)?;
            v.stack.push(I32);
        } else if n == "ref.eq" {
            v.pop(Some(ANYREF), ins)?;
            v.pop(Some(ANYREF), ins)?;
            v.stack.push(I32);
        } else if n == "delegate.new" {
            let (fi, fl) = (ins.uimm(0), ins.imm(1));
            if fi >= m.nfuncs() {
                return Err(v.err(format!("delegate.new: unknown function {fi}"), ins));
            }
            if fl & !3 != 0 || (fl & 2 != 0 && fl & 1 == 0) {
                return Err(v.err(format!("delegate.new: bad flags {fl}"), ins));
            }
            let (cp, cr, cflags) = m.func_type(fi);
            if cflags & FN_LATENT != 0 && cflags & FN_EVENT == 0 {
                return Err(v.err("delegate.new: a latent function that is not an event", ins));
            }
            let mut cp = cp;
            if fl & 1 != 0 {
                if cp.is_empty() {
                    return Err(v.err("delegate.new binds a receiver to a function with no parameters", ins));
                }
                v.pop(Some(cp[0]), ins)?;
                cp = &cp[1..];
            }
            let dt = types.iter().position(|e| match e {
                TypeEntry::Delegate(ft) if is_func_type_idx(m, *ft) => {
                    let (p, r) = func_type(m, *ft);
                    p == cp && r == cr
                }
                _ => false,
            });
            let Some(dt) = dt else {
                return Err(v.err("delegate.new: the module has no delegate type for this function", ins));
            };
            v.stack.push(Vt::Ref(dt as u32));
        } else if ["call_delegate", "dispatcher.bind", "dispatcher.unbind", "dispatcher.broadcast"].contains(&n) {
            let t = ins.imm(0);
            let ft: (Vec<Vt>, Vec<Vt>) = if n == "call_delegate" {
                if !is_func_type_idx(m, t as u32) {
                    return Err(v.err(format!("call_delegate: type {t} is not a function type"), ins));
                }
                let (p, r) = func_type(m, t as u32);
                (p.to_vec(), r.to_vec())
            } else {
                let Some(TypeEntry::Dispatcher(f)) = types.get(t as usize) else {
                    return Err(v.err(format!("{n}: type {t} is not a dispatcher type"), ins));
                };
                let (p, r) = func_type(m, *f);
                (p.to_vec(), r.to_vec())
            };
            let same_delegate = |vt: Vt| match vt {
                Vt::Ref(r) => match types.get(r as usize) {
                    Some(TypeEntry::Delegate(f)) => {
                        let (p, rr) = func_type(m, *f);
                        p == ft.0.as_slice() && rr == ft.1.as_slice()
                    }
                    _ => false,
                },
                _ => false,
            };
            if n == "call_delegate" || n == "dispatcher.broadcast" {
                v.pop_all(&ft.0, ins)?;
            }
            if n != "dispatcher.broadcast" {
                let got = v.pop(None, ins)?;
                if !same_delegate(got) {
                    return Err(v.err(
                        format!("{n}: expected a delegate of type {t}, found {}", vt_name(got, types)),
                        ins,
                    ));
                }
            }
            if n != "call_delegate" {
                v.pop(Some(Vt::Ref(t as u32)), ins)?;
            }
            if n == "call_delegate" {
                v.stack.extend_from_slice(&ft.1);
            }
        } else if n == "string.const" {
            if ins.uimm(0) >= m.data.len() {
                return Err(v.err(format!("data index {} out of range", ins.imm(0)), ins));
            }
            v.stack.push(STRING);
        } else {
            return Err(v.err(format!("instruction {n} is not supported"), ins));
        }
        max_h = max_h.max(v.stack.len());
    }
    if reachable {
        return Err(verr("control can fall off the end of the function", Some(fidx), None));
    }
    if max_h > body.max_stack as usize {
        return Err(verr(
            format!("operand stack reaches {max_h}, above declared max_stack {}", body.max_stack),
            Some(fidx),
            None,
        ));
    }
    Ok((instrs, max_h))
}
