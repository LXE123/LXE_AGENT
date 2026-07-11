import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GatewayStatusFiles } from "./planned-stop";
import { requestGatewayStop } from "./main";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Gateway executable", () => {
  test("writes a targeted stop marker and waits for the recorded process to exit", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-main-stop-"));
    roots.push(root);
    const files = new GatewayStatusFiles({ projectRoot: root, pid: 4242 });
    files.writeStatus("boot-test");
    let probes = 0;
    const stopped = await requestGatewayStop(root, {
      timeoutMs: 100,
      pollMs: 1,
      pidExists: (pid) => {
        expect(pid).toBe(4242);
        probes += 1;
        return probes < 2;
      },
      delay: async () => undefined,
    });
    expect(stopped).toBe(true);
    expect(files.readMarker()).toEqual(expect.objectContaining({
      target_pid: 4242,
      target_boot_id: "boot-test",
    }));
  });

  test("reports no running gateway when status is absent", async () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-main-empty-"));
    roots.push(root);
    expect(await requestGatewayStop(root)).toBe(false);
  });
});
