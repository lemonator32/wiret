//! The VM: loads, verifies, links and interprets WBC modules (spec sections 5 and 6), a port of
//! `src/core/vm.ts`.
//!
//! It follows the C API's model: [`Vm::load`] is `wr_load` (decode, verify, link), [`Vm::call`]
//! is `wr_push_func` + `wr_call`, faults carry a node-level traceback (section 6.9) and
//! execution is bounded by fuel (5.7). Latent functions run as fibers that [`Vm::advance`]
//! resumes as virtual time passes (4.5).
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use indexmap::IndexMap;
use serde_json::Value as J;

use crate::detmath;
use crate::lanes::{self, LaneOp, Trig};
use crate::natives::{all_natives, lane_trig_natives, CostFn, NativeFn, NativeSpec, LANE_TRIG};
use crate::value::*;
use crate::verifier::verify;
use crate::wbc::{self, Const, Reader, TypeEntry, Vt, WbcError, WbcModule};

pub const STATUS_OK: &str = "WR_OK";
pub const STATUS_FAULT: &str = "WR_ERR_FAULT";
pub const STATUS_FUEL: &str = "WR_ERR_FUEL";
pub const STATUS_LOAD: &str = "WR_ERR_LOAD";
pub const STATUS_VERIFY: &str = "WR_ERR_VERIFY";
pub const STATUS_LINK: &str = "WR_ERR_LINK";
pub const STATUS_API: &str = "WR_ERR_API";
pub const STATUS_INTERRUPT: &str = "WR_ERR_INTERRUPT";
pub const STATUS_YIELD: &str = "WR_YIELD";

pub const MAX_FRAMES: usize = 2000;
pub const MAX_CONT: usize = 10000;
/// How deeply broadcasts may nest (each runs its handlers on the host stack).
pub const MAX_NESTING: u32 = 200;
/// How many steps of virtual time [`Vm::run_function`] takes before giving up.
pub const MAX_ADVANCES: usize = 100_000;

pub const FAULT_DIVIDE: i32 = -1;
pub const FAULT_RANGE: i32 = -2;
pub const FAULT_NULL: i32 = -3;
pub const FAULT_CAST: i32 = -4;
pub const FAULT_STACK: i32 = -5;
pub const FAULT_NATIVE: i32 = -6;
pub const FAULT_UNREACHABLE: i32 = -7;

/// An error from the VM: a status code (section 6.2), a message, and for a fault the Wiret
/// call stack (function, node) from the outermost call in.
#[derive(Clone, Debug, PartialEq)]
pub struct WiretError {
    pub status: String,
    pub message: String,
    pub traceback: Vec<(String, Option<String>)>,
    pub code: i32,
}

impl WiretError {
    pub fn new(status: &str, message: impl Into<String>) -> WiretError {
        WiretError { status: status.into(), message: message.into(), traceback: vec![], code: 0 }
    }
}

impl fmt::Display for WiretError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.status, self.message)?;
        for (func, node) in &self.traceback {
            write!(f, "\n  at {func}")?;
            if let Some(n) = node {
                write!(f, " node {n}")?;
            }
        }
        Ok(())
    }
}

impl std::error::Error for WiretError {}

/// A runtime fault (catchable by `Try`, section 4.6) or an error that ends the run.
enum Trap {
    Fault(String, i32),
    Error(WiretError),
}

fn fault<T>(msg: impl Into<String>, code: i32) -> Result<T, Trap> {
    Err(Trap::Fault(msg.into(), code))
}

// -- loaded code -----------------------------------------------------------------------------
#[derive(Clone, Debug)]
pub struct Handler {
    h: usize,
    slot: usize,
    node: Option<Rc<str>>,
}

#[derive(Clone, Copy, Debug)]
enum MapOp {
    New, Find, Set, Remove, Has, Len, KeyAt, ValueAt, Clear,
}

#[derive(Clone, Copy, Debug)]
enum SetOp {
    New, Add, Remove, Has, Len, At, Clear,
}

#[derive(Clone, Copy, Debug)]
enum ArrOp {
    Len, Get, Set, Push, Insert, Remove, Clear, Clone,
}

/// One instruction, decoded and resolved at load time.
#[derive(Clone)]
enum Ins {
    Unreachable,
    Nop,
    Br(usize),
    BrIf(usize),
    Return,
    Call(usize),
    CallVirtual { slot: usize, nargs: usize },
    CallInterface { iface: u32, k: usize, nargs: usize },
    CallDelegate(usize),
    ContPush(usize),
    ContPop,
    TryPush(Handler),
    Suspend(u8),
    Throw,
    ContDepth,
    ContTrunc,
    Drop,
    Select,
    LGet(usize),
    LSet(usize),
    LTee(usize),
    GGet(usize),
    GSet(usize),
    Const(Value),
    RefNull,
    RefIsNull,
    RefEq,
    RefCast(u32),
    RefTest(u32),
    RefValid,
    RefShare,
    ClassNew(Rc<ClassInfo>),
    ClassGet(usize),
    ClassSet(usize),
    DelegateNew(usize, u8),
    Bind,
    Unbind,
    Broadcast(usize),
    StructNew(usize),
    StructGet(usize),
    StructWith(usize),
    Num(u16),
    Lane(LaneOp),
    ArrayNew(Value),
    Array(ArrOp),
    Map(MapOp, Value),
    Set(SetOp),
    Bad(u16),
}

/// A function: imported (a native) or defined in the module.
pub struct Func {
    pub index: usize,
    pub name: Rc<str>,
    pub params: Vec<Vt>,
    pub results: Vec<Vt>,
    pub flags: u8,
    pub native: Option<NativeFn>,
    pub native_name: String,
    pub cost: Option<CostFn>,
    pub locals: Vec<Vt>,
    pub zeros: Vec<Value>,
    code: Vec<Ins>,
    /// the byte offset of each instruction
    pub pcs: Vec<usize>,
    /// the node each instruction belongs to, and the node a fault there is reported at
    pub node_at: Vec<Option<Rc<str>>>,
    pub fault_at: Vec<Option<Rc<str>>>,
    starts: Vec<Option<Vec<Rc<str>>>>,
    steps: Vec<Option<Rc<str>>>,
    /// local index -> name
    pub local_names: IndexMap<u32, String>,
    /// (local, node id, pin name) for every pin value kept in a local (wr.pins)
    pub pins: Vec<(usize, Rc<str>, Rc<str>)>,
}

impl Func {
    pub fn is_latent(&self) -> bool {
        self.flags & wbc::FN_LATENT != 0
    }
}

impl fmt::Debug for Func {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Func({} {})", self.index, self.name)
    }
}

/// A module after loading: its functions, exports, globals and classes.
pub struct LoadedModule {
    pub wbc: WbcModule,
    pub name: String,
    pub funcs: Vec<Rc<Func>>,
    /// exported function name -> function index
    pub exports: IndexMap<String, usize>,
    pub globals: RefCell<Vec<Value>>,
    pub meta: IndexMap<String, String>,
    pub global_names: IndexMap<String, usize>,
    pub classes: IndexMap<String, Rc<ClassInfo>>,
    pub capabilities: Vec<String>,
    /// exports the source declared (EX_DECLARED)
    pub declared: HashSet<String>,
}

impl LoadedModule {
    pub fn export(&self, name: &str) -> Option<&Rc<Func>> {
        self.exports.get(name).map(|&i| &self.funcs[i])
    }
}

// -- fibers ----------------------------------------------------------------------------------
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FiberStatus {
    Ready,
    Running,
    Suspended,
    Done,
    Faulted,
}

impl FiberStatus {
    pub fn name(self) -> &'static str {
        match self {
            FiberStatus::Ready => "READY",
            FiberStatus::Running => "RUNNING",
            FiberStatus::Suspended => "SUSPENDED",
            FiberStatus::Done => "DONE",
            FiberStatus::Faulted => "FAULTED",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Waiting {
    Nothing,
    Time,
    Signal,
}

#[derive(Clone, Debug)]
enum Cont {
    Ret(usize),
    Handler(Handler),
}

struct Frame {
    f: Rc<Func>,
    ip: usize,
    locs: Vec<Value>,
    stack: Vec<Value>,
    cont: Vec<Cont>,
}

/// The execution state of a fiber: its current function and the frames below it.
struct ExecState {
    f: Rc<Func>,
    ip: usize,
    locs: Vec<Value>,
    stack: Vec<Value>,
    cont: Vec<Cont>,
    frames: Vec<Frame>,
}

/// One thread of execution with its own frames (section 4.5).
pub struct Fiber {
    pub id: u64,
    pub module: Rc<LoadedModule>,
    pub name: String,
    pub status: FiberStatus,
    pub results: Option<Vec<Value>>,
    pub error: Option<WiretError>,
    pub waiting: Waiting,
    pub signal: Option<Rc<Signal>>,
    pub wake: f64,
    state: Option<ExecState>,
}

pub type FiberRef = Rc<RefCell<Fiber>>;

// -- debugging -------------------------------------------------------------------------------
/// One frame of a paused fiber, for a debugger.
#[derive(Clone)]
pub struct FrameView {
    pub func: Rc<Func>,
    pub node: Option<Rc<str>>,
    pub locals: Vec<Value>,
}

impl FrameView {
    /// (node, pin, value) for every pin kept in a local (wr.pins), by "node\0pin".
    pub fn pin_values(&self) -> IndexMap<String, (Rc<str>, Rc<str>, Value)> {
        let mut out = IndexMap::new();
        for (li, node, pin) in &self.func.pins {
            let v = self.locals.get(*li).cloned().unwrap_or(Value::Null);
            out.insert(format!("{node}\0{pin}"), (node.clone(), pin.clone(), v));
        }
        out
    }
    pub fn named_locals(&self) -> IndexMap<String, Value> {
        let mut out = IndexMap::new();
        for (li, name) in &self.func.local_names {
            if let Some(v) = self.locals.get(*li as usize) {
                out.insert(name.clone(), v.clone());
            }
        }
        out
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    /// the node starts
    Enter,
    /// the node's inputs are ready and it is about to act (a stepping point)
    Ready,
}

impl Phase {
    pub fn name(self) -> &'static str {
        match self {
            Phase::Enter => "enter",
            Phase::Ready => "ready",
        }
    }
}

pub struct HookEvent<'a> {
    pub func: &'a Rc<str>,
    pub node: &'a Rc<str>,
    pub depth: usize,
    pub phase: Phase,
}

/// What a debug hook may look at while the VM is paused at a node.
pub trait DebugView {
    /// The call stack, outermost first.
    fn frames(&self) -> Vec<FrameView>;
    /// The continuation stack as node ids, bottom first.
    fn pending(&self) -> Vec<Option<String>>;
    /// A global of the running module.
    fn global(&self, index: usize) -> Option<Value>;
}

pub type Hook = Box<dyn FnMut(&HookEvent, &dyn DebugView)>;

struct View<'a> {
    st: &'a ExecState,
    node: &'a Rc<str>,
    module: &'a LoadedModule,
}

impl DebugView for View<'_> {
    fn frames(&self) -> Vec<FrameView> {
        let mut out: Vec<FrameView> = self
            .st
            .frames
            .iter()
            .map(|fr| FrameView {
                func: fr.f.clone(),
                node: fr.f.fault_at.get(fr.ip.saturating_sub(1)).cloned().flatten(),
                locals: fr.locs.clone(),
            })
            .collect();
        out.push(FrameView { func: self.st.f.clone(), node: Some(self.node.clone()), locals: self.st.locs.clone() });
        out
    }
    fn pending(&self) -> Vec<Option<String>> {
        let f = &self.st.f;
        self.st
            .cont
            .iter()
            .map(|k| match k {
                Cont::Ret(i) => f.node_at.get(*i).cloned().flatten().map(|s| s.to_string()),
                Cont::Handler(h) => Some(format!("{}!fault", h.node.as_deref().unwrap_or("null"))),
            })
            .collect()
    }
    fn global(&self, index: usize) -> Option<Value> {
        self.module.globals.borrow().get(index).cloned()
    }
}

// -- values from the host ----------------------------------------------------------------------
/// A host value as the VM holds it for a value type: numbers converted, lists, maps and sets
/// copied into fresh containers, structs rebuilt field by field.
pub fn normalise(vt: Vt, v: &Value, types: Option<&[TypeEntry]>) -> Value {
    match vt {
        Vt::Ref(t) => {
            let entry = types.and_then(|ts| ts.get(t as usize));
            match (entry, v) {
                (Some(TypeEntry::Class(_) | TypeEntry::Interface(_) | TypeEntry::Delegate(_) | TypeEntry::Dispatcher(_)), _)
                | (_, Value::Obj(_) | Value::Delegate(_) | Value::Null) => v.clone(),
                (Some(TypeEntry::Struct(fields)), _) => {
                    let items = v.items();
                    Value::list(
                        fields.iter().enumerate().map(|(i, (fvt, _))| normalise(*fvt, items.get(i).unwrap_or(&Value::Null), types)).collect(),
                    )
                }
                (Some(TypeEntry::Map(k, val)), _) => {
                    let src: Vec<(Value, Value)> = match v {
                        Value::Map(m) => m.borrow().iter().cloned().collect(),
                        _ => vec![],
                    };
                    Value::new_map(MapData::from_entries(src.iter().map(|(a, b)| (normalise(*k, a, types), normalise(*val, b, types)))))
                }
                (Some(TypeEntry::Set(e)), _) => {
                    let src: Vec<Value> = match v {
                        Value::Map(m) => m.borrow().iter().map(|(k, _)| k.clone()).collect(),
                        other => other.items(),
                    };
                    Value::new_map(MapData::from_entries(src.iter().map(|k| (normalise(*e, k, types), Value::Null))))
                }
                (None, Value::Map(m)) => Value::new_map(m.borrow().copy()),
                (entry, _) => {
                    let items = v.items();
                    let items = match entry {
                        Some(TypeEntry::Array(elem)) => items.iter().map(|x| normalise(*elem, x, types)).collect(),
                        _ => items,
                    };
                    Value::new_array(items, false)
                }
            }
        }
        wbc::I32 => Value::I32(v.i32()),
        wbc::I64 => Value::I64(v.i64()),
        wbc::F32 => Value::F32(v.as_f64() as f32),
        wbc::F64 => Value::F64(v.as_f64()),
        wbc::FAULT | wbc::SIGNAL | wbc::ANYREF => v.clone(),
        _ => {
            if let Some(name) = vt.lane() {
                return lanes::normalise(name, v);
            }
            match v {
                Value::Str(_) => v.clone(),
                other => Value::str(&format!("{}", other.as_f64())),
            }
        }
    }
}

/// A value as the host gets it back: arrays and maps copied (at any depth), so the host never
/// shares a container with the VM.
pub fn export_value(v: &Value) -> Value {
    match v {
        Value::Array(a) => Value::new_array(a.borrow().items.iter().map(export_value).collect(), false),
        Value::Map(m) => {
            let m = m.borrow();
            Value::new_map(MapData::from_entries(m.iter().map(|(k, x)| (export_value(k), export_value(x)))))
        }
        Value::Struct(items) => Value::list(items.iter().map(export_value).collect()),
        other => other.clone(),
    }
}

fn zero_of(vt: Vt) -> Value {
    match vt {
        wbc::I32 => Value::I32(0),
        wbc::I64 => Value::I64(0),
        wbc::F32 => Value::F32(0.0),
        wbc::F64 => Value::F64(0.0),
        wbc::STRING => Value::str(""),
        wbc::FAULT => no_fault(),
        _ => vt.lane().map(lanes::default_value).unwrap_or(Value::Null),
    }
}

fn const_value(vt: Vt, c: &Const, data: &[String]) -> Value {
    match c {
        Const::Null => Value::Null,
        Const::Int(n) => if vt == wbc::I64 { Value::I64(*n) } else { Value::I32(*n as i32) },
        Const::F32(x) => Value::F32(*x),
        Const::F64(x) => Value::F64(*x),
        Const::Data(i) => {
            if vt == wbc::STRING {
                Value::str(data.get(*i as usize).map(String::as_str).unwrap_or(""))
            } else {
                Value::I32(*i as i32)
            }
        }
        Const::Lane(items) => {
            let layout = lanes::layout(vt).unwrap_or(&[]);
            Value::list(
                items.iter().enumerate().map(|(i, x)| const_value(layout.get(i).copied().unwrap_or(wbc::F32), x, data)).collect(),
            )
        }
    }
}

/// The default value of each value type, for locals, globals, fields and new array elements.
struct Defaults<'a> {
    types: &'a [TypeEntry],
    data: &'a [String],
    structs: HashMap<u32, Value>,
}

impl Defaults<'_> {
    fn get(&mut self, vt: Vt) -> Value {
        let Vt::Ref(t) = vt else { return zero_of(vt) };
        match self.types.get(t as usize) {
            Some(TypeEntry::Class(_) | TypeEntry::Interface(_) | TypeEntry::Delegate(_) | TypeEntry::Dispatcher(_)) => Value::Null,
            Some(TypeEntry::Map(..) | TypeEntry::Set(_)) => Value::new_map(MapData { shared: true, ..Default::default() }),
            Some(TypeEntry::Struct(fields)) => {
                if let Some(v) = self.structs.get(&t) {
                    return v.clone();
                }
                let fields = fields.clone();
                let v = Value::list(
                    fields.iter().map(|(fvt, d)| match d {
                        None => self.get(*fvt),
                        Some(c) => const_value(*fvt, c, self.data),
                    }).collect(),
                );
                self.structs.insert(t, v.clone());
                v
            }
            _ => Value::new_array(vec![], true),
        }
    }
}

// -- custom sections ---------------------------------------------------------------------------
type DebugTable = HashMap<usize, (String, Vec<(usize, String)>, Vec<String>)>;

#[derive(Default)]
pub struct Customs {
    pub names: HashMap<usize, String>,
    pub local_names: HashMap<usize, IndexMap<u32, String>>,
    debug: DebugTable,
    pub meta: IndexMap<String, String>,
    pub class_names: HashMap<u32, (String, Vec<String>)>,
}

pub fn parse_customs(m: &WbcModule) -> Result<Customs, WbcError> {
    let mut c = Customs::default();
    if let Some(p) = m.custom("name") {
        let mut r = Reader::new(p);
        for _ in 0..r.u32()? {
            let i = r.u32()? as usize;
            c.names.insert(i, r.name()?);
        }
        for _ in 0..r.u32()? {
            let fi = r.u32()? as usize;
            let mut ln = IndexMap::new();
            for _ in 0..r.u32()? {
                let li = r.u32()?;
                ln.insert(li, r.name()?);
            }
            c.local_names.insert(fi, ln);
        }
        for _ in 0..r.u32()? {
            r.u32()?;
            r.name()?;
        }
        if !r.eof() {
            for _ in 0..r.u32()? {
                let ti = r.u32()?;
                let cname = r.name()?;
                let mut fields = Vec::new();
                for _ in 0..r.u32()? {
                    fields.push(r.name()?);
                }
                c.class_names.insert(ti, (cname, fields));
            }
        }
    }
    if let Some(p) = m.custom("wr.debug") {
        let mut r = Reader::new(p);
        for _ in 0..r.u32()? {
            let fi = r.u32()? as usize;
            let graph = r.name()?;
            let mut table = Vec::new();
            for _ in 0..r.u32()? {
                table.push(r.name()?);
            }
            let mut entries = Vec::new();
            let mut pc = 0usize;
            for _ in 0..r.u32()? {
                pc += r.u32()? as usize;
                let ni = r.u32()? as usize;
                if ni >= table.len() {
                    return Err(WbcError("wr.debug node index out of range".into()));
                }
                entries.push((pc, table[ni].clone()));
            }
            c.debug.insert(fi, (graph, entries, table));
        }
    }
    if let Some(p) = m.custom("wr.meta") {
        let mut r = Reader::new(p);
        for k in ["module", "id", "compiler", "registry", "semantic_hash", "layout_hash", "source_hash", "exports"] {
            if r.eof() {
                break;
            }
            c.meta.insert(k.into(), r.name()?);
        }
    }
    Ok(c)
}

fn parse_pins(m: &WbcModule, debug: &DebugTable) -> Result<HashMap<usize, Vec<(usize, String, String)>>, WbcError> {
    let mut out = HashMap::new();
    let Some(p) = m.custom("wr.pins") else { return Ok(out) };
    let mut r = Reader::new(p);
    let empty = vec![];
    for _ in 0..r.u32()? {
        let fi = r.u32()? as usize;
        let table = debug.get(&fi).map(|d| &d.2).unwrap_or(&empty);
        let mut entries = Vec::new();
        for _ in 0..r.u32()? {
            let (li, ni, pi) = (r.u32()? as usize, r.u32()? as usize, r.u32()? as usize);
            if ni >= table.len() || pi >= table.len() {
                return Err(WbcError("wr.pins index out of range".into()));
            }
            entries.push((li, table[ni].clone(), table[pi].clone()));
        }
        out.insert(fi, entries);
    }
    Ok(out)
}

/// wr.steps (and wr.pure, same layout): function index -> (pc, node id).
fn parse_steps(m: &WbcModule, debug: &DebugTable, section: &str) -> Result<HashMap<usize, Vec<(usize, String)>>, WbcError> {
    let mut out = HashMap::new();
    let Some(p) = m.custom(section) else { return Ok(out) };
    let mut r = Reader::new(p);
    let empty = vec![];
    for _ in 0..r.u32()? {
        let fi = r.u32()? as usize;
        let table = debug.get(&fi).map(|d| &d.2).unwrap_or(&empty);
        let mut entries = Vec::new();
        let mut pc = 0usize;
        for _ in 0..r.u32()? {
            pc += r.u32()? as usize;
            let ni = r.u32()? as usize;
            if ni >= table.len() {
                return Err(WbcError(format!("{section} index out of range")));
            }
            entries.push((pc, table[ni].clone()));
        }
        out.insert(fi, entries);
    }
    Ok(out)
}

fn parse_global_names(m: &WbcModule) -> IndexMap<String, usize> {
    let parse = || -> Result<IndexMap<String, usize>, WbcError> {
        let mut out = IndexMap::new();
        let Some(p) = m.custom("name") else { return Ok(out) };
        let mut r = Reader::new(p);
        for _ in 0..r.u32()? {
            r.u32()?;
            r.name()?;
        }
        for _ in 0..r.u32()? {
            r.u32()?;
            for _ in 0..r.u32()? {
                r.u32()?;
                r.name()?;
            }
        }
        for _ in 0..r.u32()? {
            let gi = r.u32()? as usize;
            out.insert(r.name()?, gi);
        }
        Ok(out)
    };
    parse().unwrap_or_default()
}

/// wr.caps: the capabilities the module declares it needs.
pub fn parse_caps(m: &WbcModule) -> Result<Vec<String>, WbcError> {
    let Some(p) = m.custom("wr.caps") else { return Ok(vec![]) };
    let mut r = Reader::new(p);
    let mut out = Vec::new();
    for _ in 0..r.u32()? {
        out.push(r.name()?);
    }
    Ok(out)
}

/// wr_module_each_capability before loading.
pub fn module_capabilities(data: &[u8]) -> Result<Vec<String>, WiretError> {
    let m = wbc::decode_module(data).map_err(|e| WiretError::new(STATUS_LOAD, e.0))?;
    parse_caps(&m).map_err(|e| WiretError::new(STATUS_LOAD, e.0))
}

/// The value type a native's Wiret type name maps to, for linking.
pub fn vt_of(name: &str) -> Option<Vt> {
    Some(match name {
        "bool" | "i8" | "u8" | "i16" | "u16" | "i32" | "u32" => wbc::I32,
        "i64" | "u64" => wbc::I64,
        "f32" => wbc::F32,
        "f64" => wbc::F64,
        "string" => wbc::STRING,
        "anyref" => wbc::ANYREF,
        "fault" => wbc::FAULT,
        "std.Signal" => wbc::SIGNAL,
        other => return Vt::of_lane(other),
    })
}

// -- the VM ----------------------------------------------------------------------------------
#[derive(Clone, Debug)]
pub struct Stats {
    pub instructions: u64,
    pub calls: u64,
    pub replayable: bool,
}

/// Something the input log refers to by handle.
#[derive(Clone)]
pub(crate) enum Handle {
    Module(Rc<LoadedModule>),
    Fiber(FiberRef),
    Value(Value),
}

impl Handle {
    pub(crate) fn ptr(&self) -> usize {
        match self {
            Handle::Module(m) => Rc::as_ptr(m) as *const () as usize,
            Handle::Fiber(f) => Rc::as_ptr(f) as *const () as usize,
            Handle::Value(v) => v.ptr().unwrap_or(0),
        }
    }
}

pub struct VmOptions {
    pub fuel: i64,
    pub deterministic: bool,
    /// the capabilities granted at the start; None grants every registered native's
    pub capabilities: Option<Vec<String>>,
}

impl Default for VmOptions {
    fn default() -> Self {
        VmOptions { fuel: 50_000_000, deterministic: false, capabilities: None }
    }
}

pub struct Vm {
    pub deterministic: bool,
    sink: Box<dyn FnMut(&str)>,
    /// every API call and its outcome, in deterministic mode (section 4.10)
    pub input_log: Vec<J>,
    pub(crate) depth: u32,
    pub(crate) printed: Vec<String>,
    pub(crate) handles: HashMap<usize, usize>,
    pub(crate) handle_objs: Vec<Handle>,
    pub fuel_limit: i64,
    pub fuel: i64,
    hook: Option<Hook>,
    natives: HashMap<String, NativeSpec>,
    granted: HashSet<String>,
    interrupted: Arc<AtomicBool>,
    pub stats: Stats,
    alloc: i64,
    /// virtual seconds
    pub time: f64,
    pub fibers: Vec<FiberRef>,
    next_fiber: u64,
    pub on_fault: Option<Box<dyn FnMut(&FiberRef)>>,
    pub handler_faults: Vec<WiretError>,
    pub on_handler_fault: Option<Box<dyn FnMut(&WiretError)>>,
    nesting: u32,
}

const DET_TRIG: Trig = Trig { sin: detmath::sin, cos: detmath::cos, acos: detmath::acos };

impl Vm {
    pub fn new(opts: VmOptions) -> Vm {
        let mut natives = all_natives();
        if opts.deterministic {
            for (q, spec) in natives.iter_mut() {
                if let Some(g) = detmath::bundled1(q) {
                    *spec = spec.with_fn(move |_, a| Ok(vec![Value::F64(g(a[0].as_f64()))]));
                } else if let Some(g) = detmath::bundled2(q) {
                    *spec = spec.with_fn(move |_, a| Ok(vec![Value::F64(g(a[0].as_f64(), a[1].as_f64()))]));
                }
            }
            let bundled = lane_trig_natives(DET_TRIG);
            for q in LANE_TRIG {
                natives.insert(q.to_string(), bundled[q].clone());
            }
            natives.retain(|_, s| s.deterministic);
        }
        let granted = match opts.capabilities {
            Some(c) => c.into_iter().collect(),
            None => natives.values().filter_map(|s| s.capability.clone()).collect(),
        };
        Vm {
            deterministic: opts.deterministic,
            sink: Box::new(|line| println!("{line}")),
            input_log: vec![],
            depth: 0,
            printed: vec![],
            handles: HashMap::new(),
            handle_objs: vec![],
            fuel_limit: opts.fuel,
            fuel: opts.fuel,
            hook: None,
            natives,
            granted,
            interrupted: Arc::new(AtomicBool::new(false)),
            stats: Stats { instructions: 0, calls: 0, replayable: true },
            alloc: 0,
            time: 0.0,
            fibers: vec![],
            next_fiber: 1,
            on_fault: None,
            handler_faults: vec![],
            on_handler_fault: None,
            nesting: 0,
        }
    }

    /// Where `host.Log` and other output goes (stdout by default).
    pub fn set_output(&mut self, sink: impl FnMut(&str) + 'static) {
        self.sink = Box::new(sink);
    }

    /// A function called at every node the VM enters, for a debugger.
    pub fn set_hook(&mut self, hook: Option<Hook>) {
        self.hook = hook;
    }

    /// The output function natives call.
    pub fn output(&mut self, line: &str) {
        if self.depth > 0 {
            self.printed.push(line.to_string());
        }
        (self.sink)(line);
    }

    /// wr_register. A deterministic VM refuses a native not marked deterministic.
    pub fn register(&mut self, qname: &str, spec: NativeSpec) -> Result<(), WiretError> {
        if self.deterministic && !spec.deterministic {
            return Err(WiretError::new(
                STATUS_LINK,
                format!("{qname} is not deterministic, so a deterministic VM cannot use it"),
            ));
        }
        self.natives.insert(qname.to_string(), spec);
        Ok(())
    }

    pub fn natives(&self) -> &HashMap<String, NativeSpec> {
        &self.natives
    }

    /// Stop the running fiber at its next check (every 4096 instructions). Safe to set from
    /// another thread through [`Vm::interrupt_flag`].
    pub fn interrupt(&mut self) {
        self.interrupted.store(true, Ordering::Relaxed);
        if self.deterministic {
            self.stats.replayable = false;
        }
    }

    pub fn interrupt_flag(&self) -> Arc<AtomicBool> {
        self.interrupted.clone()
    }

    // -- logged API (section 4.10) -------------------------------------------------------
    fn logged<T>(
        &mut self,
        op: &str,
        args: impl FnOnce(&mut Vm) -> Result<Vec<J>, WiretError>,
        run: impl FnOnce(&mut Vm) -> Result<T, WiretError>,
        out: impl FnOnce(&mut Vm, &T) -> Result<J, WiretError>,
    ) -> Result<T, WiretError> {
        if !self.deterministic {
            return run(self);
        }
        if self.depth > 0 {
            self.depth += 1;
            let r = run(self);
            self.depth -= 1;
            return r;
        }
        let enc_args = args(self)?;
        let before = self.stats.instructions;
        self.depth = 1;
        self.printed.clear();
        let result = run(self);
        let (out_j, error) = match &result {
            Ok(v) => match out(self, v) {
                Ok(j) => (j, J::Null),
                Err(e) => {
                    self.depth = 0;
                    return Err(e);
                }
            },
            Err(e) => (J::Null, J::Array(vec![J::from(e.status.clone()), J::from(e.message.clone()), J::from(e.code)])),
        };
        self.depth = 0;
        let mut entry = serde_json::Map::new();
        entry.insert("op".into(), J::from(op));
        entry.insert("args".into(), J::Array(enc_args));
        entry.insert("kw".into(), J::Object(Default::default()));
        entry.insert("out".into(), out_j);
        entry.insert("error".into(), error);
        entry.insert("instructions".into(), J::from(self.stats.instructions - before));
        entry.insert("fuel".into(), J::from(self.fuel));
        entry.insert("output".into(), J::Array(self.printed.iter().map(|s| J::from(s.as_str())).collect()));
        self.input_log.push(J::Object(entry));
        result
    }

    pub fn signal(&mut self) -> Result<Rc<Signal>, WiretError> {
        self.logged("signal", |_| Ok(vec![]), |_| Ok(Rc::new(Signal::default())), |vm, s| vm.enc_out(&Value::Signal(s.clone())))
    }

    pub fn grant(&mut self, capability: &str) -> Result<(), WiretError> {
        self.logged(
            "grant",
            |_| Ok(vec![J::from(capability)]),
            |vm| {
                vm.granted.insert(capability.to_string());
                Ok(())
            },
            |_, _| Ok(J::Null),
        )
    }

    // -- loading -------------------------------------------------------------------------
    pub fn load(&mut self, data: &[u8]) -> Result<Rc<LoadedModule>, WiretError> {
        self.logged(
            "load",
            |_| Ok(vec![J::from(crate::log::sha256_hex(data))]),
            |vm| vm.load_inner(data),
            |vm, m| Ok(vm.enc_handle(Handle::Module(m.clone()), true)?),
        )
    }

    fn load_inner(&mut self, data: &[u8]) -> Result<Rc<LoadedModule>, WiretError> {
        let m = wbc::decode_module(data).map_err(|e| WiretError::new(STATUS_LOAD, e.0))?;
        let verified = verify(&m).map_err(|e| WiretError::new(STATUS_VERIFY, e.0))?;
        let caps = parse_caps(&m).map_err(|e| WiretError::new(STATUS_LOAD, format!("bad custom section: {}", e.0)))?;
        for cap in &caps {
            if !self.granted.contains(cap) {
                return Err(WiretError::new(
                    STATUS_LINK,
                    format!("the module needs capability '{cap}', which the host has not granted"),
                ));
            }
        }
        let bad = |e: WbcError| WiretError::new(STATUS_LOAD, format!("bad custom section: {}", e.0));
        let mut cu = parse_customs(&m).map_err(bad)?;
        let pins = parse_pins(&m, &cu.debug).map_err(bad)?;
        let steps = parse_steps(&m, &cu.debug, "wr.steps").map_err(bad)?;
        let pure = parse_steps(&m, &cu.debug, "wr.pure").map_err(bad)?;

        let mut defaults = Defaults { types: &m.types, data: &m.data, structs: HashMap::new() };
        let mut classes: HashMap<u32, Rc<ClassInfo>> = HashMap::new();
        for (ti, entry) in m.types.iter().enumerate() {
            let TypeEntry::Class(entry) = entry else { continue };
            let ti = ti as u32;
            let mut chain = vec![];
            let mut t = Some(ti);
            while let Some(c) = t {
                if chain.contains(&c) {
                    break;
                }
                chain.push(c);
                t = match &m.types[c as usize] {
                    TypeEntry::Class(ct) => ct.sup,
                    _ => None,
                };
            }
            let mut layout: Vec<(Vt, Option<Const>)> = vec![];
            for c in chain.iter().rev() {
                if let TypeEntry::Class(ct) = &m.types[*c as usize] {
                    layout.extend(ct.fields.iter().cloned());
                }
            }
            let (cname, mut fnames) = cu.class_names.remove(&ti).unwrap_or_else(|| (format!("class{ti}"), vec![]));
            if fnames.len() != layout.len() {
                fnames = (0..layout.len()).map(|i| format!("field{i}")).collect();
            }
            let vals: Vec<Value> = layout
                .iter()
                .map(|(vt, d)| match d {
                    None => defaults.get(*vt),
                    Some(c) => const_value(*vt, c, &m.data),
                })
                .collect();
            let itables: HashMap<u32, Vec<u32>> = entry.interfaces.iter().cloned().collect();
            let slots: Vec<usize> = layout
                .iter()
                .enumerate()
                .filter(|(_, (vt, _))| matches!(vt, Vt::Ref(r) if matches!(m.types.get(*r as usize), Some(TypeEntry::Dispatcher(_)))))
                .map(|(i, _)| i)
                .collect();
            let mut overrides = HashMap::new();
            for a in &chain[1..] {
                if let TypeEntry::Class(ac) = &m.types[*a as usize] {
                    for (s, fi) in ac.vtable.iter().enumerate() {
                        if s < entry.vtable.len() {
                            overrides.entry(*fi).or_insert(entry.vtable[s]);
                        }
                    }
                }
            }
            let mut ancestors: HashSet<u32> = chain.iter().copied().collect();
            ancestors.extend(itables.keys().copied());
            classes.insert(
                ti,
                Rc::new(ClassInfo {
                    index: ti,
                    name: cname,
                    field_names: fnames,
                    defaults: vals,
                    vtable: entry.vtable.clone(),
                    ancestors,
                    itables,
                    dispatchers: slots,
                    overrides,
                }),
            );
        }

        let mut funcs: Vec<Rc<Func>> = vec![];
        for (i, imp) in m.imports.iter().enumerate() {
            let q = format!("{}.{}", imp.module, imp.field);
            let Some(TypeEntry::Func(params, results)) = m.types.get(imp.ty as usize) else {
                return Err(WiretError::new(STATUS_LINK, format!("import {q} has a bad type")));
            };
            let Some(spec) = self.natives.get(&q) else {
                return Err(WiretError::new(STATUS_LINK, format!("unresolved import {q}")));
            };
            if let Some(cap) = &spec.capability {
                if !self.granted.contains(cap) {
                    return Err(WiretError::new(
                        STATUS_LINK,
                        format!("import {q} needs capability '{cap}', which the host has not granted"),
                    ));
                }
            }
            let same = |a: &[(String, String)], b: &[Vt]| a.len() == b.len() && a.iter().zip(b).all(|((_, t), vt)| vt_of(t) == Some(*vt));
            if !same(&spec.params, params) || !same(&spec.results, results) {
                return Err(WiretError::new(STATUS_LINK, format!("import {q} has a different signature than the registered native")));
            }
            funcs.push(Rc::new(Func {
                index: i,
                name: Rc::from(q.as_str()),
                params: params.clone(),
                results: results.clone(),
                flags: imp.flags,
                native: Some(spec.func.clone()),
                native_name: q.clone(),
                cost: spec.cost.clone(),
                locals: vec![],
                zeros: vec![],
                code: vec![],
                pcs: vec![],
                node_at: vec![],
                fault_at: vec![],
                starts: vec![],
                steps: vec![],
                local_names: IndexMap::new(),
                pins: vec![],
            }));
        }
        let nimp = m.imports.len();
        let types = &m.types;
        let fparams = |t: u32| -> usize {
            match types.get(t as usize) {
                Some(TypeEntry::Func(p, _)) => p.len(),
                _ => 0,
            }
        };
        for (i, &(t, flags)) in m.funcs.iter().enumerate() {
            let body = &m.bodies[i];
            let instrs = &verified[i].0;
            let fi = nimp + i;
            let (params, results) = match types.get(t as usize) {
                Some(TypeEntry::Func(p, r)) => (p.clone(), r.clone()),
                _ => (vec![], vec![]),
            };
            let index_of: HashMap<i64, usize> = instrs.iter().enumerate().map(|(k, ins)| (ins.pc as i64, k)).collect();
            let mut code = Vec::with_capacity(instrs.len());
            for ins in instrs {
                let n = ins.name;
                let target = || index_of.get(&ins.target()).copied().unwrap_or(0);
                let tyent = || types.get(ins.uimm(0));
                let a = match n {
                    "br" => Ins::Br(target()),
                    "br_if" => Ins::BrIf(target()),
                    "cont.push" => Ins::ContPush(target()),
                    "try.push" => Ins::TryPush(Handler { h: target(), slot: ins.uimm(1), node: None }),
                    "i32.const" => Ins::Const(Value::I32(ins.imm(0) as i32)),
                    "i64.const" => Ins::Const(Value::I64(ins.imm(0))),
                    "f32.const" => Ins::Const(Value::F32(ins.fimm as f32)),
                    "f64.const" => Ins::Const(Value::F64(ins.fimm)),
                    "string.const" => Ins::Const(Value::str(m.data.get(ins.uimm(0)).map(String::as_str).unwrap_or(""))),
                    "array.new" => match tyent() {
                        Some(TypeEntry::Array(e)) => Ins::ArrayNew(defaults.get(*e)),
                        _ => Ins::Bad(ins.op),
                    },
                    "array.len" => Ins::Array(ArrOp::Len),
                    "array.get" => Ins::Array(ArrOp::Get),
                    "array.set" => Ins::Array(ArrOp::Set),
                    "array.push" => Ins::Array(ArrOp::Push),
                    "array.insert" => Ins::Array(ArrOp::Insert),
                    "array.remove" => Ins::Array(ArrOp::Remove),
                    "array.clear" => Ins::Array(ArrOp::Clear),
                    "array.clone" => Ins::Array(ArrOp::Clone),
                    _ if n.starts_with("map.") => {
                        let zero = match tyent() {
                            Some(TypeEntry::Map(_, v)) => defaults.get(*v),
                            _ => Value::Null,
                        };
                        let op = match &n[4..] {
                            "new" => MapOp::New,
                            "find" => MapOp::Find,
                            "set" => MapOp::Set,
                            "remove" => MapOp::Remove,
                            "has" => MapOp::Has,
                            "len" => MapOp::Len,
                            "key_at" => MapOp::KeyAt,
                            "value_at" => MapOp::ValueAt,
                            _ => MapOp::Clear,
                        };
                        Ins::Map(op, zero)
                    }
                    _ if n.starts_with("set.") => Ins::Set(match &n[4..] {
                        "new" => SetOp::New,
                        "add" => SetOp::Add,
                        "remove" => SetOp::Remove,
                        "has" => SetOp::Has,
                        "len" => SetOp::Len,
                        "at" => SetOp::At,
                        _ => SetOp::Clear,
                    }),
                    _ if ins.op > 0xFF => Ins::Lane(LaneOp::new(n, ins.uimm(0))),
                    "struct.new" => match tyent() {
                        Some(TypeEntry::Struct(fs)) => Ins::StructNew(fs.len()),
                        _ => Ins::Bad(ins.op),
                    },
                    "struct.get" => Ins::StructGet(ins.uimm(1)),
                    "struct.with" => Ins::StructWith(ins.uimm(1)),
                    "class.get" => Ins::ClassGet(ins.uimm(1)),
                    "class.set" => Ins::ClassSet(ins.uimm(1)),
                    "class.new" => match classes.get(&(ins.imm(0) as u32)) {
                        Some(c) => Ins::ClassNew(c.clone()),
                        None => Ins::Bad(ins.op),
                    },
                    "call_virtual" => {
                        let slot = ins.uimm(1);
                        let nargs = match tyent() {
                            Some(TypeEntry::Class(ct)) => m.func_type(ct.vtable[slot] as usize).0.len(),
                            _ => 0,
                        };
                        Ins::CallVirtual { slot, nargs }
                    }
                    "call_delegate" => Ins::CallDelegate(fparams(ins.imm(0) as u32)),
                    "dispatcher.broadcast" => match tyent() {
                        Some(TypeEntry::Dispatcher(ft)) => Ins::Broadcast(fparams(*ft)),
                        _ => Ins::Bad(ins.op),
                    },
                    "dispatcher.bind" => Ins::Bind,
                    "dispatcher.unbind" => Ins::Unbind,
                    "delegate.new" => Ins::DelegateNew(ins.uimm(0), ins.imm(1) as u8),
                    "call_interface" => {
                        let (tt, k) = (ins.imm(0) as u32, ins.uimm(1));
                        let nargs = match tyent() {
                            Some(TypeEntry::Interface(ms)) => 1 + fparams(ms[k]),
                            _ => 1,
                        };
                        Ins::CallInterface { iface: tt, k, nargs }
                    }
                    "call" => Ins::Call(ins.uimm(0)),
                    "local.get" => Ins::LGet(ins.uimm(0)),
                    "local.set" => Ins::LSet(ins.uimm(0)),
                    "local.tee" => Ins::LTee(ins.uimm(0)),
                    "global.get" => Ins::GGet(ins.uimm(0)),
                    "global.set" => Ins::GSet(ins.uimm(0)),
                    "ref.null" => Ins::RefNull,
                    "ref.is_null" => Ins::RefIsNull,
                    "ref.eq" => Ins::RefEq,
                    "ref.cast" => Ins::RefCast(ins.imm(0) as u32),
                    "ref.test" => Ins::RefTest(ins.imm(0) as u32),
                    "ref.valid" => Ins::RefValid,
                    "ref.share" => Ins::RefShare,
                    "suspend" => Ins::Suspend(ins.imm(0) as u8),
                    "unreachable" => Ins::Unreachable,
                    "nop" => Ins::Nop,
                    "return" => Ins::Return,
                    "drop" => Ins::Drop,
                    "select" => Ins::Select,
                    "throw" => Ins::Throw,
                    "cont.pop" => Ins::ContPop,
                    "cont.depth" => Ins::ContDepth,
                    "cont.trunc" => Ins::ContTrunc,
                    _ if (0x30..=0xC8).contains(&ins.op) || (0xF0..=0xF3).contains(&ins.op) => Ins::Num(ins.op),
                    _ => Ins::Bad(ins.op),
                };
                code.push(a);
            }
            let ncode = code.len();
            let mut f = Func {
                index: fi,
                name: Rc::from(cu.names.get(&fi).cloned().unwrap_or_else(|| format!("func{fi}")).as_str()),
                params: params.clone(),
                results,
                flags,
                native: None,
                native_name: String::new(),
                cost: None,
                locals: body.locals.clone(),
                zeros: body.locals.iter().map(|vt| defaults.get(*vt)).collect(),
                code,
                pcs: instrs.iter().map(|x| x.pc).collect(),
                node_at: Vec::with_capacity(ncode),
                fault_at: Vec::with_capacity(ncode),
                starts: vec![None; ncode],
                steps: vec![None; ncode],
                local_names: cu.local_names.get(&fi).cloned().unwrap_or_default(),
                pins: vec![],
            };
            let mut interned: HashMap<String, Rc<str>> = HashMap::new();
            let mut intern = |s: &str| -> Rc<str> { interned.entry(s.to_string()).or_insert_with(|| Rc::from(s)).clone() };
            let nlocals = params.len() + f.locals.len();
            f.pins = pins
                .get(&fi)
                .map(|ps| ps.iter().filter(|(li, _, _)| *li < nlocals).map(|(li, n, p)| (*li, intern(n), intern(p))).collect())
                .unwrap_or_default();
            let mut by_pc: HashMap<usize, Vec<Rc<str>>> = HashMap::new();
            if let Some((_, entries, _)) = cu.debug.get(&fi) {
                for (pc, node) in entries {
                    by_pc.entry(*pc).or_default().push(intern(node));
                }
            }
            let pure_pcs: HashMap<usize, Rc<str>> =
                pure.get(&fi).map(|es| es.iter().map(|(pc, n)| (*pc, intern(n))).collect()).unwrap_or_default();
            let mut cur: Option<Rc<str>> = None;
            let mut here: Option<Rc<str>> = None;
            for (k, ins) in instrs.iter().enumerate() {
                if let Some(l) = by_pc.get(&ins.pc) {
                    cur = l.last().cloned();
                    here = cur.clone();
                    f.starts[k] = Some(l.clone());
                }
                if let Some(n) = pure_pcs.get(&ins.pc) {
                    here = Some(n.clone());
                }
                f.node_at.push(cur.clone());
                f.fault_at.push(here.clone());
            }
            for k in 0..ncode {
                if let Ins::TryPush(h) = &mut f.code[k] {
                    h.node = f.node_at[k].clone();
                }
            }
            let step_pcs: HashMap<usize, Rc<str>> =
                steps.get(&fi).map(|es| es.iter().map(|(pc, n)| (*pc, intern(n))).collect()).unwrap_or_default();
            for (k, ins) in instrs.iter().enumerate() {
                if let Some(n) = step_pcs.get(&ins.pc) {
                    f.steps[k] = Some(n.clone());
                }
            }
            funcs.push(Rc::new(f));
        }
        let mut exports = IndexMap::new();
        for ex in m.exports.iter().filter(|e| e.kind == wbc::EXPORT_FUNC) {
            exports.insert(ex.name.clone(), ex.index as usize);
        }
        let gvals: Vec<Value> = m
            .globals
            .iter()
            .map(|g| if g.vt.is_ref() { defaults.get(g.vt) } else { const_value(g.vt, &g.init, &m.data) })
            .collect();
        let declared = m.exports.iter().filter(|e| e.flags & wbc::EX_DECLARED != 0).map(|e| e.name.clone()).collect();
        let mut class_map = IndexMap::new();
        let mut ordered: Vec<&Rc<ClassInfo>> = classes.values().collect();
        ordered.sort_by_key(|c| c.index);
        for c in ordered {
            class_map.insert(c.name.clone(), c.clone());
        }
        let global_names = parse_global_names(&m);
        Ok(Rc::new(LoadedModule {
            name: cu.meta.get("module").cloned().unwrap_or_default(),
            funcs,
            exports,
            globals: RefCell::new(gvals),
            meta: cu.meta,
            global_names,
            classes: class_map,
            capabilities: caps,
            declared,
            wbc: m,
        }))
    }

    // -- execution -------------------------------------------------------------------------
    fn make_fiber(&mut self, module: &Rc<LoadedModule>, f: &Rc<Func>, args: Vec<Value>, id: u64) -> FiberRef {
        let mut locs = args;
        locs.extend(f.zeros.iter().cloned());
        Rc::new(RefCell::new(Fiber {
            id,
            module: module.clone(),
            name: f.name.to_string(),
            status: FiberStatus::Ready,
            results: None,
            error: None,
            waiting: Waiting::Nothing,
            signal: None,
            wake: self.time,
            state: Some(ExecState { f: f.clone(), ip: 0, locs, stack: vec![], cont: vec![], frames: vec![] }),
        }))
    }

    fn fiber_for(&mut self, module: &Rc<LoadedModule>, name: &str, args: &[Value]) -> Result<FiberRef, WiretError> {
        let Some(f) = module.export(name).cloned() else {
            return Err(WiretError::new(STATUS_LINK, format!("no exported function '{name}'")));
        };
        if args.len() != f.params.len() {
            return Err(WiretError::new(
                STATUS_API,
                format!("'{name}' takes {} argument(s), got {}", f.params.len(), args.len()),
            ));
        }
        let nargs = f.params.iter().zip(args).map(|(vt, a)| normalise(*vt, a, Some(&module.wbc.types))).collect();
        let id = self.next_fiber;
        self.next_fiber += 1;
        Ok(self.make_fiber(module, &f, nargs, id))
    }

    /// wr_call on a function that cannot suspend: its results, or the error.
    pub fn call(&mut self, module: &Rc<LoadedModule>, name: &str, args: &[Value]) -> Result<Vec<Value>, WiretError> {
        self.logged(
            "call",
            |vm| Ok(vec![vm.enc_handle(Handle::Module(module.clone()), false)?, J::from(name), vm.enc_list(args, false)?]),
            |vm| {
                let fb = vm.fiber_for(module, name, args)?;
                if fb.borrow().state.as_ref().is_some_and(|s| s.f.is_latent()) {
                    return Err(WiretError::new(
                        STATUS_API,
                        format!("'{name}' is latent and may suspend; run it with start() and advance()"),
                    ));
                }
                vm.resume(&fb)?;
                let results = fb.borrow().results.clone().unwrap_or_default();
                Ok(results)
            },
            |vm, r| vm.enc_list(r, true),
        )
    }

    /// wr_start: a new fiber for `name`, queued to run on the next advance (or now).
    pub fn start(&mut self, module: &Rc<LoadedModule>, name: &str, args: &[Value], now: bool) -> Result<FiberRef, WiretError> {
        self.logged(
            "start",
            |vm| {
                Ok(vec![
                    vm.enc_handle(Handle::Module(module.clone()), false)?,
                    J::from(name),
                    vm.enc_list(args, false)?,
                    J::from(now),
                ])
            },
            |vm| {
                let fb = vm.fiber_for(module, name, args)?;
                vm.fibers.push(fb.clone());
                if now {
                    vm.resume(&fb)?;
                }
                Ok(fb)
            },
            |vm, fb| vm.enc_handle(Handle::Fiber(fb.clone()), true),
        )
    }

    /// wr_advance: move virtual time forward by `dt`, then run every fiber runnable at the new
    /// time. Returns the fibers that ran.
    pub fn advance(&mut self, dt: f64) -> Result<Vec<FiberRef>, WiretError> {
        self.logged(
            "advance",
            |_| Ok(vec![crate::log::enc_number(dt)]),
            |vm| {
                if dt < 0.0 || dt.is_nan() {
                    return Err(WiretError::new(STATUS_API, "advance needs a time step of 0 or more"));
                }
                vm.time += dt;
                let time = vm.time;
                let mut due: Vec<FiberRef> = vm
                    .fibers
                    .iter()
                    .filter(|fb| {
                        let b = fb.borrow();
                        b.status == FiberStatus::Ready || (b.waiting == Waiting::Time && b.wake <= time)
                    })
                    .cloned()
                    .collect();
                due.sort_by(|a, b| {
                    let (a, b) = (a.borrow(), b.borrow());
                    a.wake.partial_cmp(&b.wake).unwrap_or(std::cmp::Ordering::Equal).then(a.id.cmp(&b.id))
                });
                for fb in &due {
                    if vm.resume(fb).is_err() {
                        if let Some(mut cb) = vm.on_fault.take() {
                            cb(fb);
                            vm.on_fault = Some(cb);
                        }
                    }
                }
                vm.fibers.retain(|fb| matches!(fb.borrow().status, FiberStatus::Ready | FiberStatus::Suspended));
                Ok(due)
            },
            |vm, due| {
                let mut items = vec![];
                for fb in due {
                    items.push(vm.enc_handle(Handle::Fiber(fb.clone()), true)?);
                }
                Ok(crate::log::enc_a(items))
            },
        )
    }

    /// Every fiber waiting on the signal becomes runnable (inside a run: what Fire does).
    pub(crate) fn fire_signal(&mut self, signal: &Rc<Signal>) {
        let waiters = std::mem::take(&mut *signal.waiters.borrow_mut());
        for fb in waiters {
            let mut b = fb.borrow_mut();
            b.status = FiberStatus::Ready;
            b.waiting = Waiting::Nothing;
            b.signal = None;
            b.wake = self.time;
        }
    }

    /// wr_signal_fire: every fiber waiting on `signal` becomes runnable.
    pub fn fire(&mut self, signal: &Rc<Signal>) -> Result<(), WiretError> {
        self.logged(
            "fire",
            |vm| Ok(vec![vm.enc_handle(Handle::Value(Value::Signal(signal.clone())), false)?]),
            |vm| {
                vm.fire_signal(signal);
                Ok(())
            },
            |_, _| Ok(J::Null),
        )
    }

    /// wr_fiber_kill: end a fiber without running anything more of it.
    pub fn kill(&mut self, fb: &FiberRef) -> Result<(), WiretError> {
        self.logged(
            "kill",
            |vm| Ok(vec![vm.enc_handle(Handle::Fiber(fb.clone()), false)?]),
            |_| {
                let mut b = fb.borrow_mut();
                if let Some(s) = b.signal.take() {
                    s.waiters.borrow_mut().retain(|x| !Rc::ptr_eq(x, fb));
                }
                b.status = FiberStatus::Faulted;
                b.waiting = Waiting::Nothing;
                b.error = Some(WiretError::new(STATUS_FAULT, "killed by the host"));
                Ok(())
            },
            |_, _| Ok(J::Null),
        )
    }

    /// The earliest time a Delay is waiting for, if any.
    pub fn next_wake(&self) -> Option<f64> {
        self.fibers
            .iter()
            .filter_map(|fb| {
                let b = fb.borrow();
                (b.waiting == Waiting::Time).then_some(b.wake)
            })
            .reduce(f64::min)
    }

    /// An instance of `cls` with its declared defaults (wr_push_new).
    pub fn new_object(&mut self, module: &Rc<LoadedModule>, cls: &str) -> Result<Rc<Obj>, WiretError> {
        self.logged(
            "new",
            |vm| Ok(vec![vm.enc_handle(Handle::Module(module.clone()), false)?, J::from(cls)]),
            |_| match module.classes.get(cls) {
                Some(c) => Ok(Obj::new(c.clone())),
                None => Err(WiretError::new(STATUS_LINK, format!("no class '{cls}'"))),
            },
            |vm, o| vm.enc_handle(Handle::Value(Value::Obj(o.clone())), true),
        )
    }

    /// The override of `method` for obj's class, with obj as self.
    pub fn call_method(&mut self, module: &Rc<LoadedModule>, obj: Option<&Rc<Obj>>, method: &str, args: &[Value]) -> Result<Vec<Value>, WiretError> {
        let objv = obj.map(|o| Value::Obj(o.clone())).unwrap_or(Value::Null);
        self.logged(
            "call_method",
            |vm| {
                Ok(vec![
                    vm.enc_handle(Handle::Module(module.clone()), false)?,
                    if objv.is_null() { J::Null } else { vm.enc_handle(Handle::Value(objv.clone()), false)? },
                    J::from(method),
                    vm.enc_list(args, false)?,
                ])
            },
            |vm| {
                let Some(obj) = obj else {
                    return Err(WiretError { code: FAULT_NULL, ..WiretError::new(STATUS_FAULT, "method call on a null object") });
                };
                for &fi in &obj.cls.vtable {
                    let f = &module.funcs[fi as usize];
                    if f.name.rsplit('.').next() == Some(method) {
                        let name = module.exports.iter().find(|(_, &i)| i == fi as usize).map(|(n, _)| n.clone());
                        if let Some(name) = name {
                            let mut all = vec![Value::Obj(obj.clone())];
                            all.extend_from_slice(args);
                            return vm.call(module, &name, &all);
                        }
                    }
                }
                Err(WiretError::new(STATUS_LINK, format!("class '{}' has no method '{method}'", obj.cls.name)))
            },
            |vm, r| vm.enc_list(r, true),
        )
    }

    /// A delegate of an exported function, or of a method bound to `obj`.
    pub fn delegate(&mut self, module: &Rc<LoadedModule>, func: &str, obj: Option<&Rc<Obj>>) -> Result<Rc<Delegate>, WiretError> {
        self.logged(
            "delegate",
            |vm| {
                Ok(vec![
                    vm.enc_handle(Handle::Module(module.clone()), false)?,
                    J::from(func),
                    match obj {
                        Some(o) => vm.enc_handle(Handle::Value(Value::Obj(o.clone())), false)?,
                        None => J::Null,
                    },
                ])
            },
            |_| {
                let Some(&fi) = module.exports.get(func) else {
                    return Err(WiretError::new(STATUS_LINK, format!("no exported function '{func}'")));
                };
                Ok(Rc::new(match obj {
                    Some(o) => Delegate {
                        func: o.cls.overrides.get(&(fi as u32)).map(|&x| x as usize).unwrap_or(fi),
                        recv: Some(o.clone()),
                        bound: true,
                    },
                    None => Delegate { func: fi, recv: None, bound: false },
                }))
            },
            |vm, d| vm.enc_handle(Handle::Value(Value::Delegate(d.clone())), true),
        )
    }

    /// Broadcast an object's dispatcher from the host, as the Broadcast node does.
    pub fn broadcast(&mut self, module: &Rc<LoadedModule>, obj: &Rc<Obj>, dispatcher: &str, args: &[Value]) -> Result<(), WiretError> {
        self.logged(
            "broadcast",
            |vm| {
                Ok(vec![
                    vm.enc_handle(Handle::Module(module.clone()), false)?,
                    vm.enc_handle(Handle::Value(Value::Obj(obj.clone())), false)?,
                    J::from(dispatcher),
                    vm.enc_list(args, false)?,
                ])
            },
            |vm| {
                let Some(Value::Dispatcher(disp)) = obj.field(dispatcher) else {
                    return Err(WiretError::new(STATUS_API, format!("'{dispatcher}' is not a dispatcher of {}", obj.cls.name)));
                };
                vm.fuel = vm.fuel_limit;
                vm.broadcast_inner(module, &disp, args.to_vec())
            },
            |_, _| Ok(J::Null),
        )
    }

    /// Call `func` and return its results. A latent function or event runs as a fiber, and
    /// idle virtual time is skipped, so a `Delay` of five seconds finishes at once. A method
    /// called without its receiver gets a new instance of its class.
    pub fn run_function(&mut self, module: &Rc<LoadedModule>, func: &str, args: &[Value]) -> Result<Vec<Value>, WiretError> {
        let f = module.export(func).cloned();
        let owner = func.rsplit_once('.').map(|(o, _)| o).unwrap_or("");
        let mut args = args.to_vec();
        if let Some(f) = &f {
            if module.classes.contains_key(owner) && args.len() + 1 == f.params.len() {
                let o = self.new_object(module, owner)?;
                args.insert(0, Value::Obj(o));
            }
        }
        match &f {
            Some(f) if f.is_latent() => {}
            _ => return self.call(module, func, &args),
        }
        let fb = self.start(module, func, &args, true)?;
        for _ in 0..MAX_ADVANCES {
            let status = fb.borrow().status;
            if status == FiberStatus::Done {
                return Ok(fb.borrow().results.clone().unwrap_or_default());
            }
            if status == FiberStatus::Faulted {
                return Err(fb.borrow().error.clone().unwrap_or_else(|| WiretError::new(STATUS_FAULT, "fault")));
            }
            let nxt = self.next_wake();
            if self.fibers.iter().any(|x| x.borrow().status == FiberStatus::Ready) {
                self.advance(0.0)?;
            } else if let Some(t) = nxt {
                let dt = (t - self.time).max(0.0);
                self.advance(dt)?;
            } else {
                return Err(WiretError::new(STATUS_YIELD, format!("'{func}' is waiting for a signal that nothing will fire")));
            }
        }
        Err(WiretError::new(STATUS_FUEL, format!("'{func}' was still running after {MAX_ADVANCES} steps of virtual time")))
    }

    fn spawn(&mut self, module: &Rc<LoadedModule>, f: &Rc<Func>, args: Vec<Value>) {
        let id = self.next_fiber;
        self.next_fiber += 1;
        let fb = self.make_fiber(module, f, args, id);
        self.fibers.push(fb);
    }

    fn broadcast_inner(&mut self, module: &Rc<LoadedModule>, disp: &Rc<Dispatcher>, args: Vec<Value>) -> Result<(), WiretError> {
        if self.nesting >= MAX_NESTING {
            return Err(WiretError::new(STATUS_FAULT, "stack overflow"));
        }
        let handlers: Vec<Rc<Delegate>> = disp.handlers.borrow().clone();
        for d in handlers {
            let f = module.funcs[d.func].clone();
            let mut cargs = vec![];
            if d.bound {
                cargs.push(d.recv.clone().map(Value::Obj).unwrap_or(Value::Null));
            }
            cargs.extend(args.iter().cloned());
            if f.is_latent() {
                self.spawn(module, &f, cargs);
                continue;
            }
            let r = if let Some(native) = f.native.clone() {
                native(self, &cargs).map(|_| ()).map_err(|e| WiretError {
                    code: e.code,
                    ..WiretError::new(STATUS_FAULT, format!("{}: {}", f.native_name, e.message))
                })
            } else {
                let sub = self.make_fiber(module, &f, cargs, 0);
                self.nesting += 1;
                let r = self.run(&sub).map(|_| ());
                self.nesting -= 1;
                r
            };
            if let Err(e) = r {
                if e.status == STATUS_FUEL || e.status == STATUS_INTERRUPT {
                    return Err(e);
                }
                self.handler_faults.push(e.clone());
                if let Some(mut cb) = self.on_handler_fault.take() {
                    cb(&e);
                    self.on_handler_fault = Some(cb);
                }
            }
        }
        Ok(())
    }

    fn resume(&mut self, fb: &FiberRef) -> Result<(), WiretError> {
        self.fuel = self.fuel_limit;
        self.interrupted.store(false, Ordering::Relaxed);
        fb.borrow_mut().status = FiberStatus::Running;
        match self.run(fb) {
            Ok(_) => Ok(()),
            Err(e) => {
                let mut b = fb.borrow_mut();
                b.status = FiberStatus::Faulted;
                b.error = Some(e.clone());
                Err(e)
            }
        }
    }

    fn traceback(st: &ExecState) -> Vec<(String, Option<String>)> {
        st.frames
            .iter()
            .map(|fr| (&fr.f, fr.ip))
            .chain(std::iter::once((&st.f, st.ip)))
            .map(|(f, ip)| (f.name.to_string(), f.fault_at.get(ip.saturating_sub(1)).cloned().flatten().map(|s| s.to_string())))
            .collect()
    }

    /// Run a fiber until it finishes (results in its `results`), suspends, or fails.
    fn run(&mut self, fb: &FiberRef) -> Result<bool, WiretError> {
        let (module, mut st) = {
            let mut b = fb.borrow_mut();
            let Some(st) = b.state.take() else {
                return Err(WiretError::new(STATUS_API, "the fiber has no code to run"));
            };
            (b.module.clone(), st)
        };
        let mut fuel = self.fuel;
        let mut executed = 0u64;
        let result = loop {
            match self.exec(&module, fb, &mut st, &mut fuel, &mut executed) {
                Ok(exit) => break Ok(exit),
                Err(Trap::Error(e)) => break Err(e),
                Err(Trap::Fault(msg, code)) => {
                    let at = Vm::traceback(&st);
                    let mut unhandled = false;
                    while !st.cont.iter().any(|k| matches!(k, Cont::Handler(_))) {
                        let Some(fr) = st.frames.pop() else {
                            unhandled = true;
                            break;
                        };
                        st.f = fr.f;
                        st.ip = fr.ip;
                        st.locs = fr.locs;
                        st.stack = fr.stack;
                        st.cont = fr.cont;
                    }
                    if unhandled {
                        self.fuel = fuel;
                        break Err(WiretError { status: STATUS_FAULT.into(), message: msg, traceback: at, code });
                    }
                    while let Some(k) = st.cont.pop() {
                        if let Cont::Handler(h) = k {
                            st.ip = h.h;
                            if h.slot < st.locs.len() {
                                st.locs[h.slot] = Value::Fault(Rc::new(FaultValue { message: msg, code }));
                            }
                            break;
                        }
                    }
                    st.stack.clear();
                }
            }
        };
        self.stats.instructions += executed;
        self.fuel = fuel.max(0);
        match result {
            Ok(Some(res)) => {
                let out: Vec<Value> = res.iter().map(export_value).collect();
                let mut b = fb.borrow_mut();
                b.status = FiberStatus::Done;
                b.results = Some(out);
                Ok(true)
            }
            Ok(None) => {
                fb.borrow_mut().state = Some(st);
                Ok(false)
            }
            Err(e) => Err(e),
        }
    }

    fn call_hooks(&mut self, module: &LoadedModule, st: &ExecState, f: &Rc<Func>, ip: usize) {
        let Some(hook) = self.hook.as_mut() else { return };
        if let Some(Some(nodes)) = f.starts.get(ip) {
            for node in nodes {
                let view = View { st, node, module };
                hook(&HookEvent { func: &f.name, node, depth: st.frames.len(), phase: Phase::Enter }, &view);
            }
        }
        if let Some(Some(node)) = f.steps.get(ip) {
            let view = View { st, node, module };
            hook(&HookEvent { func: &f.name, node, depth: st.frames.len(), phase: Phase::Ready }, &view);
        }
    }

    fn charge_alloc(&mut self, fuel: &mut i64) {
        if self.alloc != 0 {
            *fuel -= self.alloc >> 3;
            self.alloc = 0;
        }
    }

    fn own_array(&mut self, v: &Value) -> Rc<RefCell<ArrayData>> {
        match v {
            Value::Array(a) => {
                if !a.borrow().shared {
                    return a.clone();
                }
                let items = a.borrow().items.clone();
                self.alloc += items.len() as i64;
                Rc::new(RefCell::new(ArrayData { items, shared: false }))
            }
            _ => Rc::new(RefCell::new(ArrayData::default())),
        }
    }

    fn own_map(&mut self, v: &Value) -> Rc<RefCell<MapData>> {
        match v {
            Value::Map(m) => {
                if !m.borrow().shared {
                    return m.clone();
                }
                let copy = m.borrow().copy();
                self.alloc += copy.len() as i64;
                Rc::new(RefCell::new(copy))
            }
            _ => Rc::new(RefCell::new(MapData::default())),
        }
    }

    fn do_call(&mut self, st: &mut ExecState, callee: Rc<Func>, fuel: &mut i64) -> Result<(), Trap> {
        *fuel -= 4;
        self.stats.calls += 1;
        let np = callee.params.len();
        let cargs = st.stack.split_off(st.stack.len().saturating_sub(np));
        if let Some(native) = callee.native.clone() {
            if let Some(cost) = &callee.cost {
                *fuel -= cost(&cargs);
            }
            let res = native(self, &cargs).map_err(|e| Trap::Fault(format!("{}: {}", callee.native_name, e.message), e.code))?;
            for (i, vt) in callee.results.iter().enumerate() {
                st.stack.push(normalise_result(*vt, res.get(i)));
            }
        } else {
            if st.frames.len() >= MAX_FRAMES {
                return fault("stack overflow", FAULT_STACK);
            }
            let mut locs = cargs;
            locs.extend(callee.zeros.iter().cloned());
            st.frames.push(Frame {
                f: std::mem::replace(&mut st.f, callee),
                ip: st.ip,
                locs: std::mem::replace(&mut st.locs, locs),
                stack: std::mem::take(&mut st.stack),
                cont: std::mem::take(&mut st.cont),
            });
            st.ip = 0;
        }
        Ok(())
    }

    /// The interpreter loop. Returns the results when the outermost function returns, None
    /// when the fiber suspends.
    fn exec(&mut self, module: &Rc<LoadedModule>, fb: &FiberRef, st: &mut ExecState, fuel: &mut i64, executed: &mut u64) -> Result<Option<Vec<Value>>, Trap> {
        loop {
            let f = st.f.clone();
            let ip = st.ip;
            if self.hook.is_some() {
                self.call_hooks(module, st, &f, ip);
            }
            st.ip = ip + 1;
            *fuel -= 1;
            *executed += 1;
            if *fuel < 0 {
                self.fuel = 0;
                return Err(Trap::Error(WiretError { traceback: Vm::traceback(st), ..WiretError::new(STATUS_FUEL, "fuel exhausted") }));
            }
            if *executed & 0xFFF == 0 && self.interrupted.load(Ordering::Relaxed) {
                return Err(Trap::Error(WiretError {
                    traceback: Vm::traceback(st),
                    ..WiretError::new(STATUS_INTERRUPT, "interrupted by the host")
                }));
            }
            let Some(ins) = f.code.get(ip) else {
                return Err(Trap::Error(WiretError::new(STATUS_API, "control fell off the end of a function")));
            };
            let s = &mut st.stack;
            match ins {
                Ins::LGet(i) => s.push(st.locs[*i].clone()),
                Ins::LSet(i) => st.locs[*i] = pop(s),
                Ins::LTee(i) => st.locs[*i] = s.last().cloned().unwrap_or(Value::Null),
                Ins::Num(op) => numeric(*op, s)?,
                Ins::Lane(op) => {
                    let operands = s.split_off(s.len().saturating_sub(op.arity));
                    s.push(op.exec(&operands));
                }
                Ins::Const(v) => s.push(v.clone()),
                Ins::Br(t) => st.ip = *t,
                Ins::BrIf(t) => {
                    if pop(s).truthy() {
                        st.ip = *t;
                    }
                }
                Ins::ContPush(k) => {
                    if st.cont.len() >= MAX_CONT {
                        return fault("continuation stack overflow", FAULT_STACK);
                    }
                    st.cont.push(Cont::Ret(*k));
                }
                Ins::TryPush(h) => {
                    if st.cont.len() >= MAX_CONT {
                        return fault("continuation stack overflow", FAULT_STACK);
                    }
                    st.cont.push(Cont::Handler(h.clone()));
                }
                Ins::ContPop => {
                    while let Some(k) = st.cont.pop() {
                        if let Cont::Ret(i) = k {
                            st.ip = i;
                            break;
                        }
                    }
                }
                Ins::ContDepth => s.push(Value::I32(st.cont.len() as i32)),
                Ins::ContTrunc => {
                    let d = pop(s).i32();
                    if d >= 0 && (d as usize) < st.cont.len() {
                        st.cont.truncate(d as usize);
                    }
                }
                Ins::Suspend(kind) => {
                    let time = self.time;
                    match kind {
                        1 => {
                            let secs = pop(s).as_f64();
                            let mut b = fb.borrow_mut();
                            b.waiting = Waiting::Time;
                            b.wake = time + if secs > 0.0 { secs } else { 0.0 };
                            b.status = FiberStatus::Suspended;
                        }
                        2 => {
                            let Value::Signal(sig) = pop(s) else {
                                return fault("Await on a null signal", FAULT_NULL);
                            };
                            sig.waiters.borrow_mut().push(fb.clone());
                            let mut b = fb.borrow_mut();
                            b.waiting = Waiting::Signal;
                            b.signal = Some(sig);
                            b.status = FiberStatus::Suspended;
                        }
                        _ => {
                            let mut b = fb.borrow_mut();
                            b.waiting = Waiting::Nothing;
                            b.wake = time;
                            b.status = FiberStatus::Ready;
                        }
                    }
                    self.fuel = *fuel;
                    return Ok(None);
                }
                Ins::Throw => {
                    return match pop(s) {
                        Value::Fault(fv) => fault(fv.message.clone(), fv.code),
                        _ => fault("throw of a null fault", FAULT_NULL),
                    };
                }
                Ins::GGet(i) => s.push(module.globals.borrow().get(*i).cloned().unwrap_or(Value::Null)),
                Ins::GSet(i) => {
                    let v = pop(s);
                    if let Some(g) = module.globals.borrow_mut().get_mut(*i) {
                        *g = v;
                    }
                }
                Ins::Select => {
                    let c = pop(s);
                    let b = pop(s);
                    if !c.truthy() {
                        *top(s) = b;
                    }
                }
                Ins::Drop => {
                    s.pop();
                }
                Ins::Call(i) => {
                    let callee = module.funcs[*i].clone();
                    self.do_call(st, callee, fuel)?;
                }
                Ins::CallDelegate(nargs) => {
                    let at = s.len().saturating_sub(nargs + 1);
                    let Value::Delegate(d) = s[at].clone() else {
                        return fault("invoke of a null delegate", FAULT_NULL);
                    };
                    if d.bound {
                        s[at] = d.recv.clone().map(Value::Obj).unwrap_or(Value::Null);
                    } else {
                        s.remove(at);
                    }
                    let callee = module.funcs[d.func].clone();
                    if callee.is_latent() {
                        let n = callee.params.len();
                        let cargs = s.split_off(s.len().saturating_sub(n));
                        self.spawn(module, &callee, cargs);
                        continue;
                    }
                    self.do_call(st, callee, fuel)?;
                }
                Ins::CallVirtual { slot, nargs } => {
                    let recv = s.get(s.len().wrapping_sub(*nargs)).cloned();
                    let Some(Value::Obj(o)) = recv else {
                        return fault("method call on a null object", FAULT_NULL);
                    };
                    let callee = module.funcs[o.cls.vtable[*slot] as usize].clone();
                    self.do_call(st, callee, fuel)?;
                }
                Ins::CallInterface { iface, k, nargs } => {
                    let recv = s.get(s.len().wrapping_sub(*nargs)).cloned();
                    let Some(Value::Obj(o)) = recv else {
                        return fault("method call on a null object", FAULT_NULL);
                    };
                    let fi = o.cls.itables.get(iface).and_then(|t| t.get(*k)).copied().unwrap_or(0);
                    let callee = module.funcs[fi as usize].clone();
                    self.do_call(st, callee, fuel)?;
                }
                Ins::Return => {
                    let nr = f.results.len();
                    let res = s.split_off(s.len().saturating_sub(nr));
                    let Some(fr) = st.frames.pop() else {
                        self.fuel = *fuel;
                        return Ok(Some(res));
                    };
                    st.f = fr.f;
                    st.ip = fr.ip;
                    st.locs = fr.locs;
                    st.stack = fr.stack;
                    st.cont = fr.cont;
                    st.stack.extend(res);
                }
                Ins::ClassGet(i) => {
                    let Value::Obj(o) = top(s).clone() else {
                        return fault("field read on a null object", FAULT_NULL);
                    };
                    *top(s) = o.fields.borrow().get(*i).cloned().unwrap_or(Value::Null);
                }
                Ins::ClassSet(i) => {
                    let v = pop(s);
                    let Value::Obj(o) = pop(s) else {
                        return fault("field write on a null object", FAULT_NULL);
                    };
                    let mut fields = o.fields.borrow_mut();
                    if let Some(x) = fields.get_mut(*i) {
                        *x = v;
                    }
                }
                Ins::ClassNew(cls) => {
                    s.push(Value::Obj(Obj::new(cls.clone())));
                    *fuel -= (cls.defaults.len() >> 3) as i64;
                }
                Ins::RefShare => match top(s) {
                    Value::Array(a) => a.borrow_mut().shared = true,
                    Value::Map(m) => m.borrow_mut().shared = true,
                    _ => {}
                },
                Ins::RefNull => s.push(Value::Null),
                Ins::RefIsNull => {
                    let t = top(s);
                    *t = Value::I32(t.is_null() as i32);
                }
                Ins::RefValid => {
                    let t = top(s);
                    *t = Value::I32(!t.is_null() as i32);
                }
                Ins::RefEq => {
                    let b = pop(s);
                    let t = top(s);
                    *t = Value::I32(identical(t, &b) as i32);
                }
                Ins::RefTest(ty) => {
                    let t = top(s);
                    let ok = matches!(&*t, Value::Obj(o) if o.cls.ancestors.contains(ty));
                    *t = Value::I32(ok as i32);
                }
                Ins::RefCast(ty) => {
                    if let Value::Obj(o) = top(s) {
                        if !o.cls.ancestors.contains(ty) {
                            return fault(format!("{} cannot be cast to type {ty}", o.cls.name), FAULT_CAST);
                        }
                    }
                }
                Ins::DelegateNew(fi, flags) => {
                    let mut fi = *fi;
                    if flags & 1 != 0 {
                        let Value::Obj(recv) = pop(s) else {
                            return fault("delegate bound to a null object", FAULT_NULL);
                        };
                        if flags & 2 != 0 {
                            fi = recv.cls.overrides.get(&(fi as u32)).map(|&x| x as usize).unwrap_or(fi);
                        }
                        s.push(Value::Delegate(Rc::new(Delegate { func: fi, recv: Some(recv), bound: true })));
                    } else {
                        s.push(Value::Delegate(Rc::new(Delegate { func: fi, recv: None, bound: false })));
                    }
                }
                Ins::Bind | Ins::Unbind => {
                    let bind = matches!(ins, Ins::Bind);
                    let d = pop(s);
                    let disp = pop(s);
                    let (Value::Delegate(d), Value::Dispatcher(disp)) = (&d, &disp) else {
                        let what = if d.is_null() { "handler" } else { "object" };
                        return fault(format!("{} with a null {what}", if bind { "Bind" } else { "Unbind" }), FAULT_NULL);
                    };
                    let mut hs = disp.handlers.borrow_mut();
                    let at = hs.iter().position(|h| h.equals(d));
                    if bind {
                        if at.is_none() {
                            hs.push(d.clone());
                        }
                    } else if let Some(i) = at {
                        hs.remove(i);
                    }
                }
                Ins::Broadcast(n) => {
                    let bargs = s.split_off(s.len().saturating_sub(*n));
                    let Value::Dispatcher(disp) = pop(s) else {
                        return fault("Broadcast on a null object", FAULT_NULL);
                    };
                    self.fuel = *fuel;
                    self.broadcast_inner(module, &disp, bargs).map_err(Trap::Error)?;
                    *fuel = self.fuel;
                }
                Ins::StructNew(n) => {
                    let vals = s.split_off(s.len().saturating_sub(*n));
                    s.push(Value::list(vals));
                    *fuel -= (*n >> 3) as i64;
                }
                Ins::StructGet(i) => {
                    let t = top(s);
                    let v = match &*t {
                        Value::Struct(items) => items.get(*i).cloned().unwrap_or(Value::Null),
                        _ => Value::Null,
                    };
                    *t = v;
                }
                Ins::StructWith(i) => {
                    let v = pop(s);
                    let t = top(s);
                    let mut items = t.items();
                    let n = items.len();
                    if *i < n {
                        items[*i] = v;
                    }
                    *t = Value::list(items);
                    *fuel -= (n >> 3) as i64;
                }
                Ins::Nop => {}
                Ins::Unreachable => return fault("unreachable executed", FAULT_UNREACHABLE),
                Ins::ArrayNew(z) => {
                    let n = pop(s).i32();
                    if n < 0 {
                        return fault(format!("array length {n} is negative"), FAULT_RANGE);
                    }
                    self.alloc += n as i64;
                    // an array too big for the fuel left ends the run at the next instruction,
                    // so it is never filled
                    let items = if (n as i64 >> 3) > *fuel { vec![] } else { vec![z.clone(); n as usize] };
                    s.push(Value::new_array(items, false));
                    self.charge_alloc(fuel);
                }
                Ins::Array(op) => {
                    self.array_op(*op, s)?;
                    self.charge_alloc(fuel);
                }
                Ins::Map(op, zero) => {
                    self.map_op(*op, zero, s)?;
                    self.charge_alloc(fuel);
                }
                Ins::Set(op) => {
                    self.set_op(*op, s)?;
                    self.charge_alloc(fuel);
                }
                Ins::Bad(op) => {
                    return Err(Trap::Error(WiretError::new(STATUS_API, format!("unimplemented opcode 0x{op:02X}"))));
                }
            }
        }
    }

    fn array_op(&mut self, op: ArrOp, s: &mut Vec<Value>) -> Result<(), Trap> {
        let check = |a: &Rc<RefCell<ArrayData>>, i: i32, extra: usize| -> Result<usize, Trap> {
            let len = a.borrow().items.len();
            if i < 0 || i as usize >= len + extra {
                return fault(format!("array index {i} is out of range (length {len})"), FAULT_RANGE);
            }
            Ok(i as usize)
        };
        let as_arr = |v: &Value| match v {
            Value::Array(a) => a.clone(),
            _ => Rc::new(RefCell::new(ArrayData::default())),
        };
        match op {
            ArrOp::Len => {
                let t = top(s);
                *t = Value::I32(t.len() as i32);
            }
            ArrOp::Get => {
                let i = pop(s).i32();
                let a = as_arr(top(s));
                let k = check(&a, i, 0)?;
                let v = a.borrow().items[k].clone();
                *top(s) = v;
            }
            ArrOp::Set => {
                let v = pop(s);
                let i = pop(s).i32();
                let a = as_arr(top(s));
                let k = check(&a, i, 0)?;
                let a = self.own_array(&Value::Array(a));
                a.borrow_mut().items[k] = v;
                *top(s) = Value::Array(a);
            }
            ArrOp::Push => {
                let v = pop(s);
                let a = self.own_array(top(s));
                a.borrow_mut().items.push(v);
                *top(s) = Value::Array(a);
            }
            ArrOp::Insert => {
                let v = pop(s);
                let i = pop(s).i32();
                let a = as_arr(top(s));
                let k = check(&a, i, 1)?;
                let a = self.own_array(&Value::Array(a));
                a.borrow_mut().items.insert(k, v);
                *top(s) = Value::Array(a);
            }
            ArrOp::Remove => {
                let i = pop(s).i32();
                let a = as_arr(top(s));
                let k = check(&a, i, 0)?;
                let a = self.own_array(&Value::Array(a));
                a.borrow_mut().items.remove(k);
                *top(s) = Value::Array(a);
            }
            ArrOp::Clear => *top(s) = Value::new_array(vec![], false),
            ArrOp::Clone => {
                let items = top(s).items();
                self.alloc += items.len() as i64;
                *top(s) = Value::new_array(items, false);
            }
        }
        Ok(())
    }

    fn map_op(&mut self, op: MapOp, zero: &Value, s: &mut Vec<Value>) -> Result<(), Trap> {
        let at = |m: &MapData, i: i32| -> Result<usize, Trap> {
            if i < 0 || i as usize >= m.len() {
                return fault(format!("index {i} is out of range (length {})", m.len()), FAULT_RANGE);
            }
            Ok(i as usize)
        };
        let as_map = |v: &Value| match v {
            Value::Map(m) => m.clone(),
            _ => Rc::new(RefCell::new(MapData::default())),
        };
        let b = |x: bool| Value::I32(x as i32);
        match op {
            MapOp::New => s.push(Value::new_map(MapData::default())),
            MapOp::Find => {
                let k = pop(s);
                let m = as_map(&pop(s));
                let found = m.borrow().get(&k).cloned();
                match found {
                    Some(v) => {
                        s.push(v);
                        s.push(b(true));
                    }
                    None => {
                        s.push(zero.clone());
                        s.push(b(false));
                    }
                }
            }
            MapOp::Set => {
                let v = pop(s);
                let k = pop(s);
                let m = pop(s);
                let n = self.own_map(&m);
                n.borrow_mut().set(k, v);
                s.push(Value::Map(n));
            }
            MapOp::Remove => {
                let k = pop(s);
                let m = pop(s);
                if !as_map(&m).borrow().has(&k) {
                    s.push(m);
                    s.push(b(false));
                } else {
                    let n = self.own_map(&m);
                    n.borrow_mut().remove(&k);
                    s.push(Value::Map(n));
                    s.push(b(true));
                }
            }
            MapOp::Has => {
                let k = pop(s);
                let m = as_map(&pop(s));
                let h = m.borrow().has(&k);
                s.push(b(h));
            }
            MapOp::Len => {
                let m = as_map(&pop(s));
                let n = m.borrow().len();
                s.push(Value::I32(n as i32));
            }
            MapOp::KeyAt | MapOp::ValueAt => {
                let i = pop(s).i32();
                let m = as_map(&pop(s));
                let m = m.borrow();
                let k = at(&m, i)?;
                s.push(if matches!(op, MapOp::KeyAt) { m.key_at(k) } else { m.value_at(k) });
            }
            MapOp::Clear => {
                pop(s);
                s.push(Value::new_map(MapData::default()));
            }
        }
        Ok(())
    }

    fn set_op(&mut self, op: SetOp, s: &mut Vec<Value>) -> Result<(), Trap> {
        let as_map = |v: &Value| match v {
            Value::Map(m) => m.clone(),
            _ => Rc::new(RefCell::new(MapData::default())),
        };
        let b = |x: bool| Value::I32(x as i32);
        match op {
            SetOp::New => s.push(Value::new_map(MapData::default())),
            SetOp::Add => {
                let v = pop(s);
                let st = pop(s);
                if as_map(&st).borrow().has(&v) {
                    s.push(st);
                    s.push(b(false));
                } else {
                    let n = self.own_map(&st);
                    n.borrow_mut().set(v, Value::Null);
                    s.push(Value::Map(n));
                    s.push(b(true));
                }
            }
            SetOp::Remove => {
                let v = pop(s);
                let st = pop(s);
                if !as_map(&st).borrow().has(&v) {
                    s.push(st);
                    s.push(b(false));
                } else {
                    let n = self.own_map(&st);
                    n.borrow_mut().remove(&v);
                    s.push(Value::Map(n));
                    s.push(b(true));
                }
            }
            SetOp::Has => {
                let v = pop(s);
                let m = as_map(&pop(s));
                let h = m.borrow().has(&v);
                s.push(b(h));
            }
            SetOp::Len => {
                let m = as_map(&pop(s));
                let n = m.borrow().len();
                s.push(Value::I32(n as i32));
            }
            SetOp::At => {
                let i = pop(s).i32();
                let m = as_map(&pop(s));
                let m = m.borrow();
                if i < 0 || i as usize >= m.len() {
                    return fault(format!("index {i} is out of range (length {})", m.len()), FAULT_RANGE);
                }
                s.push(m.key_at(i as usize));
            }
            SetOp::Clear => {
                pop(s);
                s.push(Value::new_map(MapData::default()));
            }
        }
        Ok(())
    }

    /// Look up a value or fiber by input-log handle.
    pub(crate) fn handle(&self, h: usize) -> Option<&Handle> {
        self.handle_objs.get(h)
    }
}

fn pop(s: &mut Vec<Value>) -> Value {
    s.pop().unwrap_or(Value::Null)
}

fn top(s: &mut Vec<Value>) -> &mut Value {
    if s.is_empty() {
        s.push(Value::Null);
    }
    s.last_mut().unwrap()
}

/// A native's result as the VM holds it for the result type.
fn normalise_result(vt: Vt, v: Option<&Value>) -> Value {
    let v = v.cloned().unwrap_or(Value::Null);
    match vt {
        wbc::I32 => Value::I32(v.i32()),
        wbc::I64 => Value::I64(v.i64()),
        wbc::F32 => Value::F32(v.as_f64() as f32),
        wbc::F64 => Value::F64(v.as_f64()),
        _ => v,
    }
}

// -- numeric instructions ------------------------------------------------------------------------
fn fmin(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a == 0.0 && b == 0.0 {
        return if a.is_sign_negative() || b.is_sign_negative() { -0.0 } else { 0.0 };
    }
    a.min(b)
}

fn fmax(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a == 0.0 && b == 0.0 {
        return if a.is_sign_positive() || b.is_sign_positive() { 0.0 } else { -0.0 };
    }
    a.max(b)
}

fn keep_sign(x: f64, g: fn(f64) -> f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let r = g(x);
    if r == 0.0 { 0.0f64.copysign(x) } else { r }
}

fn trunc_sat32(x: f64, signed: bool) -> i32 {
    if x.is_nan() {
        return 0;
    }
    let (lo, hi) = if signed { (-2147483648.0, 2147483647.0) } else { (0.0, 4294967295.0) };
    if x <= lo {
        return lo as i64 as i32;
    }
    if x >= hi {
        return hi as i64 as i32;
    }
    x.trunc() as i64 as i32
}

fn trunc_sat64(x: f64, signed: bool) -> i64 {
    if x.is_nan() {
        return 0;
    }
    if signed {
        if x <= -9223372036854775808.0 {
            return i64::MIN;
        }
        if x >= 9223372036854775808.0 {
            return i64::MAX;
        }
        x.trunc() as i64
    } else {
        if x <= 0.0 {
            return 0;
        }
        if x >= 18446744073709551616.0 {
            return -1;
        }
        x.trunc() as u64 as i64
    }
}

fn int_op_i32(i: u16, s: &mut Vec<Value>) -> Result<(), Trap> {
    let b = |x: bool| Value::I32(x as i32);
    if matches!(i, 0 | 24..=27) {
        let a = top(s).i32();
        *top(s) = match i {
            0 => b(a == 0),
            24 => Value::I32(a.wrapping_neg()),
            25 => Value::I32(!a),
            26 => Value::I32(a as i8 as i32),
            _ => Value::I32(a as i16 as i32),
        };
        return Ok(());
    }
    let c = pop(s).i32();
    let a = top(s).i32();
    let (ua, uc) = (a as u32, c as u32);
    *top(s) = match i {
        1 => b(a == c),
        2 => b(a != c),
        3 => b(a < c),
        4 => b(ua < uc),
        5 => b(a > c),
        6 => b(ua > uc),
        7 => b(a <= c),
        8 => b(ua <= uc),
        9 => b(a >= c),
        10 => b(ua >= uc),
        11 => Value::I32(a.wrapping_add(c)),
        12 => Value::I32(a.wrapping_sub(c)),
        13 => Value::I32(a.wrapping_mul(c)),
        14 => {
            if c == 0 {
                return fault("integer divide by zero", FAULT_DIVIDE);
            }
            Value::I32(a.wrapping_div(c))
        }
        15 => {
            if c == 0 {
                return fault("integer divide by zero", FAULT_DIVIDE);
            }
            Value::I32((ua / uc) as i32)
        }
        16 => {
            if c == 0 {
                return fault("integer remainder by zero", FAULT_DIVIDE);
            }
            Value::I32(a.wrapping_rem(c))
        }
        17 => {
            if c == 0 {
                return fault("integer remainder by zero", FAULT_DIVIDE);
            }
            Value::I32((ua % uc) as i32)
        }
        18 => Value::I32(a & c),
        19 => Value::I32(a | c),
        20 => Value::I32(a ^ c),
        21 => Value::I32(a.wrapping_shl(uc & 31)),
        22 => Value::I32(a.wrapping_shr(uc & 31)),
        _ => Value::I32((ua >> (uc & 31)) as i32),
    };
    Ok(())
}

fn int_op_i64(i: u16, s: &mut Vec<Value>) -> Result<(), Trap> {
    let b = |x: bool| Value::I32(x as i32);
    if matches!(i, 0 | 24..=28) {
        let a = top(s).i64();
        *top(s) = match i {
            0 => b(a == 0),
            24 => Value::I64(a.wrapping_neg()),
            25 => Value::I64(!a),
            26 => Value::I64(a as i8 as i64),
            27 => Value::I64(a as i16 as i64),
            _ => Value::I64(a as i32 as i64),
        };
        return Ok(());
    }
    let c = pop(s).i64();
    let a = top(s).i64();
    let (ua, uc) = (a as u64, c as u64);
    *top(s) = match i {
        1 => b(a == c),
        2 => b(a != c),
        3 => b(a < c),
        4 => b(ua < uc),
        5 => b(a > c),
        6 => b(ua > uc),
        7 => b(a <= c),
        8 => b(ua <= uc),
        9 => b(a >= c),
        10 => b(ua >= uc),
        11 => Value::I64(a.wrapping_add(c)),
        12 => Value::I64(a.wrapping_sub(c)),
        13 => Value::I64(a.wrapping_mul(c)),
        14 => {
            if c == 0 {
                return fault("integer divide by zero", FAULT_DIVIDE);
            }
            Value::I64(a.wrapping_div(c))
        }
        15 => {
            if c == 0 {
                return fault("integer divide by zero", FAULT_DIVIDE);
            }
            Value::I64((ua / uc) as i64)
        }
        16 => {
            if c == 0 {
                return fault("integer remainder by zero", FAULT_DIVIDE);
            }
            Value::I64(a.wrapping_rem(c))
        }
        17 => {
            if c == 0 {
                return fault("integer remainder by zero", FAULT_DIVIDE);
            }
            Value::I64((ua % uc) as i64)
        }
        18 => Value::I64(a & c),
        19 => Value::I64(a | c),
        20 => Value::I64(a ^ c),
        21 => Value::I64(a.wrapping_shl((uc & 63) as u32)),
        22 => Value::I64(a.wrapping_shr((uc & 63) as u32)),
        _ => Value::I64((ua >> (uc & 63)) as i64),
    };
    Ok(())
}

macro_rules! float_ops {
    ($name:ident, $t:ty, $wrap:expr, $get:ident) => {
        fn $name(i: u16, s: &mut Vec<Value>) {
            let b = |x: bool| Value::I32(x as i32);
            let w: fn($t) -> Value = $wrap;
            if (12..=18).contains(&i) {
                let a: $t = top(s).$get() as $t;
                let r: $t = match i {
                    12 => -a,
                    13 => a.abs(),
                    14 => {
                        if a.is_nan() || a < 0.0 { <$t>::NAN } else { a.sqrt() }
                    }
                    15 => keep_sign(a as f64, f64::ceil) as $t,
                    16 => keep_sign(a as f64, f64::floor) as $t,
                    17 => keep_sign(a as f64, f64::trunc) as $t,
                    _ => keep_sign(a as f64, f64::round_ties_even) as $t,
                };
                *top(s) = w(r);
                return;
            }
            let c: $t = pop(s).$get() as $t;
            let a: $t = top(s).$get() as $t;
            *top(s) = match i {
                0 => b(a == c),
                1 => b(a != c),
                2 => b(a < c),
                3 => b(a > c),
                4 => b(a <= c),
                5 => b(a >= c),
                6 => w(a + c),
                7 => w(a - c),
                8 => w(a * c),
                9 => w(a / c),
                10 => w(fmin(a as f64, c as f64) as $t),
                11 => w(fmax(a as f64, c as f64) as $t),
                _ => w(a.copysign(c)),
            };
        }
    };
}

float_ops!(f32_op, f32, Value::F32, f32);
float_ops!(f64_op, f64, Value::F64, as_f64);

fn numeric(op: u16, s: &mut Vec<Value>) -> Result<(), Trap> {
    match op {
        0x30..=0x4B => return int_op_i32(op - 0x30, s),
        0x50..=0x6C => return int_op_i64(op - 0x50, s),
        0x70..=0x83 => f32_op(op - 0x70, s),
        0x90..=0xA3 => f64_op(op - 0x90, s),
        0xB0..=0xC8 => {
            let a = top(s).clone();
            *top(s) = match op - 0xB0 {
                0 => Value::I32(a.i64() as i32),
                1 => Value::I64(a.i32() as i64),
                2 => Value::I64(a.i32() as u32 as i64),
                3 => Value::I32(trunc_sat32(a.f32() as f64, true)),
                4 => Value::I32(trunc_sat32(a.f32() as f64, false)),
                5 => Value::I32(trunc_sat32(a.as_f64(), true)),
                6 => Value::I32(trunc_sat32(a.as_f64(), false)),
                7 => Value::I64(trunc_sat64(a.f32() as f64, true)),
                8 => Value::I64(trunc_sat64(a.f32() as f64, false)),
                9 => Value::I64(trunc_sat64(a.as_f64(), true)),
                10 => Value::I64(trunc_sat64(a.as_f64(), false)),
                11 => Value::F32(a.i32() as f32),
                12 => Value::F32(a.i32() as u32 as f32),
                13 => Value::F32(a.i64() as f32),
                14 => Value::F32(a.i64() as u64 as f32),
                15 => Value::F64(a.i32() as f64),
                16 => Value::F64(a.i32() as u32 as f64),
                17 => Value::F64(a.i64() as f64),
                18 => Value::F64(a.i64() as u64 as f64),
                19 => Value::F32(a.as_f64() as f32),
                20 => Value::F64(a.f32() as f64),
                21 => {
                    let x = a.f32();
                    Value::I32(if x.is_nan() { 0x7FC0_0000 } else { x.to_bits() as i32 })
                }
                22 => {
                    let x = a.as_f64();
                    Value::I64(if x.is_nan() { 0x7FF8_0000_0000_0000 } else { x.to_bits() as i64 })
                }
                23 => Value::F32(f32::from_bits(a.i32() as u32)),
                _ => Value::F64(f64::from_bits(a.i64() as u64)),
            };
        }
        0xF0 => {
            let c = pop(s);
            let t = top(s);
            *t = Value::str(&format!("{}{}", t.as_str(), c.as_str()));
        }
        0xF1 => {
            let t = top(s);
            *t = Value::I32(t.as_str().len() as i32);
        }
        0xF2 => {
            let c = pop(s);
            let t = top(s);
            *t = Value::I32((t.as_str() == c.as_str()) as i32);
        }
        0xF3 => {
            let c = pop(s);
            let t = top(s);
            *t = Value::I32(match t.as_str().cmp(c.as_str()) {
                std::cmp::Ordering::Less => -1,
                std::cmp::Ordering::Equal => 0,
                std::cmp::Ordering::Greater => 1,
            });
        }
        _ => return Err(Trap::Error(WiretError::new(STATUS_API, format!("unimplemented opcode 0x{op:02X}")))),
    }
    Ok(())
}
