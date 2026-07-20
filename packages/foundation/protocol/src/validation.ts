import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";

import agentJobSchema from "../schemas/agent-job.schema.json";
import emitRequestSchema from "../schemas/emit-request.schema.json";
import type { AgentJob, EmitRequest } from "./types";

const ajv = new Ajv2020({ allErrors: true, strict: true });

export const validateAgentJob: ValidateFunction<AgentJob> =
  ajv.compile<AgentJob>(agentJobSchema);
export const validateEmitRequest: ValidateFunction<EmitRequest> =
  ajv.compile<EmitRequest>(emitRequestSchema);
