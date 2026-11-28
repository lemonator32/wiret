// Bundles the command line into cli/wiret.js, with the runtime next to it as
// cli/wiret_runtime.wasm (runtime.ts loads it relative to its own module). These two files are
// what the npm package ships.
//   node scripts/cli.mjs
import { build } from "esbuild";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "cli");
rmSync(out, { recursive: true, force: true });
mkdirSync(out);
await build({
  entryPoints: [join(root, "src/cli/bin.ts")],
  outfile: join(out, "wiret.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minifyWhitespace: true,
  legalComments: "none",
  logLevel: "warning",
});
copyFileSync(join(root, "src/core/wiret_runtime.wasm"), join(out, "wiret_runtime.wasm"));
console.log("cli.mjs: cli/wiret.js and cli/wiret_runtime.wasm");
