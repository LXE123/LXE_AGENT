import { expect, test } from "bun:test";
import { instant, localTime } from "../../../src/features/automations/form";

test("form dates use the selected timezone and reject ambiguous or nonexistent DST instants",()=>{
  expect(instant("2026-10-24T09:00","Asia/Shanghai")).toBe(Date.parse("2026-10-24T01:00:00Z"));
  expect(localTime(Date.parse("2026-10-24T01:00:00Z"),"Asia/Shanghai")).toBe("2026-10-24T09:00");
  expect(()=>instant("2026-03-08T02:30","America/New_York")).toThrow();
  expect(()=>instant("2026-11-01T01:30","America/New_York")).toThrow();
});
