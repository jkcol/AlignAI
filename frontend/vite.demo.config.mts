import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import { renameSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Build config for the public, backend-free demo (frontend/demo.html).
 *
 * Deployed to GitHub Pages, so `base` defaults to the repo subpath. Override
 * with DEMO_BASE=/ when serving from a custom domain or a local preview.
 */
const base = process.env.DEMO_BASE ?? "/AlignAI/";
const outDir = resolve(__dirname, "dist-demo");

export default defineConfig({
  base,
  plugins: [
    react(),
    {
      // Pages serves the directory index, so emit demo.html as index.html.
      name: "demo-html-as-index",
      closeBundle() {
        const built = resolve(outDir, "demo.html");
        if (existsSync(built)) renameSync(built, resolve(outDir, "index.html"));
      },
    },
  ],
  build: {
    outDir,
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, "demo.html"),
    },
  },
});
