// Builds the review page's client (web/) into ../landing/review/, which the
// Worker serves from its static assets at /review/. File names are fixed so the page shell
// in src/page.ts can reference them without a manifest.

import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [preact()],
  base: "/review/",
  publicDir: false,
  build: {
    outDir: "../landing/review",
    emptyOutDir: true,
    rollupOptions: {
      input: "web/main.tsx",
      output: {
        entryFileNames: "app.js",
        assetFileNames: (asset) =>
          asset.names.some((n) => n.endsWith(".css"))
            ? "app.css"
            : "assets/[name]-[hash][extname]",
      },
    },
  },
});
