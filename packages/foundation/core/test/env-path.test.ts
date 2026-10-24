import { expect, test } from "bun:test";
import { withExecutablePath } from "../src/env";

test("managed tools precede inherited PATH without conflicting Windows casing", () => {
  const inherited = { Path: "C:\\Windows", PATH: "C:\\Tools;C:\\Windows", OTHER: "keep" };
  const env = withExecutablePath(inherited, "C:\\App\\python;C:\\Tools", "win32");
  expect(env).toEqual({ PATH: "C:\\App\\python;C:\\Tools;C:\\Windows", OTHER: "keep" });
  expect(inherited.Path).toBe("C:\\Windows");
  expect(withExecutablePath({ Path: "C:\\Windows" }, "C:\\App", "win32").PATH).toBe("C:\\App;C:\\Windows");
  expect(withExecutablePath({ PATH: "/usr/bin", Path: "unrelated" }, "/app/bin", "darwin"))
    .toEqual({ PATH: "/app/bin:/usr/bin", Path: "unrelated" });
});
