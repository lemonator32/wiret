import { defineConfig } from "vite";

// One build for both targets: `npm run build` makes the static site in dist/ (GitHub Pages
// serves it under /wiret/, so assets use relative URLs), and Tauri loads the same dist/.
export default defineConfig({
  base: "./",
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "es2022",
    outDir: "dist",
    sourcemap: true,
  },
});
