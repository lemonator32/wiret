// Builds the Rust runtime (runtime/) as WebAssembly and puts it next to src/core/runtime.ts,
// which loads it. Runs before dev, build, test and wiret, as embed.mjs does. Needs a Rust
// toolchain with the wasm32-unknown-unknown target (`rustup target add wasm32-unknown-unknown`).
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const crate = join(root, "runtime");
const built = join(crate, "target", "wasm32-unknown-unknown", "release", "wiret_runtime.wasm");
const out = join(root, "src", "core", "wiret_runtime.wasm");

try {
  execFileSync("cargo", ["build", "--release", "--target", "wasm32-unknown-unknown", "--lib"],
               { cwd: crate, stdio: ["ignore", "inherit", "inherit"] });
} catch (e) {
  if (e.code === "ENOENT") {
    console.error("runtime.mjs: cargo was not found. Install Rust (https://rustup.rs), then run\n" +
                  "  rustup target add wasm32-unknown-unknown");
  }
  process.exit(1);
}
if (!existsSync(out) || statSync(out).mtimeMs < statSync(built).mtimeMs || statSync(out).size !== statSync(built).size) {
  copyFileSync(built, out);
}
console.log(`runtime.mjs: ${statSync(out).size} bytes in src/core/wiret_runtime.wasm`);
