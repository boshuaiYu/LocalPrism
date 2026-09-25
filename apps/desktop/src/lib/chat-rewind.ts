import type { ClaudeStreamMessage } from "@/stores/claude-chat-store";
import { messagePlainText } from "@/lib/chat-compression";

export interface RewindAnchor {
  role: "user" | "assistant";
  text: string;
  /** 1-based count of same-role messages with this text, through the anchor. */
  ordinal: number;
  /** Codex turn to keep, when the selected message belongs to one. */
  codexTurnId: string | null;
  /** 1-based user-prompt turn to keep when no Codex turn id is stamped. */
  userTurnOrdinal: number;
}

const MATCH_LIMIT = 280;

/**
 * Saved transcripts store the prompt that was sent, including reply-mode
 * instructions, the open-file header, and selected text. The chat shows the
 * user text after the last wrapper. Peel those wrappers before comparing.
 */
function extractRewindBody(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n");
  const trimmed = normalized.trimStart();
  const wrapped =
    trimmed.startsWith("[Reply mode:") ||
    trimmed.startsWith("[Currently open file:") ||
    trimmed.startsWith("[File:") ||
    trimmed.startsWith("[Selection:") ||
    trimmed.startsWith("The earlier part of this conversation was compressed.");
  if (!wrapped) return text;
  const marker = "]\n\n";
  const index = normalized.lastIndexOf(marker);
  if (index < 0) return text;
  const body = normalized.slice(index + marker.length);
  return body.trim() ? body : text;
}

export function rewindMatchText(text: string): string {
  let value = extractRewindBody(text).replace(/\s+/g, " ").trim();
  let previous = "";
  while (value && value !== previous) {
    previous = value;
    value = stripRewindPrefix(value);
  }
  return [...value].slice(0, MATCH_LIMIT).join("");
}

function stripRewindPrefix(value: string): string {
  const trimmed = value.trim();
  for (const prefix of ["[Currently open file:", "[Selection:", "[File:"]) {
    if (!trimmed.startsWith(prefix)) continue;
    const end = trimmed.indexOf("]");
    if (end >= 0) return trimmed.slice(end + 1).trim();
  }
  if (trimmed.startsWith("@")) {
    const space = trimmed.indexOf(" ");
    if (space > 1) {
      const head = trimmed.slice(0, space);
      if (head.includes(":") || head.includes("/") || head.includes("\\")) {
        return trimmed.slice(space + 1).trim();
      }
    }
  }
  return trimmed;
}

export function rewindTextsMatch(left: string, right: string): boolean {
  return left.length > 0 && left === right;
}

function contentBlocks(message: ClaudeStreamMessage) {
  const content = message.message?.content;
  return Array.isArray(content) ? content : [];
}

export function isToolResultOnly(message: ClaudeStreamMessage): boolean {
  if (message.type !== "user") return false;
  const blocks = contentBlocks(message);
  return (
    blocks.length > 0 && blocks.every((block) => block.type === "tool_result")
  );
}

export function isUserPrompt(message: ClaudeStreamMessage): boolean {
  if (message.type !== "user" || message.subtype === "context-summary") {
    return false;
  }
  if (isToolResultOnly(message)) return false;
  return rewindMatchText(messagePlainText(message)).length > 0;
}

function isVisibleTurnBoundary(message: ClaudeStreamMessage): boolean {
  if (message.subtype === "context-summary") return true;
  if (isUserPrompt(message)) return true;
  if (message.type === "assistant" || message.type === "result") {
    return rewindMatchText(messagePlainText(message)).length > 0;
  }
  return false;
}

/** Inclusive index kept in the UI. Codex keeps the rest of the selected turn. */
export function rewindKeepEnd(
  messages: readonly ClaudeStreamMessage[],
  index: number,
): number {
  if (index < 0 || index >= messages.length) return -1;
  const turnId = messages[index]?.codexTurnId;
  if (turnId) {
    let end = index;
    for (let cursor = index + 1; cursor < messages.length; cursor += 1) {
      const nextTurn = messages[cursor]?.codexTurnId;
      if (nextTurn && nextTurn !== turnId) break;
      if (!nextTurn && isUserPrompt(messages[cursor])) break;
      end = cursor;
    }
    return end;
  }

  let end = index;
  for (let cursor = index + 1; cursor < messages.length; cursor += 1) {
    if (isVisibleTurnBoundary(messages[cursor])) break;
    end = cursor;
  }
  return end;
}

export function canRewindTo(
  messages: readonly ClaudeStreamMessage[],
  index: number,
): boolean {
  const end = rewindKeepEnd(messages, index);
  return end >= 0 && end < messages.length - 1;
}

export function rewindAnchor(
  messages: readonly ClaudeStreamMessage[],
  index: number,
): RewindAnchor | null {
  const end = rewindKeepEnd(messages, index);
  if (end < 0) return null;
  const target = messages[index];
  if (!target) return null;
  const role =
    target.type === "user"
      ? "user"
      : target.type === "assistant"
        ? "assistant"
        : null;
  if (!role || isToolResultOnly(target)) return null;
  const text = rewindMatchText(messagePlainText(target));
  if (!text) return null;

  let ordinal = 0;
  for (let cursor = 0; cursor <= index; cursor += 1) {
    const message = messages[cursor];
    if (!message || message.type !== role || isToolResultOnly(message))
      continue;
    const candidate = rewindMatchText(messagePlainText(message));
    if (rewindTextsMatch(candidate, text)) ordinal += 1;
  }
  if (ordinal < 1) return null;

  let userTurnOrdinal = 0;
  for (let cursor = 0; cursor <= end; cursor += 1) {
    if (isUserPrompt(messages[cursor])) userTurnOrdinal += 1;
  }

  return {
    role,
    text,
    ordinal,
    codexTurnId: target.codexTurnId ?? null,
    userTurnOrdinal,
  };
}

/**
 * Prompt to send again after rewind. Present only when the kept transcript
 * ends on that user turn, with no assistant reply left after it.
 */
export function rewindUserResendPrompt(
  messages: readonly ClaudeStreamMessage[],
  index: number,
): string | null {
  const end = rewindKeepEnd(messages, index);
  if (end < index) return null;
  const target = messages[index];
  if (!target || !isUserPrompt(target)) return null;
  for (let cursor = index + 1; cursor <= end; cursor += 1) {
    const message = messages[cursor];
    if (!message) continue;
    if (message.type !== "assistant" && message.type !== "result") continue;
    if (rewindMatchText(messagePlainText(message)).length > 0) return null;
  }
  const prompt = messagePlainText(target).trim();
  return prompt.length > 0 ? prompt : null;
}

export function lastUserPromptIndex(
  messages: readonly ClaudeStreamMessage[],
): number {
  let last = -1;
  for (let index = 0; index < messages.length; index += 1) {
    if (isUserPrompt(messages[index])) last = index;
  }
  return last;
}
