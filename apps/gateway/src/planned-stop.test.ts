import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GatewayStatusFiles,
  PlannedStopPoller,
} from "./planned-stop";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "LXE 状态 with spaces "));
  roots.push(root);
  let now = new Date("2026-07-10T02:00:00.000Z");
  const files = new GatewayStatusFiles({
    projectRoot: root,
    pid: 4321,
    requesterPid: 8765,
    now: () => now,
  });
  return { files, root, setNow: (value: string) => { now = new Date(value); } };
};

describe("GatewayStatusFiles", () => {
  test("writes exact compatible status and marker fields as atomic UTF-8 JSON", () => {
    const { files } = fixture();
    const status = files.writeStatus("boot-中文");
    expect(status).toEqual({
      pid: 4321,
      boot_id: "boot-中文",
      started_at: "2026-07-10T02:00:00.000Z",
      marker_path: files.markerPath,
    });
    const marker = files.writePlannedStopMarker(status);
    expect(marker).toEqual({
      target_pid: 4321,
      target_boot_id: "boot-中文",
      requester_pid: 8765,
      requested_at: "2026-07-10T02:00:00.000Z",
    });
    expect(JSON.parse(readFileSync(files.statusPath, "utf8"))).toEqual(status);
    expect(JSON.parse(readFileSync(files.markerPath, "utf8"))).toEqual(marker);
  });

  test("consumes self marker and removes stale or foreign markers", () => {
    const { files, setNow } = fixture();
    const status = files.writeStatus("boot-a");
    files.writePlannedStopMarker(status);
    expect(files.markerTargetsSelf("boot-a")).toBe(true);
    expect(files.consumeMarkerForSelf("boot-a")).toBe(true);
    expect(files.readMarker()).toBeUndefined();

    writeFileSync(files.markerPath, JSON.stringify({
      target_pid: 9999,
      target_boot_id: "foreign",
      requester_pid: 1,
      requested_at: "2026-07-10T02:00:00.000Z",
    }), "utf8");
    expect(files.consumeMarkerForSelf("boot-a")).toBe(false);
    expect(files.readMarker()).toBeUndefined();

    files.writePlannedStopMarker(status);
    setNow("2026-07-10T02:05:01.000Z");
    expect(files.markerTargetsSelf("boot-a")).toBe(false);
    expect(files.consumeMarkerForSelf("boot-a")).toBe(false);
    expect(files.readMarker()).toBeUndefined();
  });

  test("clears status only for the matching boot and accepts naive UTC timestamps", () => {
    const { files } = fixture();
    files.writeStatus("boot-a");
    files.clearStatus("boot-b");
    expect(files.readStatus()?.boot_id).toBe("boot-a");

    const status = files.readStatus()!;
    files.writePlannedStopMarker(status);
    const marker = files.readMarker()!;
    writeFileSync(files.markerPath, JSON.stringify({
      ...marker,
      requested_at: "2026-07-10T02:00:00",
    }), "utf8");
    expect(files.markerTargetsSelf("boot-a")).toBe(true);
    files.clearStatus("boot-a");
    expect(files.readStatus()).toBeUndefined();
  });
});

describe("PlannedStopPoller", () => {
  test("reports a poll error and continues polling", () => {
    const { files } = fixture();
    const scheduled: Array<() => void> = [];
    const errors: Error[] = [];
    let polls = 0;
    let stops = 0;
    files.consumeMarkerForSelf = () => {
      polls += 1;
      if (polls === 1) throw new Error("transient read failure");
      return true;
    };
    const poller = new PlannedStopPoller(
      files,
      {
        setInterval(callback) {
          scheduled.push(callback);
          return 1;
        },
        clearInterval: () => undefined,
      },
      (error) => errors.push(error),
    );
    poller.start("boot-a", () => {
      stops += 1;
    });

    expect(() => scheduled[0]!()).not.toThrow();
    expect(errors.map((error) => error.message)).toEqual(["transient read failure"]);
    scheduled[0]!();
    expect(stops).toBe(1);
  });

  test("polls, consumes a targeted marker, and requests shutdown once", () => {
    const { files } = fixture();
    const status = files.writeStatus("boot-a");
    files.writePlannedStopMarker(status);
    const scheduled: Array<() => void> = [];
    let clears = 0;
    let stops = 0;
    const poller = new PlannedStopPoller(files, {
      setInterval: (callback, milliseconds) => {
        expect(milliseconds).toBe(500);
        scheduled.push(callback);
        return 11;
      },
      clearInterval: (token) => {
        expect(token).toBe(11);
        clears += 1;
      },
    });
    poller.start("boot-a", () => {
      stops += 1;
    });
    scheduled[0]!();
    scheduled[0]!();
    expect(stops).toBe(1);
    expect(clears).toBe(1);
  });
});
