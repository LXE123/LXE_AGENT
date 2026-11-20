// Real CLI/OAuth, with only the OS browser launch delegated to a loopback fixture.
import { sanitizeLogValueWithPolicy } from "@lxe/core";
import { runMcpCommand } from "../src/mcp-command";

if (import.meta.main) {
  console.log = (...values) => { process.stderr.write(values.map(String).join(" ") + "\n"); };
  const [endpoint, ...args] = process.argv.slice(2);
  try {
    process.exitCode = await runMcpCommand(args, async url => {
      const response = await fetch(endpoint!, { method: "POST", body: url });
      if (!response.ok) throw new Error(await response.text());
    });
  } catch (error) {
    process.stderr.write(String(sanitizeLogValueWithPolicy(error instanceof Error ? error.message : String(error), { maxString: 4_000 })) + "\n");
    process.exitCode = 1;
  }
}
