//! WBC 1 binary format (spec section 5): value types, the section container and instruction
//! decoding. A port of `src/core/wbc.ts` (the decoding half; the TypeScript compiler keeps the
//! encoder).
//!
//! Encoding choices the draft leaves open: every `u32` in the container is unsigned LEB128,
//! only magic, version and flags are fixed-width little-endian, and branch offsets are signed
//! LEB128 padded to five bytes.
use std::collections::HashMap;
use std::fmt;
use std::sync::OnceLock;

use crate::lanes;

pub const MAGIC: [u8; 4] = [0x00, 0x57, 0x42, 0x43];
pub const VERSION: u32 = 1;
pub const FLAG_HAS_SOURCE: u32 = 1;
pub const FLAG_LANES: u32 = 2;

/// A value type (section 5.3): a one-byte code, or `6B t`, a reference to type entry `t`.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Vt {
    Code(u8),
    Ref(u32),
}

pub const I32: Vt = Vt::Code(0x7F);
pub const I64: Vt = Vt::Code(0x7E);
pub const F32: Vt = Vt::Code(0x7D);
pub const F64: Vt = Vt::Code(0x7C);
pub const STRING: Vt = Vt::Code(0x6E);
pub const ANYREF: Vt = Vt::Code(0x6D);
pub const FAULT: Vt = Vt::Code(0x6A);
pub const SIGNAL: Vt = Vt::Code(0x69);
pub const VEC2: Vt = Vt::Code(0x76);
pub const VEC3: Vt = Vt::Code(0x75);
pub const QUAT: Vt = Vt::Code(0x74);
pub const TRANSFORM: Vt = Vt::Code(0x73);
const REF: u8 = 0x6B;

impl Vt {
    pub fn is_ref(self) -> bool {
        matches!(self, Vt::Ref(_))
    }
    /// The lane type's Wiret name, for `vec2`, `vec3`, `quat` and `transform`.
    pub fn lane(self) -> Option<&'static str> {
        match self {
            VEC2 => Some("vec2"),
            VEC3 => Some("vec3"),
            QUAT => Some("quat"),
            TRANSFORM => Some("transform"),
            _ => None,
        }
    }
    pub fn of_lane(name: &str) -> Option<Vt> {
        match name {
            "vec2" => Some(VEC2),
            "vec3" => Some(VEC3),
            "quat" => Some(QUAT),
            "transform" => Some(TRANSFORM),
            _ => None,
        }
    }
}

pub const FUNC_TYPE: u8 = 0x60;
pub const ARRAY_TYPE: u8 = 0x5E;
pub const STRUCT_TYPE: u8 = 0x5F;
pub const MAP_TYPE: u8 = 0x5D;
pub const SET_TYPE: u8 = 0x5C;
pub const CLASS_TYPE: u8 = 0x5B;
pub const INTERFACE_TYPE: u8 = 0x5A;
pub const DELEGATE_TYPE: u8 = 0x59;
pub const DISPATCHER_TYPE: u8 = 0x58;

pub const SEC_CUSTOM: u8 = 0;
pub const SEC_TYPE: u8 = 1;
pub const SEC_IMPORT: u8 = 2;
pub const SEC_FUNCTION: u8 = 3;
pub const SEC_GLOBAL: u8 = 4;
pub const SEC_EXPORT: u8 = 5;
pub const SEC_DATA: u8 = 6;
pub const SEC_CODE: u8 = 7;

pub const FN_PURE: u8 = 1;
pub const FN_LATENT: u8 = 2;
pub const FN_EVENT: u8 = 4;
pub const EX_EVENT: u8 = 1;
pub const EX_LATENT: u8 = 2;
pub const EX_PURE: u8 = 4;
pub const EX_DECLARED: u8 = 8;
pub const EXPORT_FUNC: u8 = 0;
pub const EXPORT_GLOBAL: u8 = 1;
pub const EXPORT_TYPE: u8 = 2;

/// A constant in the module: a field default or a global's initial value.
#[derive(Clone, Debug, PartialEq)]
pub enum Const {
    Null,
    Int(i64),
    F32(f32),
    F64(f64),
    /// an index into the data section
    Data(u32),
    Lane(Vec<Const>),
}

#[derive(Clone, Debug)]
pub struct ClassType {
    pub sup: Option<u32>,
    pub fields: Vec<(Vt, Option<Const>)>,
    pub vtable: Vec<u32>,
    pub interfaces: Vec<(u32, Vec<u32>)>,
}

#[derive(Clone, Debug)]
pub enum TypeEntry {
    Func(Vec<Vt>, Vec<Vt>),
    Array(Vt),
    Struct(Vec<(Vt, Option<Const>)>),
    Map(Vt, Vt),
    Set(Vt),
    Class(ClassType),
    Delegate(u32),
    Dispatcher(u32),
    Interface(Vec<u32>),
}

impl TypeEntry {
    pub fn is_ref_entry(&self) -> bool {
        !matches!(self, TypeEntry::Func(..))
    }
}

/// The name of a value type, for messages.
pub fn vt_name(vt: Vt, types: &[TypeEntry]) -> String {
    vt_name_depth(vt, types, 0)
}

fn vt_name_depth(vt: Vt, types: &[TypeEntry], depth: usize) -> String {
    match vt {
        Vt::Ref(t) => match types.get(t as usize) {
            Some(TypeEntry::Array(e)) if depth < 8 => format!("array#<{}>", vt_name_depth(*e, types, depth + 1)),
            Some(TypeEntry::Struct(_)) => format!("struct {t}"),
            Some(TypeEntry::Class(_)) => format!("class {t}"),
            Some(TypeEntry::Interface(_)) => format!("interface {t}"),
            Some(TypeEntry::Map(k, v)) if depth < 8 => {
                format!("map#<{}, {}>", vt_name_depth(*k, types, depth + 1), vt_name_depth(*v, types, depth + 1))
            }
            Some(TypeEntry::Set(e)) if depth < 8 => format!("set#<{}>", vt_name_depth(*e, types, depth + 1)),
            _ => format!("ref {t}"),
        },
        Vt::Code(c) => match vt {
            I32 => "i32".into(),
            I64 => "i64".into(),
            F32 => "f32".into(),
            F64 => "f64".into(),
            STRING => "string".into(),
            ANYREF => "anyref".into(),
            FAULT => "fault".into(),
            SIGNAL => "signal".into(),
            _ => vt.lane().map(String::from).unwrap_or_else(|| format!("0x{c:02X}")),
        },
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct WbcError(pub String);

impl fmt::Display for WbcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

fn err<T>(msg: impl Into<String>) -> Result<T, WbcError> {
    Err(WbcError(msg.into()))
}

// -- opcodes ---------------------------------------------------------------------------------
/// An opcode's name and immediates: L = branch label (padded s32), u = u32, s = s32, S = s64,
/// f = f32 bytes, d = f64 bytes, T = br_table, b = u8, Lu = label then u32, ub = u32 then u8.
#[derive(Clone, Copy, Debug)]
pub struct OpInfo {
    pub name: &'static str,
    pub imm: &'static str,
}

pub const INT_OPS: [&str; 28] = [
    "eqz", "eq", "ne", "lt_s", "lt_u", "gt_s", "gt_u", "le_s", "le_u", "ge_s", "ge_u", "add", "sub", "mul", "div_s",
    "div_u", "rem_s", "rem_u", "and", "or", "xor", "shl", "shr_s", "shr_u", "neg", "not", "extend8_s", "extend16_s",
];
pub const FLOAT_OPS: [&str; 20] = [
    "eq", "ne", "lt", "gt", "le", "ge", "add", "sub", "mul", "div", "min", "max", "neg", "abs", "sqrt", "ceil", "floor",
    "trunc", "nearest", "copysign",
];
pub const CONV: [&str; 25] = [
    "i32.wrap_i64", "i64.extend_i32_s", "i64.extend_i32_u", "i32.trunc_f32_s", "i32.trunc_f32_u", "i32.trunc_f64_s",
    "i32.trunc_f64_u", "i64.trunc_f32_s", "i64.trunc_f32_u", "i64.trunc_f64_s", "i64.trunc_f64_u",
    "f32.convert_i32_s", "f32.convert_i32_u", "f32.convert_i64_s", "f32.convert_i64_u", "f64.convert_i32_s",
    "f64.convert_i32_u", "f64.convert_i64_s", "f64.convert_i64_u", "f32.demote_f64", "f64.promote_f32",
    "i32.reinterpret_f32", "i64.reinterpret_f64", "f32.reinterpret_i32", "f64.reinterpret_i64",
];
pub const LANE_PREFIX: u8 = 0xFB;

const BASE_OPS: &[(&str, u16, &str)] = &[
    ("unreachable", 0x00, ""), ("nop", 0x01, ""), ("br", 0x02, "L"), ("br_if", 0x03, "L"),
    ("br_table", 0x04, "T"), ("return", 0x05, ""), ("call", 0x06, "u"),
    ("cont.push", 0x0A, "L"), ("cont.pop", 0x0B, ""), ("try.push", 0x0C, "Lu"),
    ("cont.depth", 0x17, ""), ("cont.trunc", 0x18, ""),
    ("throw", 0x0E, ""), ("suspend", 0x0D, "b"), ("call_virtual", 0x07, "uu"),
    ("call_interface", 0x08, "uu"), ("call_delegate", 0x09, "u"),
    ("delegate.new", 0xF4, "ub"), ("dispatcher.bind", 0xF5, "u"),
    ("dispatcher.unbind", 0xF6, "u"), ("dispatcher.broadcast", 0xF7, "u"),
    ("ref.null", 0x25, "u"), ("ref.is_null", 0x26, ""), ("ref.eq", 0x27, ""),
    ("ref.cast", 0x28, "u"), ("ref.test", 0x29, "u"), ("ref.valid", 0x2A, ""),
    ("ref.share", 0x2B, ""),
    ("class.new", 0xD3, "u"), ("class.get", 0xD4, "uu"), ("class.set", 0xD5, "uu"),
    ("drop", 0x10, ""), ("select", 0x11, ""),
    ("local.get", 0x12, "u"), ("local.set", 0x13, "u"), ("local.tee", 0x14, "u"),
    ("global.get", 0x15, "u"), ("global.set", 0x16, "u"),
    ("i32.const", 0x20, "s"), ("i64.const", 0x21, "S"), ("f32.const", 0x22, "f"),
    ("f64.const", 0x23, "d"), ("string.const", 0x24, "u"),
    ("string.concat", 0xF0, ""), ("string.len", 0xF1, ""), ("string.eq", 0xF2, ""),
    ("string.cmp", 0xF3, ""),
    ("array.new", 0xD6, "u"), ("array.len", 0xD7, ""), ("array.get", 0xD8, "u"),
    ("array.set", 0xD9, "u"), ("array.push", 0xDA, "u"), ("array.insert", 0xDB, "u"),
    ("array.remove", 0xDC, "u"), ("array.clear", 0xDD, "u"), ("array.clone", 0xDE, "u"),
    ("struct.new", 0xD0, "u"), ("struct.get", 0xD1, "uu"), ("struct.with", 0xD2, "uu"),
    ("map.new", 0xE0, "u"), ("map.find", 0xE1, "u"), ("map.set", 0xE2, "u"),
    ("map.remove", 0xE3, "u"), ("map.has", 0xE4, "u"), ("map.len", 0xE5, "u"),
    ("map.key_at", 0xE6, "u"), ("map.value_at", 0xE7, "u"), ("map.clear", 0xE8, "u"),
    ("set.new", 0xE9, "u"), ("set.add", 0xEA, "u"), ("set.remove", 0xEB, "u"),
    ("set.has", 0xEC, "u"), ("set.len", 0xED, "u"), ("set.at", 0xEE, "u"),
    ("set.clear", 0xEF, "u"),
];

fn leak(s: String) -> &'static str {
    Box::leak(s.into_boxed_str())
}

/// Every opcode by code. Lane instructions are `0xFB00 | sub`.
pub fn ops() -> &'static HashMap<u16, OpInfo> {
    static OPS: OnceLock<HashMap<u16, OpInfo>> = OnceLock::new();
    OPS.get_or_init(|| {
        let mut t = HashMap::new();
        for &(name, code, imm) in BASE_OPS {
            t.insert(code, OpInfo { name, imm });
        }
        for (i, n) in INT_OPS.iter().enumerate() {
            t.insert(0x30 + i as u16, OpInfo { name: leak(format!("i32.{n}")), imm: "" });
        }
        for (i, n) in INT_OPS.iter().chain(["extend32_s"].iter()).enumerate() {
            t.insert(0x50 + i as u16, OpInfo { name: leak(format!("i64.{n}")), imm: "" });
        }
        for (i, n) in FLOAT_OPS.iter().enumerate() {
            t.insert(0x70 + i as u16, OpInfo { name: leak(format!("f32.{n}")), imm: "" });
            t.insert(0x90 + i as u16, OpInfo { name: leak(format!("f64.{n}")), imm: "" });
        }
        for (i, n) in CONV.iter().enumerate() {
            t.insert(0xB0 + i as u16, OpInfo { name: n, imm: "" });
        }
        for b in lanes::BLOCKS.iter() {
            for &(i, op) in b.ops {
                let name = leak(format!("{}.{}", b.prefix, op));
                let imm = if op == "get" || op == "with" { "b" } else { "" };
                t.insert(0xFB00 | (b.base + i), OpInfo { name, imm });
            }
        }
        t
    })
}

/// The code of an opcode by name.
pub fn op_code(name: &str) -> Option<u16> {
    static BY_NAME: OnceLock<HashMap<&'static str, u16>> = OnceLock::new();
    BY_NAME.get_or_init(|| ops().iter().map(|(c, i)| (i.name, *c)).collect()).get(name).copied()
}

// -- byte reader -----------------------------------------------------------------------------
pub struct Reader<'a> {
    pub d: &'a [u8],
    pub p: usize,
    pub end: usize,
}

impl<'a> Reader<'a> {
    pub fn new(d: &'a [u8]) -> Self {
        Reader { d, p: 0, end: d.len() }
    }
    pub fn range(d: &'a [u8], pos: usize, end: usize) -> Self {
        Reader { d, p: pos, end }
    }
    pub fn eof(&self) -> bool {
        self.p >= self.end
    }
    pub fn need(&self, n: usize) -> Result<(), WbcError> {
        if self.p.checked_add(n).map_or(true, |e| e > self.end) {
            return err("unexpected end of data");
        }
        Ok(())
    }
    pub fn u8(&mut self) -> Result<u8, WbcError> {
        self.need(1)?;
        let b = self.d[self.p];
        self.p += 1;
        Ok(b)
    }
    pub fn u32(&mut self) -> Result<u32, WbcError> {
        let mut result: u64 = 0;
        let mut shift = 0u32;
        loop {
            let b = self.u8()?;
            result += ((b & 0x7F) as u64) << shift;
            shift += 7;
            if b & 0x80 == 0 {
                break;
            }
            if shift > 35 {
                return err("LEB128 too long");
            }
        }
        if result > 0xFFFF_FFFF {
            return err("u32 out of range");
        }
        Ok(result as u32)
    }
    /// Signed LEB128 of up to `bits` bits (a longer encoding is an error).
    pub fn sleb_big(&mut self, bits: u32) -> Result<i128, WbcError> {
        let mut result: i128 = 0;
        let mut shift = 0u32;
        let mut b;
        loop {
            b = self.u8()?;
            if shift < 127 {
                result |= ((b & 0x7F) as i128) << shift;
            }
            shift += 7;
            if b & 0x80 == 0 {
                break;
            }
            if shift > bits + 7 {
                return err("LEB128 too long");
            }
        }
        if b & 0x40 != 0 && shift < 127 {
            result -= 1i128 << shift;
        }
        Ok(result)
    }
    pub fn sleb(&mut self, bits: u32) -> Result<i64, WbcError> {
        Ok(self.sleb_big(bits)? as i64)
    }
    pub fn f32(&mut self) -> Result<f32, WbcError> {
        Ok(f32::from_le_bytes(self.raw(4)?.try_into().unwrap()))
    }
    pub fn f64(&mut self) -> Result<f64, WbcError> {
        Ok(f64::from_le_bytes(self.raw(8)?.try_into().unwrap()))
    }
    pub fn i64(&mut self) -> Result<i64, WbcError> {
        Ok(i64::from_le_bytes(self.raw(8)?.try_into().unwrap()))
    }
    pub fn u32le(&mut self) -> Result<u32, WbcError> {
        Ok(u32::from_le_bytes(self.raw(4)?.try_into().unwrap()))
    }
    pub fn raw(&mut self, n: usize) -> Result<&'a [u8], WbcError> {
        self.need(n)?;
        let v = &self.d[self.p..self.p + n];
        self.p += n;
        Ok(v)
    }
    pub fn name(&mut self) -> Result<String, WbcError> {
        let n = self.u32()? as usize;
        let b = self.raw(n)?;
        String::from_utf8(b.to_vec()).map_err(|_| WbcError("invalid UTF-8 in name".into()))
    }
    pub fn blob(&mut self) -> Result<&'a [u8], WbcError> {
        let n = self.u32()? as usize;
        self.raw(n)
    }
    pub fn vt(&mut self) -> Result<Vt, WbcError> {
        let code = self.u8()?;
        Ok(if code == REF { Vt::Ref(self.u32()?) } else { Vt::Code(code) })
    }
}

// -- instructions ----------------------------------------------------------------------------
#[derive(Clone, Debug)]
pub struct Instr {
    pub pc: usize,
    pub size: usize,
    pub op: u16,
    pub name: &'static str,
    /// integer immediates in order (a label is its signed offset)
    pub imms: Vec<i64>,
    /// the value of an `f32.const` or `f64.const`
    pub fimm: f64,
}

impl Instr {
    /// Absolute pc of a label immediate.
    pub fn target(&self) -> i64 {
        self.pc as i64 + self.size as i64 + self.imms[0]
    }
    pub fn imm(&self, i: usize) -> i64 {
        self.imms.get(i).copied().unwrap_or(0)
    }
    pub fn uimm(&self, i: usize) -> usize {
        self.imm(i) as usize
    }
}

pub fn decode_code(code: &[u8]) -> Result<Vec<Instr>, WbcError> {
    let mut out = Vec::new();
    let mut r = Reader::new(code);
    let table = ops();
    while !r.eof() {
        let pc = r.p;
        let mut op = r.u8()? as u16;
        if op == LANE_PREFIX as u16 {
            let sub = r.u32()?;
            let code = if sub <= 0xFF { Some(0xFB00 | sub as u16) } else { None };
            match code.filter(|c| table.contains_key(c)) {
                Some(c) => op = c,
                None => return err(format!("invalid lane sub-opcode FB {sub:02X} at pc {pc}")),
            }
        }
        let Some(info) = table.get(&op) else {
            return err(format!("invalid opcode 0x{op:02X} at pc {pc}"));
        };
        let mut fimm = 0.0;
        let imms = match info.imm {
            "" => vec![],
            "L" => vec![r.sleb(32)?],
            "Lu" => vec![r.sleb(32)?, r.u32()? as i64],
            "b" => vec![r.u8()? as i64],
            "ub" => vec![r.u32()? as i64, r.u8()? as i64],
            "u" => vec![r.u32()? as i64],
            "uu" => vec![r.u32()? as i64, r.u32()? as i64],
            "s" => vec![r.sleb(32)?],
            "S" => vec![r.sleb(64)?],
            "f" => {
                fimm = r.f32()? as f64;
                vec![]
            }
            "d" => {
                fimm = r.f64()?;
                vec![]
            }
            "T" => {
                let n = r.u32()? as usize;
                let mut v = Vec::new();
                for _ in 0..n + 1 {
                    v.push(r.sleb(32)?);
                }
                v
            }
            other => return err(format!("bad immediate kind {other}")),
        };
        out.push(Instr { pc, size: r.p - pc, op, name: info.name, imms, fimm });
    }
    Ok(out)
}

// -- module ----------------------------------------------------------------------------------
#[derive(Clone, Debug)]
pub struct Body {
    pub locals: Vec<Vt>,
    pub max_stack: u32,
    pub max_cont: u32,
    pub code: Vec<u8>,
}

#[derive(Clone, Debug, Default)]
pub struct Import {
    pub module: String,
    pub field: String,
    pub ty: u32,
    pub flags: u8,
}

#[derive(Clone, Debug)]
pub struct Global {
    pub vt: Vt,
    pub mutable: bool,
    pub init: Const,
}

#[derive(Clone, Debug)]
pub struct Export {
    pub name: String,
    pub kind: u8,
    pub index: u32,
    pub flags: u8,
}

#[derive(Clone, Debug, Default)]
pub struct WbcModule {
    pub flags: u32,
    pub types: Vec<TypeEntry>,
    pub imports: Vec<Import>,
    /// (type index, flags)
    pub funcs: Vec<(u32, u8)>,
    pub globals: Vec<Global>,
    pub exports: Vec<Export>,
    pub data: Vec<String>,
    pub bodies: Vec<Body>,
    pub customs: Vec<(String, Vec<u8>)>,
}

impl WbcModule {
    pub fn custom(&self, name: &str) -> Option<&[u8]> {
        self.customs.iter().find(|(n, _)| n == name).map(|(_, p)| p.as_slice())
    }

    /// (params, results, flags) for a function index (imports first). The verifier has
    /// checked that the type index names a function type.
    pub fn func_type(&self, fidx: usize) -> (&[Vt], &[Vt], u8) {
        let (t, flags) = if fidx < self.imports.len() {
            (self.imports[fidx].ty, self.imports[fidx].flags)
        } else {
            self.funcs[fidx - self.imports.len()]
        };
        match self.types.get(t as usize) {
            Some(TypeEntry::Func(p, r)) => (p, r, flags),
            _ => (&[], &[], flags),
        }
    }

    pub fn nfuncs(&self) -> usize {
        self.imports.len() + self.funcs.len()
    }
}

fn read_const(r: &mut Reader, vt: Vt) -> Result<Const, WbcError> {
    if let Some(layout) = lanes::layout(vt) {
        let mut v = Vec::new();
        for f in layout {
            v.push(if lanes::layout(*f).is_some() { read_const(r, *f)? } else { Const::F32(r.f32()?) });
        }
        return Ok(Const::Lane(v));
    }
    if vt.is_ref() || vt == SIGNAL {
        return Ok(Const::Null);
    }
    match vt {
        I32 | I64 => Ok(Const::Int(r.i64()?)),
        F32 => {
            let v = r.f32()?;
            r.raw(4)?;
            Ok(Const::F32(v))
        }
        F64 => Ok(Const::F64(r.f64()?)),
        STRING => Ok(Const::Data(r.u32()?)),
        Vt::Code(c) => err(format!("bad const type 0x{c:02X}")),
        Vt::Ref(_) => unreachable!(),
    }
}

pub fn decode_module(data: &[u8]) -> Result<WbcModule, WbcError> {
    if data.len() < 12 || data[..4] != MAGIC {
        return err("not a WBC module (bad magic)");
    }
    let mut head = Reader::range(data, 4, data.len());
    let version = head.u32le()?;
    let flags = head.u32le()?;
    if version != VERSION {
        return err(format!("unsupported WBC version {version}"));
    }
    if flags & !(FLAG_HAS_SOURCE | FLAG_LANES) != 0 {
        return err(format!("module requires unknown features (flags 0x{flags:08X})"));
    }
    let mut m = WbcModule { flags, ..Default::default() };
    let mut r = Reader::range(data, 12, data.len());
    let mut last = 0u8;
    while !r.eof() {
        let sid = r.u8()?;
        let size = r.u32()? as usize;
        r.need(size)?;
        let mut s = Reader::range(data, r.p, r.p + size);
        r.p += size;
        if sid == SEC_CUSTOM {
            let name = s.name()?;
            m.customs.push((name, data[s.p..s.end].to_vec()));
            continue;
        }
        if sid > SEC_CODE {
            return err(format!("unknown section id {sid}"));
        }
        if sid <= last {
            return err(format!("section {sid} out of order"));
        }
        last = sid;
        match sid {
            SEC_TYPE => {
                for _ in 0..s.u32()? {
                    let code = s.u8()?;
                    let entry = match code {
                        ARRAY_TYPE => TypeEntry::Array(s.vt()?),
                        MAP_TYPE => {
                            let k = s.vt()?;
                            TypeEntry::Map(k, s.vt()?)
                        }
                        DELEGATE_TYPE => TypeEntry::Delegate(s.u32()?),
                        DISPATCHER_TYPE => TypeEntry::Dispatcher(s.u32()?),
                        INTERFACE_TYPE => {
                            let mut methods = Vec::new();
                            for _ in 0..s.u32()? {
                                methods.push(s.u32()?);
                            }
                            TypeEntry::Interface(methods)
                        }
                        SET_TYPE => TypeEntry::Set(s.vt()?),
                        STRUCT_TYPE | CLASS_TYPE => {
                            let mut sup = None;
                            let mut ifaces = Vec::new();
                            if code == CLASS_TYPE {
                                if s.u8()? != 0 {
                                    return err("host class types are not supported by this VM");
                                }
                                let sp = s.u32()?;
                                sup = if sp == 0 { None } else { Some(sp - 1) };
                                for _ in 0..s.u32()? {
                                    let iface = s.u32()?;
                                    let mut imp = Vec::new();
                                    for _ in 0..s.u32()? {
                                        imp.push(s.u32()?);
                                    }
                                    ifaces.push((iface, imp));
                                }
                            }
                            let mut fields = Vec::new();
                            for _ in 0..s.u32()? {
                                let vt = s.vt()?;
                                let fl = s.u8()?;
                                if fl & !1 != 0 {
                                    return err(format!("struct field flags 0x{fl:02X} are not supported"));
                                }
                                if fl != 0 && vt.is_ref() {
                                    return err("a reference field cannot have a default");
                                }
                                fields.push((vt, if fl != 0 { Some(read_const(&mut s, vt)?) } else { None }));
                            }
                            if code == CLASS_TYPE {
                                let mut vtable = Vec::new();
                                for _ in 0..s.u32()? {
                                    vtable.push(s.u32()?);
                                }
                                TypeEntry::Class(ClassType { sup, fields, vtable, interfaces: ifaces })
                            } else {
                                TypeEntry::Struct(fields)
                            }
                        }
                        FUNC_TYPE => {
                            let mut params = Vec::new();
                            let mut results = Vec::new();
                            for _ in 0..s.u32()? {
                                params.push(s.vt()?);
                            }
                            for _ in 0..s.u32()? {
                                results.push(s.vt()?);
                            }
                            TypeEntry::Func(params, results)
                        }
                        _ => return err(format!("type entry 0x{code:02X} is not supported by this VM")),
                    };
                    m.types.push(entry);
                }
            }
            SEC_IMPORT => {
                for _ in 0..s.u32()? {
                    let module = s.name()?;
                    let field = s.name()?;
                    if s.u8()? != 0 {
                        return err("only function imports are supported");
                    }
                    let ty = s.u32()?;
                    m.imports.push(Import { module, field, ty, flags: s.u8()? });
                }
            }
            SEC_FUNCTION => {
                for _ in 0..s.u32()? {
                    let t = s.u32()?;
                    m.funcs.push((t, s.u8()?));
                }
            }
            SEC_GLOBAL => {
                for _ in 0..s.u32()? {
                    let vt = s.vt()?;
                    let mutable = s.u8()? != 0;
                    let init = read_const(&mut s, vt)?;
                    m.globals.push(Global { vt, mutable, init });
                }
            }
            SEC_EXPORT => {
                for _ in 0..s.u32()? {
                    let name = s.name()?;
                    let kind = s.u8()?;
                    let index = s.u32()?;
                    m.exports.push(Export { name, kind, index, flags: s.u8()? });
                }
            }
            SEC_DATA => {
                for _ in 0..s.u32()? {
                    let b = s.blob()?;
                    m.data.push(
                        String::from_utf8(b.to_vec()).map_err(|_| WbcError("invalid UTF-8 in data section".into()))?,
                    );
                }
            }
            SEC_CODE => {
                for _ in 0..s.u32()? {
                    let bsize = s.u32()? as usize;
                    s.need(bsize)?;
                    let mut b = Reader::range(data, s.p, s.p + bsize);
                    s.p += bsize;
                    let mut locs = Vec::new();
                    for _ in 0..b.u32()? {
                        let count = b.u32()? as usize;
                        let vt = b.vt()?;
                        if count > 65536 || locs.len() + count > 65536 {
                            return err("too many locals");
                        }
                        locs.extend(std::iter::repeat(vt).take(count));
                    }
                    let ms = b.u32()?;
                    let mc = b.u32()?;
                    m.bodies.push(Body { locals: locs, max_stack: ms, max_cont: mc, code: data[b.p..b.end].to_vec() });
                }
            }
            _ => {}
        }
        if !s.eof() {
            return err(format!("section {sid} has trailing bytes"));
        }
    }
    Ok(m)
}
