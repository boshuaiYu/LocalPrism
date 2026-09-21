import { toolResultText } from "@/lib/tool-result-text";
import type { ContentBlock } from "@/stores/claude-chat-store";

export function isSkillToolName(name?: string | null): boolean {
  const normalized = name?.trim().toLowerCase() ?? "";
  return normalized === "skill" || normalized === "loadskill";
}

export function skillToolDisplayName(input: unknown): string {
  if (!input || typeof input !== "object") return "skill";
  const record = input as Record<string, unknown>;
  for (const key of ["skill", "skill_name", "name", "command"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim().replace(/^\//, "");
    }
  }
  return "skill";
}

export function isSkillInstructionDump(text?: string | null): boolean {
  const trimmed = text?.trim() ?? "";
  if (!trimmed) return false;
  if (/^Base directory for this skill:/i.test(trimmed)) return true;
  if (/^Launching skill:/i.test(trimmed)) return true;
  if (/^<(?:skill|skill_instructions|loaded_skill)\b/i.test(trimmed)) {
    return true;
  }
  return false;
}

function compactText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function isSkillToolResultEcho(
  text: string,
  skillResults: Iterable<ContentBlock | undefined>,
): boolean {
  if (isSkillInstructionDump(text)) return true;

  const compact = compactText(text);
  if (compact.length < 120) return false;

  for (const result of skillResults) {
    const resultText = compactText(toolResultText(result));
    if (!isSkillInstructionDump(resultText)) continue;
    if (compact === resultText) return true;
  }
  return false;
}
