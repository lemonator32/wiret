//! A JSON protocol for hosts that cannot hold Rust values: the web editor (through the
//! WebAssembly build, `wasm.rs`) and the Tauri desktop app (through IPC). A [`Session`] is one
//! VM plus the modules loaded into it; requests and replies are JSON.
//!
//! Values travel as JSON with a few tagged forms:
//!
//! | value                  | JSON                                                        |
//! |------------------------|-------------------------------------------------------------|
//! | i32, integral float    | a number                                                    |
//! | other float            | `{"f": "0x1.8p+0"}` (Python's float.hex; NaN is `"nan"`)    |
//! | i64                    | `{"i": "123"}`                                              |
//! | string, null           | a string, null                                              |
//! | array, struct, lane    | an array                                                    |
//! | map, set               | `{"m": [[key, value], ...]}` (a set's values are null)      |
//! | object                 | `{"o": id, "c": class, "n": [field names], "v": [fields]}`  |
//! |                        | (only `{"o": id}` when it occurs again in the same reply)   |
//! | delegate               | `{"d": id, "func": n, "bound": b, "recv": object or null}`  |
//! | dispatcher             | `{"disp": id, "n": handler count}`                          |
//! | signal                 | `{"sig": id}`                                               |
//! | fault                  | `{"fault": [message, code]}`                                |
//!
//! A host passes an object, delegate, dispatcher or signal back as `{"h": id}`. The session
//! keeps every value it has handed out alive until the host sends `release`.
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use serde_json::{json, Map, Value as J};

use crate::fmt::{float_from_hex, float_hex};
use crate::value::{FaultValue, MapData, Value};
use crate::vm::{FiberRef, FiberStatus, LoadedModule, Vm, VmOptions, Waiting, WiretError, STATUS_API};

/// The reference values a host has been given, by id.
#[derive(Default)]
pub struct Bridge {
    handles: HashMap<usize, Value>,
}

impl Bridge {
    fn keep(&mut self, v: &Value) -> usize {
        let id = v.ptr().unwrap_or(0);
        self.handles.entry(id).or_insert_with(|| v.clone());
        id
    }

    pub fn encode(&mut self, v: &Value) -> J {
        let mut seen = HashSet::new();
        self.enc(v, &mut seen)
    }

    pub fn encode_list(&mut self, vals: &[Value]) -> J {
        let mut seen = HashSet::new();
        J::Array(vals.iter().map(|v| self.enc(v, &mut seen)).collect())
    }

    fn enc(&mut self, v: &Value, seen: &mut HashSet<usize>) -> J {
        match v {
            Value::Null => J::Null,
            Value::I32(x) => J::from(*x),
            Value::I64(x) => json!({ "i": x.to_string() }),
            Value::F32(x) => num(*x as f64),
            Value::F64(x) => num(*x),
            Value::Str(s) => J::from(&**s),
            Value::Array(_) | Value::Struct(_) => J::Array(v.items().iter().map(|x| self.enc(x, seen)).collect()),
            Value::Map(m) => {
                let entries: Vec<(Value, Value)> = m.borrow().iter().cloned().collect();
                json!({ "m": entries.iter().map(|(k, x)| J::Array(vec![self.enc(k, seen), self.enc(x, seen)])).collect::<Vec<_>>() })
            }
            Value::Obj(o) => {
                let id = self.keep(v);
                if !seen.insert(id) {
                    return json!({ "o": id });
                }
                let fields: Vec<Value> = o.fields.borrow().clone();
                json!({
                    "o": id,
                    "c": o.cls.name,
                    "n": o.cls.field_names,
                    "v": fields.iter().map(|x| self.enc(x, seen)).collect::<Vec<_>>(),
                })
            }
            Value::Delegate(d) => {
                let id = self.keep(v);
                let recv = d.recv.clone().map(|o| self.enc(&Value::Obj(o), seen)).unwrap_or(J::Null);
                json!({ "d": id, "func": d.func, "bound": d.bound, "recv": recv })
            }
            Value::Dispatcher(d) => {
                let id = self.keep(v);
                json!({ "disp": id, "n": d.handlers.borrow().len() })
            }
            Value::Signal(_) => json!({ "sig": self.keep(v) }),
            Value::Fault(f) => json!({ "fault": [f.message, f.code] }),
        }
    }

    pub fn decode(&self, j: &J) -> Result<Value, String> {
        Ok(match j {
            J::Null => Value::Null,
            J::Bool(b) => Value::I32(*b as i32),
            J::Number(n) => match n.as_i64() {
                Some(i) if i32::try_from(i).is_ok() => Value::I32(i as i32),
                _ => Value::F64(n.as_f64().unwrap_or(f64::NAN)),
            },
            J::String(s) => Value::str(s),
            J::Array(a) => Value::list(a.iter().map(|x| self.decode(x)).collect::<Result<_, _>>()?),
            J::Object(o) => {
                if let Some(f) = o.get("f") {
                    Value::F64(f.as_str().and_then(float_from_hex).ok_or_else(|| format!("bad float {f}"))?)
                } else if let Some(i) = o.get("i") {
                    Value::I64(i.as_str().and_then(|s| s.parse().ok()).ok_or_else(|| format!("bad i64 {i}"))?)
                } else if let Some(J::Array(m)) = o.get("m") {
                    let mut entries = vec![];
                    for e in m {
                        match e {
                            J::Array(kv) if kv.len() == 2 => entries.push((self.decode(&kv[0])?, self.decode(&kv[1])?)),
                            _ => return Err(format!("bad map entry {e}")),
                        }
                    }
                    Value::new_map(MapData::from_entries(entries))
                } else if let Some(h) = o.get("h").and_then(J::as_u64) {
                    self.handles.get(&(h as usize)).cloned().ok_or_else(|| format!("no value with handle {h}"))?
                } else if let Some(J::Array(f)) = o.get("fault") {
                    Value::Fault(Rc::new(FaultValue {
                        message: f.first().and_then(J::as_str).unwrap_or("").into(),
                        code: f.get(1).and_then(J::as_i64).unwrap_or(0) as i32,
                    }))
                } else {
                    return Err(format!("cannot read the value {j}"));
                }
            }
        })
    }

    pub fn release(&mut self, ids: &[usize]) {
        for id in ids {
            self.handles.remove(id);
        }
    }
}

/// A float as JSON: a number when it is integral and exactly representable, else hex.
fn num(x: f64) -> J {
    if x.is_finite() && x.fract() == 0.0 && !(x == 0.0 && x.is_sign_negative()) && x.abs() < 9007199254740992.0 {
        J::from(x as i64)
    } else {
        json!({ "f": float_hex(x) })
    }
}

pub fn error_json(e: &WiretError) -> J {
    json!({
        "status": e.status,
        "message": e.message,
        "traceback": e.traceback.iter().map(|(f, n)| json!([f, n])).collect::<Vec<_>>(),
        "code": e.code,
    })
}

fn api_err(msg: impl Into<String>) -> J {
    error_json(&WiretError::new(STATUS_API, msg))
}

/// One VM, the modules loaded into it and the fibers it has started.
pub struct Session {
    pub vm: Vm,
    pub modules: Vec<Rc<LoadedModule>>,
    fibers: HashMap<usize, FiberRef>,
    pub bridge: Rc<RefCell<Bridge>>,
}

/// The options a session is made with: `{"deterministic": false, "fuel": 50000000,
/// "capabilities": null}` (null grants every registered native's capability).
pub fn options(cfg: &J) -> VmOptions {
    let d = VmOptions::default();
    VmOptions {
        deterministic: cfg.get("deterministic").and_then(J::as_bool).unwrap_or(false),
        fuel: cfg.get("fuel").and_then(J::as_f64).map(|f| f as i64).unwrap_or(d.fuel),
        capabilities: cfg
            .get("capabilities")
            .and_then(J::as_array)
            .map(|a| a.iter().filter_map(|c| c.as_str().map(String::from)).collect()),
    }
}

type Reply = Result<J, J>;

impl Session {
    pub fn new(cfg: &J, output: impl FnMut(&str) + 'static) -> Session {
        let mut vm = Vm::new(options(cfg));
        vm.set_output(output);
        Session { vm, modules: vec![], fibers: HashMap::new(), bridge: Rc::new(RefCell::new(Bridge::default())) }
    }

    /// Load a module. The reply describes it: its index for later requests, its name, its
    /// exported functions as [name, function index, latent, parameter count], its globals by
    /// name, its classes and the capabilities it needs.
    pub fn load(&mut self, bytes: &[u8]) -> Reply {
        let m = self.vm.load(bytes).map_err(|e| error_json(&e))?;
        let index = self.modules.len();
        self.modules.push(m.clone());
        let exports: Vec<J> = m
            .exports
            .iter()
            .map(|(name, &fi)| {
                let f = &m.funcs[fi];
                json!([name, fi, f.is_latent(), f.params.len()])
            })
            .collect();
        let globals: Map<String, J> = m.global_names.iter().map(|(n, &i)| (n.clone(), J::from(i))).collect();
        Ok(json!({
            "module": index,
            "name": m.name,
            "exports": exports,
            "globals": globals,
            "classes": m.classes.keys().collect::<Vec<_>>(),
            "capabilities": m.capabilities,
        }))
    }

    fn module(&self, req: &J) -> Result<Rc<LoadedModule>, J> {
        let i = req.get("module").and_then(J::as_u64).unwrap_or(0) as usize;
        self.modules.get(i).cloned().ok_or_else(|| api_err(format!("no module {i}")))
    }

    fn arg(&self, req: &J, key: &str) -> Result<Value, J> {
        self.bridge.borrow().decode(req.get(key).unwrap_or(&J::Null)).map_err(api_err)
    }

    fn args(&self, req: &J) -> Result<Vec<Value>, J> {
        Ok(self.arg(req, "args")?.items())
    }

    fn str_arg<'a>(req: &'a J, key: &str) -> &'a str {
        req.get(key).and_then(J::as_str).unwrap_or("")
    }

    fn fiber(&self, req: &J) -> Result<FiberRef, J> {
        let id = req.get("fiber").and_then(J::as_u64).unwrap_or(0) as usize;
        self.fibers.get(&id).cloned().ok_or_else(|| api_err(format!("no fiber {id}")))
    }

    fn keep_fiber(&mut self, fb: &FiberRef) -> J {
        let id = Rc::as_ptr(fb) as *const () as usize;
        self.fibers.entry(id).or_insert_with(|| fb.clone());
        J::from(id)
    }

    fn results(&self, r: Result<Vec<Value>, WiretError>) -> Reply {
        let vals = r.map_err(|e| error_json(&e))?;
        Ok(self.bridge.borrow_mut().encode_list(&vals))
    }

    /// Handle one request, `{"op": ..., ...}`. The ops are the VM's API: `call` and
    /// `run_function` (`module`, `name`, `args`), `start` (and `now`), `advance` (`dt`),
    /// `fiber`, `kill` (`fiber`), `fire` (`signal`), `next_wake`, `time`, `new` (`module`,
    /// `class`), `call_method` (`obj`, `method`, `args`), `delegate` (`func`, `obj`),
    /// `broadcast` (`obj`, `dispatcher`, `args`), `signal`, `global` (`module`, `index`),
    /// `grant` (`capability`), `interrupt`, `stats`, `input_log` and `release` (`ids`).
    pub fn command(&mut self, req: &J) -> Reply {
        let op = Self::str_arg(req, "op");
        let err = |e: WiretError| error_json(&e);
        match op {
            "call" | "run_function" => {
                let m = self.module(req)?;
                let args = self.args(req)?;
                let name = Self::str_arg(req, "name");
                let r = if op == "call" { self.vm.call(&m, name, &args) } else { self.vm.run_function(&m, name, &args) };
                self.results(r)
            }
            "start" => {
                let m = self.module(req)?;
                let args = self.args(req)?;
                let now = req.get("now").and_then(J::as_bool).unwrap_or(false);
                let fb = self.vm.start(&m, Self::str_arg(req, "name"), &args, now).map_err(err)?;
                Ok(self.keep_fiber(&fb))
            }
            "advance" => {
                let dt = req.get("dt").and_then(J::as_f64).unwrap_or(0.0);
                let due = self.vm.advance(dt).map_err(err)?;
                Ok(J::Array(due.iter().map(|fb| self.keep_fiber(fb)).collect()))
            }
            "fiber" => {
                let fb = self.fiber(req)?;
                let b = fb.borrow();
                let results = b.results.as_ref().map(|r| self.bridge.borrow_mut().encode_list(r)).unwrap_or(J::Null);
                Ok(json!({
                    "status": b.status.name(),
                    "results": results,
                    "error": b.error.as_ref().map(error_json),
                    "waiting": match b.waiting { Waiting::Time => J::from("time"), Waiting::Signal => J::from("signal"), Waiting::Nothing => J::Null },
                    "wake": b.wake,
                    "name": b.name,
                }))
            }
            "kill" => {
                let fb = self.fiber(req)?;
                self.vm.kill(&fb).map_err(err)?;
                Ok(J::Null)
            }
            "fire" => match self.arg(req, "signal")? {
                Value::Signal(s) => {
                    self.vm.fire(&s).map_err(err)?;
                    Ok(J::Null)
                }
                _ => Err(api_err("fire needs a signal")),
            },
            "signal" => {
                let s = self.vm.signal().map_err(err)?;
                Ok(self.bridge.borrow_mut().encode(&Value::Signal(s)))
            }
            "next_wake" => Ok(self.vm.next_wake().map(J::from).unwrap_or(J::Null)),
            "time" => Ok(J::from(self.vm.time)),
            "new" => {
                let m = self.module(req)?;
                let o = self.vm.new_object(&m, Self::str_arg(req, "class")).map_err(err)?;
                Ok(self.bridge.borrow_mut().encode(&Value::Obj(o)))
            }
            "call_method" => {
                let m = self.module(req)?;
                let obj = match self.arg(req, "obj")? {
                    Value::Obj(o) => Some(o),
                    _ => None,
                };
                let args = self.args(req)?;
                let r = self.vm.call_method(&m, obj.as_ref(), Self::str_arg(req, "method"), &args);
                self.results(r)
            }
            "delegate" => {
                let m = self.module(req)?;
                let obj = match self.arg(req, "obj")? {
                    Value::Obj(o) => Some(o),
                    _ => None,
                };
                let d = self.vm.delegate(&m, Self::str_arg(req, "func"), obj.as_ref()).map_err(err)?;
                Ok(self.bridge.borrow_mut().encode(&Value::Delegate(d)))
            }
            "broadcast" => {
                let m = self.module(req)?;
                let Value::Obj(o) = self.arg(req, "obj")? else { return Err(api_err("broadcast needs an object")) };
                let args = self.args(req)?;
                self.vm.broadcast(&m, &o, Self::str_arg(req, "dispatcher"), &args).map_err(err)?;
                Ok(J::Null)
            }
            "global" => {
                let m = self.module(req)?;
                let i = req.get("index").and_then(J::as_u64).unwrap_or(0) as usize;
                let v = m.globals.borrow().get(i).cloned().unwrap_or(Value::Null);
                Ok(self.bridge.borrow_mut().encode(&v))
            }
            "grant" => {
                self.vm.grant(Self::str_arg(req, "capability")).map_err(err)?;
                Ok(J::Null)
            }
            "interrupt" => {
                self.vm.interrupt();
                Ok(J::Null)
            }
            "stats" => Ok(json!({
                "instructions": self.vm.stats.instructions,
                "calls": self.vm.stats.calls,
                "replayable": self.vm.stats.replayable,
                "fuel": self.vm.fuel,
            })),
            "input_log" => Ok(J::Array(self.vm.input_log.clone())),
            "release" => {
                let ids: Vec<usize> =
                    req.get("ids").and_then(J::as_array).map(|a| a.iter().filter_map(|x| x.as_u64().map(|i| i as usize)).collect()).unwrap_or_default();
                self.bridge.borrow_mut().release(&ids);
                for id in &ids {
                    self.fibers.remove(id);
                }
                Ok(J::Null)
            }
            other => Err(api_err(format!("unknown request '{other}'"))),
        }
    }

    /// The fiber status names the replies use.
    pub fn status_name(s: FiberStatus) -> &'static str {
        s.name()
    }
}

/// A reply as one JSON document: `{"ok": value}` or `{"err": {status, message, traceback, code}}`.
pub fn reply_json(r: Reply) -> J {
    match r {
        Ok(v) => json!({ "ok": v }),
        Err(e) => json!({ "err": e }),
    }
}
