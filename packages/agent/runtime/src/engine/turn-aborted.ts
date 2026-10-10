import type { RuntimeConversationMessage, RuntimeMessage } from "./types";

const TURN_ABORTED_CONTENT = "<turn_aborted>\n用户主动中断了上一回合。被中断的工具或命令可能已部分执行；后续继续时请先核实实际状态。\n</turn_aborted>";

/** Runtime-owned context; its transcript reason keeps it out of desktop conversation rows. */
export function turnAbortedMessage(): RuntimeConversationMessage {
  return {
    role: "user",
    runtimeContextKind: "turn_aborted",
    content: TURN_ABORTED_CONTENT,
  };
}

/** Exact legacy text is accepted only for anonymous Runtime-owned context. */
export function isTurnAbortedMessage(message: RuntimeMessage): boolean {
  return message.role === "user" && !message.message_id?.trim() && !message.client_message_id?.trim()
    && (message.runtimeContextKind === "turn_aborted" || message.content === TURN_ABORTED_CONTENT);
}
