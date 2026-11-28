import { defineConfig } from "vite";

// One build for both targets: `npm run build` makes the static site in dist/ (GitHub Pages
// serves it under /wiret/, so assets use relative URLs), and Tauri loads the same dist/.
export default defineConfig({
  base: "./",
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    // Cargo's build folders are not page sources, and on Windows watching them crashes Vite
    // (EBUSY) when Cargo locks a DLL mid-build, which makes the first `tauri dev` fail.
    watch: { ignored: ["**/src-tauri/**", "**/runtime/target/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "es2022",
    outDir: "dist",
    sourcemap: true,
  },
});
