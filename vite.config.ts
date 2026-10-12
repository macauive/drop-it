import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { inlineWidget } from "./scripts/inline-widget.js";
export default defineConfig({
  root: "web",
  base: "./",
  plugins: [react(), inlineWidget()],
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
    sourcemap: false,
    assetsInlineLimit: () => true,
    cssCodeSplit: false,
    assetsDir: "",
    rolldownOptions: { output: { codeSplitting: false } },
  },
});
