import { toolResultText } from "@/lib/tool-result-text";
import type {
  ClaudeStreamMessage,
  ContentBlock,
} from "@/stores/claude-chat-store";

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

function skillToolArgs(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const args = (input as Record<string, unknown>).args;
  return typeof args === "string" ? args.trim() : "";
}

function skillInvocationSignature(block: ContentBlock): string {
  return `${skillToolDisplayName(block.input)}\n${skillToolArgs(block.input)}`;
}

function userProseResetsSkillTurn(message: ClaudeStreamMessage): boolean {
  if (message.type !== "user") return false;
  const content = message.message?.content;
  if (Array.isArray(content)) {
    if (
      content.length > 0 &&
      content.every((block) => block.type === "tool_result")
    ) {
      return false;
    }
    const text = content
      .filter((block) => block.type === "text" && block.text)
      .map((block) => block.text ?? "")
      .join("\n")
      .trim();
    return Boolean(text) && !isSkillInstructionDump(text);
  }
  if (typeof content === "string") {
    const text = content.trim();
    return Boolean(text) && !isSkillInstructionDump(text);
  }
  return false;
}

/**
 * One card per tool id, and one card per identical Skill invocation inside a
 * user turn. Later snapshots win so a partial name is replaced by the
 * completed call. A later user message may show the same skill again.
 */
export function collapseRepeatedSkillToolMessages<
  T extends ClaudeStreamMessage,
>(messages: T[]): T[] {
  const turnByMessage: number[] = [];
  let turn = 0;
  for (const message of messages) {
    if (userProseResetsSkillTurn(message)) turn += 1;
    turnByMessage.push(turn);
  }

  const lastToolId = new Map<string, string>();
  const lastSkillSignature = new Map<string, string>();
  messages.forEach((message, messageIndex) => {
    if (
      message.type !== "assistant" ||
      !Array.isArray(message.message?.content)
    ) {
      return;
    }
    message.message.content.forEach((block, blockIndex) => {
      if (block.type !== "tool_use") return;
      const loc = `${messageIndex}:${blockIndex}`;
      if (block.id) lastToolId.set(block.id, loc);
      if (isSkillToolName(block.name)) {
        const key = `${turnByMessage[messageIndex]}\0${skillInvocationSignature(block)}`;
        lastSkillSignature.set(key, loc);
      }
    });
  });

  let changed = false;
  const next: T[] = [];
  messages.forEach((message, messageIndex) => {
    if (
      message.type !== "assistant" ||
      !Array.isArray(message.message?.content)
    ) {
      next.push(message);
      return;
    }
    const content = message.message.content;
    const kept = content.filter((block, blockIndex) => {
      if (block.type !== "tool_use") return true;
      const loc = `${messageIndex}:${blockIndex}`;
      if (block.id && lastToolId.get(block.id) !== loc) return false;
      if (isSkillToolName(block.name)) {
        const key = `${turnByMessage[messageIndex]}\0${skillInvocationSignature(block)}`;
        if (lastSkillSignature.get(key) !== loc) return false;
      }
      return true;
    });
    if (kept.length === content.length) {
      next.push(message);
      return;
    }
    changed = true;
    if (kept.length === 0) return;
    next.push({
      ...message,
      message: { ...message.message, content: kept },
    });
  });

  return changed ? next : messages;
}
