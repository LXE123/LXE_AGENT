import Ajv2020, { type ValidateFunction } from "ajv/dist/2020";

import agentJobSchema from "../schemas/agent-job.schema.json";
import emitRequestSchema from "../schemas/emit-request.schema.json";
import inboundEventSchema from "../schemas/inbound-event.schema.json";
import workerEnvelopeSchema from "../schemas/worker-envelope.schema.json";
import type {
  AgentJob,
  EmitRequest,
  InboundEvent,
  WorkerEnvelope,
} from "./types";

const ajv = new Ajv2020({ allErrors: true, strict: true });

export const validateInboundEvent: ValidateFunction<InboundEvent> =
  ajv.compile<InboundEvent>(inboundEventSchema);
export const validateAgentJob: ValidateFunction<AgentJob> =
  ajv.compile<AgentJob>(agentJobSchema);
export const validateEmitRequest: ValidateFunction<EmitRequest> =
  ajv.compile<EmitRequest>(emitRequestSchema);
export const validateWorkerEnvelope: ValidateFunction<WorkerEnvelope> =
  ajv.compile<WorkerEnvelope>(workerEnvelopeSchema);

export const contractSchemas = {
  inbound_event: inboundEventSchema,
  agent_job: agentJobSchema,
  emit_request: emitRequestSchema,
  worker_envelope: workerEnvelopeSchema,
} as const;

export const contractValidators = {
  inbound_event: validateInboundEvent,
  agent_job: validateAgentJob,
  emit_request: validateEmitRequest,
  worker_envelope: validateWorkerEnvelope,
} as const;
