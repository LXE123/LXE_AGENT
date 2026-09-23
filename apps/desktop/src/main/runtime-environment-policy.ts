type Environment = Record<string, string | undefined>;

const RETIRED_AGENT_TRACE_VARIABLES = [
  "AGENT_STREAM_TRACE_ENABLED",
  "AGENT_STREAM_TRACE_DIR",
] as const;

const RETIRED_SHANGMAN_VARIABLES = [
  "LXE_SHANGMAN_PASSWORD",
  "LXE_SHANGMAN_BASIC_USERNAME",
  "LXE_SHANGMAN_BASIC_PASSWORD",
  "LXE_SHANGMAN_BASIC_AUTH",
] as const;

export function withoutRetiredAgentTraceEnvironment(source: Environment): Environment {
  const environment = { ...source };
  for (const name of RETIRED_AGENT_TRACE_VARIABLES) delete environment[name];
  return environment;
}

export function withoutRetiredShangmanEnvironment(source: Environment): Environment {
  const environment = { ...source };
  for (const name of RETIRED_SHANGMAN_VARIABLES) delete environment[name];
  return environment;
}
