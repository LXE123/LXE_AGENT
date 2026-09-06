// Compile-only assertions, included by protocol's typecheck; never imported at runtime.
import type {
  AgentJob, DesktopStreamMutation, DisplayMetrics, EmitRequest, JsonObject, JsonValue,
  ToolStep, TurnProcessPart, WorkspaceContext,
} from "../src/index";

declare const emit: EmitRequest;
declare const metrics: DisplayMetrics;
declare const part: TurnProcessPart;
declare const mutation: DesktopStreamMutation;
declare const workspace: WorkspaceContext;
declare const tool: ToolStep;
declare const job: AgentJob;

if (emit.emit_kind === "stream") {
  const requiredMetrics: DisplayMetrics = emit.display_metrics;
  const requiredParts: TurnProcessPart[] = emit.process_parts;
  const streamType: "final_answer" = emit.stream_type;
} else {
  const sequence: 0 = emit.seq;
  const empty: "" = emit.stream_type;
  const noMetrics: undefined = emit.display_metrics;
}
if (mutation.kind === "part_delta") {
  const text: string = mutation.delta;
  // @ts-expect-error delta mutations do not contain full parts
  mutation.part;
} else if (mutation.kind === "part_updated") {
  const processPart: TurnProcessPart = mutation.part;
} else {
  const display: DisplayMetrics = mutation.display_metrics;
}
if (part.type === "text") {
  const presentation: "process" | "final" = part.presentation;
  // @ts-expect-error text blocks have no tool step
  part.tool_step;
} else if (part.type === "tool") {
  const step: ToolStep = part.tool_step;
} else {
  const redacted: number = part.redacted_count;
}
const jsonObjects: JsonObject[] = [workspace, metrics, tool, job];
const nestedJson: JsonValue = { values: [null, true, 42, "text", { nested: [] }] };
const sourceOmitted: DisplayMetrics = { ...metrics };
const sourceEstimated: DisplayMetrics = { ...metrics, context_source: "estimated" };
const sourceCalibrated: DisplayMetrics = { ...metrics, context_source: "usage_calibrated" };
// @ts-expect-error context source is not arbitrary text
const sourceInvalid: DisplayMetrics = { ...metrics, context_source: "unknown" };
// @ts-expect-error closed display metrics do not accept arbitrary properties
const metricsExtra: DisplayMetrics = { ...metrics, unexpected: true };
// @ts-expect-error JSON values exclude functions
const invalidJson: JsonValue = { nested: [() => 1] };
// @ts-expect-error full tool identity is required
const incompleteTool: ToolStep = { id: "t" };
// @ts-expect-error stream requires metrics and parts
const incompleteStream: EmitRequest = { ...emit, emit_kind: "stream", stream_type: "final_answer", state: "delta", seq: 1, display_metrics: undefined };
declare const streamWithoutParts: Omit<Extract<EmitRequest, { emit_kind: "stream" }>, "process_parts">;
// @ts-expect-error process parts are also required independently of metrics
const missingParts: EmitRequest = streamWithoutParts;
// @ts-expect-error nonstream messages prohibit stream-only fields
const invalidFinal: EmitRequest = { ...emit, emit_kind: "final", stream_type: "", state: "", seq: 0, display_metrics: metrics };
