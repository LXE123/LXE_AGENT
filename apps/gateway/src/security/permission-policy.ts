import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseDocument } from "yaml";
import { repositoryRoot } from "@lxe/core";

export const ALL = "*";
export const POLICY_PATH_ENV = "LXE_PERMISSION_POLICY_PATH";
export class PermissionPolicyError extends Error {}

export interface PermissionPolicy {
  path: string;
  botIdToKey: ReadonlyMap<string, string>;
  botAliasToKey: ReadonlyMap<string, string>;
  botAliasToAppId: ReadonlyMap<string, string>;
  botSkillPolicy: ReadonlyMap<string, ReadonlySet<string>>;
  userAgentPolicy: ReadonlyMap<string, ReadonlySet<string>>;
  userNameToUnionId: ReadonlyMap<string, string>;
  userNameToAllowAliases: ReadonlyMap<string, ReadonlySet<string>>;
}

type Mapping = Record<string, unknown>;
const clean = (value: unknown): string => {
  if (value === null || value === undefined || value === false || value === 0 || value === "") return "";
  if (value === true) return "True";
  if (Array.isArray(value) && value.length === 0) return "";
  if (typeof value === "object" && Object.keys(value).length === 0) return "";
  return String(value).trim();
};
const isMapping = (value: unknown): value is Mapping =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const requireMapping = (value: unknown, context: string): Mapping => {
  if (!isMapping(value)) throw new PermissionPolicyError(`${context} must be a mapping`);
  return value;
};

const stringList = (value: unknown, context: string): string[] => {
  if (!Array.isArray(value)) throw new PermissionPolicyError(`${context} must be a list`);
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const safe = clean(item);
    if (!safe) throw new PermissionPolicyError(`${context} contains an empty value`);
    if (seen.has(safe)) throw new PermissionPolicyError(`${context} contains duplicate value: ${safe}`);
    seen.add(safe);
    result.push(safe);
  }
  return result;
};

export function buildPermissionPolicy(data: unknown, path: string): PermissionPolicy {
  const root = requireMapping(data, "permission policy root");
  const bots = requireMapping(root.bots, "bots");
  const users = requireMapping(root.users, "users");
  if (Object.keys(bots).length === 0) throw new PermissionPolicyError("bots must not be empty");

  const botIdToKey = new Map<string, string>();
  const botAliasToKey = new Map<string, string>();
  const botAliasToAppId = new Map<string, string>();
  const botSkillPolicy = new Map<string, ReadonlySet<string>>();
  for (const [rawAlias, rawBot] of Object.entries(bots)) {
    const alias = clean(rawAlias);
    if (!alias) throw new PermissionPolicyError("bot alias must not be empty");
    const bot = requireMapping(rawBot, `bot ${alias}`);
    const key = clean(bot.key);
    const appId = clean(bot.app_id);
    const skills = stringList(bot.skill_types, `bot ${alias}.skill_types`);
    if (!key) throw new PermissionPolicyError(`bot ${alias}.key must not be empty`);
    if (!appId) throw new PermissionPolicyError(`bot ${alias}.app_id must not be empty`);
    if (skills.length === 0) throw new PermissionPolicyError(`bot ${alias}.skill_types must not be empty`);
    if (botIdToKey.has(appId)) throw new PermissionPolicyError(`duplicate bot app_id: ${appId}`);
    const skillSet = new Set(skills);
    const existing = botSkillPolicy.get(key);
    if (existing && (existing.size !== skillSet.size || [...existing].some((item) => !skillSet.has(item)))) {
      throw new PermissionPolicyError(`bot ${alias}.skill_types must match shared permission key: ${key}`);
    }
    botIdToKey.set(appId, key);
    botAliasToKey.set(alias, key);
    botAliasToAppId.set(alias, appId);
    botSkillPolicy.set(key, skillSet);
  }

  const userAgentPolicy = new Map<string, ReadonlySet<string>>();
  const userNameToUnionId = new Map<string, string>();
  const userNameToAllowAliases = new Map<string, ReadonlySet<string>>();
  for (const [rawName, rawUser] of Object.entries(users)) {
    const name = clean(rawName);
    if (!name) throw new PermissionPolicyError("user name must not be empty");
    const user = requireMapping(rawUser, `user ${name}`);
    const unionId = clean(user.union_id);
    const aliases = stringList(user.allow, `user ${name}.allow`);
    if (!unionId) throw new PermissionPolicyError(`user ${name}.union_id must not be empty`);
    if (aliases.length === 0) throw new PermissionPolicyError(`user ${name}.allow must not be empty`);
    if (userAgentPolicy.has(unionId)) throw new PermissionPolicyError(`duplicate user union_id: ${unionId}`);
    if (aliases.includes(ALL) && aliases.length > 1) {
      throw new PermissionPolicyError(`user ${name}.allow cannot mix '*' with bot aliases`);
    }
    const allowed = new Set<string>();
    for (const alias of aliases) {
      if (alias === ALL) allowed.add(ALL);
      else {
        const key = botAliasToKey.get(alias);
        if (!key) throw new PermissionPolicyError(`user ${name}.allow references unknown bot alias: ${alias}`);
        allowed.add(key);
      }
    }
    userAgentPolicy.set(unionId, allowed);
    userNameToUnionId.set(name, unionId);
    userNameToAllowAliases.set(name, new Set(aliases));
  }
  return {
    path,
    botIdToKey,
    botAliasToKey,
    botAliasToAppId,
    botSkillPolicy,
    userAgentPolicy,
    userNameToUnionId,
    userNameToAllowAliases,
  };
}

interface PermissionPolicyPathOptions {
  path?: string;
  env?: Readonly<Record<string, string | undefined>>;
  projectRoot?: string;
  home?: string;
}

const expandUser = (path: string, home: string): string => {
  if (path === "~") return home;
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(home, path.slice(2));
  return path;
};

export function permissionPolicyPath(options: PermissionPolicyPathOptions = {}): string {
  const env = options.env ?? process.env;
  const configured = clean(options.path) || clean(env[POLICY_PATH_ENV]);
  if (configured) return expandUser(configured, options.home ?? homedir());
  const projectRoot = options.projectRoot ?? repositoryRoot(import.meta.dirname);
  return join(projectRoot, "config", "permission_policy.yaml");
}

export function loadPermissionPolicy(path?: string): PermissionPolicy {
  const safePath = permissionPolicyPath(path === undefined ? {} : { path });
  let content: string;
  try {
    content = readFileSync(safePath, "utf8");
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") throw new PermissionPolicyError(`permission policy file not found: ${safePath}`);
    throw new PermissionPolicyError(`cannot read permission policy file: ${safePath}: ${String(error)}`);
  }
  const document = parseDocument(content, { uniqueKeys: true });
  if (document.errors.length > 0) {
    const detail = document.errors[0]?.message ?? "unknown YAML error";
    const prefix = detail.includes("Map keys must be unique")
      ? "duplicate YAML key"
      : "invalid permission policy YAML";
    throw new PermissionPolicyError(`${prefix}: ${safePath}: ${detail}`);
  }
  return buildPermissionPolicy(document.toJS(), safePath);
}

export const botKeyForBotId = (policy: PermissionPolicy, botId: string): string =>
  policy.botIdToKey.get(clean(botId)) ?? "";
export const isKnownBotId = (policy: PermissionPolicy, botId: string): boolean =>
  Boolean(botKeyForBotId(policy, botId));
export function canUserAccessBot(policy: PermissionPolicy, userId: string, botId: string): boolean {
  const botKey = botKeyForBotId(policy, botId);
  if (!botKey) return false;
  const allowed = policy.userAgentPolicy.get(clean(userId)) ?? new Set<string>();
  return allowed.has(ALL) || allowed.has(botKey);
}

interface SourceLike {
  platform?: unknown;
  union_id?: unknown;
  source?: unknown;
  raw_data?: unknown;
}
const mapping = (value: unknown): Mapping => (isMapping(value) ? value : {});
export function resolvePermissionUserId(source: SourceLike): string {
  const raw = mapping(source.raw_data ?? source.source);
  return clean(source.union_id) || clean(raw.union_id) || clean(raw.sender_union_id);
}
export function resolveBotId(source: SourceLike, feishuAppId = ""): string {
  const raw = mapping(source.raw_data ?? source.source);
  const extra = mapping(raw.extra);
  const direct =
    clean(raw.bot_id) ||
    clean(raw.app_id) ||
    clean(raw.bot_app_id) ||
    clean(extra.bot_app_id) ||
    clean(extra.bot_id);
  const platform = (clean(source.platform) || clean(raw.platform)).toLowerCase();
  return platform === "feishu" ? direct || clean(feishuAppId) : direct;
}
