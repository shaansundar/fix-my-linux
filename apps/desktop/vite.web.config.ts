import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/** Browser-only renderer for UI work and the #/gallery parity check (no Electron APIs). */
export default defineConfig({
  root: resolve(__dirname, "src/renderer"),
  resolve: { alias: { "@": resolve(__dirname, "src/renderer") } },
  plugins: [react(), tailwindcss()],
  server: { port: 5199, strictPort: true },
});
