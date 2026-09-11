import type { RuntimeMessage } from "./types";

/** Runtime-owned context; its transcript reason keeps it out of desktop conversation rows. */
export function turnAbortedMessage(): RuntimeMessage {
  return {
    role: "user",
    content: "<turn_aborted>\n用户主动中断了上一回合。被中断的工具或命令可能已部分执行；后续继续时请先核实实际状态。\n</turn_aborted>",
  };
}
