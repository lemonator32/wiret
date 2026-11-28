//! The WebAssembly interface the web editor loads (`src/core/vm.ts`). Plain C-ABI exports, no
//! bindings generator: the host passes bytes and JSON in memory it gets from `wr_alloc`, and
//! reads each reply (JSON, see [`crate::bridge`]) from `wr_result_ptr()` for the length the
//! call returns.
//!
//! The module imports two functions from `env`:
//!
//! - `wr_host_output(vm, ptr, len)`: a line of output (UTF-8).
//! - `wr_host_hook(vm, phase, func_ptr, func_len, node_ptr, node_len, depth)`: the VM entered
//!   a node (phase 0) or reached a stepping point (phase 1). The strings stay at the same
//!   address while the VM lives, so the host can cache them by pointer. During the call the
//!   host may call `wr_hook_view` to see the call stack and globals.
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

use serde_json::{json, Value as J};

use crate::bridge::{error_json, reply_json, Bridge, Session};
use crate::vm::{module_capabilities, DebugView, Phase, VmOptions};

#[link(wasm_import_module = "env")]
extern "C" {
    fn wr_host_output(vm: u32, ptr: *const u8, len: usize);
    fn wr_host_hook(vm: u32, phase: u32, func_ptr: *const u8, func_len: usize, node_ptr: *const u8, node_len: usize, depth: u32);
}

type ViewPtr = *const (dyn DebugView + 'static);

thread_local! {
    static SESSIONS: RefCell<HashMap<u32, Rc<RefCell<Session>>>> = RefCell::new(HashMap::new());
    static NEXT: Cell<u32> = const { Cell::new(1) };
    static RESULT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    /// the view of the VM while a hook runs, and the bridge to encode values with
    static HOOK: Cell<Option<(ViewPtr, *const RefCell<Bridge>)>> = const { Cell::new(None) };
}

fn set_result(j: &J) -> usize {
    let bytes = j.to_string().into_bytes();
    let n = bytes.len();
    RESULT.with(|r| *r.borrow_mut() = bytes);
    n
}

unsafe fn input<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
    if len == 0 {
        &[]
    } else {
        std::slice::from_raw_parts(ptr, len)
    }
}

unsafe fn input_json(ptr: *const u8, len: usize) -> J {
    serde_json::from_slice(input(ptr, len)).unwrap_or(J::Null)
}

fn session(id: u32) -> Option<Rc<RefCell<Session>>> {
    SESSIONS.with(|s| s.borrow().get(&id).cloned())
}

#[no_mangle]
pub extern "C" fn wr_alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len.max(1));
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// `ptr` and `len` must come from one `wr_alloc`.
#[no_mangle]
pub unsafe extern "C" fn wr_free(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, 0, len.max(1)));
}

#[no_mangle]
pub extern "C" fn wr_result_ptr() -> *const u8 {
    RESULT.with(|r| r.borrow().as_ptr())
}

/// A new VM from a JSON config (`{"deterministic", "fuel", "capabilities", "hook"}`); its id.
///
/// # Safety
/// `ptr` and `len` must describe readable memory.
#[no_mangle]
pub unsafe extern "C" fn wr_vm_new(ptr: *const u8, len: usize) -> u32 {
    let cfg = input_json(ptr, len);
    let id = NEXT.with(|n| {
        let id = n.get();
        n.set(id + 1);
        id
    });
    let mut s = Session::new(&cfg, move |line| unsafe { wr_host_output(id, line.as_ptr(), line.len()) });
    if cfg.get("hook").and_then(J::as_bool).unwrap_or(false) {
        let bridge = s.bridge.clone();
        s.vm.set_hook(Some(Box::new(move |ev, view| {
            let p: *const (dyn DebugView + '_) = view;
            // SAFETY: the pointer is only read by wr_hook_view while this call is running
            let p: ViewPtr = unsafe { std::mem::transmute(p) };
            let prev = HOOK.with(|h| h.replace(Some((p, Rc::as_ptr(&bridge)))));
            let phase = if ev.phase == Phase::Enter { 0 } else { 1 };
            unsafe {
                wr_host_hook(id, phase, ev.func.as_ptr(), ev.func.len(), ev.node.as_ptr(), ev.node.len(), ev.depth as u32);
            }
            HOOK.with(|h| h.set(prev));
        })));
    }
    SESSIONS.with(|m| m.borrow_mut().insert(id, Rc::new(RefCell::new(s))));
    id
}

#[no_mangle]
pub extern "C" fn wr_vm_free(id: u32) {
    let s = SESSIONS.with(|m| m.borrow_mut().remove(&id));
    drop(s);
}

fn no_vm(id: u32) -> usize {
    set_result(&json!({ "err": error_json(&crate::vm::WiretError::new(crate::vm::STATUS_API, format!("no VM {id}"))) }))
}

/// Load a module into VM `id`. The reply's length; the reply is `{"ok": module info}` or
/// `{"err": error}`.
///
/// # Safety
/// `ptr` and `len` must describe readable memory.
#[no_mangle]
pub unsafe extern "C" fn wr_load(id: u32, ptr: *const u8, len: usize) -> usize {
    let Some(s) = session(id) else { return no_vm(id) };
    let bytes = input(ptr, len).to_vec();
    let r = s.borrow_mut().load(&bytes);
    set_result(&reply_json(r))
}

/// Run one JSON request on VM `id` (see [`Session::command`]).
///
/// # Safety
/// `ptr` and `len` must describe readable memory.
#[no_mangle]
pub unsafe extern "C" fn wr_command(id: u32, ptr: *const u8, len: usize) -> usize {
    let Some(s) = session(id) else { return no_vm(id) };
    let req = input_json(ptr, len);
    let r = s.borrow_mut().command(&req);
    set_result(&reply_json(r))
}

/// While a hook runs: the call stack (`kind` 0) as `[{func, node, locals: [[name, value]],
/// pins: [[node, pin, value]]}]`, global `arg` of the running module (1), or the pending
/// continuation nodes (2).
#[no_mangle]
pub extern "C" fn wr_hook_view(kind: u32, arg: u32) -> usize {
    let Some((view, bridge)) = HOOK.with(|h| h.get()) else {
        return set_result(&J::Null);
    };
    // SAFETY: HOOK is only set while the hook that owns these runs
    let (view, bridge) = unsafe { (&*view, &*bridge) };
    let mut b = bridge.borrow_mut();
    let out = match kind {
        0 => J::Array(
            view.frames()
                .iter()
                .map(|fr| {
                    let locals: Vec<J> = fr.named_locals().iter().map(|(n, v)| json!([n, b.encode(v)])).collect();
                    let pins: Vec<J> = fr.pin_values().values().map(|(n, p, v)| json!([&**n, &**p, b.encode(v)])).collect();
                    json!({ "func": &*fr.func.name, "node": fr.node.as_deref(), "locals": locals, "pins": pins })
                })
                .collect(),
        ),
        1 => view.global(arg as usize).map(|v| b.encode(&v)).unwrap_or(J::Null),
        _ => J::Array(view.pending().into_iter().map(|p| p.map(J::from).unwrap_or(J::Null)).collect()),
    };
    set_result(&out)
}

/// The capabilities a module declares, before loading it: `{"ok": [...]}` or `{"err": ...}`.
///
/// # Safety
/// `ptr` and `len` must describe readable memory.
#[no_mangle]
pub unsafe extern "C" fn wr_module_capabilities(ptr: *const u8, len: usize) -> usize {
    let r = module_capabilities(input(ptr, len)).map(|c| json!(c)).map_err(|e| error_json(&e));
    set_result(&reply_json(r))
}

/// Decode and verify a module without loading it: `{"ok": [max stack height per defined
/// function]}` or `{"err": message}`. The compiler uses it to fill in `max_stack`.
///
/// # Safety
/// `ptr` and `len` must describe readable memory.
#[no_mangle]
pub unsafe extern "C" fn wr_verify(ptr: *const u8, len: usize) -> usize {
    let r = crate::wbc::decode_module(input(ptr, len))
        .map_err(|e| e.0)
        .and_then(|m| crate::verifier::verify(&m).map_err(|e| e.0))
        .map(|fs| json!(fs.iter().map(|(_, h)| *h).collect::<Vec<_>>()))
        .map_err(J::from);
    set_result(&reply_json(r))
}

/// A module's disassembly (`wiret dis`): `{"ok": text}` or `{"err": message}`.
///
/// # Safety
/// `ptr` and `len` must describe readable memory.
#[no_mangle]
pub unsafe extern "C" fn wr_disassemble(ptr: *const u8, len: usize) -> usize {
    let r = crate::disasm::disassemble(input(ptr, len)).map(J::from).map_err(|e| J::from(e.0));
    set_result(&reply_json(r))
}

/// The signature of every native the runtime provides (see `natives::native_table`).
#[no_mangle]
pub extern "C" fn wr_natives() -> usize {
    set_result(&crate::natives::native_table())
}

/// A float as Wiret writes it (section 3.2), as a JSON string; `single` for an f32.
#[no_mangle]
pub extern "C" fn wr_float_text(x: f64, single: u32) -> usize {
    set_result(&J::from(crate::fmt::float_to_text(x, single != 0)))
}

/// Replay an input log (JSON) against a module: `{"ok": {"instructions": n}}`, or
/// `{"mismatch": message}`, or `{"err": message}` for a log that cannot be read.
///
/// # Safety
/// Both pointer and length pairs must describe readable memory.
#[no_mangle]
pub unsafe extern "C" fn wr_replay(data_ptr: *const u8, data_len: usize, log_ptr: *const u8, log_len: usize) -> usize {
    let log = input_json(log_ptr, log_len);
    let entries = log.as_array().cloned().unwrap_or_default();
    let out = match crate::log::replay(input(data_ptr, data_len), &entries, VmOptions::default()) {
        Ok(vm) => json!({ "ok": { "instructions": vm.stats.instructions } }),
        Err(crate::log::ReplayError::Mismatch(m)) => json!({ "mismatch": m.to_string() }),
        Err(e) => json!({ "err": e.to_string() }),
    };
    set_result(&out)
}
