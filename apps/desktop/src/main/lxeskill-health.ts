import { createLogger } from "@lxe/core";
import type { DesktopHealth } from "@lxe/desktop-protocol";
import { redactAndBound, type LxeSkillClient } from "./lxeskill-client";

interface LxeSkillHealthOptions {
  client: LxeSkillClient;
  recovery: string;
  timeoutMs?: number;
  onChanged?: () => void;
}

/** Desktop diagnostics only: never controls whether an Agent may execute a command. */
export class DesktopLxeSkillHealth {
  private readonly logger = createLogger("desktop.lxeskill");
  private status: { state: DesktopHealth["lxeskill"]; message: string } = { state: "stopped", message: "" };
  private probe: { controller: AbortController; done: Promise<void> } | undefined;

  constructor(private readonly options: LxeSkillHealthOptions) {}

  snapshot(): { state: DesktopHealth["lxeskill"]; message: string } { return { ...this.status }; }

  check(): Promise<void> {
    if (this.probe) return this.probe.done;
    const controller = new AbortController();
    const probe = { controller, done: Promise.resolve() };
    this.probe = probe;
    this.status = { state: "starting", message: "" };
    // Queue the subprocess so the caller can start the Agent independently.
    probe.done = Promise.resolve().then(async () => {
      if (controller.signal.aborted) return;
      const result = await this.options.client.run(["list"], {
        timeoutMs: this.options.timeoutMs ?? 30_000, signal: controller.signal, maxOutputBytes: 10 * 1024 * 1024,
      });
      if (this.probe !== probe) return;
      if (result.command !== "list" || !Array.isArray(result.record.files) || !Array.isArray(result.data.commands)) {
        throw new Error(redactAndBound(`Invalid lxeskill list result: ${JSON.stringify(result.record)}`));
      }
      this.status = { state: "ready", message: "" };
      this.logger.info("lxeskill_probe_ready");
    }).catch(cause => {
      if (this.probe !== probe) return;
      const reason = cause instanceof Error ? cause.message : String(cause);
      this.status = { state: "error", message: `LXE Skill CLI is unavailable: ${reason}. ${this.options.recovery}` };
      this.logger.warn("lxeskill_probe_failed", { reason });
    }).finally(() => {
      if (this.probe !== probe) return;
      this.probe = undefined;
      this.options.onChanged?.();
    });
    this.options.onChanged?.();
    return probe.done;
  }

  async stop(): Promise<void> {
    const probe = this.probe;
    this.probe = undefined;
    probe?.controller.abort();
    this.status = { state: "stopped", message: "" };
    this.options.onChanged?.();
    await probe?.done;
  }
}
