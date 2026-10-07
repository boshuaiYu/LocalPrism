/**
 * The chat picker always offers a built-in default agent.
 * A saved profile is that agent when it carries one of:
 * - slug `default` or `default-agent`
 * - display name `默认智能体`
 * - frontmatter flag `default` / `isDefault` / `is_default` set true
 * When none of those are installed, the picker entry with an empty id
 * (labeled “默认智能体” / “Default”) is the default.
 */

export interface DefaultAgentCandidate {
  id: string;
  name: string;
  scope?: string;
  unknownFields?: Record<string, string> | null;
}

const DEFAULT_AGENT_SLUGS = new Set(["default", "default-agent"]);

export const BUILT_IN_DEFAULT_AGENT_NAME = "默认智能体";

function normalizedId(agent: DefaultAgentCandidate): string {
  return agent.id.trim().toLowerCase();
}

function defaultFlag(agent: DefaultAgentCandidate): string {
  const fields = agent.unknownFields;
  if (!fields) return "";
  for (const key of ["default", "isDefault", "is_default"]) {
    const value = fields[key]?.trim().toLowerCase() ?? "";
    if (value) return value;
  }
  return "";
}

function hasDefaultFlag(agent: DefaultAgentCandidate): boolean {
  const value = defaultFlag(agent);
  return value === "true" || value === "1" || value === "yes";
}

export function isBuiltInDefaultAgent(agent: DefaultAgentCandidate): boolean {
  return (
    hasDefaultFlag(agent) ||
    DEFAULT_AGENT_SLUGS.has(normalizedId(agent)) ||
    agent.name.trim() === BUILT_IN_DEFAULT_AGENT_NAME
  );
}

function identityRank(agent: DefaultAgentCandidate): number {
  if (hasDefaultFlag(agent)) return 0;
  if (DEFAULT_AGENT_SLUGS.has(normalizedId(agent))) return 1;
  if (agent.name.trim() === BUILT_IN_DEFAULT_AGENT_NAME) return 2;
  return 3;
}

export function findBuiltInDefaultAgent<T extends DefaultAgentCandidate>(
  agents: readonly T[],
): T | null {
  const matches = agents.filter((agent) => isBuiltInDefaultAgent(agent));
  if (matches.length === 0) return null;
  return (
    [...matches].sort((left, right) => {
      const byIdentity = identityRank(left) - identityRank(right);
      if (byIdentity !== 0) return byIdentity;
      const leftScope = left.scope === "project" ? 1 : 0;
      const rightScope = right.scope === "project" ? 1 : 0;
      if (leftScope !== rightScope) return leftScope - rightScope;
      return left.id.localeCompare(right.id);
    })[0] ?? null
  );
}

/** Saved id of the built-in default agent, or null for the synthetic picker entry. */
export function builtInDefaultAgentId(
  agents: readonly DefaultAgentCandidate[],
): string | null {
  const id = findBuiltInDefaultAgent(agents)?.id.trim() ?? "";
  return id || null;
}

/**
 * Agent to show when a chat opens.
 * A listed selection is kept. An empty or missing id falls back to the
 * built-in default agent.
 */
export function resolveOpenAgentId(
  agentId: string | null | undefined,
  agents: readonly DefaultAgentCandidate[],
): string | null {
  const current = agentId?.trim() || null;
  if (current && agents.some((agent) => agent.id === current)) return current;
  return builtInDefaultAgentId(agents);
}
