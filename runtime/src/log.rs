//! The input log and replay (spec section 4.10).
//!
//! In deterministic mode every API call is logged with its arguments, its result or fault, the
//! instructions it ran, the fuel left and the output it printed. Replaying the log on a new
//! VM must give the same entry for every call. Values are encoded as the TypeScript port's log
//! encodes them: `{"i": "..."}` for an i64, `{"f": hex}` for a float that is not an integer,
//! `{"a": [...]}` for a list, `{"m": [[k, v], ...]}` for a map, `{"h": n}` for a handle.
use std::fmt;
use std::rc::Rc;

use serde_json::{json, Value as J};
use sha2::{Digest, Sha256};

use crate::fmt::{float_from_hex, float_hex, py_repr_str};
use crate::value::{MapData, Value};
use crate::vm::{FiberRef, Handle, LoadedModule, Vm, VmOptions, WiretError, STATUS_API};

pub fn sha256_hex(data: &[u8]) -> String {
    Sha256::digest(data).iter().map(|b| format!("{b:02x}")).collect()
}

/// A number as JavaScript's JSON gives an integral one, else in hex.
pub fn enc_number(x: f64) -> J {
    if x.is_finite() && x.fract() == 0.0 && !(x == 0.0 && x.is_sign_negative()) {
        if x.abs() < 9.2e18 {
            return J::from(x as i64);
        }
        return J::from(x);
    }
    json!({ "f": float_hex(x) })
}

pub(crate) fn enc_a(items: Vec<J>) -> J {
    json!({ "a": items })
}

fn kind_name(h: &Handle) -> &'static str {
    match h {
        Handle::Module(_) => "LoadedModule",
        Handle::Fiber(_) => "Fiber",
        Handle::Value(Value::Obj(_)) => "Obj",
        Handle::Value(Value::Signal(_)) => "Signal",
        Handle::Value(Value::Delegate(_)) => "Delegate",
        Handle::Value(Value::Dispatcher(_)) => "DispatcherObj",
        Handle::Value(_) => "value",
    }
}

impl Vm {
    pub(crate) fn enc_handle(&mut self, h: Handle, new_ok: bool) -> Result<J, WiretError> {
        let p = h.ptr();
        if let Some(&i) = self.handles.get(&p) {
            return Ok(json!({ "h": i }));
        }
        if !new_ok {
            return Err(WiretError::new(
                STATUS_API,
                format!("{} did not come from this VM's API, so a deterministic run cannot log it", kind_name(&h)),
            ));
        }
        let i = self.handle_objs.len();
        self.handles.insert(p, i);
        self.handle_objs.push(h);
        Ok(json!({ "h": i }))
    }

    pub(crate) fn enc_value(&mut self, v: &Value, new_ok: bool) -> Result<J, WiretError> {
        Ok(match v {
            Value::Null => J::Null,
            Value::I32(x) => J::from(*x),
            Value::I64(x) => json!({ "i": x.to_string() }),
            Value::F32(x) => enc_number(*x as f64),
            Value::F64(x) => enc_number(*x),
            Value::Str(s) => J::from(&**s),
            Value::Array(_) | Value::Struct(_) => self.enc_list(&v.items(), new_ok)?,
            Value::Map(m) => {
                let entries: Vec<(Value, Value)> = m.borrow().iter().cloned().collect();
                let mut out = vec![];
                for (k, x) in &entries {
                    out.push(J::Array(vec![self.enc_value(k, new_ok)?, self.enc_value(x, new_ok)?]));
                }
                json!({ "m": out })
            }
            Value::Obj(_) | Value::Signal(_) | Value::Delegate(_) | Value::Dispatcher(_) => {
                self.enc_handle(Handle::Value(v.clone()), new_ok)?
            }
            Value::Fault(_) => return Err(WiretError::new(STATUS_API, "cannot log a FaultValue")),
        })
    }

    pub(crate) fn enc_list(&mut self, vals: &[Value], new_ok: bool) -> Result<J, WiretError> {
        let mut out = vec![];
        for v in vals {
            out.push(self.enc_value(v, new_ok)?);
        }
        Ok(enc_a(out))
    }

    pub(crate) fn enc_out(&mut self, v: &Value) -> Result<J, WiretError> {
        self.enc_value(v, true)
    }
}

/// A replayed call gave a different entry than the one recorded.
#[derive(Clone, Debug)]
pub struct ReplayMismatch {
    pub index: usize,
    pub op: String,
    pub what: String,
    pub expected: J,
    pub got: J,
}

impl fmt::Display for ReplayMismatch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "entry {} ({}): {} differs: recorded {}, replay gave {}",
            self.index,
            self.op,
            self.what,
            py_repr_str(&self.expected.to_string()),
            py_repr_str(&self.got.to_string())
        )
    }
}

#[derive(Clone, Debug)]
pub enum ReplayError {
    Mismatch(ReplayMismatch),
    /// the log is not one this VM can read
    Bad(String),
}

impl fmt::Display for ReplayError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ReplayError::Mismatch(m) => m.fmt(f),
            ReplayError::Bad(s) => f.write_str(s),
        }
    }
}

/// JSON values equal as data: numbers compare by value whatever their form.
pub fn json_eq(a: &J, b: &J) -> bool {
    match (a, b) {
        (J::Number(x), J::Number(y)) => x.as_f64() == y.as_f64(),
        (J::Array(x), J::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| json_eq(p, q)),
        (J::Object(x), J::Object(y)) => x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| json_eq(v, w))),
        _ => a == b,
    }
}

enum Dec {
    V(Value),
    Module(Rc<LoadedModule>),
    Fiber(FiberRef),
}

impl Vm {
    fn decode_log(&self, j: &J) -> Result<Dec, ReplayError> {
        let bad = || ReplayError::Bad(format!("cannot read the log value {j}"));
        Ok(match j {
            J::Null => Dec::V(Value::Null),
            J::Bool(b) => Dec::V(Value::I32(*b as i32)),
            J::Number(n) => Dec::V(Value::F64(n.as_f64().unwrap_or(f64::NAN))),
            J::String(s) => Dec::V(Value::str(s)),
            J::Array(_) => return Err(bad()),
            J::Object(o) => {
                if let Some(f) = o.get("f") {
                    Dec::V(Value::F64(f.as_str().and_then(float_from_hex).ok_or_else(bad)?))
                } else if let Some(i) = o.get("i") {
                    Dec::V(Value::I64(i.as_str().and_then(|s| s.parse().ok()).ok_or_else(bad)?))
                } else if let Some(J::Array(a)) = o.get("a") {
                    let mut items = vec![];
                    for x in a {
                        items.push(self.decode_value(x)?);
                    }
                    Dec::V(Value::list(items))
                } else if let Some(J::Array(m)) = o.get("m") {
                    let mut entries = vec![];
                    for e in m {
                        let J::Array(kv) = e else { return Err(bad()) };
                        if kv.len() != 2 {
                            return Err(bad());
                        }
                        entries.push((self.decode_value(&kv[0])?, self.decode_value(&kv[1])?));
                    }
                    Dec::V(Value::new_map(MapData::from_entries(entries)))
                } else if let Some(h) = o.get("h").and_then(|h| h.as_u64()) {
                    match self.handle(h as usize) {
                        Some(Handle::Module(m)) => Dec::Module(m.clone()),
                        Some(Handle::Fiber(f)) => Dec::Fiber(f.clone()),
                        Some(Handle::Value(v)) => Dec::V(v.clone()),
                        None => return Err(ReplayError::Bad(format!("the log names handle {h}, which the replay has not made"))),
                    }
                } else {
                    return Err(bad());
                }
            }
        })
    }

    fn decode_value(&self, j: &J) -> Result<Value, ReplayError> {
        match self.decode_log(j)? {
            Dec::V(v) => Ok(v),
            _ => Err(ReplayError::Bad(format!("the log value {j} is not a value"))),
        }
    }

    fn decode_module(&self, j: &J) -> Result<Rc<LoadedModule>, ReplayError> {
        match self.decode_log(j)? {
            Dec::Module(m) => Ok(m),
            _ => Err(ReplayError::Bad(format!("the log value {j} is not a module"))),
        }
    }

    /// Run one logged call again. Its own entry is the last of the replay's log.
    fn replay_entry(&mut self, op: &str, args: &[J], data: &[u8]) -> Result<(), ReplayError> {
        let a = |i: usize| args.get(i).cloned().unwrap_or(J::Null);
        let s = |i: usize| a(i).as_str().unwrap_or("").to_string();
        let list = |vm: &Vm, i: usize| -> Result<Vec<Value>, ReplayError> { Ok(vm.decode_value(&a(i))?.items()) };
        let obj = |vm: &Vm, i: usize| -> Result<Option<Rc<crate::value::Obj>>, ReplayError> {
            match vm.decode_value(&a(i))? {
                Value::Obj(o) => Ok(Some(o)),
                _ => Ok(None),
            }
        };
        match op {
            "load" => drop(self.load(data)),
            "grant" => drop(self.grant(&s(0))),
            "signal" => drop(self.signal()),
            "call" => {
                let m = self.decode_module(&a(0))?;
                let args = list(self, 2)?;
                drop(self.call(&m, &s(1), &args));
            }
            "start" => {
                let m = self.decode_module(&a(0))?;
                let args = list(self, 2)?;
                drop(self.start(&m, &s(1), &args, a(3).as_bool().unwrap_or(false)));
            }
            "advance" => {
                let dt = self.decode_value(&a(0))?.as_f64();
                drop(self.advance(dt));
            }
            "fire" => {
                if let Value::Signal(sig) = self.decode_value(&a(0))? {
                    drop(self.fire(&sig));
                }
            }
            "kill" => {
                if let Dec::Fiber(fb) = self.decode_log(&a(0))? {
                    drop(self.kill(&fb));
                }
            }
            "new" => {
                let m = self.decode_module(&a(0))?;
                drop(self.new_object(&m, &s(1)));
            }
            "call_method" => {
                let m = self.decode_module(&a(0))?;
                let o = obj(self, 1)?;
                let args = list(self, 3)?;
                drop(self.call_method(&m, o.as_ref(), &s(2), &args));
            }
            "delegate" => {
                let m = self.decode_module(&a(0))?;
                let o = obj(self, 2)?;
                drop(self.delegate(&m, &s(1), o.as_ref()));
            }
            "broadcast" => {
                let m = self.decode_module(&a(0))?;
                let o = obj(self, 1)?;
                let args = list(self, 3)?;
                if let Some(o) = o {
                    drop(self.broadcast(&m, &o, &s(2), &args));
                }
            }
            other => return Err(ReplayError::Bad(format!("the log has an unknown call '{other}'"))),
        }
        Ok(())
    }
}

/// Run an input log again on a new deterministic VM and check that every call gives the same
/// result or fault, instruction count, fuel and output (section 4.10).
pub fn replay(data: &[u8], log: &[J], opts: VmOptions) -> Result<Vm, ReplayError> {
    let mut vm = Vm::new(VmOptions { deterministic: true, ..opts });
    vm.set_output(|_| {});
    for (i, entry) in log.iter().enumerate() {
        let op = entry.get("op").and_then(J::as_str).unwrap_or("").to_string();
        let args: Vec<J> = entry.get("args").and_then(J::as_array).cloned().unwrap_or_default();
        if op == "load" && args.first().and_then(J::as_str) != Some(sha256_hex(data).as_str()) {
            return Err(ReplayError::Mismatch(ReplayMismatch {
                index: i,
                op,
                what: "module".into(),
                expected: args.first().cloned().unwrap_or(J::Null),
                got: J::from("different bytes"),
            }));
        }
        vm.replay_entry(&op, &args, data)?;
        let got = vm.input_log.last().cloned().unwrap_or(J::Null);
        for what in ["out", "error", "instructions", "fuel", "output"] {
            let (e, g) = (entry.get(what).unwrap_or(&J::Null), got.get(what).unwrap_or(&J::Null));
            if !json_eq(e, g) {
                return Err(ReplayError::Mismatch(ReplayMismatch {
                    index: i,
                    op,
                    what: what.into(),
                    expected: e.clone(),
                    got: g.clone(),
                }));
            }
        }
    }
    Ok(vm)
}
