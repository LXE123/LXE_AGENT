import { expect, test } from "bun:test";
import { managedPythonEnvironment } from "../src/env";

test("managed launches ignore inherited Python configuration without changing the parent", () => {
  const inherited = {
    PYTHONHOME: "/foreign", pythonpath: "/other-checkout", PythonUserBase: "/user-site",
    PYTHONINSPECT: "1", PYTHONNOUSERSITE: "0", PYTHONIOENCODING: "ascii",
    PATH: "/tools", LXE_DATA_ROOT: "/data", HTTPS_PROXY: "http://fixture.invalid",
  };
  const prepared = managedPythonEnvironment(inherited);
  expect(prepared).toEqual({
    PATH: "/tools", LXE_DATA_ROOT: "/data", HTTPS_PROXY: "http://fixture.invalid",
    PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1",
    PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1",
  });
  expect(inherited.PYTHONHOME).toBe("/foreign");
  expect(inherited.PYTHONNOUSERSITE).toBe("0");
});
