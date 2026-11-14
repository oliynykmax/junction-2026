// Bundles the landing page's client (web/landing.ts) with @ui-sdk/web into
// ../landing/assets/landing.js, which the Worker serves at /assets/landing.js.
// The output is a build artifact (git-ignored), made by `bun run build`.

import { defineConfig } from "vite";

export default defineConfig({
  publicDir: false,
  build: {
    outDir: "../landing/assets",
    emptyOutDir: false,
    rollupOptions: {
      input: "web/landing.ts",
      output: { entryFileNames: "landing.js", inlineDynamicImports: true },
    },
  },
});
