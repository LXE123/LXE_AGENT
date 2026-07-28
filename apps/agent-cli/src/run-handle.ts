import type { RuntimeHandle } from "@lxe/runtime";

export class AgentRunHandle implements RuntimeHandle {
  private readonly abortController = new AbortController();
  private readonly processes = new Set<{
    kill(): void | Promise<void>;
    forceKill(): void | Promise<void>;
  }>();
  private steering: Array<{
    text: string;
    response_route_id?: string;
    message_id?: string;
  }> = [];

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  get cancelled(): boolean {
    return this.signal.aborted;
  }

  pushSteering(message: { text: string; response_route_id: string; message_id: string }): void {
    this.steering.push(message);
  }

  drainSteering(): Array<{ text: string; response_route_id?: string; message_id?: string }> {
    const messages = this.steering;
    this.steering = [];
    return messages;
  }

  registerProcess(process: {
    kill(): void | Promise<void>;
    forceKill(): void | Promise<void>;
  }): () => void {
    this.processes.add(process);
    return () => this.processes.delete(process);
  }

  async abort(force = false): Promise<void> {
    if (!this.signal.aborted) this.abortController.abort();
    await Promise.allSettled([...this.processes].map((process) =>
      Promise.resolve(force ? process.forceKill() : process.kill())));
  }
}
