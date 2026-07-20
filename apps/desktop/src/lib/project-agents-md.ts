import { exists, join } from "@/lib/tauri/fs";
import { writeTextFile } from "@tauri-apps/plugin-fs";

/**
 * Codex project instructions created only when Codex is selected/enabled.
 * Never overwrite an existing AGENTS.md.
 */
export const DEFAULT_AGENTS_MD = `# Project Instructions

Work inside this project directory. Preserve existing LaTeX structure and verify generated outputs before reporting completion.
`;

export type AgentsMdWriteReason = "created" | "exists" | "disabled";

export interface EnsureAgentsMdDecision {
  shouldWrite: boolean;
  reason: AgentsMdWriteReason;
}

/** Pure decision helper for tests and callers. */
export function decideAgentsMdWrite(options: {
  enableCodex: boolean;
  agentsMdExists: boolean;
}): EnsureAgentsMdDecision {
  if (!options.enableCodex) {
    return { shouldWrite: false, reason: "disabled" };
  }
  if (options.agentsMdExists) {
    return { shouldWrite: false, reason: "exists" };
  }
  return { shouldWrite: true, reason: "created" };
}

/**
 * Create AGENTS.md when Codex is enabled and the file is missing.
 * Never overwrites CLAUDE.md, agents/, or skills/.
 */
export async function ensureProjectAgentsMd(
  projectPath: string,
  enableCodex: boolean,
): Promise<AgentsMdWriteReason> {
  const agentsMdPath = await join(projectPath, "AGENTS.md");
  const decision = decideAgentsMdWrite({
    enableCodex,
    agentsMdExists: await exists(agentsMdPath),
  });
  if (decision.shouldWrite) {
    await writeTextFile(agentsMdPath, DEFAULT_AGENTS_MD);
  }
  return decision.reason;
}
