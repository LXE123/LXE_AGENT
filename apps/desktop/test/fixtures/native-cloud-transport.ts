import assert from "node:assert/strict";
import { CloudHttpError } from "../../src/main/cloud/cloud-errors";
import { DirectNativeCloudClient } from "../../src/main/cloud/native-cloud-client";

const paths: string[] = [];
const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const path = new URL(request.url).pathname;
  paths.push(path);
  assert.equal(request.headers.get("authorization"), null);
  assert.equal(request.headers.get("cookie"), null);
  assert.equal(request.headers.get("x-lxe-client"), "cli");
  if (path.endsWith("redirect")) return new Response(null, { status: 302, headers: { location: "/leak" } });
  return Response.json({ ok: true });
} });
try {
  const client = new DirectNativeCloudClient(), signal = new AbortController().signal;
  const server = `http://127.0.0.1:${upstream.port}`;
  assert.deepEqual(await client.request(server, "/api/v1/device-access", signal), { ok: true });
  // Settle real I/O before asserting: Bun's .rejects matcher can crash in libuv on Windows.
  const error = await client.request(server, "/api/v1/device-access/redirect", signal).catch(cause => cause);
  assert.ok(error instanceof CloudHttpError);
  assert.equal(error.httpStatus, 302);
  assert.deepEqual(paths, ["/api/v1/device-access", "/api/v1/device-access/redirect"]);
  console.log(JSON.stringify({ paths, redirectStatus: error.httpStatus }));
} finally {
  await upstream.stop(true);
}
