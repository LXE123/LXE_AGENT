import { randomBytes } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { AutomationClock, AutomationService, AutomationBlockedError, AutomationTargetMissingError, type DirectGatewayComposition, type ProcessAgentRuntime, type AutomationStore } from "@lxe/gateway/desktop";
import { DESKTOP_MCP_NAME, parseDashboardRpcCall, type AutomationDefinition, type AutomationOperation, type DashboardRpcCall, type AutomationRun, type AutomationRunView } from "@lxe/desktop-protocol";
import { startDesktopPipe } from "../mcp/pipe";
import { desktopTools } from "../mcp/tools";

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Desktop tool arguments must be an object");
  return value as Record<string, unknown>;
};

export class DesktopAutomations {
  readonly service: AutomationService;
  private pipe: Awaited<ReturnType<typeof startDesktopPipe>> | undefined;
  constructor(private readonly options: {
    store: AutomationStore; composition: DirectGatewayComposition; runtime: ProcessAgentRuntime;
    environment: Record<string, string | undefined>; node: string; script: string;
    timeWorker?: string; changed(): void; onError(error: unknown): void;
  }) {
    this.service = new AutomationService({ clock: new AutomationClock({ workerPath: options.timeWorker }), store: options.store, changed: options.changed, onError: options.onError,
      generateName: async definition => (await options.runtime.dashboardCall({ operation: "titles.generate", input: {
        text: definition.prompt, ...(definition.target.mode === "reuse" ? { session_id: definition.target.session_id }
          : definition.target.model ? { model: definition.target.model } : {}),
      } })).title,
      execution: {
        ready: () => options.runtime.isReady,
        validate: definition => this.validateTarget(definition),
        blockReason: async task => {
          await this.validateTarget(task);
          if (task.target.mode === "new") return null;
          if (options.composition.parts.scheduler.hasInflightWork(task.target.session_id)) return "会话正在使用中，稍后再试";
          const status = await options.composition.parts.sessionStatus!.list([task.target.session_id]);
          const current = status.items[0];
          if (current?.error) throw new Error(current.error);
          if (["queued", "running", "stopping", "unknown"].includes(current?.state ?? "unknown")) return "会话尚未空闲或执行状态待确认";
          const [questions, approvals] = await Promise.all([
            options.runtime.dashboardCall({ operation: "sessions.questions", input: {} }),
            options.runtime.dashboardCall({ operation: "sessions.approvals", input: {} }),
          ]);
          const sessionId = task.target.session_id;
          return questions.items.some(item => item.session_id === sessionId) ? "会话正在等待用户回答"
            : approvals.items.some(item => item.session_id === sessionId) ? "会话正在等待审批" : null;
        },
        submit: (run, assertCurrent) => this.submit(run, assertCurrent),
        observe: run => this.observe(run),
      } });
  }
  private async validateTarget(definition: AutomationDefinition): Promise<void> {
    if (definition.target.mode === "reuse") {
      let result;
      try { result = await this.options.runtime.dashboardCall({ operation: "sessions.detail", input: { session_id: definition.target.session_id, message_limit: 1 } }); }
      catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "not_found") throw new AutomationTargetMissingError("绑定的会话已不存在");
        throw error;
      }
      if (result.session.source_summary.platform !== "desktop") throw new Error("定时任务只能绑定桌面对话");
      if (this.options.composition.parts.scheduler.isSessionDeletionFenced(definition.target.session_id)) throw new AutomationBlockedError("会话正在删除");
    } else {
      const workspaces = await this.options.runtime.dashboardCall({ operation: "sessions.workspaces", input: {} });
      const id = definition.target.workspace_id;
      const workspace = workspaces.items.find(item => item.workspace_id === id);
      if (!workspace) throw new AutomationTargetMissingError("任务工作区已不存在");
      accessSync(workspace.directory, constants.R_OK | constants.W_OK | constants.X_OK);
      let levels: string[] | undefined;
      if (definition.target.model) {
        const selected = definition.target.model;
        const models = await this.options.runtime.dashboardCall({ operation: "models.list", input: {} });
        const provider = models.items.find(item => item.provider === selected.provider && item.credential_source === selected.credential_source);
        if (!provider?.selectable || !provider.model_options.some(item => item.model === selected.model)) throw new Error("任务指定的模型不可用，请编辑任务选择可用模型");
        levels = provider.model_options.find(item => item.model === selected.model)!.thinking_levels;
      }
      if (definition.target.effort !== undefined) {
        levels ??= (await this.options.runtime.dashboardCall({ operation: "models.current", input: {} })).thinking_levels;
        if (!levels.includes(definition.target.effort)) throw new Error("任务指定的思考强度不受当前模型支持，请重新选择");
      }
    }
  }
  private async submit(run: AutomationRun, assertCurrent: () => void): Promise<void> {
    const target = run.definition.target;
    let directory: string | undefined;
    if (target.mode === "new") {
      const { items } = await this.options.runtime.dashboardCall({ operation: "sessions.workspaces", input: {} });
      directory = items.find(item => item.workspace_id === target.workspace_id)?.directory;
      if (!directory) throw new AutomationBlockedError("工作区已不存在");
    }
    assertCurrent();
    await this.options.composition.parts.conversations.send({
      ...(target.mode === "reuse" ? { session_id: run.session_id } : { directory: directory! }),
      text: `[定时任务：${run.definition.name}]\n\n${run.definition.prompt}`,
      client_message_id: `automation:${run.id}`,
    }, { id: run.automation_id, session_id: run.session_id, turn_id: run.turn_id, fresh: target.mode === "new", assertCurrent,
      ...(target.mode === "new" && (target.model || target.effort !== undefined) ? { prepareSession: async () => {
        if (target.model) await this.options.runtime.dashboardCall({ operation: "models.update", input: { ...target.model, session_id: run.session_id } });
        if (target.effort !== undefined) await this.options.runtime.dashboardCall({ operation: "models.thinking.update", input: { level: target.effort, session_id: run.session_id } });
      } } : {}),
    });
    await this.options.composition.parts.sessionStatus?.flush();
  }
  private async observe(run: AutomationRun): Promise<AutomationRunView["execution_state"] | "missing"> {
    const live = this.options.composition.parts.scheduler.runStatuses().find(item => item.session_id === run.session_id && item.turn_id === run.turn_id);
    const state = live?.state ?? (await this.options.runtime.dashboardCall({ operation: "sessions.turn.lookup", input: { session_id: run.session_id, turn_id: run.turn_id } })).state;
    if (state !== "running") return state;
    const [questions, approvals] = await Promise.all([
      this.options.runtime.dashboardCall({ operation: "sessions.questions", input: {} }),
      this.options.runtime.dashboardCall({ operation: "sessions.approvals", input: {} }),
    ]);
    return questions.items.some(item => item.session_id === run.session_id) ? "waiting_input"
      : approvals.items.some(item => item.session_id === run.session_id) ? "waiting_approval" : state;
  }
  async openPipe(): Promise<void> {
    const token = randomBytes(32).toString("hex");
    this.pipe = await startDesktopPipe({ token, call: (method, params, signal) => this.toolCall(method, params, signal) });
    Object.assign(this.options.environment, {
      LXE_DESKTOP_MCP_COMMAND: this.options.node, LXE_DESKTOP_MCP_SCRIPT: this.options.script,
      LXE_DESKTOP_MCP_PIPE: this.pipe.path, LXE_DESKTOP_MCP_TOKEN: token,
      LXE_DESKTOP_MCP_ENABLED: this.options.store.setting("desktop_mcp_enabled") ?? "1",
    });
  }
  async close(): Promise<void> {
    await this.service.stop();
    await this.pipe?.close(); this.pipe = undefined;
  }
  async setMcpEnabled(enabled: boolean) {
    const result = await this.options.runtime.dashboardCall({ operation: "mcp.servers.update", input: { name: DESKTOP_MCP_NAME, enabled } });
    this.options.store.setSetting("desktop_mcp_enabled", enabled ? "1" : "0");
    this.options.environment.LXE_DESKTOP_MCP_ENABLED = enabled ? "1" : "0";
    return result;
  }
  async call(call: DashboardRpcCall<AutomationOperation>, assertCurrent?: () => void): Promise<unknown> {
    assertCurrent?.();
    switch (call.operation) {
      case "automations.list": return { items: this.service.list() };
      case "automations.save": return this.service.save(call.input, assertCurrent);
      case "automations.status": return this.service.setStatus(call.input.id, call.input.version, call.input.status, assertCurrent);
      case "automations.delete": this.service.delete(call.input.id, call.input.version); return { deleted: true };
      case "automations.run": return this.service.runNow(call.input.id, assertCurrent);
      case "automations.runs": return { items: await this.service.runs(call.input.id, call.input.limit) };
      case "automations.preview": return this.service.preview(call.input.definition);
      case "automations.editing": this.service.setEditing(call.input.session_id, call.input.editing); return { accepted: true };
    }
  }
  private async toolCall(method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    if (method === "tools/list") return { tools: desktopTools };
    if (method !== "tools/call") throw new Error(`Unknown desktop pipe method: ${method}`);
    const request = object(params), caller = object(request.caller);
    if (caller.platform !== "desktop" || typeof caller.session_id !== "string" || typeof caller.turn_id !== "string"
      || typeof caller.tool_call_id !== "string" || !caller.tool_call_id) throw new Error("Desktop caller metadata is required");
    const assertCaller = () => {
      signal.throwIfAborted();
      const active = this.options.composition.parts.scheduler.activeRun(String(caller.session_id));
      if (!active || active.jobId !== caller.turn_id || active.originJob.source.platform !== "desktop" || active.cancelled) throw new Error("Desktop caller is not an active desktop turn");
    };
    assertCaller();
    const args = object(request.arguments);
    if (request.name === "automation_list") {
      parseDashboardRpcCall({ operation: "automations.list", input: args });
      return {
      items: this.service.list(), workspaces: (await this.options.runtime.dashboardCall({ operation: "sessions.workspaces", input: {} })).items,
      current_session_id: caller.session_id,
    };
    }
    let call: DashboardRpcCall;
    if (request.name === "automation_runs" || request.name === "automation_run_now") {
      call = parseDashboardRpcCall({ operation: request.name === "automation_runs" ? "automations.runs" : "automations.run", input: args });
    } else if (request.name === "automation_update") {
      const fields = args.mode === "create" ? ["mode", "definition"] : args.mode === "view" ? ["mode", "id"]
        : args.mode === "update" ? ["mode", "id", "version", "definition"] : ["mode", "id", "version"];
      const unsupported = Object.keys(args).filter(key => !fields.includes(key));
      if (unsupported.length) throw new Error(`Unsupported fields: ${unsupported.join(", ")}`);
      if (args.mode === "view") return this.service.get(String(args.id ?? ""));
      if (args.mode === "create" || args.mode === "update") {
        const definition = object(structuredClone(args.definition));
        const target = object(definition.target);
        if (target.mode === "reuse" && target.session_id === "current") target.session_id = caller.session_id;
        call = parseDashboardRpcCall({ operation: "automations.save", input: { definition,
          ...(args.mode === "update" ? { id: args.id, version: args.version } : {}) } });
      } else if (args.mode === "pause" || args.mode === "resume") {
        call = parseDashboardRpcCall({ operation: "automations.status", input: { id: args.id, version: args.version, status: args.mode === "pause" ? "paused" : "active" } });
      } else if (args.mode === "delete") call = parseDashboardRpcCall({ operation: "automations.delete", input: { id: args.id, version: args.version } });
      else throw new Error("Invalid automation_update mode");
    } else throw new Error(`Unknown desktop tool: ${String(request.name)}`);
    signal.throwIfAborted();
    return this.call(call as DashboardRpcCall<AutomationOperation>, assertCaller);
  }
}
