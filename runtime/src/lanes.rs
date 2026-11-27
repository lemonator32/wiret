//! The lane types `vec2`, `vec3`, `quat` and `transform` (spec section 3.1.1), a port of
//! `src/core/lanes.ts`.
//!
//! A lane value is a struct of `f32` components (a transform is a struct of a vec3, a quat and a
//! vec3). Every operation is the `f32` operation of section 4.10: each `+ - * /` and `Sqrt` is
//! rounded once to binary32, and the formulas run in the order the specification writes them,
//! with no fused multiply-add.
use std::rc::Rc;

use crate::value::Value;
use crate::wbc::{Vt, F32, QUAT, TRANSFORM, VEC2, VEC3};

pub const LANE_TYPES: [&str; 4] = ["vec2", "vec3", "quat", "transform"];

/// The fields of a lane type: (name, Wiret type).
pub fn fields(ty: &str) -> &'static [(&'static str, &'static str)] {
    match ty {
        "vec2" => &[("x", "f32"), ("y", "f32")],
        "vec3" => &[("x", "f32"), ("y", "f32"), ("z", "f32")],
        "quat" => &[("x", "f32"), ("y", "f32"), ("z", "f32"), ("w", "f32")],
        "transform" => &[("translation", "vec3"), ("rotation", "quat"), ("scale", "vec3")],
        _ => &[],
    }
}

/// The value types of a lane type's fields, as the WBC constant layout gives them.
pub fn layout(vt: Vt) -> Option<&'static [Vt]> {
    match vt {
        VEC2 => Some(&[F32, F32]),
        VEC3 => Some(&[F32, F32, F32]),
        QUAT => Some(&[F32, F32, F32, F32]),
        TRANSFORM => Some(&[VEC3, QUAT, VEC3]),
        _ => None,
    }
}

pub struct Block {
    pub prefix: &'static str,
    pub base: u16,
    pub ty: &'static str,
    pub ops: &'static [(u16, &'static str)],
}

const fn vec_ops_v2() -> [(u16, &'static str); 21] {
    [
        (0, "make"), (1, "get"), (2, "with"), (3, "add"), (4, "sub"), (5, "mul"), (6, "div"), (7, "min"), (8, "max"),
        (9, "neg"), (10, "abs"), (11, "scale"), (12, "eq"), (13, "ne"), (14, "dot"), (15, "len"), (16, "lensq"),
        (17, "normalize"), (18, "lerp"), (19, "reflect"), (20, "perpdot"),
    ]
}

const fn vec_ops_v3() -> [(u16, &'static str); 23] {
    [
        (0, "make"), (1, "get"), (2, "with"), (3, "add"), (4, "sub"), (5, "mul"), (6, "div"), (7, "min"), (8, "max"),
        (9, "neg"), (10, "abs"), (11, "scale"), (12, "eq"), (13, "ne"), (14, "dot"), (15, "len"), (16, "lensq"),
        (17, "normalize"), (18, "lerp"), (19, "reflect"), (20, "cross"), (21, "from_v2"), (22, "to_v2"),
    ]
}

static V2_OPS: [(u16, &str); 21] = vec_ops_v2();
static V3_OPS: [(u16, &str); 23] = vec_ops_v3();
static Q_OPS: [(u16, &str); 11] = [
    (0, "make"), (1, "get"), (2, "with"), (3, "mul"), (4, "conj"), (5, "inverse"), (6, "normalize"), (7, "dot"),
    (8, "eq"), (9, "ne"), (10, "rotate"),
];
static T_OPS: [(u16, &str); 9] = [
    (0, "make"), (1, "get"), (2, "with"), (3, "mul"), (4, "inverse"), (5, "apply"), (6, "apply_vector"), (7, "eq"),
    (8, "ne"),
];

/// block prefix, base sub-opcode, Wiret type and operations (section 5.6).
pub static BLOCKS: [Block; 4] = [
    Block { prefix: "v2", base: 0x00, ty: "vec2", ops: &V2_OPS },
    Block { prefix: "v3", base: 0x20, ty: "vec3", ops: &V3_OPS },
    Block { prefix: "q", base: 0x40, ty: "quat", ops: &Q_OPS },
    Block { prefix: "t", base: 0x60, ty: "transform", ops: &T_OPS },
];

fn partition(name: &str) -> (&str, &str) {
    name.split_once('.').unwrap_or((name, ""))
}

pub fn block_type(prefix: &str) -> Option<&'static str> {
    BLOCKS.iter().find(|b| b.prefix == prefix).map(|b| b.ty)
}

/// (operand Wiret types, result Wiret type) of a lane instruction.
pub fn effect(name: &str, field: usize) -> (Vec<&'static str>, &'static str) {
    let (p, op) = partition(name);
    let ty = block_type(p).unwrap_or("vec2");
    let fs: Vec<&'static str> = fields(ty).iter().map(|(_, t)| *t).collect();
    match op {
        "make" => (fs, ty),
        "get" => (vec![ty], fs.get(field).copied().unwrap_or("f32")),
        "with" => (vec![ty, fs.get(field).copied().unwrap_or("f32")], ty),
        "neg" | "abs" | "normalize" | "conj" | "inverse" => (vec![ty], ty),
        "scale" => (vec![ty, "f32"], ty),
        "eq" | "ne" => (vec![ty, ty], "bool"),
        "dot" | "perpdot" => (vec![ty, ty], "f32"),
        "len" | "lensq" => (vec![ty], "f32"),
        "lerp" => (vec![ty, ty, "f32"], ty),
        "from_v2" => (vec!["vec2"], "vec3"),
        "to_v2" => (vec!["vec3"], "vec2"),
        "rotate" => (vec!["quat", "vec3"], "vec3"),
        "apply" | "apply_vector" => (vec!["transform", "vec3"], "vec3"),
        _ => (vec![ty, ty], ty),
    }
}

// -- component arithmetic ------------------------------------------------------------------
type L = Vec<f32>;

pub fn comps(v: &Value) -> L {
    match v {
        Value::Struct(items) => items.iter().map(|x| x.as_f64() as f32).collect(),
        _ => vec![],
    }
}

pub fn mk(v: L) -> Value {
    Value::Struct(v.into_iter().map(Value::F32).collect::<Vec<_>>().into())
}

fn part(v: &Value, i: usize) -> Value {
    match v {
        Value::Struct(items) => items.get(i).cloned().unwrap_or(Value::Null),
        _ => Value::Null,
    }
}

fn mk_t(t: Value, r: Value, s: Value) -> Value {
    Value::Struct(Rc::from(vec![t, r, s]))
}

fn sqrt(x: f32) -> f32 {
    if x < 0.0 || x.is_nan() {
        f32::NAN
    } else {
        x.sqrt()
    }
}

pub fn min(a: f32, b: f32) -> f32 {
    if a.is_nan() || b.is_nan() {
        return f32::NAN;
    }
    if a == 0.0 && b == 0.0 {
        return if a.is_sign_negative() { a } else { b };
    }
    if a < b { a } else { b }
}

pub fn max(a: f32, b: f32) -> f32 {
    if a.is_nan() || b.is_nan() {
        return f32::NAN;
    }
    if a == 0.0 && b == 0.0 {
        return if a.is_sign_negative() { b } else { a };
    }
    if a > b { a } else { b }
}

fn zip(a: &[f32], b: &[f32], f: impl Fn(f32, f32) -> f32) -> L {
    a.iter().zip(b.iter()).map(|(&x, &y)| f(x, y)).collect()
}

pub fn add(a: &[f32], b: &[f32]) -> L {
    zip(a, b, |x, y| x + y)
}
pub fn sub(a: &[f32], b: &[f32]) -> L {
    zip(a, b, |x, y| x - y)
}
pub fn mul(a: &[f32], b: &[f32]) -> L {
    zip(a, b, |x, y| x * y)
}
pub fn div(a: &[f32], b: &[f32]) -> L {
    zip(a, b, |x, y| x / y)
}
pub fn neg(a: &[f32]) -> L {
    a.iter().map(|x| -x).collect()
}
pub fn abs(a: &[f32]) -> L {
    a.iter().map(|x| x.abs()).collect()
}
pub fn scale(v: &[f32], s: f32) -> L {
    v.iter().map(|x| x * s).collect()
}

/// Component-wise, in field order, with the f32 rules: NaN is never equal.
pub fn eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Struct(x), Value::Struct(y)) => {
            if matches!(x.first(), Some(Value::Struct(_))) {
                return x.iter().zip(y.iter()).all(|(p, q)| eq(p, q)) && x.len() <= y.len();
            }
            x.iter().zip(y.iter()).all(|(p, q)| p.as_f64() == q.as_f64())
        }
        _ => false,
    }
}

/// `(a.x*b.x + a.y*b.y) + a.z*b.z`, left to right.
pub fn dot(a: &[f32], b: &[f32]) -> f32 {
    let n = a.len().min(b.len());
    if n == 0 {
        return f32::NAN;
    }
    let mut total = a[0] * b[0];
    for i in 1..n {
        total += a[i] * b[i];
    }
    total
}

pub fn cross(a: &[f32], b: &[f32]) -> L {
    vec![a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

pub fn perpdot(a: &[f32], b: &[f32]) -> f32 {
    a[0] * b[1] - a[1] * b[0]
}
pub fn lensq(v: &[f32]) -> f32 {
    dot(v, v)
}
pub fn length(v: &[f32]) -> f32 {
    sqrt(dot(v, v))
}
pub fn distance(a: &[f32], b: &[f32]) -> f32 {
    length(&sub(a, b))
}

/// Each component divided by the length when it is > 0; otherwise (zero or NaN) zero.
pub fn normalize(v: &[f32]) -> L {
    let n = length(v);
    if n > 0.0 {
        v.iter().map(|x| x / n).collect()
    } else {
        vec![0.0; v.len()]
    }
}

pub fn lerp(a: &[f32], b: &[f32], t: f32) -> L {
    zip(a, b, |x, y| x + (y - x) * t)
}
pub fn reflect(v: &[f32], n: &[f32]) -> L {
    sub(v, &scale(n, 2.0 * dot(v, n)))
}

// -- quaternions -----------------------------------------------------------------------------
pub const IDENTITY: [f32; 4] = [0.0, 0.0, 0.0, 1.0];

/// The Hamilton product: the rotation b, then a.
pub fn qmul(a: &[f32], b: &[f32]) -> L {
    let (ax, ay, az, aw) = (a[0], a[1], a[2], a[3]);
    let (bx, by, bz, bw) = (b[0], b[1], b[2], b[3]);
    vec![
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    ]
}

pub fn conj(q: &[f32]) -> L {
    vec![-q[0], -q[1], -q[2], q[3]]
}

pub fn qinverse(q: &[f32]) -> L {
    let d = dot(q, q);
    if d > 0.0 {
        conj(q).iter().map(|x| x / d).collect()
    } else {
        IDENTITY.to_vec()
    }
}

pub fn qnormalize(q: &[f32]) -> L {
    let n = length(q);
    if n > 0.0 {
        q.iter().map(|x| x / n).collect()
    } else {
        IDENTITY.to_vec()
    }
}

/// `t = Scale(Cross(u, v), 2)`, then `(v + Scale(t, q.w)) + Cross(u, t)`.
pub fn rotate(q: &[f32], v: &[f32]) -> L {
    let u = &q[..3];
    let t = scale(&cross(u, v), 2.0);
    add(&add(v, &scale(&t, q[3])), &cross(u, &t))
}

/// The math functions std.quat builds on, so deterministic mode can give the bundled ones.
#[derive(Clone, Copy)]
pub struct Trig {
    pub sin: fn(f64) -> f64,
    pub cos: fn(f64) -> f64,
    pub acos: fn(f64) -> f64,
}

impl Trig {
    fn s(&self, x: f32) -> f32 {
        (self.sin)(x as f64) as f32
    }
    fn c(&self, x: f32) -> f32 {
        (self.cos)(x as f64) as f32
    }

    pub fn from_axis_angle(&self, axis: &[f32], angle: f32) -> L {
        let n = normalize(axis);
        if n[0] == 0.0 && n[1] == 0.0 && n[2] == 0.0 {
            return IDENTITY.to_vec();
        }
        let h = angle * 0.5;
        let sh = self.s(h);
        vec![n[0] * sh, n[1] * sh, n[2] * sh, self.c(h)]
    }

    pub fn slerp(&self, a: &[f32], b: &[f32], t: f32) -> L {
        let mut b = b.to_vec();
        let mut d = dot(a, &b);
        if d < 0.0 {
            b = neg(&b);
            d = -d;
        }
        if d > 0.9995f32 {
            return qnormalize(&lerp(a, &b, t));
        }
        let th = (self.acos)(d as f64) as f32;
        let st = self.s(th);
        let wa = self.s((1.0 - t) * th) / st;
        let wb = self.s(t * th) / st;
        add(&scale(a, wa), &scale(&b, wb))
    }

    pub fn angle(&self, a: &[f32], b: &[f32]) -> f32 {
        let d = dot(a, b).abs();
        2.0 * ((self.acos)(min(d, 1.0) as f64) as f32)
    }
}

// -- transforms ------------------------------------------------------------------------------
pub fn apply(t: &Value, p: &[f32]) -> L {
    add(&comps(&part(t, 0)), &rotate(&comps(&part(t, 1)), &mul(&comps(&part(t, 2)), p)))
}
pub fn apply_vector(t: &Value, v: &[f32]) -> L {
    rotate(&comps(&part(t, 1)), &mul(&comps(&part(t, 2)), v))
}

/// Composition: b, then a.
pub fn tmul(a: &Value, b: &Value) -> Value {
    mk_t(
        mk(apply(a, &comps(&part(b, 0)))),
        mk(qmul(&comps(&part(a, 1)), &comps(&part(b, 1)))),
        mk(mul(&comps(&part(a, 2)), &comps(&part(b, 2)))),
    )
}

pub fn tinverse(t: &Value) -> Value {
    let r = conj(&comps(&part(t, 1)));
    let s: L = comps(&part(t, 2)).iter().map(|&x| if x == 0.0 { 0.0 } else { 1.0 / x }).collect();
    let tr = mul(&s, &rotate(&r, &neg(&comps(&part(t, 0)))));
    mk_t(mk(tr), mk(r), mk(s))
}

// -- text ------------------------------------------------------------------------------------
/// The literal form (section 3.2): `(0, 1.5, 0)`, nested for a transform.
pub fn to_text(v: &Value, single: &dyn Fn(f64) -> String) -> String {
    match v {
        Value::Struct(items) => {
            let inner: Vec<String> = items
                .iter()
                .map(|x| if matches!(x, Value::Struct(_)) { to_text(x, single) } else { single(x.as_f64()) })
                .collect();
            format!("({})", inner.join(", "))
        }
        _ => String::from("()"),
    }
}

/// A host value as the VM holds a lane value.
pub fn normalise(ty: &str, v: &Value) -> Value {
    if ty == "transform" {
        return mk_t(normalise("vec3", &part(v, 0)), normalise("quat", &part(v, 1)), normalise("vec3", &part(v, 2)));
    }
    match v {
        Value::Struct(items) => mk(items.iter().map(|x| x.as_f64() as f32).collect()),
        Value::Array(a) => mk(a.borrow().items.iter().map(|x| x.as_f64() as f32).collect()),
        _ => mk(vec![]),
    }
}

pub fn default_value(ty: &str) -> Value {
    match ty {
        "vec2" => mk(vec![0.0, 0.0]),
        "vec3" => mk(vec![0.0, 0.0, 0.0]),
        "quat" => mk(IDENTITY.to_vec()),
        _ => mk_t(mk(vec![0.0, 0.0, 0.0]), mk(IDENTITY.to_vec()), mk(vec![1.0, 1.0, 1.0])),
    }
}

// -- lane instructions (section 5.6) ---------------------------------------------------------
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Make, Get, With, Eq, Ne, Add, Sub, Mul, Div, Min, Max, Neg, Abs, Scale, Dot, Len, LenSq, Normalize, Lerp,
    Reflect, PerpDot, Cross, FromV2, ToV2, Conj, Rotate, Apply, ApplyVector, QMul, TMul, QNormalize,
    QInverse, TInverse,
}

/// One decoded lane instruction: what it computes and how many operands it takes.
#[derive(Clone, Copy, Debug)]
pub struct LaneOp {
    pub kind: Kind,
    pub field: usize,
    pub arity: usize,
}

impl LaneOp {
    pub fn new(name: &str, field: usize) -> LaneOp {
        let (p, op) = partition(name);
        let ty = block_type(p).unwrap_or("vec2");
        let kind = match op {
            "make" => Kind::Make,
            "get" => Kind::Get,
            "with" => Kind::With,
            "eq" => Kind::Eq,
            "ne" => Kind::Ne,
            "mul" if ty == "quat" => Kind::QMul,
            "mul" if ty == "transform" => Kind::TMul,
            "normalize" if ty == "quat" => Kind::QNormalize,
            "inverse" if ty == "quat" => Kind::QInverse,
            "inverse" => Kind::TInverse,
            "add" => Kind::Add,
            "sub" => Kind::Sub,
            "mul" => Kind::Mul,
            "div" => Kind::Div,
            "min" => Kind::Min,
            "max" => Kind::Max,
            "neg" => Kind::Neg,
            "abs" => Kind::Abs,
            "scale" => Kind::Scale,
            "dot" => Kind::Dot,
            "len" => Kind::Len,
            "lensq" => Kind::LenSq,
            "normalize" => Kind::Normalize,
            "lerp" => Kind::Lerp,
            "reflect" => Kind::Reflect,
            "perpdot" => Kind::PerpDot,
            "cross" => Kind::Cross,
            "from_v2" => Kind::FromV2,
            "to_v2" => Kind::ToV2,
            "conj" => Kind::Conj,
            "rotate" => Kind::Rotate,
            "apply" => Kind::Apply,
            _ => Kind::ApplyVector,
        };
        LaneOp { kind, field, arity: effect(name, field).0.len() }
    }

    /// The instruction's result, from its operands in order.
    pub fn exec(&self, xs: &[Value]) -> Value {
        let c = |i: usize| comps(&xs[i]);
        let f = |i: usize| xs[i].as_f64() as f32;
        let b = |x: bool| Value::I32(x as i32);
        match self.kind {
            Kind::Make => Value::Struct(xs.iter().cloned().collect::<Vec<_>>().into()),
            Kind::Get => part(&xs[0], self.field),
            Kind::With => match &xs[0] {
                Value::Struct(items) => {
                    let mut v = items.to_vec();
                    if self.field < v.len() {
                        v[self.field] = xs[1].clone();
                    }
                    Value::Struct(v.into())
                }
                other => other.clone(),
            },
            Kind::Eq => b(eq(&xs[0], &xs[1])),
            Kind::Ne => b(!eq(&xs[0], &xs[1])),
            Kind::Add => mk(add(&c(0), &c(1))),
            Kind::Sub => mk(sub(&c(0), &c(1))),
            Kind::Mul => mk(mul(&c(0), &c(1))),
            Kind::Div => mk(div(&c(0), &c(1))),
            Kind::Min => mk(zip(&c(0), &c(1), min)),
            Kind::Max => mk(zip(&c(0), &c(1), max)),
            Kind::Neg => mk(neg(&c(0))),
            Kind::Abs => mk(abs(&c(0))),
            Kind::Scale => mk(scale(&c(0), f(1))),
            Kind::Dot => Value::F32(dot(&c(0), &c(1))),
            Kind::Len => Value::F32(length(&c(0))),
            Kind::LenSq => Value::F32(lensq(&c(0))),
            Kind::Normalize => mk(normalize(&c(0))),
            Kind::Lerp => mk(lerp(&c(0), &c(1), f(2))),
            Kind::Reflect => mk(reflect(&c(0), &c(1))),
            Kind::PerpDot => Value::F32(perpdot(&c(0), &c(1))),
            Kind::Cross => mk(cross(&c(0), &c(1))),
            Kind::FromV2 => {
                let v = c(0);
                mk(vec![v[0], v[1], 0.0])
            }
            Kind::ToV2 => {
                let v = c(0);
                mk(vec![v[0], v[1]])
            }
            Kind::Conj => mk(conj(&c(0))),
            Kind::Rotate => mk(rotate(&c(0), &c(1))),
            Kind::Apply => mk(apply(&xs[0], &c(1))),
            Kind::ApplyVector => mk(apply_vector(&xs[0], &c(1))),
            Kind::QMul => mk(qmul(&c(0), &c(1))),
            Kind::TMul => tmul(&xs[0], &xs[1]),
            Kind::QNormalize => mk(qnormalize(&c(0))),
            Kind::QInverse => mk(qinverse(&c(0))),
            Kind::TInverse => tinverse(&xs[0]),
        }
    }
}
