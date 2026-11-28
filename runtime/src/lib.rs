//! The Wiret bytecode runtime: decodes, verifies, links and runs WBC 1 modules (the `.wbc`
//! files `wiret build` writes). This is the runtime the reference specification calls
//! `libwiret` (sections 5 and 6), which replaced the TypeScript VM the editor used before.
//! The TypeScript compiler relies on it to verify what it builds, and the editor to
//! disassemble and run it.
//!
//! The same crate serves three hosts:
//!
//! - Rust programs (the Tauri desktop app, a game engine written in Rust) use [`Vm`] directly.
//! - The web editor loads it as WebAssembly (`src/wasm.rs`, built for `wasm32-unknown-unknown`).
//! - Hosts that talk JSON (the WebAssembly build, Tauri IPC) use [`bridge::Session`].
//!
//! ```no_run
//! use wiret_runtime::{Value, Vm, VmOptions};
//! let bytes = std::fs::read("game.wbc").unwrap();
//! let mut vm = Vm::new(VmOptions::default());
//! let module = vm.load(&bytes).unwrap();
//! let results = vm.run_function(&module, "Main", &[]).unwrap();
//! # let _ = (results, Value::Null);
//! ```
pub mod bridge;
pub mod detmath;
pub mod disasm;
pub mod fmt;
pub mod lanes;
pub mod log;
pub mod natives;
pub mod value;
pub mod verifier;
pub mod vm;
pub mod wbc;

#[cfg(target_arch = "wasm32")]
mod wasm;

pub use log::{replay, ReplayError, ReplayMismatch};
pub use natives::{NativeFault, NativeSpec};
pub use value::{Obj, Value};
pub use vm::{
    module_capabilities, DebugView, Fiber, FiberRef, FiberStatus, FrameView, HookEvent, LoadedModule, Phase, Vm, VmOptions,
    WiretError,
};
