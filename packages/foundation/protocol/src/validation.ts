import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020";

import agentJobSchema from "../schemas/agent-job.schema.json";
import commonSchema from "../schemas/common.schema.json";
import desktopStreamBatchSchema from "../schemas/desktop-stream-batch.schema.json";
import emitRequestSchema from "../schemas/emit-request.schema.json";
import type { AgentJob, DesktopStreamBatchRequest, EmitRequest } from "./types";

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(commonSchema);

export const validateAgentJob: ValidateFunction<AgentJob> =
  ajv.compile<AgentJob>(agentJobSchema);
export const validateEmitRequest: ValidateFunction<EmitRequest> =
  ajv.compile<EmitRequest>(emitRequestSchema);
export const validateDesktopStreamBatchRequest: ValidateFunction<DesktopStreamBatchRequest> =
  ajv.compile<DesktopStreamBatchRequest>(desktopStreamBatchSchema);

// Diagnostic validators select the same schema branches by their actual discriminants.
// They run only after a rejected batch, without relying on oneOf array positions.
const mutationBranches = commonSchema.$defs.DesktopStreamMutation.oneOf;
const partBranches = commonSchema.$defs.TurnProcessPart.oneOf;
const kindSelector = {
  type: "object", required: ["kind"],
  properties: { kind: { enum: mutationBranches.map((branch) => branch.properties.kind.const) } },
};
const typeSelector = {
  type: "object", required: ["type"],
  properties: { type: { enum: partBranches.map((branch) => branch.properties.type.const) } },
};
const diagnosticValidators = new Map<string, ValidateFunction>();
function addDiagnosticValidator(key: string, schema: object): void {
  diagnosticValidators.set(key, ajv.compile({
    ...schema, $id: `https://lxe-agent.local/protocol/diagnostic-${key}.schema.json`,
  }));
}
addDiagnosticValidator("unknown", kindSelector);
for (const branch of mutationBranches) {
  const kind = branch.properties.kind.const;
  if ("part" in branch.properties) {
    addDiagnosticValidator(kind, { ...branch, properties: { ...branch.properties, part: typeSelector } });
    for (const part of partBranches) {
      addDiagnosticValidator(`${kind}-${part.properties.type.const}`, {
        ...branch, properties: { ...branch.properties, part },
      });
    }
  } else addDiagnosticValidator(kind, branch);
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

export function desktopStreamBatchValidationError(value: unknown): string {
  if (validateDesktopStreamBatchRequest(value)) return "";
  const errors: ErrorObject[] = [...(validateDesktopStreamBatchRequest.errors ?? [])];
  const mutations = asObject(value)?.mutations;
  let relevant = errors;
  if (Array.isArray(mutations)) {
    relevant = errors.filter((error) => !/^\/mutations\/\d+(?:\/|$)/u.test(error.instancePath));
    mutations.forEach((mutation, index) => {
      const object = asObject(mutation);
      const kind = typeof object?.kind === "string" ? object.kind : "";
      const rawPartType = asObject(object?.part)?.type;
      const partType = typeof rawPartType === "string" ? rawPartType : "";
      const validator = diagnosticValidators.get(`${kind}-${partType}`)
        ?? diagnosticValidators.get(kind) ?? diagnosticValidators.get("unknown")!;
      if (!validator(mutation)) {
        relevant.push(...(validator.errors ?? []).map((error) => ({
          ...error, instancePath: `/mutations/${index}${error.instancePath}`,
        })));
      }
    });
  }
  return relevant.map((error) => {
    const property = error.params.additionalProperty ?? error.params.missingProperty;
    const suffix = property === undefined ? "" : `/${String(property).replaceAll("~", "~0").replaceAll("/", "~1")}`;
    return `${error.instancePath}${suffix || (error.instancePath ? "" : "/")}: ${error.message}`;
  }).join("; ");
}
