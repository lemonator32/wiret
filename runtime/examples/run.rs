//! A minimal host: load a `.wbc` file and run one of its functions, as a game engine would.
//!
//!     cargo run --example run -- game.wbc Main [--deterministic]
//!
//! It also shows how a host adds a native: `host.Now` gives the VM's virtual time. A module
//! uses it with `extern func host.Now() -> (t: f64)`.
use wiret_runtime::{NativeSpec, Value, Vm, VmOptions};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (Some(path), Some(func)) = (args.first(), args.get(1)) else {
        eprintln!("usage: run FILE.wbc FUNC [--deterministic]");
        std::process::exit(2);
    };
    let deterministic = args.iter().any(|a| a == "--deterministic");
    let bytes = std::fs::read(path).unwrap_or_else(|e| {
        eprintln!("{path}: {e}");
        std::process::exit(2);
    });
    let mut vm = Vm::new(VmOptions { deterministic, ..VmOptions::default() });
    vm.register("host.Now", NativeSpec::new(&[], &[("t", "f64")], "impure", |vm, _| Ok(vec![Value::F64(vm.time)])))
        .expect("register host.Now");
    let result = vm.load(&bytes).and_then(|m| vm.run_function(&m, func, &[]));
    match result {
        Ok(values) => {
            if !values.is_empty() {
                println!("{values:?}");
            }
        }
        Err(e) => {
            println!("{e}");
            std::process::exit(1);
        }
    }
}
