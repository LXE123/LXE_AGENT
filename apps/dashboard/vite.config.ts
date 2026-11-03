import { pdfAssets } from "./vite/pdf-assets";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { singleReactRuntimeGuard } from "./vite/react-runtime-guard";
import { rendererCspGuard } from "./vite/renderer-csp-guard";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [pdfAssets(), react(), tailwindcss(), singleReactRuntimeGuard(), rendererCspGuard()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    dedupe: ["react", "react-dom"]
  },
  server: {
    host: "127.0.0.1",
    port: 5173
  }
});
