// From the repository root: bun apps/dashboard/test/features/sessions/display-fixture-server.ts
import { resolve } from "node:path";
import { createServer } from "vite";
const server = await createServer({ root: resolve("apps/dashboard"), server: { host: "127.0.0.1", port: 5199, strictPort: true } });
await server.listen();
console.log("http://127.0.0.1:5199/test/features/sessions/display-fixture.html");
