//! Float text: culture-independent, shortest round-tripping (spec section 3.2), and the hex
//! form the input log uses. The forms match the TypeScript port's (`pyutil.ts`), which match
//! the Python prototype's.
use num_bigint::BigUint;

/// The exact decimal value of a finite |x|: digits (no leading zeros, "0" for zero) and the
/// power of ten of the last digit.
fn exact_decimal(x: f64) -> (String, i32) {
    let x = x.abs();
    if x == 0.0 {
        return ("0".into(), 0);
    }
    let bits = x.to_bits();
    let exp_bits = ((bits >> 52) & 0x7FF) as i32;
    let mut mant = bits & ((1u64 << 52) - 1);
    let e = if exp_bits == 0 {
        -1074
    } else {
        mant |= 1u64 << 52;
        exp_bits - 1075
    };
    if e >= 0 {
        return ((BigUint::from(mant) << e as usize).to_string(), 0);
    }
    ((BigUint::from(mant) * BigUint::from(5u32).pow((-e) as u32)).to_string(), e)
}

/// Round |x| to `sig` significant digits, ties to even: the digits and the decimal exponent of
/// the first digit.
fn round_sig(x: f64, sig: usize) -> (String, i32) {
    let (d, e) = exact_decimal(x);
    if d == "0" {
        return ("0".repeat(sig), 0);
    }
    let mut point = d.len() as i32 + e - 1;
    if d.len() <= sig {
        return (format!("{d}{}", "0".repeat(sig - d.len())), point);
    }
    let mut head: BigUint = d[..sig].parse().unwrap();
    let rest = &d.as_bytes()[sig..];
    let first = rest[0] - b'0';
    let tail = rest[1..].iter().any(|&c| c != b'0');
    if first > 5 || (first == 5 && (tail || head.bit(0))) {
        head += 1u32;
    }
    let mut s = head.to_string();
    if s.len() > sig {
        s.truncate(sig);
        point += 1;
    }
    (s, point)
}

/// The shortest digits that read back as x, and the exponent of the first digit.
fn shortest(x: f64) -> (String, i32) {
    let s = format!("{:e}", x.abs());
    let (m, ex) = s.split_once('e').unwrap();
    (m.replace('.', ""), ex.parse().unwrap())
}

fn exp_text(e: i32) -> String {
    format!("{}{:02}", if e < 0 { '-' } else { '+' }, e.abs())
}

fn sign(x: f64) -> &'static str {
    if x.is_sign_negative() { "-" } else { "" }
}

fn fixed(digits: &str, point: i32, dot_zero: bool) -> String {
    if point < 0 {
        format!("0.{}{digits}", "0".repeat((-point - 1) as usize))
    } else if digits.len() as i32 <= point + 1 {
        let mut s = format!("{digits}{}", "0".repeat((point + 1) as usize - digits.len()));
        if dot_zero {
            s.push_str(".0");
        }
        s
    } else {
        let p = (point + 1) as usize;
        format!("{}.{}", &digits[..p], &digits[p..])
    }
}

/// Python's repr(x) for a float.
pub fn float_repr(x: f64) -> String {
    if x.is_nan() {
        return "nan".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "inf".into() } else { "-inf".into() };
    }
    if x == 0.0 {
        return format!("{}0.0", sign(x));
    }
    let (digits, point) = shortest(x);
    if !(-4..16).contains(&point) {
        let mant = if digits.len() > 1 { format!("{}.{}", &digits[..1], &digits[1..]) } else { digits };
        return format!("{}{mant}e{}", sign(x), exp_text(point));
    }
    format!("{}{}", sign(x), fixed(&digits, point, true))
}

/// Python's format(x, f".{p}g").
pub fn format_g(x: f64, p: usize) -> String {
    if x.is_nan() {
        return "nan".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "inf".into() } else { "-inf".into() };
    }
    let p = p.max(1);
    if x == 0.0 {
        return format!("{}0", sign(x));
    }
    let (digits, point) = round_sig(x, p);
    let digits = digits.trim_end_matches('0');
    let digits = if digits.is_empty() { "0" } else { digits };
    if point < -4 || point >= p as i32 {
        let mant = if digits.len() > 1 { format!("{}.{}", &digits[..1], &digits[1..]) } else { digits.to_string() };
        return format!("{}{mant}e{}", sign(x), exp_text(point));
    }
    format!("{}{}", sign(x), fixed(digits, point, false))
}

/// Culture-independent, shortest round-tripping text (section 3.2). `single` gives the
/// shortest text that reads back as the same `f32`.
pub fn float_to_text(x: f64, single: bool) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    let mut s = String::new();
    if single {
        for p in 1..10 {
            s = format_g(x, p);
            if s.parse::<f64>().map(|v| v as f32 as f64 == x).unwrap_or(false) {
                break;
            }
        }
    } else {
        s = float_repr(x);
    }
    if let Some((mant, exp)) = s.split_once('e') {
        let e: i32 = exp.parse().unwrap_or(0);
        s = format!("{mant}e{e}");
    } else if !s.contains('.') && !s.contains("inf") {
        s.push_str(".0");
    }
    s
}

/// Python's float.hex().
pub fn float_hex(x: f64) -> String {
    if x.is_nan() {
        return "nan".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "inf".into() } else { "-inf".into() };
    }
    if x == 0.0 {
        return format!("{}0x0.0p+0", sign(x));
    }
    let bits = x.abs().to_bits();
    let exp_bits = ((bits >> 52) & 0x7FF) as i32;
    let mant = bits & ((1u64 << 52) - 1);
    let lead = if exp_bits == 0 { '0' } else { '1' };
    let e = if exp_bits == 0 { -1022 } else { exp_bits - 1023 };
    format!("{}0x{lead}.{mant:013x}p{}{e}", sign(x), if e >= 0 { "+" } else { "" })
}

/// x * 2^k, exact when the result is representable.
pub fn ldexp(mut x: f64, mut k: i32) -> f64 {
    let step = |k: i32| f64::from_bits(((k + 1023) as u64) << 52);
    while k > 1000 {
        x *= step(1000);
        k -= 1000;
    }
    while k < -1000 {
        x *= step(-1000);
        k += 1000;
    }
    x * step(k)
}

/// Python's float.fromhex() for what `float_hex` writes.
pub fn float_from_hex(s: &str) -> Option<f64> {
    match s {
        "nan" => return Some(f64::NAN),
        "inf" => return Some(f64::INFINITY),
        "-inf" => return Some(f64::NEG_INFINITY),
        _ => {}
    }
    let (neg, rest) = match s.strip_prefix('-') {
        Some(r) => (true, r),
        None => (false, s),
    };
    let rest = rest.strip_prefix("0x")?;
    let (lead, rest) = rest.split_at(1);
    if lead != "0" && lead != "1" {
        return None;
    }
    let rest = rest.strip_prefix('.')?;
    let (hex, exp) = rest.split_once('p')?;
    if hex.is_empty() || !hex.bytes().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()) {
        return None;
    }
    let exp: i32 = exp.strip_prefix('+').unwrap_or(exp).parse().ok()?;
    let digits = BigUint::parse_bytes(hex.as_bytes(), 16)?;
    let mant = digits + if lead == "1" { BigUint::from(1u32) << (hex.len() * 4) } else { BigUint::from(0u32) };
    let m: f64 = mant.to_string().parse().ok()?;
    let v = ldexp(m, exp - hex.len() as i32 * 4);
    Some(if neg { -v } else { v })
}

/// Python's repr() of a string.
pub fn py_repr_str(s: &str) -> String {
    let q = if s.contains('\'') && !s.contains('"') { '"' } else { '\'' };
    let mut out = String::new();
    out.push(q);
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c == q => {
                out.push('\\');
                out.push(c);
            }
            c if (c as u32) < 0x20 || c as u32 == 0x7F => out.push_str(&format!("\\x{:02x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push(q);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repr_and_text() {
        assert_eq!(float_repr(0.1), "0.1");
        assert_eq!(float_repr(1e16), "1e+16");
        assert_eq!(float_repr(1e-5), "1e-05");
        assert_eq!(float_repr(123.0), "123.0");
        assert_eq!(float_to_text(1e16, false), "1e16");
        assert_eq!(float_to_text(2.0, false), "2.0");
        assert_eq!(float_to_text(0.1f32 as f64, true), "0.1");
        assert_eq!(float_to_text(1.5e-7f32 as f64, true), "1.5e-7");
        assert_eq!(format_g(0.125, 2), "0.12");
        assert_eq!(format_g(1234567.0, 3), "1.23e+06");
    }

    #[test]
    fn hex_round_trip() {
        for x in [0.1, -2.5, 1e-310, 5e-324, f64::MAX, 3.0] {
            assert_eq!(float_from_hex(&float_hex(x)), Some(x), "{x}");
        }
        assert_eq!(float_hex(1.0), "0x1.0000000000000p+0");
    }
}
