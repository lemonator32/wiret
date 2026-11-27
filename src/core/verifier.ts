/** Single-pass bytecode verifier (spec section 5.5). */
import {
  ANYREF, ArrayType, ClassType, decodeCode, DelegateType, DispatcherType, F32, F64, FAULT, FLAG_LANES, FN_EVENT,
  FN_LATENT, FN_PURE, FuncType, I32, I64, Instr, InterfaceType, isFuncType, LANE_VTS, MapType, Ref, SetType, SIGNAL,
  STRING, StructType, VT, vtName, WbcError, WbcModule,
} from "./wbc.js";
import * as lanes from "./lanes.js";

const isRefEntry = (e: unknown) => e instanceof ArrayType || e instanceof StructType || e instanceof MapType ||
  e instanceof SetType || e instanceof ClassType || e instanceof InterfaceType || e instanceof DelegateType ||
  e instanceof DispatcherType;

const VALTYPES = new Set<VT>([I32, I64, F32, F64, STRING]);
const HANDLE_TYPES = new Set<VT>([FAULT, SIGNAL]);
const _PREFIX: Record<string, number> = { i32: I32, i64: I64, f32: F32, f64: F64 };
const _INT_CMP = new Set(["eq", "ne", "lt_s", "lt_u", "gt_s", "gt_u", "le_s", "le_u", "ge_s", "ge_u"]);
const _INT_BIN = new Set(["add", "sub", "mul", "div_s", "div_u", "rem_s", "rem_u", "and", "or", "xor", "shl", "shr_s", "shr_u"]);
const _INT_UN = new Set(["neg", "not", "extend8_s", "extend16_s", "extend32_s"]);
const _F_CMP = new Set(["eq", "ne", "lt", "gt", "le", "ge"]);
const _F_BIN = new Set(["add", "sub", "mul", "div", "min", "max", "copysign"]);
const _F_UN = new Set(["neg", "abs", "sqrt", "ceil", "floor", "trunc", "nearest"]);
const _LANE_VT: Record<string, number> = { f32: F32, bool: I32 };
for (const [vt, name] of LANE_VTS) _LANE_VT[name] = vt;

/** [pops, pushes] of a lane instruction (section 5.6). */
export function laneEffect(name: string, field = 0): [VT[], VT[]] {
  const [ins, out] = lanes.effect(name, field);
  return [ins.map((t) => _LANE_VT[t]), [_LANE_VT[out]]];
}

export class VerifyError extends Error {
  constructor(msg: string, func: number | null = null, pc: number | null = null) {
    let where = func !== null ? `function ${func}` : "module";
    if (pc !== null) where += `, pc ${pc}`;
    super(`${where}: ${msg}`);
  }
}

/** [pops, pushes] for instructions whose typing depends only on the opcode. */
export function simpleEffect(name: string): [VT[], VT[]] | null {
  if (name === "string.concat") return [[STRING, STRING], [STRING]];
  if (name === "string.len") return [[STRING], [I32]];
  if (name === "string.eq" || name === "string.cmp") return [[STRING, STRING], [I32]];
  const dot = name.indexOf(".");
  const pre = dot < 0 ? name : name.slice(0, dot), op = dot < 0 ? "" : name.slice(dot + 1);
  if (!(pre in _PREFIX)) return null;
  const t = _PREFIX[pre];
  const parts = op.split("_");
  if (parts.length >= 2 && ["wrap", "extend", "trunc", "convert", "demote", "promote", "reinterpret"].includes(parts[0]) && parts[1] in _PREFIX)
    return [[_PREFIX[parts[1]]], [t]];
  if (pre === "i32" || pre === "i64") {
    if (op === "eqz") return [[t], [I32]];
    if (_INT_CMP.has(op)) return [[t, t], [I32]];
    if (_INT_BIN.has(op)) return [[t, t], [t]];
    if (_INT_UN.has(op)) return [[t], [t]];
  } else {
    if (_F_CMP.has(op)) return [[t, t], [I32]];
    if (_F_BIN.has(op)) return [[t, t], [t]];
    if (_F_UN.has(op)) return [[t], [t]];
  }
  return null;
}

export function validVt(m: WbcModule, vt: VT): boolean {
  if (vt instanceof Ref) return vt.type < m.types.length && isRefEntry(m.types[vt.type]);
  if (LANE_VTS.has(vt)) return !!(m.flags & FLAG_LANES);
  return VALTYPES.has(vt);
}

function keyVtOk(m: WbcModule, vt: VT, depth = 0): boolean {
  if (!(vt instanceof Ref)) return VALTYPES.has(vt) || (LANE_VTS.has(vt) && !!(m.flags & FLAG_LANES));
  const entry = vt.type < m.types.length ? m.types[vt.type] : null;
  if (!(entry instanceof StructType) || depth > 64) return false;
  return entry.fields.every(([fvt]) => keyVtOk(m, fvt, depth + 1));
}

/** A class type index and its superclasses, nearest first. */
export function classChain(m: WbcModule, t: number | null): number[] {
  const out: number[] = [];
  while (t !== null && !out.includes(t)) {
    out.push(t);
    t = (m.types[t] as ClassType).super_;
  }
  return out;
}

/** Reference subtyping (section 5.5). */
export function isSub(m: WbcModule, got: VT, expected: VT): boolean {
  if (got === expected) return true;
  if (expected === ANYREF) return got instanceof Ref;
  if (!(got instanceof Ref && expected instanceof Ref && m.types[got.type] instanceof ClassType)) return false;
  const target = m.types[expected.type];
  if (target instanceof ClassType) return classChain(m, got.type).includes(expected.type);
  if (target instanceof InterfaceType) return (m.types[got.type] as ClassType).interfaces.some(([i]) => i === expected.type);
  return false;
}

function commonRef(m: WbcModule, a: VT, b: VT): VT {
  if (isSub(m, a, b)) return b;
  if (isSub(m, b, a)) return a;
  return ANYREF;
}

const sameList = (a: readonly VT[], b: readonly VT[]) => a.length === b.length && a.every((x, i) => x === b[i]);

function checkClasses(m: WbcModule, nfuncs: number): void {
  m.types.forEach((entry, t) => {
    if (!(entry instanceof ClassType)) return;
    if (entry.super_ !== null && (entry.super_ >= m.types.length || !(m.types[entry.super_] instanceof ClassType)))
      throw new VerifyError(`class type ${t} has a superclass that is not a class type`);
  });
  m.types.forEach((entry, t) => {
    if (!(entry instanceof ClassType)) return;
    const seen = new Set<number>();
    let cur: number | null = t;
    while (cur !== null) {
      if (seen.has(cur)) throw new VerifyError(`class type ${t} inherits from itself`);
      seen.add(cur);
      cur = (m.types[cur] as ClassType).super_;
    }
  });
  m.types.forEach((entry, t) => {
    if (!(entry instanceof ClassType)) return;
    const chain = classChain(m, t);
    const sup = entry.super_ !== null ? m.types[entry.super_] as ClassType : null;
    if (sup !== null && entry.vtable.length < sup.vtable.length) throw new VerifyError(`class type ${t} drops slots of its superclass's vtable`);
    const mine = entry.interfaces.map(([i]) => i);
    if (new Set(mine).size !== mine.length) throw new VerifyError(`class type ${t} lists an interface twice`);
    if (sup !== null && !sup.interfaces.every(([i]) => mine.includes(i))) throw new VerifyError(`class type ${t} drops an interface of its superclass`);
    for (const [iface, impl] of entry.interfaces) {
      if (iface >= m.types.length || !(m.types[iface] instanceof InterfaceType))
        throw new VerifyError(`class type ${t} implements type ${iface}, not an interface`);
      const methods = (m.types[iface] as InterfaceType).methods;
      if (impl.length !== methods.length)
        throw new VerifyError(`class type ${t} gives ${impl.length} methods for interface ${iface}, which has ${methods.length}`);
      for (let k = 0; k < impl.length; k++) {
        const fi = impl[k], ft = methods[k];
        if (fi >= nfuncs || ft >= m.types.length || !isFuncType(m.types[ft]))
          throw new VerifyError(`class type ${t}: interface ${iface} method ${k} is out of range`);
        const [params, results, flags] = m.funcType(fi);
        if (!params.length || !(params[0] instanceof Ref) || !chain.includes(params[0].type))
          throw new VerifyError(`class type ${t}: interface ${iface} method ${k} does not take this class or a superclass as its receiver`);
        const ftt = m.types[ft] as FuncType;
        if (!sameList(params.slice(1), ftt[0]) || !sameList(results, ftt[1]))
          throw new VerifyError(`class type ${t}: interface ${iface} method ${k} does not have the interface's signature`);
        if (flags & FN_LATENT) throw new VerifyError(`class type ${t}: interface ${iface} method ${k} is latent`);
      }
    }
    entry.vtable.forEach((fi, slot) => {
      if (fi >= nfuncs) throw new VerifyError(`class type ${t} slot ${slot} names function ${fi}, out of range`);
      const [params, results] = m.funcType(fi);
      if (!params.length || !(params[0] instanceof Ref) || !chain.includes(params[0].type))
        throw new VerifyError(`class type ${t} slot ${slot}: the function does not take this class or a superclass as its receiver`);
      if (sup !== null && slot < sup.vtable.length) {
        const [bp, br] = m.funcType(sup.vtable[slot]);
        if (!sameList(bp.slice(1), params.slice(1)) || !sameList(br, results))
          throw new VerifyError(`class type ${t} slot ${slot} does not have the signature of the slot it overrides`);
      }
    });
  });
}

/** Every field's value type, inherited ones first: the layout `class.get` indexes. */
export function classFields(m: WbcModule, t: number): VT[] {
  const out: VT[] = [];
  for (const c of [...classChain(m, t)].reverse()) for (const [vt] of (m.types[c] as ClassType).fields) out.push(vt);
  return out;
}

const isFuncTypeIdx = (m: WbcModule, t: number) => t < m.types.length && isFuncType(m.types[t]);

function checkStructCycles(m: WbcModule): void {
  const state = new Map<number, number>();
  const visit = (t: number): void => {
    if (state.get(t) === 2) return;
    if (state.get(t) === 1) throw new VerifyError(`struct type ${t} contains itself by value`);
    state.set(t, 1);
    for (const [vt] of (m.types[t] as StructType).fields)
      if (vt instanceof Ref && m.types[vt.type] instanceof StructType) visit(vt.type);
    state.set(t, 2);
  };
  m.types.forEach((e, t) => { if (e instanceof StructType) visit(t); });
}

/** Verify a decoded module. Returns, per defined function, [instrs, max_height]. */
export function verify(m: WbcModule): [Instr[], number][] {
  m.types.forEach((entry, i) => {
    let vts: VT[];
    if (entry instanceof ArrayType) vts = [entry.elem];
    else if (entry instanceof MapType) vts = [entry.key, entry.value];
    else if (entry instanceof SetType) vts = [entry.elem];
    else if (entry instanceof DelegateType || entry instanceof DispatcherType) {
      vts = [];
      if (!isFuncTypeIdx(m, entry.functype)) throw new VerifyError(`type ${i} names ${entry.functype}, not a function type`);
      if (entry instanceof DispatcherType && (m.types[entry.functype] as FuncType)[1].length) throw new VerifyError(`dispatcher type ${i} has results`);
    } else if (entry instanceof InterfaceType) {
      vts = [];
      for (const ft of entry.methods) if (!isFuncTypeIdx(m, ft)) throw new VerifyError(`interface type ${i} names ${ft}, not a function type`);
    } else if (entry instanceof StructType || entry instanceof ClassType) {
      vts = entry.fields.map(([vt]) => vt);
      for (const [vt, def] of entry.fields)
        if (vt === STRING && def !== null && def >= m.data.length) throw new VerifyError(`type ${i} has a field default naming missing data`);
    } else {
      vts = [...entry[0], ...entry[1]].filter((vt) => vt !== ANYREF && vt !== FAULT && vt !== SIGNAL);
    }
    for (const vt of vts) if (!validVt(m, vt)) throw new VerifyError(`type ${i} uses an unsupported value type`);
  });
  checkStructCycles(m);
  m.types.forEach((entry, i) => {
    if (entry instanceof MapType || entry instanceof SetType) {
      const k = entry instanceof MapType ? entry.key : entry.elem;
      if (!keyVtOk(m, k)) throw new VerifyError(`type ${i}: a map key or set item must be a number, a string or a struct of those`);
    }
  });
  for (const [mod, fld, t] of m.imports) if (!isFuncTypeIdx(m, t)) throw new VerifyError(`import ${mod}.${fld} has bad type index ${t}`);
  m.funcs.forEach(([t, flags], i) => {
    if (!isFuncTypeIdx(m, t)) throw new VerifyError(`function has bad type index ${t}`, i);
    if (flags & ~(FN_PURE | FN_LATENT | FN_EVENT)) throw new VerifyError(`function has unknown flag bits 0x${flags.toString(16).padStart(2, "0")}`, i);
    if (flags & FN_PURE && flags & FN_LATENT) throw new VerifyError("a pure function is never latent", i);
    if (flags & FN_EVENT && ((m.types[t] as FuncType)[1].length || !(flags & FN_LATENT))) throw new VerifyError("an event is latent and has no results", i);
  });
  if (m.bodies.length !== m.funcs.length) throw new VerifyError("function and code section counts differ");
  checkClasses(m, m.imports.length + m.funcs.length);
  const nfuncs = m.imports.length + m.funcs.length;
  const names = new Set<string>();
  for (const [name, kind, index] of m.exports) {
    if (names.has(name)) throw new VerifyError(`duplicate export '${name}'`);
    names.add(name);
    if (kind === 0 && index >= nfuncs) throw new VerifyError(`export '${name}' names function ${index}, out of range`);
    if (kind === 1 && index >= m.globals.length) throw new VerifyError(`export '${name}' names global ${index}, out of range`);
    if (kind === 2 && index >= m.types.length) throw new VerifyError(`export '${name}' names type ${index}, out of range`);
    if (![0, 1, 2].includes(kind)) throw new VerifyError(`export '${name}' has unsupported kind ${kind}`);
  }
  m.globals.forEach(([vt, , init], gi) => {
    if (vt !== SIGNAL && !validVt(m, vt)) throw new VerifyError(`global ${gi} has unsupported type`);
    if (vt === STRING && init >= m.data.length) throw new VerifyError(`global ${gi} initialiser names missing data ${init}`);
  });
  return m.funcs.map((_, i) => verifyFunction(m, i));
}

export function verifyFunction(m: WbcModule, i: number): [Instr[], number] {
  const fidx = m.imports.length + i;
  const [params, results, flags] = m.funcType(fidx);
  const body = m.bodies[i];
  for (const vt of body.locals)
    if (!HANDLE_TYPES.has(vt) && vt !== ANYREF && !validVt(m, vt)) throw new VerifyError("local of unsupported type", fidx);
  const localTypes = [...params, ...body.locals];
  let instrs: Instr[];
  try {
    instrs = decodeCode(body.code);
  } catch (e) {
    if (e instanceof WbcError) throw new VerifyError(e.message, fidx);
    throw e;
  }
  if (!instrs.length) throw new VerifyError("empty function body", fidx);
  const starts = new Set(instrs.map((x) => x.pc));
  const labels = new Set<number>();
  for (const ins of instrs) {
    if (["br", "br_if", "cont.push", "try.push"].includes(ins.name)) {
      const t = ins.target();
      if (!starts.has(t)) throw new VerifyError(`branch target ${t} is not an instruction boundary`, fidx, ins.pc);
      labels.add(t);
    }
  }
  let stack: VT[] = [];
  let reachable = true;
  let maxH = 0;
  const pop = (expected: VT | null, ins: Instr): VT => {
    if (!stack.length) throw new VerifyError(`${ins.name}: operand stack underflow`, fidx, ins.pc);
    const got = stack.pop()!;
    if (expected !== null && isSub(m, got, expected)) return got;
    if (expected !== null && got !== expected)
      throw new VerifyError(`${ins.name}: expected ${vtName(expected, m.types)}, found ${vtName(got, m.types)}`, fidx, ins.pc);
    return got;
  };
  const structType = (ins: Instr): [Ref, VT[]] => {
    const t = ins.imms[0];
    if (t >= m.types.length || !(m.types[t] instanceof StructType)) throw new VerifyError(`${ins.name}: type ${t} is not a struct type`, fidx, ins.pc);
    const fields = (m.types[t] as StructType).fields.map(([vt]) => vt);
    if (ins.imms.length > 1 && ins.imms[1] >= fields.length) throw new VerifyError(`${ins.name}: struct type ${t} has no field ${ins.imms[1]}`, fidx, ins.pc);
    return [Ref.of(t), fields];
  };
  const containerType = <T>(ins: Instr, cls: new (...a: any[]) => T, label: string): [Ref, T] => {
    const t = ins.imms[0];
    if (t >= m.types.length || !(m.types[t] instanceof cls)) throw new VerifyError(`${ins.name}: type ${t} is not a ${label} type`, fidx, ins.pc);
    return [Ref.of(t), m.types[t] as T];
  };
  const arrayType = (ins: Instr): [Ref, VT] => {
    const t = ins.imms[0];
    if (t >= m.types.length || !(m.types[t] instanceof ArrayType)) throw new VerifyError(`${ins.name}: type ${t} is not an array type`, fidx, ins.pc);
    return [Ref.of(t), (m.types[t] as ArrayType).elem];
  };

  for (const ins of instrs) {
    if (labels.has(ins.pc)) {
      if (reachable && stack.length) throw new VerifyError("operand stack is not empty at a label", fidx, ins.pc);
      reachable = true;
    }
    if (!reachable) throw new VerifyError("unreachable instruction without a label", fidx, ins.pc);
    const n = ins.name;
    let eff = simpleEffect(n);
    if (ins.op > 0xFF) {
      if (!(m.flags & FLAG_LANES)) throw new VerifyError(`${n}: lane instructions need feature flag bit 1`, fidx, ins.pc);
      const field = ins.imms.length ? ins.imms[0] : 0;
      const ty = lanes.BLOCKS[n.split(".")[0]][1];
      if (ins.imms.length && field >= lanes.LANE_FIELDS[ty].length) throw new VerifyError(`${n}: ${ty} has no field ${field}`, fidx, ins.pc);
      eff = laneEffect(n, field);
    }
    if (eff !== null) {
      for (const t of [...eff[0]].reverse()) pop(t, ins);
      stack.push(...eff[1]);
    } else if (n === "nop") {
      // nothing
    } else if (n === "br" || n === "unreachable") {
      if (n === "br" && stack.length) throw new VerifyError("br with a non-empty operand stack", fidx, ins.pc);
      stack = [];
      reachable = false;
    } else if (n === "br_if") {
      if (!(stack.length === 1 && stack[0] === I32)) throw new VerifyError("br_if needs exactly one i32 on the stack", fidx, ins.pc);
      stack = [];
    } else if (n === "cont.push") {
      // nothing
    } else if (n === "try.push") {
      const li = ins.imms[1];
      if (li >= localTypes.length || localTypes[li] !== FAULT) throw new VerifyError("try.push must name a local of type fault", fidx, ins.pc);
    } else if (n === "suspend") {
      const kind = ins.imms[0];
      if (!(flags & FN_LATENT)) throw new VerifyError("suspend in a function that is not latent", fidx, ins.pc);
      if (kind > 2) throw new VerifyError(`suspend kind ${kind} is not 0, 1 or 2`, fidx, ins.pc);
      if (kind) pop(kind === 1 ? F64 : SIGNAL, ins);
      if (stack.length) throw new VerifyError("suspend with more than its operand on the stack", fidx, ins.pc);
    } else if (n === "throw") {
      pop(FAULT, ins);
      stack = [];
      reachable = false;
    } else if (n === "cont.pop") {
      if (stack.length) throw new VerifyError("cont.pop with a non-empty operand stack", fidx, ins.pc);
    } else if (n === "cont.depth") {
      stack.push(I32);
    } else if (n === "cont.trunc") {
      pop(I32, ins);
    } else if (n === "return") {
      if (stack.length !== results.length || !stack.every((g, k) => isSub(m, g, results[k])))
        throw new VerifyError("stack does not match the function's results at return", fidx, ins.pc);
      stack = [];
      reachable = false;
    } else if (n === "call" || n === "call_virtual" || n === "call_interface") {
      let callee = 0;
      let t = 0;
      if (n === "call_interface") {
        const [ti, k] = ins.imms;
        if (ti >= m.types.length || !(m.types[ti] instanceof InterfaceType)) throw new VerifyError(`call_interface: type ${ti} is not an interface`, fidx, ins.pc);
        const it = m.types[ti] as InterfaceType;
        if (k >= it.methods.length) throw new VerifyError(`call_interface: interface ${ti} has no method ${k}`, fidx, ins.pc);
        const ft = it.methods[k];
        if (ft >= m.types.length || !isFuncType(m.types[ft])) throw new VerifyError(`call_interface: bad function type ${ft}`, fidx, ins.pc);
        const ftt = m.types[ft] as FuncType;
        for (const vt of [...ftt[0]].reverse()) pop(vt, ins);
        pop(Ref.of(ti), ins);
        stack.push(...ftt[1]);
      } else if (n === "call") {
        callee = ins.imms[0];
        if (callee >= m.imports.length + m.funcs.length) throw new VerifyError(`call to unknown function ${callee}`, fidx, ins.pc);
      } else {
        const [ti, slot] = ins.imms;
        t = ti;
        if (ti >= m.types.length || !(m.types[ti] instanceof ClassType)) throw new VerifyError(`call_virtual: type ${ti} is not a class type`, fidx, ins.pc);
        const ct = m.types[ti] as ClassType;
        if (slot >= ct.vtable.length) throw new VerifyError(`call_virtual: class type ${ti} has no slot ${slot}`, fidx, ins.pc);
        callee = ct.vtable[slot];
      }
      if (n !== "call_interface") {
        let [cp, cr, cflags] = m.funcType(callee);
        if (n === "call_virtual") cp = [Ref.of(t), ...cp.slice(1)];
        if (cflags & FN_LATENT && !(flags & FN_LATENT) && callee >= m.imports.length)
          throw new VerifyError("non-latent function calls a latent function", fidx, ins.pc);
        for (const vt of [...cp].reverse()) pop(vt, ins);
        stack.push(...cr);
      }
    } else if (n === "drop") {
      pop(null, ins);
    } else if (n === "select") {
      pop(I32, ins);
      const b = pop(null, ins);
      if (b instanceof Ref || b === ANYREF) {
        const a = pop(null, ins);
        if (!(a instanceof Ref || a === ANYREF)) throw new VerifyError("select: a reference and a non-reference", fidx, ins.pc);
        stack.push(commonRef(m, a, b));
      } else {
        pop(b, ins);
        stack.push(b);
      }
    } else if (n === "local.get" || n === "local.set" || n === "local.tee") {
      const li = ins.imms[0];
      if (li >= localTypes.length) throw new VerifyError(`local ${li} out of range`, fidx, ins.pc);
      const t = localTypes[li];
      if (n === "local.get") stack.push(t);
      else {
        pop(t, ins);
        if (n === "local.tee") stack.push(t);
      }
    } else if (n === "global.get" || n === "global.set") {
      const gi = ins.imms[0];
      if (gi >= m.globals.length) throw new VerifyError(`global ${gi} out of range`, fidx, ins.pc);
      const [t, mut] = m.globals[gi];
      if (n === "global.get") stack.push(t);
      else {
        if (!mut) throw new VerifyError(`global ${gi} is immutable`, fidx, ins.pc);
        pop(t, ins);
      }
    } else if (n === "i32.const") {
      if (!(-(2 ** 31) <= ins.imms[0] && ins.imms[0] < 2 ** 31)) throw new VerifyError("i32.const out of range", fidx, ins.pc);
      stack.push(I32);
    } else if (n === "i64.const") stack.push(I64);
    else if (n === "f32.const") stack.push(F32);
    else if (n === "f64.const") stack.push(F64);
    else if (n === "array.len") {
      const got = pop(null, ins);
      if (!(got instanceof Ref) || !(m.types[got.type] instanceof ArrayType)) throw new VerifyError("array.len needs an array", fidx, ins.pc);
      stack.push(I32);
    } else if (n.startsWith("array.")) {
      const [ref, elem] = arrayType(ins);
      const operands: Record<string, VT[]> = {
        "array.new": [I32], "array.get": [ref, I32], "array.set": [ref, I32, elem], "array.push": [ref, elem],
        "array.insert": [ref, I32, elem], "array.remove": [ref, I32], "array.clear": [ref], "array.clone": [ref],
      };
      for (const t of [...operands[n]].reverse()) pop(t, ins);
      stack.push(n === "array.get" ? elem : ref);
    } else if (n === "struct.new") {
      const [ref, fields] = structType(ins);
      for (const t of [...fields].reverse()) pop(t, ins);
      stack.push(ref);
    } else if (n === "struct.get") {
      const [ref, fields] = structType(ins);
      pop(ref, ins);
      stack.push(fields[ins.imms[1]]);
    } else if (n === "struct.with") {
      const [ref, fields] = structType(ins);
      pop(fields[ins.imms[1]], ins);
      pop(ref, ins);
      stack.push(ref);
    } else if (n.startsWith("map.")) {
      const [ref, e] = containerType(ins, MapType, "map");
      const k = e.key, v = e.value;
      const ops: Record<string, [VT[], VT[]]> = {
        "map.new": [[], [ref]], "map.find": [[ref, k], [v, I32]], "map.set": [[ref, k, v], [ref]],
        "map.remove": [[ref, k], [ref, I32]], "map.has": [[ref, k], [I32]], "map.len": [[ref], [I32]],
        "map.key_at": [[ref, I32], [k]], "map.value_at": [[ref, I32], [v]], "map.clear": [[ref], [ref]],
      };
      const [ins_, outs] = ops[n];
      for (const t of [...ins_].reverse()) pop(t, ins);
      stack.push(...outs);
    } else if (n.startsWith("set.")) {
      const [ref, e] = containerType(ins, SetType, "set");
      const el = e.elem;
      const ops: Record<string, [VT[], VT[]]> = {
        "set.new": [[], [ref]], "set.add": [[ref, el], [ref, I32]], "set.remove": [[ref, el], [ref, I32]],
        "set.has": [[ref, el], [I32]], "set.len": [[ref], [I32]], "set.at": [[ref, I32], [el]], "set.clear": [[ref], [ref]],
      };
      const [ins_, outs] = ops[n];
      for (const t of [...ins_].reverse()) pop(t, ins);
      stack.push(...outs);
    } else if (n.startsWith("class.") || n === "ref.null" || n === "ref.cast" || n === "ref.test") {
      const t = ins.imms[0];
      const ok = n.startsWith("class.") ? m.types[t] instanceof ClassType : m.types[t] instanceof ClassType || m.types[t] instanceof InterfaceType;
      if (t >= m.types.length || !ok) throw new VerifyError(`${n}: type ${t} is not a class type`, fidx, ins.pc);
      if (n === "class.new" || n === "ref.null") stack.push(Ref.of(t));
      else if (n === "class.get" || n === "class.set") {
        const fields = classFields(m, t);
        if (ins.imms[1] >= fields.length) throw new VerifyError(`${n}: class type ${t} has no field ${ins.imms[1]}`, fidx, ins.pc);
        if (n === "class.set") pop(fields[ins.imms[1]], ins);
        pop(Ref.of(t), ins);
        if (n === "class.get") stack.push(fields[ins.imms[1]]);
      } else {
        pop(ANYREF, ins);
        stack.push(n === "ref.cast" ? Ref.of(t) : I32);
      }
    } else if (n === "ref.share") {
      const got = pop(null, ins);
      if (!(got instanceof Ref && got.type < m.types.length &&
            (m.types[got.type] instanceof ArrayType || m.types[got.type] instanceof MapType || m.types[got.type] instanceof SetType)))
        throw new VerifyError("ref.share needs an array, a map or a set", fidx, ins.pc);
      stack.push(got);
    } else if (n === "ref.is_null" || n === "ref.valid") {
      pop(ANYREF, ins);
      stack.push(I32);
    } else if (n === "ref.eq") {
      pop(ANYREF, ins);
      pop(ANYREF, ins);
      stack.push(I32);
    } else if (n === "delegate.new") {
      const [fi, fl] = ins.imms;
      if (fi >= m.imports.length + m.funcs.length) throw new VerifyError(`delegate.new: unknown function ${fi}`, fidx, ins.pc);
      if (fl & ~3 || (fl & 2 && !(fl & 1))) throw new VerifyError(`delegate.new: bad flags ${fl}`, fidx, ins.pc);
      let [cp, cr, cflags] = m.funcType(fi);
      if (cflags & FN_LATENT && !(cflags & FN_EVENT)) throw new VerifyError("delegate.new: a latent function that is not an event", fidx, ins.pc);
      if (fl & 1) {
        if (!cp.length) throw new VerifyError("delegate.new binds a receiver to a function with no parameters", fidx, ins.pc);
        pop(cp[0], ins);
        cp = cp.slice(1);
      }
      const dt = m.types.findIndex((e) => e instanceof DelegateType && isFuncTypeIdx(m, e.functype) &&
        sameList((m.types[e.functype] as FuncType)[0], cp) && sameList((m.types[e.functype] as FuncType)[1], cr));
      if (dt < 0) throw new VerifyError("delegate.new: the module has no delegate type for this function", fidx, ins.pc);
      stack.push(Ref.of(dt));
    } else if (["call_delegate", "dispatcher.bind", "dispatcher.unbind", "dispatcher.broadcast"].includes(n)) {
      const t = ins.imms[0];
      let ft: FuncType;
      if (n === "call_delegate") {
        if (!isFuncTypeIdx(m, t)) throw new VerifyError(`call_delegate: type ${t} is not a function type`, fidx, ins.pc);
        ft = m.types[t] as FuncType;
      } else {
        if (t >= m.types.length || !(m.types[t] instanceof DispatcherType)) throw new VerifyError(`${n}: type ${t} is not a dispatcher type`, fidx, ins.pc);
        ft = m.types[(m.types[t] as DispatcherType).functype] as FuncType;
      }
      const sameDelegate = (vt: VT) => {
        const e = vt instanceof Ref && vt.type < m.types.length ? m.types[vt.type] : null;
        return e instanceof DelegateType && sameList((m.types[e.functype] as FuncType)[0], ft[0]) &&
          sameList((m.types[e.functype] as FuncType)[1], ft[1]);
      };
      if (n === "call_delegate" || n === "dispatcher.broadcast") for (const vt of [...ft[0]].reverse()) pop(vt, ins);
      if (n !== "dispatcher.broadcast") {
        const got = pop(null, ins);
        if (!sameDelegate(got)) throw new VerifyError(`${n}: expected a delegate of type ${t}, found ${vtName(got, m.types)}`, fidx, ins.pc);
      }
      if (n !== "call_delegate") pop(Ref.of(t), ins);
      if (n === "call_delegate") stack.push(...ft[1]);
    } else if (n === "string.const") {
      if (ins.imms[0] >= m.data.length) throw new VerifyError(`data index ${ins.imms[0]} out of range`, fidx, ins.pc);
      stack.push(STRING);
    } else throw new VerifyError(`instruction ${n} is not supported`, fidx, ins.pc);
    maxH = Math.max(maxH, stack.length);
  }
  if (reachable) throw new VerifyError("control can fall off the end of the function", fidx);
  if (maxH > body.max_stack) throw new VerifyError(`operand stack reaches ${maxH}, above declared max_stack ${body.max_stack}`, fidx);
  return [instrs, maxH];
}
