//! The Wiret runtime (the `wiret-runtime` crate in runtime/) for the desktop app: VMs that run
//! natively in this process, which the page drives through Tauri commands (src/web/nativevm.ts).
//!
//! A VM holds single-threaded values (`Rc`), so every VM lives on one worker thread and each
//! command is a job sent to it. A request and its reply are the runtime's JSON protocol
//! (runtime/src/bridge.rs); each reply also carries the output lines the VM wrote meanwhile.
//! `runtime_interrupt` does not queue: it sets the VM's interrupt flag from the calling thread,
//! so it stops a run that is still going.
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::atomic::AtomicBool;
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::{json, Value as J};
use wiret_runtime::bridge::{reply_json, Session};

struct Vm {
    session: Session,
    output: Rc<RefCell<Vec<String>>>,
}

type Job = Box<dyn FnOnce(&mut HashMap<u32, Vm>) + Send>;

struct Worker {
    jobs: Mutex<Sender<Job>>,
    /// each VM's interrupt flag, which any thread may set
    flags: Mutex<HashMap<u32, Arc<AtomicBool>>>,
}

fn worker() -> &'static Worker {
    static W: OnceLock<Worker> = OnceLock::new();
    W.get_or_init(|| {
        let (tx, rx) = channel::<Job>();
        std::thread::Builder::new()
            .name("wiret-runtime".into())
            // deep Wiret call stacks recurse in the runtime's broadcast path
            .stack_size(64 << 20)
            .spawn(move || {
                let mut vms = HashMap::new();
                for job in rx {
                    job(&mut vms);
                }
            })
            .expect("could not start the Wiret runtime thread");
        Worker { jobs: Mutex::new(tx), flags: Mutex::new(HashMap::new()) }
    })
}

/// Run `f` on the runtime thread and wait for its result, off the main thread.
async fn on_runtime<T: Send + 'static>(f: impl FnOnce(&mut HashMap<u32, Vm>) -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (tx, rx) = channel();
        let job: Job = Box::new(move |vms| {
            let _ = tx.send(f(vms));
        });
        worker().jobs.lock().map_err(|e| e.to_string())?.send(job).map_err(|_| "the Wiret runtime has stopped".to_string())?;
        rx.recv().map_err(|_| "the Wiret runtime has stopped".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// `{"ok": ..., "output": [...]}` or `{"err": ..., "output": [...]}`.
fn with_output(mut reply: J, vm: &Vm) -> J {
    let lines: Vec<String> = std::mem::take(&mut *vm.output.borrow_mut());
    reply["output"] = json!(lines);
    reply
}

fn no_vm(id: u32) -> J {
    json!({ "err": { "status": "WR_ERR_API", "message": format!("no VM {id}"), "traceback": [], "code": 0 }, "output": [] })
}

/// A new VM. `config` is `{"deterministic": bool, "fuel": n, "capabilities": [..] | null}`.
#[tauri::command]
pub async fn runtime_new(config: J) -> Result<u32, String> {
    on_runtime(move |vms| {
        static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);
        let id = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let output = Rc::new(RefCell::new(Vec::new()));
        let sink = output.clone();
        let session = Session::new(&config, move |line| sink.borrow_mut().push(line.to_string()));
        if let Ok(mut flags) = worker().flags.lock() {
            flags.insert(id, session.vm.interrupt_flag());
        }
        vms.insert(id, Vm { session, output });
        id
    })
    .await
}

/// Load a module (the bytes of a `.wbc` file) into VM `id`.
#[tauri::command]
pub async fn runtime_load(id: u32, bytes: Vec<u8>) -> Result<J, String> {
    on_runtime(move |vms| match vms.get_mut(&id) {
        Some(vm) => {
            let r = vm.session.load(&bytes);
            with_output(reply_json(r), vm)
        }
        None => no_vm(id),
    })
    .await
}

/// One request to VM `id` (see `Session::command` in runtime/src/bridge.rs).
#[tauri::command]
pub async fn runtime_command(id: u32, request: J) -> Result<J, String> {
    on_runtime(move |vms| match vms.get_mut(&id) {
        Some(vm) => {
            let r = vm.session.command(&request);
            with_output(reply_json(r), vm)
        }
        None => no_vm(id),
    })
    .await
}

/// Stop VM `id`'s running code at its next check. Returns at once.
#[tauri::command]
pub fn runtime_interrupt(id: u32) -> bool {
    let flag = worker().flags.lock().ok().and_then(|f| f.get(&id).cloned());
    match flag {
        Some(f) => {
            f.store(true, std::sync::atomic::Ordering::Relaxed);
            true
        }
        None => false,
    }
}

#[tauri::command]
pub async fn runtime_free(id: u32) -> Result<bool, String> {
    if let Ok(mut flags) = worker().flags.lock() {
        flags.remove(&id);
    }
    on_runtime(move |vms| vms.remove(&id).is_some()).await
}

/// The capabilities a module declares, before loading it.
#[tauri::command]
pub fn runtime_module_capabilities(bytes: Vec<u8>) -> Result<Vec<String>, String> {
    wiret_runtime::module_capabilities(&bytes).map_err(|e| e.to_string())
}
