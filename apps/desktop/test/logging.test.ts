import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@lxe/core";
import type { DesktopLoggingSinkStatus } from "@lxe/desktop-protocol";
import { DesktopLoggingManager } from "../src/main/logging";

const roots: string[] = [];
const managers: DesktopLoggingManager[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("DesktopLoggingManager", () => {
  test("uses an isolated desktop log and applies logging profile changes", () => {
    const root = mkdtempSync(join(tmpdir(), "lxe-desktop-logging-"));
    roots.push(root);
    const statuses: DesktopLoggingSinkStatus[] = [];
    let profile: "standard" | "diagnostic" | "off" = "standard";
    const manager = new DesktopLoggingManager({
      dataRoot: root,
      environment: () => ({
        LOCAL_LOGS_ENABLED: profile === "off" ? "0" : "1",
        LOG_LEVEL: "ERROR",
        RUNTIME_LOG_LEVEL: profile === "diagnostic" ? "DEBUG" : "INFO",
      }),
      onStatusChange: (status) => statuses.push(status),
    });
    managers.push(manager);

    const active = manager.configure();
    expect(active).toMatchObject({
      local_file_enabled: true,
      console_level: "error",
      file_level: "info",
    });
    expect(active.file_path).toMatch(/logs[\\/]runtime[\\/]\d{8}[\\/]desktop\.log$/u);
    expect(active.file_path).not.toMatch(/var[\\/]var[\\/]/u);
    createLogger("gateway.desktop_test").debug("standard_filtered_record");
    createLogger("gateway.desktop_test").info("desktop_test_record");
    const activeContent = readFileSync(active.file_path, "utf8");
    expect(activeContent).toContain('"message":"logging_configured"');
    expect(activeContent).toContain('"message":"desktop_test_record"');
    expect(activeContent).not.toContain("standard_filtered_record");

    profile = "diagnostic";
    const diagnostic = manager.configure();
    expect(diagnostic.file_level).toBe("debug");
    createLogger("gateway.desktop_test").debug("diagnostic_record");
    const diagnosticContent = readFileSync(active.file_path, "utf8");
    expect(diagnosticContent).toContain('"message":"diagnostic_record"');

    profile = "off";
    const disabled = manager.configure();
    expect(disabled).toMatchObject({
      local_file_enabled: false,
      disabled_reason: "disabled_by_config",
    });
    createLogger("gateway.desktop_test").info("disabled_record");
    expect(readFileSync(active.file_path, "utf8")).toBe(diagnosticContent);
    expect(statuses.at(-1)).toEqual(disabled);
  });
});
