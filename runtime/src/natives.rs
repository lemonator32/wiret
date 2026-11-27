//! Standard-library and host natives (spec sections 3.4 and 6.6), a port of
//! `src/core/natives.ts`.
//!
//! `std.*` natives are always available. Host natives (`host.*`) must be declared with `extern
//! func` in the module; the host supplies them with [`crate::Vm::register`]. The non-deterministic
//! math natives use the `libm` crate, so they give the same bits on every platform too (but
//! deterministic mode does not rely on that: it swaps in [`crate::detmath`]).
use std::collections::HashMap;
use std::rc::Rc;

use crate::fmt::float_to_text;
use crate::lanes::{self, Trig};
use crate::value::{value_size, values_equal, FaultValue, Signal, Value};
use crate::vm::Vm;

/// Raised by a native to report a fault to the VM. Code -6 means an error from a native.
#[derive(Clone, Debug)]
pub struct NativeFault {
    pub message: String,
    pub code: i32,
}

impl NativeFault {
    pub fn new(message: impl Into<String>) -> NativeFault {
        NativeFault { message: message.into(), code: -6 }
    }
}

pub type NativeFn = Rc<dyn Fn(&mut Vm, &[Value]) -> Result<Vec<Value>, NativeFault>>;
pub type CostFn = Rc<dyn Fn(&[Value]) -> i64>;

/// A native function and its signature. Parameter and result types are Wiret type names
/// (`i32`, `f64`, `string`, `vec3`, `std.Signal`, ...).
#[derive(Clone)]
pub struct NativeSpec {
    pub params: Vec<(String, String)>,
    pub results: Vec<(String, String)>,
    pub purity: String,
    pub func: NativeFn,
    pub doc: String,
    /// extra fuel a call costs, from its arguments
    pub cost: Option<CostFn>,
    /// the capability the host must grant before a module may import it
    pub capability: Option<String>,
    /// WR_NATIVE_DETERMINISTIC (section 6.6)
    pub deterministic: bool,
}

impl NativeSpec {
    pub fn new(
        params: &[(&str, &str)],
        results: &[(&str, &str)],
        purity: &str,
        func: impl Fn(&mut Vm, &[Value]) -> Result<Vec<Value>, NativeFault> + 'static,
    ) -> NativeSpec {
        let own = |v: &[(&str, &str)]| v.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect();
        NativeSpec {
            params: own(params),
            results: own(results),
            purity: purity.into(),
            func: Rc::new(func),
            doc: String::new(),
            cost: None,
            capability: None,
            deterministic: true,
        }
    }
    pub fn with_fn(&self, func: impl Fn(&mut Vm, &[Value]) -> Result<Vec<Value>, NativeFault> + 'static) -> NativeSpec {
        NativeSpec { func: Rc::new(func), ..self.clone() }
    }
}

type R = Result<Vec<Value>, NativeFault>;

fn f(v: &Value) -> f64 {
    v.as_f64()
}

fn round_half_away(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    (x.abs() + 0.5).floor().copysign(x)
}

fn is_int(y: f64) -> bool {
    y.is_finite() && y == y.floor()
}

/// Python's math.pow, with ValueError giving NaN and OverflowError +inf for a positive base
/// (else NaN), as the prototype's `_pow` does.
pub fn py_pow(a: f64, b: f64) -> f64 {
    if b == 0.0 || a == 1.0 {
        return 1.0;
    }
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a == 0.0 && b < 0.0 && b.is_finite() {
        return f64::NAN;
    }
    if a < 0.0 && a.is_finite() && b.is_finite() && !is_int(b) {
        return f64::NAN;
    }
    if a == -1.0 && !b.is_finite() {
        return 1.0;
    }
    let r = libm::pow(a, b);
    if !r.is_finite() && a.is_finite() && b.is_finite() {
        return if a > 0.0 { f64::INFINITY } else { f64::NAN };
    }
    r
}

/// Python's math functions raise where these give NaN.
fn py_exp(x: f64) -> f64 {
    let r = libm::exp(x);
    if r == f64::INFINITY && x != f64::INFINITY { f64::NAN } else { r }
}
fn py_log(x: f64) -> f64 {
    if x <= 0.0 { f64::NAN } else { libm::log(x) }
}
fn py_floor(x: f64) -> f64 {
    if !x.is_finite() { f64::NAN } else { x.floor() + 0.0 }
}
fn py_ceil(x: f64) -> f64 {
    if !x.is_finite() { f64::NAN } else { x.ceil() + 0.0 }
}
fn py_sqrt(x: f64) -> f64 {
    if x < 0.0 { f64::NAN } else { x.sqrt() }
}

fn f64u(g: fn(f64) -> f64) -> impl Fn(&mut Vm, &[Value]) -> R {
    move |_, a| Ok(vec![Value::F64(g(f(&a[0])))])
}

fn substring(s: &str, start: i64, length: i64) -> R {
    let b = s.as_bytes();
    if start < 0 || length < 0 || start + length > b.len() as i64 {
        return Err(NativeFault::new(format!("Substring({start}, {length}) out of range for length {}", b.len())));
    }
    let part = &b[start as usize..(start + length) as usize];
    Ok(vec![Value::str(&String::from_utf8_lossy(part))])
}

/// The longest string Repeat makes, as JavaScript's limit on a string's length is.
const MAX_STRING: usize = 1 << 29;

fn signal_fire(vm: &mut Vm, a: &[Value]) -> R {
    match &a[0] {
        Value::Signal(s) => {
            vm.fire_signal(s);
            Ok(vec![])
        }
        _ => Err(NativeFault { message: "Fire on a null signal".into(), code: -3 }),
    }
}

fn single_text(x: f64) -> String {
    float_to_text(x, true)
}

fn lane_natives(out: &mut HashMap<String, NativeSpec>, trig: Trig) {
    let mut nat = |name: String, params: &[(&str, &str)], results: &[(&str, &str)], g: Rc<dyn Fn(&[Value]) -> Value>, doc: &str| {
        let mut spec = NativeSpec::new(params, results, "pure", move |_, a| Ok(vec![g(a)]));
        spec.doc = doc.into();
        out.insert(name, spec);
    };
    use lanes::{comps as c, mk};
    for t in ["vec2", "vec3"] {
        let p2: &[(&str, &str)] = &[("a", t), ("b", t)];
        nat(format!("std.vec.Dot#<{t}>"), p2, &[("result", "f32")], Rc::new(|a| Value::F32(lanes::dot(&c(&a[0]), &c(&a[1])))), "");
        nat(format!("std.vec.Length#<{t}>"), &[("v", t)], &[("result", "f32")], Rc::new(|a| Value::F32(lanes::length(&c(&a[0])))), "");
        nat(format!("std.vec.LengthSquared#<{t}>"), &[("v", t)], &[("result", "f32")], Rc::new(|a| Value::F32(lanes::lensq(&c(&a[0])))), "");
        nat(format!("std.vec.Distance#<{t}>"), p2, &[("result", "f32")], Rc::new(|a| Value::F32(lanes::distance(&c(&a[0]), &c(&a[1])))), "");
        nat(format!("std.vec.Normalize#<{t}>"), &[("v", t)], &[("result", t)], Rc::new(|a| mk(lanes::normalize(&c(&a[0])))),
            "The vector scaled to length 1; the zero vector when it has no direction.");
        nat(format!("std.vec.Lerp#<{t}>"), &[("a", t), ("b", t), ("t", "f32")], &[("result", t)],
            Rc::new(|a| mk(lanes::lerp(&c(&a[0]), &c(&a[1]), a[2].f32()))), "");
        nat(format!("std.vec.Reflect#<{t}>"), &[("v", t), ("n", t)], &[("result", t)], Rc::new(|a| mk(lanes::reflect(&c(&a[0]), &c(&a[1])))), "");
    }
    nat("std.vec.Cross".into(), &[("a", "vec3"), ("b", "vec3")], &[("result", "vec3")], Rc::new(|a| mk(lanes::cross(&c(&a[0]), &c(&a[1])))), "");
    nat("std.vec.PerpDot".into(), &[("a", "vec2"), ("b", "vec2")], &[("result", "f32")], Rc::new(|a| Value::F32(lanes::perpdot(&c(&a[0]), &c(&a[1])))), "");
    nat("std.quat.Rotate".into(), &[("q", "quat"), ("v", "vec3")], &[("result", "vec3")], Rc::new(|a| mk(lanes::rotate(&c(&a[0]), &c(&a[1])))),
        "Rotate a vector by a unit quaternion.");
    nat("std.quat.Conjugate".into(), &[("q", "quat")], &[("result", "quat")], Rc::new(|a| mk(lanes::conj(&c(&a[0])))), "");
    nat("std.quat.Inverse".into(), &[("q", "quat")], &[("result", "quat")], Rc::new(|a| mk(lanes::qinverse(&c(&a[0])))), "");
    nat("std.quat.Normalize".into(), &[("q", "quat")], &[("result", "quat")], Rc::new(|a| mk(lanes::qnormalize(&c(&a[0])))), "");
    nat("std.quat.FromAxisAngle".into(), &[("axis", "vec3"), ("angle", "f32")], &[("result", "quat")],
        Rc::new(move |a| mk(trig.from_axis_angle(&c(&a[0]), a[1].f32()))), "The rotation by `angle` radians about `axis`.");
    nat("std.quat.Slerp".into(), &[("a", "quat"), ("b", "quat"), ("t", "f32")], &[("result", "quat")],
        Rc::new(move |a| mk(trig.slerp(&c(&a[0]), &c(&a[1]), a[2].f32()))), "Interpolate between two rotations along the shorter arc.");
    nat("std.quat.Angle".into(), &[("a", "quat"), ("b", "quat")], &[("result", "f32")],
        Rc::new(move |a| Value::F32(trig.angle(&c(&a[0]), &c(&a[1])))), "The angle in radians between two rotations.");
    nat("std.transform.Apply".into(), &[("t", "transform"), ("p", "vec3")], &[("result", "vec3")],
        Rc::new(|a| mk(lanes::apply(&a[0], &c(&a[1])))), "Transform a point: scale, rotate, then translate.");
    nat("std.transform.ApplyVector".into(), &[("t", "transform"), ("v", "vec3")], &[("result", "vec3")],
        Rc::new(|a| mk(lanes::apply_vector(&a[0], &c(&a[1])))), "Transform a direction: no translation.");
    nat("std.transform.Inverse".into(), &[("t", "transform")], &[("result", "transform")], Rc::new(|a| lanes::tinverse(&a[0])), "");
}

/// The natives that deterministic mode replaces with ones built on the bundled math (4.10).
pub const LANE_TRIG: [&str; 3] = ["std.quat.FromAxisAngle", "std.quat.Slerp", "std.quat.Angle"];

/// The lane natives built on `trig`.
pub fn lane_trig_natives(trig: Trig) -> HashMap<String, NativeSpec> {
    let mut out = HashMap::new();
    lane_natives(&mut out, trig);
    out
}

pub const LIBM_TRIG: Trig = Trig { sin: libm::sin, cos: libm::cos, acos: libm::acos };

/// `std.*`, the compiler's internal natives and `host.Log`.
pub fn all_natives() -> HashMap<String, NativeSpec> {
    let mut t: HashMap<String, NativeSpec> = HashMap::new();
    let mut put = |name: &str, spec: NativeSpec| {
        t.insert(name.to_string(), spec);
    };
    const FX: &[(&str, &str)] = &[("x", "f64")];
    const FR: &[(&str, &str)] = &[("result", "f64")];
    put("std.math.Sqrt", NativeSpec::new(FX, FR, "pure", f64u(py_sqrt)));
    put("std.math.Sin", NativeSpec::new(FX, FR, "pure", f64u(libm::sin)));
    put("std.math.Cos", NativeSpec::new(FX, FR, "pure", f64u(libm::cos)));
    put("std.math.Tan", NativeSpec::new(FX, FR, "pure", f64u(libm::tan)));
    put("std.math.Exp", NativeSpec::new(FX, FR, "pure", f64u(py_exp)));
    put("std.math.Log", NativeSpec::new(FX, FR, "pure", f64u(py_log)));
    put("std.math.Floor", NativeSpec::new(FX, FR, "pure", f64u(py_floor)));
    put("std.math.Ceil", NativeSpec::new(FX, FR, "pure", f64u(py_ceil)));
    put("std.math.Round", NativeSpec::new(FX, FR, "pure", f64u(round_half_away)));
    put("std.math.Acos", NativeSpec::new(FX, FR, "pure", f64u(libm::acos)));
    put("std.math.Pow", NativeSpec::new(&[("a", "f64"), ("b", "f64")], FR, "pure", |_, a| Ok(vec![Value::F64(py_pow(f(&a[0]), f(&a[1])))])));
    put("std.math.Atan2", NativeSpec::new(&[("y", "f64"), ("x", "f64")], FR, "pure", |_, a| Ok(vec![Value::F64(libm::atan2(f(&a[0]), f(&a[1])))])));
    put("std.math.Lerp", NativeSpec::new(&[("a", "f64"), ("b", "f64"), ("t", "f64")], FR, "pure", |_, a| {
        let (x, y, s) = (f(&a[0]), f(&a[1]), f(&a[2]));
        Ok(vec![Value::F64(x + (y - x) * s)])
    }));
    put("std.math.Pi", NativeSpec::new(&[], FR, "pure", |_, _| Ok(vec![Value::F64(std::f64::consts::PI)])));
    const S2: &[(&str, &str)] = &[("a", "string"), ("b", "string")];
    put("std.string.Concat", NativeSpec::new(S2, &[("result", "string")], "pure", |_, a| {
        Ok(vec![Value::str(&format!("{}{}", a[0].as_str(), a[1].as_str()))])
    }));
    put("std.string.Length", NativeSpec::new(&[("s", "string")], &[("result", "i32")], "pure", |_, a| {
        Ok(vec![Value::I32(a[0].as_str().len() as i32)])
    }));
    put("std.string.Substring", NativeSpec::new(&[("s", "string"), ("start", "i32"), ("length", "i32")], &[("result", "string")], "pure", |_, a| {
        substring(a[0].as_str(), a[1].i32() as i64, a[2].i32() as i64)
    }));
    put("std.string.Find", NativeSpec::new(&[("s", "string"), ("sub", "string")], &[("result", "i32")], "pure", |_, a| {
        Ok(vec![Value::I32(a[0].as_str().find(a[1].as_str()).map_or(-1, |i| i as i32))])
    }));
    put("std.string.ToUpper", NativeSpec::new(&[("s", "string")], &[("result", "string")], "pure", |_, a| Ok(vec![Value::str(&a[0].as_str().to_uppercase())])));
    put("std.string.ToLower", NativeSpec::new(&[("s", "string")], &[("result", "string")], "pure", |_, a| Ok(vec![Value::str(&a[0].as_str().to_lowercase())])));
    put("std.string.Repeat", NativeSpec::new(&[("s", "string"), ("count", "i32")], &[("result", "string")], "pure", |_, a| {
        let s = a[0].as_str();
        let n = a[1].i32().max(0) as usize;
        if s.len().saturating_mul(n) > MAX_STRING {
            return Err(NativeFault::new(format!("Repeat({n}) makes a string longer than {MAX_STRING} bytes")));
        }
        Ok(vec![Value::str(&s.repeat(n))])
    }));
    let mut sig_new = NativeSpec::new(&[], &[("signal", "std.Signal")], "impure", |_, _| Ok(vec![Value::Signal(Rc::new(Signal::default()))]));
    sig_new.doc = "Make a new signal that fibers can Await.".into();
    put("std.signal.New", sig_new);
    let mut sig_fire = NativeSpec::new(&[("signal", "std.Signal")], &[], "impure", signal_fire);
    sig_fire.doc = "Wake every fiber waiting on the signal. They run on the next advance of time.".into();
    put("std.signal.Fire", sig_fire);

    // natives the compiler calls on its own to lower Convert<X, string> and float Rem
    let conv = |ty: &'static str, g: fn(&Value) -> String| NativeSpec::new(&[("v", ty)], &[("r", "string")], "pure", move |_, a| Ok(vec![Value::str(&g(&a[0]))]));
    put("std.convert.FromBool", conv("i32", |v| if v.i32() != 0 { "true".into() } else { "false".into() }));
    put("std.convert.FromI32", conv("i32", |v| v.i32().to_string()));
    put("std.convert.FromU32", conv("i32", |v| (v.i32() as u32).to_string()));
    put("std.convert.FromI64", conv("i64", |v| v.i64().to_string()));
    put("std.convert.FromU64", conv("i64", |v| (v.i64() as u64).to_string()));
    put("std.convert.FromF32", conv("f32", |v| float_to_text(v.as_f64(), true)));
    put("std.convert.FromF64", conv("f64", |v| float_to_text(v.as_f64(), false)));
    for t in ["vec2", "vec3", "quat", "transform"] {
        let name = format!("std.convert.From{}{}", t[..1].to_uppercase(), &t[1..]);
        put(&name, NativeSpec::new(&[("v", t)], &[("r", "string")], "pure", |_, a| Ok(vec![Value::str(&lanes::to_text(&a[0], &single_text))])));
    }
    put("std.math.FRem32", NativeSpec::new(&[("a", "f32"), ("b", "f32")], &[("r", "f32")], "pure", |_, a| {
        let (x, y) = (a[0].f32() as f64, a[1].f32() as f64);
        Ok(vec![Value::F32(if y != 0.0 && !y.is_nan() { (x % y) as f32 } else { f32::NAN })])
    }));
    put("std.math.FRem64", NativeSpec::new(&[("a", "f64"), ("b", "f64")], &[("r", "f64")], "pure", |_, a| {
        let (x, y) = (f(&a[0]), f(&a[1]));
        Ok(vec![Value::F64(if y != 0.0 && !y.is_nan() { x % y } else { f64::NAN })])
    }));
    put("std.fault.Make", NativeSpec::new(&[("message", "string"), ("code", "i32")], &[("fault", "fault")], "pure", |_, a| {
        Ok(vec![Value::Fault(Rc::new(FaultValue { message: a[0].as_str().to_string(), code: a[1].i32() }))])
    }));
    put("std.fault.Message", NativeSpec::new(&[("fault", "fault")], &[("message", "string")], "pure", |_, a| {
        Ok(vec![match &a[0] {
            Value::Fault(x) => Value::str(&x.message),
            _ => Value::str(""),
        }])
    }));
    put("std.fault.Code", NativeSpec::new(&[("fault", "fault")], &[("code", "i32")], "pure", |_, a| {
        Ok(vec![Value::I32(match &a[0] {
            Value::Fault(x) => x.code,
            _ => 0,
        })])
    }));
    for kind in ["array", "set", "map"] {
        let mut spec = NativeSpec::new(&[("a", "anyref"), ("b", "anyref")], &[("r", "bool")], "pure", |_, a| {
            Ok(vec![Value::I32(values_equal(&a[0], &a[1]) as i32)])
        });
        spec.doc = format!("True when two {kind}s are equal.");
        // 1 fuel per 8 elements visited, like allocation; nothing when the lengths differ
        spec.cost = Some(Rc::new(|a: &[Value]| {
            if a[0].len() != a[1].len() { 0 } else { (value_size(&a[0]).min(value_size(&a[1])) >> 3) as i64 }
        }));
        put(&format!("std.{kind}.Equals"), spec);
    }
    let mut log = NativeSpec::new(&[("message", "string")], &[], "impure", |vm, a| {
        vm.output(a[0].as_str());
        Ok(vec![])
    });
    log.doc = "Write a line to the console.".into();
    log.capability = Some("console.write".into());
    put("host.Log", log);
    lane_natives(&mut t, LIBM_TRIG);
    t
}
