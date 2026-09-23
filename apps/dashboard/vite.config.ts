import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolveDashboardDevPort } from "./vite/dev-server";
import { singleReactRuntimeGuard } from "./vite/react-runtime-guard";
import { rendererCspGuard } from "./vite/renderer-csp-guard";

export default defineConfig({
  plugins: [react(), singleReactRuntimeGuard(), rendererCspGuard()],
  resolve: {
    dedupe: ["react", "react-dom"]
  },
  server: {
    host: "127.0.0.1",
    port: resolveDashboardDevPort(),
    strictPort: true,
  }
});
