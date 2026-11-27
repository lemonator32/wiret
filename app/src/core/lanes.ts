/** The lane types `vec2`, `vec3`, `quat` and `transform` (spec section 3.1.1).
 *
 * They are built-in structs with fixed `f32` fields that the VM holds unboxed. A value is an
 * array of numbers, nested for a transform, which is how the VM holds a struct too; what
 * makes them lane types is that the compiler emits the lane instructions of section 5.6 for
 * them instead of `struct.*`, and that they never cost allocation fuel.
 *
 * Every operation is the `f32` operation of section 4.10: each `+ - * /` and `Sqrt` is
 * computed in binary64 and rounded once to binary32, and the formulas run in the order the
 * specification writes them, with no fused multiply-add. */
import { copysign, f32 } from "./pyutil.js";

export type Lane = readonly number[];
export type LaneValue = Lane | readonly Lane[];

export const LANE_FIELDS: Record<string, [string, string][]> = {
  vec2: [["x", "f32"], ["y", "f32"]],
  vec3: [["x", "f32"], ["y", "f32"], ["z", "f32"]],
  quat: [["x", "f32"], ["y", "f32"], ["z", "f32"], ["w", "f32"]],
  transform: [["translation", "vec3"], ["rotation", "quat"], ["scale", "vec3"]],
};
export const LANE_TYPES = Object.keys(LANE_FIELDS);
export const VECTORS = ["vec2", "vec3"];

export const DEFAULTS: Record<string, any> = {
  vec2: [0.0, 0.0],
  vec3: [0.0, 0.0, 0.0],
  quat: [0.0, 0.0, 0.0, 1.0],
  transform: [[0.0, 0.0, 0.0], [0.0, 0.0, 0.0, 1.0], [1.0, 1.0, 1.0]],
};
export const LANE_COUNTS: Record<string, number> = { vec2: 2, vec3: 3, quat: 4, transform: 10 };

export { f32 };

function _div(a: number, b: number): number {
  if (b === 0) {
    if (a === 0 || a !== a) return NaN;
    return copysign(Infinity, a) * copysign(1.0, b);
  }
  return f32(a / b);
}

function _sqrt(x: number): number {
  return x < 0 || x !== x ? NaN : f32(Math.sqrt(x));
}

export function _min(a: number, b: number): number {
  if (a !== a || b !== b) return NaN;
  if (a === 0 && b === 0) return copysign(1, a) < 0 ? a : b;     // -0 orders before +0
  return a < b ? a : b;
}

export function _max(a: number, b: number): number {
  if (a !== a || b !== b) return NaN;
  if (a === 0 && b === 0) return copysign(1, a) < 0 ? b : a;
  return a > b ? a : b;
}

const zipMap = (a: Lane, b: Lane, fn: (x: number, y: number) => number): number[] => {
  const n = Math.min(a.length, b.length);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(fn(a[i], b[i]));
  return out;
};

export const add = (a: Lane, b: Lane) => zipMap(a, b, (x, y) => f32(x + y));
export const sub = (a: Lane, b: Lane) => zipMap(a, b, (x, y) => f32(x - y));
export const mul = (a: Lane, b: Lane) => zipMap(a, b, (x, y) => f32(x * y));
export const div = (a: Lane, b: Lane) => zipMap(a, b, _div);
export const vmin = (a: Lane, b: Lane) => zipMap(a, b, _min);
export const vmax = (a: Lane, b: Lane) => zipMap(a, b, _max);
export const neg = (a: Lane) => a.map((x) => -x);
export const vabs = (a: Lane) => a.map((x) => Math.abs(x));
export const scale = (v: Lane, s: number) => v.map((x) => f32(x * s));

/** Component-wise, in field order, with the f32 rules: NaN is never equal. */
export function eq(a: any, b: any): number {
  if (Array.isArray(a[0])) return a.every((x: any, i: number) => eq(x, b[i])) ? 1 : 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (!(a[i] === b[i])) return 0;
  return 1;
}

/** `(a.x*b.x + a.y*b.y) + a.z*b.z`, left to right; over as many components as given. */
export function dot(a: Lane, b: Lane): number {
  let total = f32(a[0] * b[0]);
  const n = Math.min(a.length, b.length);
  for (let i = 1; i < n; i++) total = f32(total + f32(a[i] * b[i]));
  return total;
}

export function cross(a: Lane, b: Lane): number[] {
  return [f32(f32(a[1] * b[2]) - f32(a[2] * b[1])),
          f32(f32(a[2] * b[0]) - f32(a[0] * b[2])),
          f32(f32(a[0] * b[1]) - f32(a[1] * b[0]))];
}

export const perpdot = (a: Lane, b: Lane) => f32(f32(a[0] * b[1]) - f32(a[1] * b[0]));
export const lensq = (v: Lane) => dot(v, v);
export const length = (v: Lane) => _sqrt(dot(v, v));
export const distance = (a: Lane, b: Lane) => length(sub(a, b));

/** Each component divided by the length when it is > 0; otherwise (zero or NaN) zero. */
export function normalize(v: Lane): number[] {
  const n = length(v);
  return n > 0 ? v.map((x) => _div(x, n)) : v.map(() => 0.0);
}

export const lerp = (a: Lane, b: Lane, t: number) => zipMap(a, b, (x, y) => f32(x + f32(f32(y - x) * t)));
export const reflect = (v: Lane, n: Lane) => sub(v, scale(n, f32(2 * dot(v, n))));
export const fromV2 = (v: Lane) => [v[0], v[1], 0.0];
export const toV2 = (v: Lane) => [v[0], v[1]];

// -- quaternions ---------------------------------------------------------------------------
export const IDENTITY: Lane = DEFAULTS.quat;

/** The Hamilton product: the rotation b, then a. */
export function qmul(a: Lane, b: Lane): number[] {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  const m = (x: number, y: number) => f32(x * y);
  return [f32(f32(f32(m(aw, bx) + m(ax, bw)) + m(ay, bz)) - m(az, by)),
          f32(f32(f32(m(aw, by) - m(ax, bz)) + m(ay, bw)) + m(az, bx)),
          f32(f32(f32(m(aw, bz) + m(ax, by)) - m(ay, bx)) + m(az, bw)),
          f32(f32(f32(m(aw, bw) - m(ax, bx)) - m(ay, by)) - m(az, bz))];
}

export const conj = (q: Lane) => [-q[0], -q[1], -q[2], q[3]];

export function qinverse(q: Lane): Lane {
  const d = dot(q, q);
  return d > 0 ? conj(q).map((x) => _div(x, d)) : IDENTITY;
}

export function qnormalize(q: Lane): Lane {
  const n = length(q);
  return n > 0 ? q.map((x) => _div(x, n)) : IDENTITY;
}

/** `t = Scale(Cross(u, v), 2)`, then `(v + Scale(t, q.w)) + Cross(u, t)`. */
export function rotate(q: Lane, v: Lane): number[] {
  const u = q.slice(0, 3);
  const t = scale(cross(u, v), 2.0);
  return add(add(v, scale(t, q[3])), cross(u, t));
}

type F1 = (x: number) => number;

/** The std.quat functions built on Sin, Cos and Acos (natives, section 5.6). The math
 * functions are passed in, so that deterministic mode can give the bundled ones. */
export function quatNatives(sin: F1, cos: F1, acos: F1) {
  const s = (x: number) => f32(sin(x));
  const c = (x: number) => f32(cos(x));

  function fromAxisAngle(axis: Lane, angle: number): Lane {
    const n = normalize(axis);
    if (n[0] === 0 && n[1] === 0 && n[2] === 0) return IDENTITY;
    const h = f32(angle * 0.5);
    const sh = s(h);
    return [f32(n[0] * sh), f32(n[1] * sh), f32(n[2] * sh), c(h)];
  }

  function slerp(a: Lane, b: Lane, t: number): Lane {
    let d = dot(a, b);
    if (d < 0) { b = neg(b); d = -d; }
    if (d > f32(0.9995)) return qnormalize(lerp(a, b, t));
    const th = f32(acos(d));
    const st = s(th);
    const wa = _div(s(f32(f32(1 - t) * th)), st);
    const wb = _div(s(f32(t * th)), st);
    return add(scale(a, wa), scale(b, wb));
  }

  function angle(a: Lane, b: Lane): number {
    const d = Math.abs(dot(a, b));
    return f32(2 * f32(acos(_min(d, 1.0))));
  }
  return [fromAxisAngle, slerp, angle] as const;
}

// -- transforms ----------------------------------------------------------------------------
type T = readonly Lane[];
export const apply = (t: T, p: Lane) => add(t[0], rotate(t[1], mul(t[2], p)));
export const applyVector = (t: T, v: Lane) => rotate(t[1], mul(t[2], v));

/** Composition: b, then a. Exact when a's scale is uniform or b's rotation the identity. */
export const tmul = (a: T, b: T): Lane[] => [apply(a, b[0]), qmul(a[1], b[1]), mul(a[2], b[2])];

export function tinverse(t: T): Lane[] {
  const r = conj(t[1]);
  const s = t[2].map((x) => x === 0 ? 0.0 : _div(1.0, x));
  return [mul(s, rotate(r, neg(t[0]))), r, s];
}

// -- text ----------------------------------------------------------------------------------
/** The literal form (section 3.2): `(0, 1.5, 0)`, nested for a transform. */
export function toText(v: any, singleText: (x: number) => string): string {
  if (Array.isArray(v[0])) return "(" + v.map((x: any) => toText(x, singleText)).join(", ") + ")";
  return "(" + v.map((x: number) => singleText(x)).join(", ") + ")";
}

/** A host value (any numbers or arrays) as the VM holds a lane value. */
export function normalise(ty: string, v: any): any {
  if (ty === "transform") return [normalise("vec3", v[0]), normalise("quat", v[1]), normalise("vec3", v[2])];
  return Array.from(v as ArrayLike<any>, (x) => f32(Number(x)));
}

// -- lane instructions (section 5.6) -------------------------------------------------------
const _VEC: [number, string][] = [[0, "make"], [1, "get"], [2, "with"], [3, "add"], [4, "sub"],
  [5, "mul"], [6, "div"], [7, "min"], [8, "max"], [9, "neg"], [10, "abs"], [11, "scale"],
  [12, "eq"], [13, "ne"], [14, "dot"], [15, "len"], [16, "lensq"], [17, "normalize"],
  [18, "lerp"], [19, "reflect"]];
/** block prefix -> [base sub-opcode, Wiret type, [index, name][]]. */
export const BLOCKS: Record<string, [number, string, [number, string][]]> = {
  v2: [0x00, "vec2", [..._VEC, [20, "perpdot"]]],
  v3: [0x20, "vec3", [..._VEC, [20, "cross"], [21, "from_v2"], [22, "to_v2"]]],
  q: [0x40, "quat", [[0, "make"], [1, "get"], [2, "with"], [3, "mul"], [4, "conj"],
                     [5, "inverse"], [6, "normalize"], [7, "dot"], [8, "eq"], [9, "ne"],
                     [10, "rotate"]]],
  t: [0x60, "transform", [[0, "make"], [1, "get"], [2, "with"], [3, "mul"], [4, "inverse"],
                          [5, "apply"], [6, "apply_vector"], [7, "eq"], [8, "ne"]]],
};
export const PREFIX: Record<string, string> = Object.fromEntries(
  Object.entries(BLOCKS).map(([p, [, ty]]) => [ty, p]));

/** name -> sub-opcode; field-index immediates for get and with. */
export const SUB_OPS: Record<string, number> = {};
for (const [p, [base, , ops]] of Object.entries(BLOCKS))
  for (const [i, name] of ops) SUB_OPS[`${p}.${name}`] = base + i;
export const IMM_OPS = new Set(Object.keys(SUB_OPS).filter((n) => n.endsWith(".get") || n.endsWith(".with")));

function partition(name: string): [string, string] {
  const i = name.indexOf(".");
  return i < 0 ? [name, ""] : [name.slice(0, i), name.slice(i + 1)];
}

/** [operand Wiret types, result Wiret type] of a lane instruction. */
export function effect(name: string, field = 0): [string[], string] {
  const [p, op] = partition(name);
  const ty = BLOCKS[p][1];
  const fields = LANE_FIELDS[ty].map(([, t]) => t);
  if (op === "make") return [fields, ty];
  if (op === "get") return [[ty], fields[field]];
  if (op === "with") return [[ty, fields[field]], ty];
  if (["neg", "abs", "normalize", "conj", "inverse"].includes(op)) return [[ty], ty];
  if (op === "scale") return [[ty, "f32"], ty];
  if (op === "eq" || op === "ne") return [[ty, ty], "bool"];
  if (op === "dot" || op === "perpdot") return [[ty, ty], "f32"];
  if (op === "len" || op === "lensq") return [[ty], "f32"];
  if (op === "lerp") return [[ty, ty, "f32"], ty];
  if (op === "from_v2") return [["vec2"], "vec3"];
  if (op === "to_v2") return [["vec3"], "vec2"];
  if (op === "rotate") return [["quat", "vec3"], "vec3"];
  if (op === "apply" || op === "apply_vector") return [["transform", "vec3"], "vec3"];
  return [[ty, ty], ty];          // add sub mul div min max reflect cross, q/t mul
}

/** The function an instruction computes, taking its operands in order. */
export function laneFunction(name: string, field = 0): (...xs: any[]) => any {
  const [p, op] = partition(name);
  const ty = BLOCKS[p][1];
  if (op === "make") return (...xs) => xs;
  if (op === "get") return (v) => v[field];
  if (op === "with") return (v, x) => [...v.slice(0, field), x, ...v.slice(field + 1)];
  if (op === "eq") return (a, b) => eq(a, b);
  if (op === "ne") return (a, b) => 1 - eq(a, b);
  if (op === "mul" && ty === "quat") return qmul;
  if (op === "mul" && ty === "transform") return tmul;
  if (op === "normalize" && ty === "quat") return qnormalize;
  if (op === "inverse") return ty === "quat" ? qinverse : tinverse;
  const table: Record<string, (...xs: any[]) => any> = {
    add, sub, mul, div, min: vmin, max: vmax, neg, abs: vabs, scale, dot, len: length,
    lensq, normalize, lerp, reflect, perpdot, cross, from_v2: fromV2, to_v2: toV2,
    conj, rotate, apply, apply_vector: applyVector,
  };
  return table[op];
}

/** The std.vec, std.quat and std.transform functions that lower to one lane instruction:
 * qualified name with type arguments -> instruction (or a list of instructions). */
export const INTRINSICS: Record<string, string | string[]> = {};
for (const [t, p] of [["vec2", "v2"], ["vec3", "v3"]]) {
  for (const [fn, op] of [["Dot", "dot"], ["Length", "len"], ["LengthSquared", "lensq"],
                          ["Normalize", "normalize"], ["Lerp", "lerp"], ["Reflect", "reflect"]])
    INTRINSICS[`std.vec.${fn}#<${t}>`] = `${p}.${op}`;
  INTRINSICS[`std.vec.Distance#<${t}>`] = [`${p}.sub`, `${p}.len`];
}
INTRINSICS["std.vec.Cross"] = "v3.cross";
INTRINSICS["std.vec.PerpDot"] = "v2.perpdot";
Object.assign(INTRINSICS, {
  "std.quat.Rotate": "q.rotate", "std.quat.Conjugate": "q.conj",
  "std.quat.Inverse": "q.inverse", "std.quat.Normalize": "q.normalize",
  "std.transform.Apply": "t.apply", "std.transform.ApplyVector": "t.apply_vector",
  "std.transform.Inverse": "t.inverse",
});
