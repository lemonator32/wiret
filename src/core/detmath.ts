/** The bundled `std.math` implementations of deterministic mode (spec section 4.10).
 *
 * Functions that IEEE-754 does not require to be correctly rounded (`Sin`, `Cos`, `Tan`,
 * `Exp`, `Log`, `Pow`, `Atan2`) differ in their last bits between C libraries. In
 * deterministic mode the VM uses these instead of the platform's Math. Each one works in
 * decimal.js, whose arithmetic is implemented in software, so it gives the same digits on
 * every platform. The result is computed to WORK significant digits and then converted to
 * binary64 once, with round to nearest even.
 *
 * Special values (NaN, infinities, signed zeros) follow C99 Annex F, and every NaN result is
 * the canonical quiet NaN. */
import DecimalBase from "decimal.js";
import { copysign, exactDecimalString } from "./pyutil.js";

export const WORK = 60;
const NAN = NaN;
const INF = Infinity;

type D = InstanceType<typeof DecimalBase>;
const ctxCache = new Map<number, typeof DecimalBase>();
/** A Decimal constructor whose arithmetic rounds to `prec` digits, half-even, as Python's
 * decimal context does by default. */
function ctx(prec: number): typeof DecimalBase {
  let C = ctxCache.get(prec);
  if (!C) {
    C = DecimalBase.clone({ precision: prec, rounding: DecimalBase.ROUND_HALF_EVEN, modulo: DecimalBase.ROUND_HALF_EVEN,
                            toExpNeg: -9e15, toExpPos: 9e15, minE: -9e15, maxE: 9e15 });
    ctxCache.set(prec, C);
  }
  return C;
}

/** An exact Decimal of a double. */
function dec(C: typeof DecimalBase, x: number): D {
  return new C(exactDecimalString(x));
}

/** Round a Decimal to the nearest binary64 (JS's Number(string) is correctly rounded). */
function toFloat(d: D): number {
  return Number(d.toString());
}

const PI_CACHE = new Map<number, D>();

/** pi to `digits` significant digits, by Machin's formula, cached. */
function pi(digits: number): D {
  if (!PI_CACHE.has(digits)) {
    const C = ctx(digits + 10);
    const arctanInv = (n: number): D => {
      const x = new C(1).div(n);
      const x2 = x.mul(x);
      let total = x, term = x, k = 1;
      const eps = new C(10).pow(-(digits + 8));
      while (term.abs().gt(eps)) {
        term = term.mul(x2.neg());
        k += 2;
        total = total.add(term.div(k));
      }
      return total;
    };
    const p = new C(16).mul(arctanInv(5)).sub(new C(4).mul(arctanInv(239)));
    PI_CACHE.set(digits, new (ctx(digits))(p).toSignificantDigits(digits, DecimalBase.ROUND_HALF_EVEN));
  }
  return PI_CACHE.get(digits)!;
}

const REDUCE_DIGITS = 309 + WORK + 20;

/** x modulo 2*pi, into [-pi, pi], exactly enough for any finite binary64 x. */
function reduce(x: number): D {
  const C = ctx(REDUCE_DIGITS);
  const twoPi = new C(2).mul(pi(REDUCE_DIGITS));
  const r = dec(C, x).mod(twoPi);          // modulo mode ROUND_HALF_EVEN: remainder_near
  return r.toSignificantDigits(WORK + 10, DecimalBase.ROUND_HALF_EVEN);
}

function sinSeries(C: typeof DecimalBase, r: D): D {
  r = new C(r);
  const r2 = r.mul(r);
  let term = r, total = r, n = 1;
  const eps = new C(10).pow(-(WORK + 15));
  while (term.abs().gt(eps)) {
    term = term.mul(r2.neg().div((n + 1) * (n + 2)));
    n += 2;
    total = total.add(term);
  }
  return total;
}

function cosSeries(C: typeof DecimalBase, r: D): D {
  r = new C(r);
  const r2 = r.mul(r);
  let term = new C(1), total = new C(1), n = 0;
  const eps = new C(10).pow(-(WORK + 15));
  while (term.abs().gt(eps)) {
    term = term.mul(r2.neg().div((n + 1) * (n + 2)));
    n += 2;
    total = total.add(term);
  }
  return total;
}

export function sin(x: number): number {
  if (!Number.isFinite(x)) return NAN;
  if (x === 0) return x;
  const r = reduce(x);
  return toFloat(sinSeries(ctx(WORK + 10), r));
}

export function cos(x: number): number {
  if (!Number.isFinite(x)) return NAN;
  const r = reduce(x);
  return toFloat(cosSeries(ctx(WORK + 10), r));
}

export function tan(x: number): number {
  if (!Number.isFinite(x)) return NAN;
  if (x === 0) return x;
  const r = reduce(x);
  const C = ctx(WORK + 10);
  return toFloat(sinSeries(C, r).div(cosSeries(C, r)));
}

export function exp(x: number): number {
  if (Number.isNaN(x)) return NAN;
  if (x === INF) return INF;
  if (x === -INF) return 0.0;
  if (x > 710) return INF;
  if (x < -746) return 0.0;
  return toFloat(dec(ctx(WORK), x).exp());
}

export function log(x: number): number {
  if (Number.isNaN(x) || x < 0) return NAN;
  if (x === 0) return -INF;
  if (x === INF) return INF;
  return toFloat(dec(ctx(WORK), x).ln());
}

const isInt = (y: number) => Number.isFinite(y) && y === Math.floor(y);
const isOddInt = (y: number) => isInt(y) && Math.abs(y) < 2 ** 53 && Math.abs(y % 2) === 1;

/** x to the power y, with the special cases of C99 Annex F (F.10.4.4). */
export function pow(x: number, y: number): number {
  if (y === 0) return 1.0;
  if (x === 1) return 1.0;
  if (Number.isNaN(x) || Number.isNaN(y)) return NAN;
  if (x === 0) {
    if (y < 0) return isOddInt(y) ? copysign(INF, x) : INF;
    return isOddInt(y) ? x : 0.0;
  }
  if (!Number.isFinite(y)) {
    if (x === -1) return 1.0;
    if ((Math.abs(x) < 1) === (y < 0)) return INF;
    return 0.0;
  }
  if (!Number.isFinite(x)) {
    if (x > 0) return y > 0 ? INF : 0.0;
    if (y > 0) return isOddInt(y) ? -INF : INF;
    return isOddInt(y) ? -0.0 : 0.0;
  }
  if (x < 0 && !isInt(y)) return NAN;
  const negative = x < 0 && isOddInt(y);
  const C = ctx(WORK);
  const ax = dec(C, Math.abs(x));
  const mag = Math.abs(x) !== 1 ? y * Math.log10(Math.abs(x)) : 0.0;
  let r: number;
  if (mag > 400) r = INF;
  else if (mag < -400) r = 0.0;
  else if (isInt(y) && Math.abs(y) <= 4096) r = toFloat(ax.pow(y));
  else r = toFloat(dec(C, y).mul(ax.ln()).exp());
  return negative ? -r : r;
}

/** atan t for t >= 0, in the caller's precision: reduce to small t, then the series. */
function atanD(C: typeof DecimalBase, t: D): D {
  if (t.gt(1)) return pi(WORK + 15).div(2).sub(atanD(C, new C(1).div(t)));
  let halvings = 0;
  const tenth = new C("0.1");
  while (t.gt(tenth)) {
    t = t.div(new C(1).add(new C(1).add(t.mul(t)).sqrt()));
    halvings += 1;
  }
  const t2 = t.mul(t);
  let term = t, total = t, n = 1;
  const eps = new C(10).pow(-(WORK + 15));
  while (term.abs().gt(eps)) {
    term = term.mul(t2.neg());
    n += 2;
    total = total.add(term.div(n));
  }
  return total.mul(2 ** halvings);
}

/** The angle of the point (x, y), with the special cases of C99 Annex F (F.10.1.4). */
export function atan2(y: number, x: number): number {
  if (Number.isNaN(x) || Number.isNaN(y)) return NAN;
  const p = Math.PI;
  if (y === 0) {
    if (x > 0 || (x === 0 && copysign(1, x) > 0)) return y;
    return copysign(p, y);
  }
  if (x === 0) return copysign(p / 2, y);
  if (!Number.isFinite(x)) {
    if (!Number.isFinite(y)) return copysign(x > 0 ? p / 4 : 3 * p / 4, y);
    return x > 0 ? copysign(0.0, y) : copysign(p, y);
  }
  if (!Number.isFinite(y)) return copysign(p / 2, y);
  const C = ctx(WORK + 15);
  let a = atanD(C, dec(C, y).div(dec(C, x)).abs());
  if (x < 0) a = new C(pi(WORK + 15)).sub(a);
  if (y < 0) a = a.neg();
  return toFloat(a);
}

/** The angle in [0, pi] whose cosine is x; NaN outside [-1, 1] (C99 F.10.1.1). */
export function acos(x: number): number {
  if (Number.isNaN(x) || Math.abs(x) > 1) return NAN;
  if (x === 1) return 0.0;
  if (x === -1) return Math.PI;
  if (x === 0) return Math.PI / 2;
  const C = ctx(WORK + 15);
  const d = dec(C, x);
  let a = atanD(C, new C(1).sub(d).mul(new C(1).add(d)).sqrt().div(d.abs()));
  if (x < 0) a = new C(pi(WORK + 15)).sub(a);
  return toFloat(a);
}

export const BUNDLED: Record<string, (x: number) => number> = {
  "std.math.Sin": sin, "std.math.Cos": cos, "std.math.Tan": tan, "std.math.Exp": exp, "std.math.Log": log, "std.math.Acos": acos,
};
export const BUNDLED2: Record<string, (a: number, b: number) => number> = { "std.math.Pow": pow, "std.math.Atan2": atan2 };
