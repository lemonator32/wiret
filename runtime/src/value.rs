//! Values as the VM holds them (spec sections 3.1 and 4.9).
//!
//! `i32` (and `bool` and the small integer types) are `I32`, `i64` and `u64` are `I64`. An array is
//! a shared, copy-on-write list; a map or a set (whose values are null) an insertion-ordered
//! map with the same flag. A struct or lane value is an immutable list. Objects, delegates,
//! dispatchers and signals are references with identity.
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use indexmap::IndexMap;

use crate::vm::FiberRef;

#[derive(Clone)]
pub enum Value {
    Null,
    I32(i32),
    I64(i64),
    F32(f32),
    F64(f64),
    Str(Rc<str>),
    Array(Rc<RefCell<ArrayData>>),
    Map(Rc<RefCell<MapData>>),
    Struct(Rc<[Value]>),
    Obj(Rc<Obj>),
    Delegate(Rc<Delegate>),
    Dispatcher(Rc<Dispatcher>),
    Signal(Rc<Signal>),
    Fault(Rc<FaultValue>),
}

impl std::fmt::Debug for Value {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Value::Null => write!(f, "null"),
            Value::I32(x) => write!(f, "{x}"),
            Value::I64(x) => write!(f, "{x}i64"),
            Value::F32(x) => write!(f, "{x}f32"),
            Value::F64(x) => write!(f, "{x}"),
            Value::Str(s) => write!(f, "{s:?}"),
            Value::Array(a) => f.debug_list().entries(a.borrow().items.iter()).finish(),
            Value::Map(m) => f.debug_map().entries(m.borrow().entries.values().map(|(k, v)| (k, v))).finish(),
            Value::Struct(items) => f.debug_tuple("").field(&items).finish(),
            Value::Obj(o) => write!(f, "<{} {:x}>", o.cls.name, o.serial),
            Value::Delegate(d) => write!(f, "<delegate func {}{}>", d.func, if d.bound { " bound" } else { "" }),
            Value::Dispatcher(d) => write!(f, "<dispatcher, {} bound>", d.handlers.borrow().len()),
            Value::Signal(_) => write!(f, "<signal>"),
            Value::Fault(x) => write!(f, "<fault {:?} {}>", x.message, x.code),
        }
    }
}

impl Value {
    pub fn str(s: &str) -> Value {
        Value::Str(Rc::from(s))
    }
    pub fn list(items: Vec<Value>) -> Value {
        Value::Struct(items.into())
    }
    pub fn new_array(items: Vec<Value>, shared: bool) -> Value {
        Value::Array(Rc::new(RefCell::new(ArrayData { items, shared })))
    }
    pub fn new_map(data: MapData) -> Value {
        Value::Map(Rc::new(RefCell::new(data)))
    }
    pub fn is_null(&self) -> bool {
        matches!(self, Value::Null)
    }

    /// The value as a JavaScript number would be: for numeric conversions.
    pub fn as_f64(&self) -> f64 {
        match self {
            Value::I32(x) => *x as f64,
            Value::I64(x) => *x as f64,
            Value::F32(x) => *x as f64,
            Value::F64(x) => *x,
            Value::Str(s) => s.trim().parse().unwrap_or(f64::NAN),
            Value::Null => 0.0,
            _ => f64::NAN,
        }
    }
    pub fn i32(&self) -> i32 {
        match self {
            Value::I32(x) => *x,
            Value::I64(x) => *x as i32,
            other => to_int32(other.as_f64()),
        }
    }
    pub fn i64(&self) -> i64 {
        match self {
            Value::I64(x) => *x,
            Value::I32(x) => *x as i64,
            other => {
                let f = other.as_f64();
                if f.is_finite() { f.trunc() as i128 as i64 } else { 0 }
            }
        }
    }
    pub fn f32(&self) -> f32 {
        match self {
            Value::F32(x) => *x,
            other => other.as_f64() as f32,
        }
    }
    pub fn as_str(&self) -> &str {
        match self {
            Value::Str(s) => s,
            _ => "",
        }
    }
    pub fn truthy(&self) -> bool {
        match self {
            Value::Null => false,
            Value::I32(x) => *x != 0,
            Value::I64(x) => *x != 0,
            Value::F32(x) => *x != 0.0 && !x.is_nan(),
            Value::F64(x) => *x != 0.0 && !x.is_nan(),
            Value::Str(s) => !s.is_empty(),
            _ => true,
        }
    }
    /// The number of elements of an array or struct, or entries of a map.
    pub fn len(&self) -> usize {
        match self {
            Value::Array(a) => a.borrow().items.len(),
            Value::Map(m) => m.borrow().len(),
            Value::Struct(s) => s.len(),
            _ => 0,
        }
    }
    /// The elements of an array or struct (a copy).
    pub fn items(&self) -> Vec<Value> {
        match self {
            Value::Array(a) => a.borrow().items.clone(),
            Value::Struct(s) => s.to_vec(),
            _ => vec![],
        }
    }
    /// An address that identifies a reference value while it is alive.
    pub fn ptr(&self) -> Option<usize> {
        Some(match self {
            Value::Array(a) => Rc::as_ptr(a) as *const () as usize,
            Value::Map(m) => Rc::as_ptr(m) as *const () as usize,
            Value::Struct(s) => s.as_ptr() as *const () as usize,
            Value::Obj(o) => Rc::as_ptr(o) as *const () as usize,
            Value::Delegate(d) => Rc::as_ptr(d) as *const () as usize,
            Value::Dispatcher(d) => Rc::as_ptr(d) as *const () as usize,
            Value::Signal(s) => Rc::as_ptr(s) as *const () as usize,
            Value::Fault(x) => Rc::as_ptr(x) as *const () as usize,
            _ => return None,
        })
    }
}

/// JavaScript's ToInt32, which `x | 0` applies.
pub fn to_int32(x: f64) -> i32 {
    if !x.is_finite() {
        return 0;
    }
    let t = x.trunc();
    let m = t.rem_euclid(4294967296.0);
    m as u32 as i32
}

/// `ref.eq` and JavaScript's `===` on the values the VM keeps: identity for references.
pub fn identical(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Null, Value::Null) => true,
        (Value::I32(x), Value::I32(y)) => x == y,
        (Value::I64(x), Value::I64(y)) => x == y,
        (Value::F32(x), Value::F32(y)) => x == y,
        (Value::F64(x), Value::F64(y)) => x == y,
        (Value::Str(x), Value::Str(y)) => x == y,
        _ => match (a.ptr(), b.ptr()) {
            (Some(p), Some(q)) => p == q && std::mem::discriminant(a) == std::mem::discriminant(b),
            _ => false,
        },
    }
}

#[derive(Clone, Default)]
pub struct ArrayData {
    pub items: Vec<Value>,
    pub shared: bool,
}

/// A map key as stored: every NaN is one key, -0 is 0, and structs match by value.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub enum Key {
    Null,
    Num(u64),
    Big(i64),
    Str(Rc<str>),
    List(Vec<Key>),
    Ptr(usize),
}

fn num_key(x: f64) -> Key {
    if x.is_nan() {
        Key::Num(0x7FF8_0000_0000_0000)
    } else if x == 0.0 {
        Key::Num(0)
    } else {
        Key::Num(x.to_bits())
    }
}

pub fn key_of(v: &Value) -> Key {
    match v {
        Value::Null => Key::Null,
        Value::I32(x) => num_key(*x as f64),
        Value::F32(x) => num_key(*x as f64),
        Value::F64(x) => num_key(*x),
        Value::I64(x) => Key::Big(*x),
        Value::Str(s) => Key::Str(s.clone()),
        Value::Struct(items) => Key::List(items.iter().map(key_of).collect()),
        Value::Array(a) => Key::List(a.borrow().items.iter().map(key_of).collect()),
        other => Key::Ptr(other.ptr().unwrap_or(0)),
    }
}

/// A map, or a set (its values are null): insertion-ordered, plus the copy-on-write flag.
#[derive(Clone, Default)]
pub struct MapData {
    pub entries: IndexMap<Key, (Value, Value)>,
    pub shared: bool,
}

impl MapData {
    pub fn from_entries(items: impl IntoIterator<Item = (Value, Value)>) -> MapData {
        let mut m = MapData::default();
        for (k, v) in items {
            m.set(k, v);
        }
        m
    }
    pub fn len(&self) -> usize {
        self.entries.len()
    }
    pub fn has(&self, k: &Value) -> bool {
        self.entries.contains_key(&key_of(k))
    }
    pub fn get(&self, k: &Value) -> Option<&Value> {
        self.entries.get(&key_of(k)).map(|e| &e.1)
    }
    /// The first key written stays, as in a dict.
    pub fn set(&mut self, k: Value, v: Value) {
        let key = key_of(&k);
        if let Some(e) = self.entries.get_mut(&key) {
            e.1 = v;
        } else {
            self.entries.insert(key, (k, v));
        }
    }
    pub fn remove(&mut self, k: &Value) -> bool {
        self.entries.shift_remove(&key_of(k)).is_some()
    }
    pub fn key_at(&self, i: usize) -> Value {
        self.entries.get_index(i).map(|(_, e)| e.0.clone()).unwrap_or(Value::Null)
    }
    pub fn value_at(&self, i: usize) -> Value {
        self.entries.get_index(i).map(|(_, e)| e.1.clone()).unwrap_or(Value::Null)
    }
    pub fn iter(&self) -> impl Iterator<Item = &(Value, Value)> {
        self.entries.values()
    }
    pub fn copy(&self) -> MapData {
        MapData { entries: self.entries.clone(), shared: false }
    }
}

/// A loaded class type: its name, field layout and defaults, vtable and ancestors.
#[derive(Debug)]
pub struct ClassInfo {
    pub index: u32,
    pub name: String,
    pub field_names: Vec<String>,
    pub defaults: Vec<Value>,
    pub vtable: Vec<u32>,
    pub ancestors: HashSet<u32>,
    pub itables: HashMap<u32, Vec<u32>>,
    pub dispatchers: Vec<usize>,
    pub overrides: HashMap<u32, u32>,
}

thread_local! {
    static OBJ_COUNTER: Cell<u64> = const { Cell::new(0) };
}

/// A class instance (section 3.1): a reference with identity.
pub struct Obj {
    pub cls: Rc<ClassInfo>,
    pub fields: RefCell<Vec<Value>>,
    pub serial: u64,
}

impl Obj {
    pub fn new(cls: Rc<ClassInfo>) -> Rc<Obj> {
        let mut fields = cls.defaults.clone();
        for &i in &cls.dispatchers {
            if i < fields.len() {
                fields[i] = Value::Dispatcher(Rc::new(Dispatcher::default()));
            }
        }
        let serial = OBJ_COUNTER.with(|c| {
            c.set(c.get() + 1);
            c.get()
        });
        Rc::new(Obj { cls, fields: RefCell::new(fields), serial })
    }
    pub fn field(&self, name: &str) -> Option<Value> {
        let i = self.cls.field_names.iter().position(|n| n == name)?;
        self.fields.borrow().get(i).cloned()
    }
}

/// A function plus, when `bound`, its receiver (section 3.1).
pub struct Delegate {
    pub func: usize,
    pub recv: Option<Rc<Obj>>,
    pub bound: bool,
}

impl Delegate {
    pub fn equals(&self, o: &Delegate) -> bool {
        self.func == o.func
            && self.bound == o.bound
            && match (&self.recv, &o.recv) {
                (None, None) => true,
                (Some(a), Some(b)) => Rc::ptr_eq(a, b),
                _ => false,
            }
    }
}

/// A dispatcher member of one object: its handlers in bind order.
#[derive(Default)]
pub struct Dispatcher {
    pub handlers: RefCell<Vec<Rc<Delegate>>>,
}

/// A value of type `std.Signal` (section 4.5). Equality is identity.
#[derive(Default)]
pub struct Signal {
    pub waiters: RefCell<Vec<FiberRef>>,
}

/// A value of type `fault` (section 4.6).
#[derive(Clone, Debug, PartialEq)]
pub struct FaultValue {
    pub message: String,
    pub code: i32,
}

pub fn no_fault() -> Value {
    Value::Fault(Rc::new(FaultValue { message: String::new(), code: 0 }))
}

/// `Eq` on two values of one type, as the VM stores them (section 4.9).
pub fn values_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Array(_) | Value::Struct(_), _) => {
            if !matches!(b, Value::Array(_) | Value::Struct(_)) {
                return false;
            }
            let (x, y) = (a.items(), b.items());
            x.len() == y.len() && x.iter().zip(y.iter()).all(|(p, q)| values_equal(p, q))
        }
        (Value::Map(x), _) => {
            let Value::Map(y) = b else { return false };
            let (x, y) = (x.borrow(), y.borrow());
            if x.len() != y.len() {
                return false;
            }
            let same = x.iter().all(|(k, v)| y.get(k).is_some_and(|w| values_equal(v, w)));
            same
        }
        (Value::Fault(x), Value::Fault(y)) => x.message == y.message && x.code == y.code,
        _ => identical(a, b),
    }
}

/// How many elements, entries and fields `values_equal` may visit.
pub fn value_size(v: &Value) -> usize {
    match v {
        Value::Array(_) | Value::Struct(_) => {
            let items = v.items();
            let mut n = items.len();
            for x in &items {
                if matches!(x, Value::Array(_) | Value::Struct(_) | Value::Map(_)) {
                    n += value_size(x);
                }
            }
            n
        }
        Value::Map(m) => {
            let m = m.borrow();
            let mut n = m.len();
            for (_, x) in m.iter() {
                if matches!(x, Value::Array(_) | Value::Struct(_) | Value::Map(_)) {
                    n += value_size(x);
                }
            }
            n
        }
        _ => 0,
    }
}
