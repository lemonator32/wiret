// Every test file runs programs on the Rust runtime (runtime/), compiled to WebAssembly.
import { init } from "../src/core/vm.js";

await init();
