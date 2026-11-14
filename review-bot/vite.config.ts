// Builds the review page and dashboard clients (web/) into ../landing/review/,
// which the Worker serves from its static assets at /review/. File names are
// fixed so the shells in src/page.ts and src/dashboard.ts can reference them
// without a manifest.

import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [preact()],
  base: "/review/",
  publicDir: false,
  build: {
    outDir: "../landing/review",
    emptyOutDir: true,
    // One stylesheet for both pages: split CSS would land in a hashed shared chunk.
    cssCodeSplit: false,
    rollupOptions: {
      input: { app: "web/main.tsx", dashboard: "web/dashboard.tsx" },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: (asset) =>
          asset.names.some((n) => n.endsWith(".css"))
            ? "app.css"
            : "assets/[name]-[hash][extname]",
      },
    },
  },
});
