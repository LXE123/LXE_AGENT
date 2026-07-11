import type { JsonObject } from "@lxe/protocol";
import type { RuntimeHandle, ToolExecutionResult, ToolSchema } from "./types";

export interface ToolDefinition extends ToolSchema {
  execute(input: JsonObject, context: { handle: RuntimeHandle; session_id: string }): Promise<ToolExecutionResult>;
}

export class ToolRegistry {
  private readonly definitions = new Map<string, ToolDefinition>();

  register(definition: ToolDefinition): void {
    const name = definition.name.trim();
    if (!name) throw new Error("tool name is required");
    this.definitions.set(name, definition);
  }

  schemas(): ToolSchema[] {
    return [...this.definitions.values()].map(({ name, description, input_schema }) => ({
      name,
      description,
      input_schema: structuredClone(input_schema),
    }));
  }

  async execute(
    name: string,
    input: JsonObject,
    context: { handle: RuntimeHandle; session_id: string },
  ): Promise<ToolExecutionResult> {
    const definition = this.definitions.get(name.trim());
    if (!definition) throw new Error(`unknown tool: ${name}`);
    if (context.handle.signal.aborted) throw new DOMException("Turn cancelled", "AbortError");
    return definition.execute(input, context);
  }
}
