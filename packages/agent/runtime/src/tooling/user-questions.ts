import { randomUUID } from "node:crypto";
import {
  parseUserQuestions, parseUserQuestionSubmission, validateUserQuestionAnswers,
  type JsonObject, type PendingUserQuestion, type SubmitUserQuestionAnswer, type UserQuestionAnswer,
} from "@lxe/protocol";
import { ToolExecutionError, type ToolDefinition, type ToolRegistry } from "./registry";

type CallContext = Parameters<ToolDefinition["execute"]>[1];
/** Replaceable interaction boundary; other channels can provide an adapter later. */
export interface UserQuestionInteraction {
  ask(input: JsonObject, context: CallContext): Promise<{ answers: UserQuestionAnswer[] }>;
}
interface Pending {
  request: PendingUserQuestion;
  signal: AbortSignal;
  resolve(answers: UserQuestionAnswer[]): void;
  reject(error: Error): void;
  dispose(): void;
}
const failure = (message: string) => new ToolExecutionError("failed_precondition", message);

/** Process-local owner. UI remounts query it; a new process cannot revive its requests. */
export class UserQuestionService {
  private readonly pending = new Map<string, Pending>();
  private readonly answered = new Map<string, { request: PendingUserQuestion; answers: UserQuestionAnswer[]; signal: AbortSignal }>();
  constructor(private readonly changed: (sessionId: string) => void) {}

  snapshot(): PendingUserQuestion[] {
    return [...this.pending.values()].map(entry => structuredClone(entry.request));
  }

  async ask(input: JsonObject, context: CallContext): Promise<{ answers: UserQuestionAnswer[] }> {
    if (context.platform !== "desktop") throw failure("User questions are only available for desktop turns");
    context.handle.signal.throwIfAborted();
    if (!context.turn_id || !context.tool_call_id) throw failure("User questions require a live turn and tool call");
    if (this.pending.has(context.session_id)) throw failure("This session already has a pending question");
    const request: PendingUserQuestion = {
      request_id: randomUUID(), session_id: context.session_id,
      turn_id: context.turn_id, tool_call_id: context.tool_call_id,
      questions: parseUserQuestions(input.questions),
    };
    const signal = context.handle.signal;
    const answers = await new Promise<UserQuestionAnswer[]>((resolve, reject) => {
      const abort = () => {
        this.pending.delete(request.session_id);
        signal.removeEventListener("abort", abort);
        reject(failure("User question cancelled before an answer was accepted"));
        this.changed(request.session_id);
      };
      this.pending.set(request.session_id, { request, signal, resolve, reject, dispose: () => signal.removeEventListener("abort", abort) });
      signal.addEventListener("abort", abort, { once: true });
      this.changed(request.session_id);
    });
    return { answers };
  }

  submit(raw: SubmitUserQuestionAnswer): { accepted: true; request_id: string } {
    const input = parseUserQuestionSubmission(raw);
    const entry = this.pending.get(input.session_id);
    const previous = this.answered.get(input.request_id);
    if (previous && previous.request.session_id === input.session_id && !previous.signal.aborted) {
      const answers = validateUserQuestionAnswers(previous.request.questions, input.answers);
      if (JSON.stringify(answers) !== JSON.stringify(previous.answers)) throw failure("This question was already answered differently");
      return { accepted: true, request_id: input.request_id };
    }
    if (!entry || entry.request.request_id !== input.request_id || entry.signal.aborted) {
      throw failure("This question is no longer pending for this session; it may have been cancelled or the Agent restarted");
    }
    const answers = validateUserQuestionAnswers(entry.request.questions, input.answers);
    this.pending.delete(input.session_id);
    entry.dispose();
    this.answered.set(input.request_id, { request: entry.request, answers: structuredClone(answers), signal: entry.signal });
    if (this.answered.size > 1000) this.answered.delete(this.answered.keys().next().value!);
    entry.resolve(answers);
    this.changed(input.session_id);
    return { accepted: true, request_id: input.request_id };
  }

  forgetSession(sessionId: string): void {
    const entry = this.pending.get(sessionId);
    if (entry) {
      this.pending.delete(sessionId);
      entry.dispose();
      entry.reject(failure("User question ended because its session or runtime closed"));
      this.changed(sessionId);
    }
    for (const [id, value] of this.answered) if (value.request.session_id === sessionId) this.answered.delete(id);
  }

  async stop(): Promise<void> {
    for (const sessionId of [...this.pending.keys()]) this.forgetSession(sessionId);
    this.answered.clear();
  }
}

export function registerUserQuestionTool(registry: ToolRegistry, service: UserQuestionInteraction): void {
  registry.register({
    name: "ask_user_question",
    platforms: ["desktop"],
    description: "Ask the user for a choice or missing information that you cannot discover yourself. Ask 1–3 concise questions, optionally with up to 8 choices. The desktop displays a form and this call waits for the user's answer. Use this as the only tool call in your response. An answer with selected: [] and no custom text means the user skipped that question; it is not consent or authorization. Continue with the available information without inventing an answer or repeating a skipped question unless new information makes it necessary. User answers apply only to the questions asked; do not expand their authorization. Do not ask the same question again after the user stops the task.",
    input_schema: {
      type: "object", additionalProperties: false, required: ["questions"],
      properties: { questions: {
        type: "array", minItems: 1, maxItems: 3,
        items: {
          type: "object", additionalProperties: false, required: ["id", "question"],
          properties: {
            id: { type: "string", description: "Unique question id, echoed in its answer." },
            question: { type: "string" }, header: { type: "string" },
            options: { type: "array", minItems: 1, maxItems: 8, items: {
              type: "object", additionalProperties: false, required: ["label"],
              properties: { label: { type: "string" }, description: { type: "string" } },
            } },
            multi_select: { type: "boolean", default: false },
          },
        },
      } },
    },
    execute: async (input, context) => ({
      content: [{ type: "text", text: JSON.stringify(await service.ask(input, context)) }],
    }),
  });
}
