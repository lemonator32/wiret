#!/usr/bin/env node
// The `wiret` command. `npm run wiret -- ARGS` runs it from source; `npm run cli` bundles it
// into cli/wiret.js, the file the npm package's `bin` points to.
import { cli } from "./wiret.js";

process.exitCode = await cli(process.argv.slice(2));
