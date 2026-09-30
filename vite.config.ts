import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";
export default defineConfig({
  root: "web",
  plugins: [react(), viteSingleFile()],
  build: { outDir: "../dist/web", emptyOutDir: true, sourcemap: false },
});
