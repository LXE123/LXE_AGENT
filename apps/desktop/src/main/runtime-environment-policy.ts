type Environment = Record<string, string | undefined>;

const RETIRED_AGENT_TRACE_VARIABLES = [
  "AGENT_STREAM_TRACE_ENABLED",
  "AGENT_STREAM_TRACE_DIR",
] as const;

export function withoutRetiredAgentTraceEnvironment(source: Environment): Environment {
  const environment = { ...source };
  for (const name of RETIRED_AGENT_TRACE_VARIABLES) delete environment[name];
  return environment;
}
