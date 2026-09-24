import {
  builtinAgentPreset,
  isBuiltinAgentPresetId,
  type BuiltinAgentPresetId,
} from "@/lib/agent-presets";

/** Built-in presets speak in their own style. Everything else stays custom. */
export type ReplyMode = "custom" | BuiltinAgentPresetId;

export const AGENT_SWITCH_FLASH_EVENT = "localprism:agent-switch-flash";

export function replyModeForAgent(
  agentId: string | null | undefined,
): ReplyMode {
  const id = agentId?.trim() ?? "";
  return isBuiltinAgentPresetId(id) ? id : "custom";
}

/**
 * Preset switches flash the composer card's outer border. Custom agents,
 * Default, and re-selecting the same preset do not.
 */
export function shouldFlashPresetAgentSwitch(
  previousAgentId: string | null | undefined,
  nextAgentId: string | null | undefined,
): boolean {
  if (replyModeForAgent(nextAgentId) === "custom") return false;
  return (previousAgentId?.trim() || null) !== (nextAgentId?.trim() || null);
}

export function requestPresetAgentFlash(agentId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(AGENT_SWITCH_FLASH_EVENT, {
      detail: { agentId },
    }),
  );
}

interface AgentInstructions {
  id: string;
  instructions: string;
}

/**
 * Speaking style for the next model turn. Null keeps today's custom prompt.
 * Earlier chat messages are not included or rewritten.
 */
export function replyStylePrefix(
  agentId: string | null | undefined,
  agents: readonly AgentInstructions[] = [],
): string | null {
  const mode = replyModeForAgent(agentId);
  if (mode === "custom") return null;
  const saved = agents.find((agent) => agent.id === mode)?.instructions.trim();
  const instructions = saved || builtinAgentPreset(mode).instructions.trim();
  if (!instructions) return null;
  return `[Reply mode: ${mode}. Follow this speaking style for this turn only. Do not rewrite earlier messages.]\n${instructions}`;
}

export function applyReplyStyleToPrompt(
  prompt: string,
  agentId: string | null | undefined,
  agents: readonly AgentInstructions[] = [],
): string {
  const prefix = replyStylePrefix(agentId, agents);
  if (!prefix) return prompt;
  return `${prefix}\n\n${prompt}`;
}
