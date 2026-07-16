import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { singleReactRuntimeGuard } from "./vite/react-runtime-guard";

export default defineConfig({
  plugins: [react(), singleReactRuntimeGuard()],
  resolve: {
    dedupe: ["react", "react-dom"]
  },
  server: {
    host: "127.0.0.1",
    port: 5173
  }
});
