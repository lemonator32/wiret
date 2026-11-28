//! The bundled `std.math` implementations of deterministic mode (spec section 4.10).
//!
//! Functions that IEEE-754 does not require to be correctly rounded (`Sin`, `Cos`, `Tan`, `Exp`,
//! `Log`, `Pow`, `Atan2`, `Acos`) differ in their last bits between C libraries. In deterministic
//! mode the VM uses these instead. Each works in integer fixed-point arithmetic with 400
//! fractional bits (argument reduction for the trigonometric functions uses 1600), far more
//! than binary64 needs, and rounds the result to binary64 once, to nearest even. Being integer
//! arithmetic, it gives the same bits on every platform. The TypeScript port computed the same
//! functions with 60-digit decimal arithmetic; both round the true value correctly, so they
//! agree.
//!
//! Special values (NaN, infinities, signed zeros) follow C99 Annex F.
use std::sync::OnceLock;

use num_bigint::{BigInt, BigUint};
use num_traits::{One, Signed, ToPrimitive, Zero};

use crate::fmt::ldexp;

/// Fractional bits of the working values.
const W: u64 = 400;
/// Extra bits for constants, so that multiplying them by a small integer stays exact enough.
const G: u64 = 64;
/// Fractional bits for reducing a large argument modulo 2*pi.
const F: u64 = 1600;

const TINY: f64 = 8.673617379884035e-19; // 2^-60

fn one(scale: u64) -> BigInt {
    BigInt::one() << scale
}

/// a >> s, rounding toward zero.
fn shr(a: &BigInt, s: u64) -> BigInt {
    if a.is_negative() {
        -((-a) >> s)
    } else {
        a >> s
    }
}

fn mul(a: &BigInt, b: &BigInt) -> BigInt {
    shr(&(a * b), W)
}

fn div(a: &BigInt, b: &BigInt) -> BigInt {
    (a << W) / b
}

/// |x| = m * 2^e exactly.
fn parts(x: f64) -> (BigUint, i64) {
    let bits = x.abs().to_bits();
    let exp_bits = ((bits >> 52) & 0x7FF) as i64;
    let mant = bits & ((1u64 << 52) - 1);
    if exp_bits == 0 {
        (BigUint::from(mant), -1074)
    } else {
        (BigUint::from(mant | (1u64 << 52)), exp_bits - 1075)
    }
}

/// x as a fixed-point integer with `scale` fractional bits (truncated if x has more).
fn to_fixed(x: f64, scale: u64) -> BigInt {
    let (m, e) = parts(x);
    let s = e + scale as i64;
    let mag = BigInt::from(m);
    let v = if s >= 0 { mag << s as u64 } else { mag >> (-s) as u64 };
    if x < 0.0 { -v } else { v }
}

/// n * 2^-scale rounded to the nearest binary64, ties to even, with subnormals and overflow.
fn round_to_f64(neg: bool, n: &BigUint, scale: i64) -> f64 {
    let signed = |v: f64| if neg { -v } else { v };
    if n.is_zero() {
        return signed(0.0);
    }
    let bits = n.bits() as i64;
    let e = bits - 1 - scale;
    if e > 1023 {
        return signed(f64::INFINITY);
    }
    let ulp_e = (e - 52).max(-1074);
    let s = ulp_e + scale;
    let q = if s <= 0 {
        n << (-s) as u64
    } else {
        let s = s as u64;
        let mut q = n >> s;
        let r = n - (&q << s);
        let half = BigUint::one() << (s - 1);
        if r > half || (r == half && q.bit(0)) {
            q += 1u32;
        }
        q
    };
    signed(ldexp(q.to_u64().unwrap_or(u64::MAX) as f64, ulp_e as i32))
}

fn round_fixed(v: &BigInt, scale: u64) -> f64 {
    round_to_f64(v.is_negative(), v.magnitude(), scale as i64)
}

/// num / den * 2^exp2, correctly rounded.
fn round_rational(neg: bool, num: &BigUint, den: &BigUint, exp2: i64) -> f64 {
    let k = (den.bits() as i64 - num.bits() as i64 + 66).max(0) as u64;
    let shifted = num << k;
    let q = &shifted / den;
    let sticky = (&q * den) != shifted;
    let q2 = (q << 1u32) + if sticky { 1u32 } else { 0u32 };
    round_to_f64(neg, &q2, k as i64 + 1 - exp2)
}

// -- constants -------------------------------------------------------------------------------
/// atan(1/n) at `scale` fractional bits.
fn atan_inv(n: u64, scale: u64) -> BigInt {
    let mut p = one(scale) / n;
    let mut total = p.clone();
    let n2 = n * n;
    let mut i = 1u64;
    loop {
        p /= n2;
        if p.is_zero() {
            break;
        }
        let t = &p / (2 * i + 1);
        if i % 2 == 1 {
            total -= t;
        } else {
            total += t;
        }
        i += 1;
    }
    total
}

/// pi at `scale` fractional bits, by Machin's formula.
fn pi_at(scale: u64) -> BigInt {
    let s = scale + G;
    let p = atan_inv(5, s) * 16 - atan_inv(239, s) * 4;
    shr(&p, G)
}

fn pi_w() -> &'static BigInt {
    static P: OnceLock<BigInt> = OnceLock::new();
    P.get_or_init(|| pi_at(W))
}

fn pi_wg() -> &'static BigInt {
    static P: OnceLock<BigInt> = OnceLock::new();
    P.get_or_init(|| pi_at(W + G))
}

fn pi_f() -> &'static BigInt {
    static P: OnceLock<BigInt> = OnceLock::new();
    P.get_or_init(|| pi_at(F))
}

/// ln 2 at W + G fractional bits: 2 atanh(1/3).
fn ln2_wg() -> &'static BigInt {
    static L: OnceLock<BigInt> = OnceLock::new();
    L.get_or_init(|| {
        let s = W + G + 8;
        let mut p = one(s) / 3u32;
        let mut total = p.clone();
        let mut k = 1u64;
        loop {
            p /= 9u32;
            let t = &p / (2 * k + 1);
            if t.is_zero() {
                break;
            }
            total += t;
            k += 1;
        }
        shr(&(total * 2), 8)
    })
}

fn sqrt2_w() -> &'static BigInt {
    static S: OnceLock<BigInt> = OnceLock::new();
    S.get_or_init(|| BigInt::from((BigUint::from(2u32) << (2 * W)).sqrt()))
}

fn isqrt_fixed(a: &BigInt) -> BigInt {
    BigInt::from((a.magnitude() << W).sqrt())
}

/// q / d rounded to the nearest integer (ties cannot occur for the irrational divisors used).
fn round_div(q: &BigInt, d: &BigInt) -> BigInt {
    let k = q / d;
    let rem = q - &k * d;
    if rem.magnitude() * 2u32 > *d.magnitude() {
        if rem.is_negative() { k - 1 } else { k + 1 }
    } else {
        k
    }
}

// -- trigonometry ----------------------------------------------------------------------------
/// x modulo 2*pi, into [-pi, pi], at W fractional bits, exact enough for any finite x.
fn reduce(x: f64) -> BigInt {
    if x.abs() < 1048576.0 {
        let xv = to_fixed(x, W + G);
        let two_pi = pi_wg() * 2;
        let k = round_div(&xv, &two_pi);
        shr(&(xv - k * two_pi), G)
    } else {
        let xv = to_fixed(x, F);
        let two_pi = pi_f() * 2;
        let k = round_div(&xv, &two_pi);
        shr(&(xv - k * two_pi), F - W)
    }
}

fn sin_series(r: &BigInt) -> BigInt {
    let r2 = mul(r, r);
    let mut term = r.clone();
    let mut total = r.clone();
    let mut n = 1u64;
    loop {
        term = -(mul(&term, &r2) / ((n + 1) * (n + 2)));
        n += 2;
        if term.is_zero() {
            break;
        }
        total += &term;
    }
    total
}

fn cos_series(r: &BigInt) -> BigInt {
    let r2 = mul(r, r);
    let mut term = one(W);
    let mut total = term.clone();
    let mut n = 0u64;
    loop {
        term = -(mul(&term, &r2) / ((n + 1) * (n + 2)));
        n += 2;
        if term.is_zero() {
            break;
        }
        total += &term;
    }
    total
}

pub fn sin(x: f64) -> f64 {
    if !x.is_finite() {
        return f64::NAN;
    }
    if x == 0.0 || x.abs() < TINY {
        return x;
    }
    round_fixed(&sin_series(&reduce(x)), W)
}

pub fn cos(x: f64) -> f64 {
    if !x.is_finite() {
        return f64::NAN;
    }
    if x.abs() < TINY {
        return 1.0;
    }
    round_fixed(&cos_series(&reduce(x)), W)
}

pub fn tan(x: f64) -> f64 {
    if !x.is_finite() {
        return f64::NAN;
    }
    if x == 0.0 || x.abs() < TINY {
        return x;
    }
    let r = reduce(x);
    round_fixed(&div(&sin_series(&r), &cos_series(&r)), W)
}

// -- exp and log -----------------------------------------------------------------------------
/// e^(t * 2^-W), rounded to binary64.
fn exp_fixed(t: &BigInt) -> f64 {
    let ln2 = ln2_wg();
    let tg = t << G;
    let k = round_div(&tg, ln2);
    let kk = k.to_i64().unwrap_or(if k.is_negative() { i64::MIN } else { i64::MAX });
    if kk > 1100 {
        return f64::INFINITY;
    }
    if kk < -1200 {
        return 0.0;
    }
    let r = shr(&(tg - &k * ln2), G);
    let mut term = one(W);
    let mut total = term.clone();
    let mut n = 1u64;
    loop {
        term = mul(&term, &r) / n;
        n += 1;
        if term.is_zero() {
            break;
        }
        total += &term;
    }
    round_to_f64(false, total.magnitude(), W as i64 - kk)
}

pub fn exp(x: f64) -> f64 {
    if x.is_nan() {
        return f64::NAN;
    }
    if x == f64::INFINITY {
        return f64::INFINITY;
    }
    if x == f64::NEG_INFINITY {
        return 0.0;
    }
    if x > 710.0 {
        return f64::INFINITY;
    }
    if x < -746.0 {
        return 0.0;
    }
    if x.abs() < TINY {
        return 1.0;
    }
    exp_fixed(&to_fixed(x, W))
}

/// ln x for a finite x > 0, at W fractional bits.
fn ln_fixed(x: f64) -> BigInt {
    let (m, e) = parts(x);
    let n = m.bits() as i64;
    let mut k = e + n - 1;
    let mut t = BigInt::from(m) << (W as i64 - (n - 1)) as u64;
    if &t > sqrt2_w() {
        t >>= 1u32;
        k += 1;
    }
    let one_w = one(W);
    let z = div(&(&t - &one_w), &(&t + &one_w));
    let z2 = mul(&z, &z);
    let mut term = z.clone();
    let mut total = z;
    let mut i = 1u64;
    loop {
        term = mul(&term, &z2);
        let s = &term / (2 * i + 1);
        if s.is_zero() {
            break;
        }
        total += s;
        i += 1;
    }
    total * 2 + shr(&(ln2_wg() * k), G)
}

pub fn log(x: f64) -> f64 {
    if x.is_nan() || x < 0.0 {
        return f64::NAN;
    }
    if x == 0.0 {
        return f64::NEG_INFINITY;
    }
    if x == f64::INFINITY {
        return f64::INFINITY;
    }
    round_fixed(&ln_fixed(x), W)
}

fn is_int(y: f64) -> bool {
    y.is_finite() && y == y.floor()
}

fn is_odd_int(y: f64) -> bool {
    is_int(y) && y.abs() < 9007199254740992.0 && (y % 2.0).abs() == 1.0
}

/// x to the power y, with the special cases of C99 Annex F (F.10.4.4).
pub fn pow(x: f64, y: f64) -> f64 {
    let inf = f64::INFINITY;
    if y == 0.0 || x == 1.0 {
        return 1.0;
    }
    if x.is_nan() || y.is_nan() {
        return f64::NAN;
    }
    if x == 0.0 {
        if y < 0.0 {
            return if is_odd_int(y) { inf.copysign(x) } else { inf };
        }
        return if is_odd_int(y) { x } else { 0.0 };
    }
    if !y.is_finite() {
        if x == -1.0 {
            return 1.0;
        }
        return if (x.abs() < 1.0) == (y < 0.0) { inf } else { 0.0 };
    }
    if !x.is_finite() {
        if x > 0.0 {
            return if y > 0.0 { inf } else { 0.0 };
        }
        if y > 0.0 {
            return if is_odd_int(y) { -inf } else { inf };
        }
        return if is_odd_int(y) { -0.0 } else { 0.0 };
    }
    if x < 0.0 && !is_int(y) {
        return f64::NAN;
    }
    let negative = x < 0.0 && is_odd_int(y);
    let ax = x.abs();
    let mag = if ax != 1.0 { y * libm::log10(ax) } else { 0.0 };
    let r = if mag > 400.0 {
        inf
    } else if mag < -400.0 {
        0.0
    } else if is_int(y) && y.abs() <= 4096.0 {
        let (m, e) = parts(ax);
        let n = y.abs() as u32;
        let p = m.pow(n);
        if y > 0.0 {
            round_to_f64(false, &p, -(e * n as i64))
        } else {
            round_rational(false, &BigUint::one(), &p, -(e * n as i64))
        }
    } else {
        let l = ln_fixed(ax);
        let (my, ey) = parts(y);
        let prod = l * BigInt::from(my);
        let t = if ey >= 0 { prod << ey as u64 } else { shr(&prod, (-ey) as u64) };
        exp_fixed(&if y < 0.0 { -t } else { t })
    };
    if negative { -r } else { r }
}

// -- inverse trigonometry ---------------------------------------------------------------------
/// atan t for 0 <= t <= 1 (at W fractional bits): halve the argument, then the series.
fn atan_fixed(t: &BigInt) -> BigInt {
    let one_w = one(W);
    let tenth = &one_w / 10u32;
    let mut t = t.clone();
    let mut halvings = 0u32;
    while t > tenth {
        let d = &one_w + isqrt_fixed(&(&one_w + mul(&t, &t)));
        t = div(&t, &d);
        halvings += 1;
    }
    let t2 = mul(&t, &t);
    let mut term = t.clone();
    let mut total = t;
    let mut n = 1u64;
    loop {
        term = -mul(&term, &t2);
        n += 2;
        let s = &term / n;
        if s.is_zero() {
            break;
        }
        total += s;
    }
    total << halvings
}

/// atan(num / den) for num, den >= 0, not both zero.
fn atan_ratio(num: &BigInt, den: &BigInt) -> BigInt {
    if num <= den {
        atan_fixed(&((num << W) / den))
    } else {
        pi_w() / 2 - atan_fixed(&((den << W) / num))
    }
}

/// The angle of the point (x, y), with the special cases of C99 Annex F (F.10.1.4).
pub fn atan2(y: f64, x: f64) -> f64 {
    use std::f64::consts::PI as P;
    if x.is_nan() || y.is_nan() {
        return f64::NAN;
    }
    if y == 0.0 {
        if x > 0.0 || (x == 0.0 && x.is_sign_positive()) {
            return y;
        }
        return P.copysign(y);
    }
    if x == 0.0 {
        return (P / 2.0).copysign(y);
    }
    if !x.is_finite() {
        if !y.is_finite() {
            return (if x > 0.0 { P / 4.0 } else { 3.0 * P / 4.0 }).copysign(y);
        }
        return if x > 0.0 { 0.0f64.copysign(y) } else { P.copysign(y) };
    }
    if !y.is_finite() {
        return (P / 2.0).copysign(y);
    }
    let (my, ey) = parts(y);
    let (mx, ex) = parts(x);
    let emin = ey.min(ex);
    let yi = my << (ey - emin) as u64;
    let xi = mx << (ex - emin) as u64;
    if x > 0.0 && (&yi << 64u32) < xi {
        // atan t = t - t^3/3 + ...: below 2^-64 the correction cannot move t's rounding
        return round_rational(y < 0.0, &yi, &xi, 0);
    }
    let mut a = atan_ratio(&BigInt::from(yi), &BigInt::from(xi));
    if x < 0.0 {
        a = pi_w() - a;
    }
    if y < 0.0 {
        a = -a;
    }
    round_fixed(&a, W)
}

/// The angle in [0, pi] whose cosine is x; NaN outside [-1, 1] (C99 F.10.1.1).
pub fn acos(x: f64) -> f64 {
    use std::f64::consts::PI as P;
    if x.is_nan() || x.abs() > 1.0 {
        return f64::NAN;
    }
    if x == 1.0 {
        return 0.0;
    }
    if x == -1.0 {
        return P;
    }
    if x == 0.0 {
        return P / 2.0;
    }
    let d = to_fixed(x.abs(), W);
    let s2 = one(2 * W) - &d * &d;
    let s = BigInt::from(s2.magnitude().sqrt());
    let mut a = atan_ratio(&s, &d);
    if x < 0.0 {
        a = pi_w() - a;
    }
    round_fixed(&a, W)
}

/// The natives deterministic mode replaces, by qualified name.
pub fn bundled1(name: &str) -> Option<fn(f64) -> f64> {
    Some(match name {
        "std.math.Sin" => sin,
        "std.math.Cos" => cos,
        "std.math.Tan" => tan,
        "std.math.Exp" => exp,
        "std.math.Log" => log,
        "std.math.Acos" => acos,
        _ => return None,
    })
}

pub fn bundled2(name: &str) -> Option<fn(f64, f64) -> f64> {
    Some(match name {
        "std.math.Pow" => pow,
        "std.math.Atan2" => atan2,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_cases() {
        assert_eq!(sin(0.0), 0.0);
        assert_eq!(cos(0.0), 1.0);
        assert_eq!(exp(1.0), std::f64::consts::E);
        assert_eq!(log(std::f64::consts::E), 1.0);
        assert_eq!(log(2.0), std::f64::consts::LN_2);
        assert_eq!(pow(2.0, 10.0), 1024.0);
        assert_eq!(pow(2.0, -3.0), 0.125);
        assert_eq!(pow(2.0, 0.5), std::f64::consts::SQRT_2);
        assert_eq!(atan2(1.0, 1.0), std::f64::consts::FRAC_PI_4);
        assert_eq!(acos(0.5), 1.0471975511965979);
        assert_eq!(sin(std::f64::consts::PI), 1.2246467991473532e-16);
        assert_eq!(cos(1e22), 0.523214785395139);
        assert_eq!(sin(1e300), -0.8178819121159085);
        assert_eq!(exp(-745.0), 5e-324);
        assert_eq!(exp(709.9), f64::INFINITY);
        assert_eq!(tan(1.0), 1.5574077246549023);
    }
}
