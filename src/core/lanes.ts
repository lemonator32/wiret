/** The lane types `vec2`, `vec3`, `quat` and `transform` (spec section 3.1.1), as the compiler
 * and editor see them: their fields and defaults, the lane instructions of section 5.6 and the
 * std functions that lower to them. Their arithmetic is the runtime's (runtime/src/lanes.rs).
 *
 * A value is an array of numbers, nested for a transform. */
import { f32 } from "./pyutil.js";

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

/** The literal form (section 3.2): `(0, 1.5, 0)`, nested for a transform. */
export function toText(v: any, singleText: (x: number) => string): string {
  if (Array.isArray(v[0])) return "(" + v.map((x: any) => toText(x, singleText)).join(", ") + ")";
  return "(" + v.map((x: number) => singleText(x)).join(", ") + ")";
}

/** A literal's numbers as a lane value: each component rounded to f32. */
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
