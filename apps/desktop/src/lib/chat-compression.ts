import type { ClaudeStreamMessage } from "@/stores/claude-chat-store";
import { translate, type UiLanguage } from "@/lib/i18n";

export const RECENT_KEEP = 6;
export const MIN_OLDER_MESSAGES = 4;

export interface CompressionPlan {
  older: ClaudeStreamMessage[];
  recent: ClaudeStreamMessage[];
  transcript: string;
}

export function messagePlainText(message: ClaudeStreamMessage): string {
  if (message.subtype === "context-summary") {
    return message.contextSummary?.text ?? message.result ?? "";
  }
  const raw = message.message?.content;
  if (typeof raw === "string") return raw;
  if (!Array.isArray(raw)) return message.result ?? "";
  return raw
    .map((block) => {
      if (block.type === "text" && block.text) return block.text;
      if (block.type === "thinking" && block.thinking) return block.thinking;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function renderTranscript(
  messages: readonly ClaudeStreamMessage[],
): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.subtype === "context-summary") {
      const text = (
        message.contextSummary?.text ??
        message.result ??
        ""
      ).trim();
      if (text) lines.push(`Summary: ${clip(text, 500)}`);
      continue;
    }
    const text = messagePlainText(message).replace(/\s+/g, " ").trim();
    if (!text) continue;
    const role =
      message.type === "user"
        ? "User"
        : message.type === "assistant"
          ? "Assistant"
          : "Note";
    lines.push(`${role}: ${clip(text, 400)}`);
  }
  return lines.join("\n");
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).trimEnd()}…`;
}

export function planCompression(
  messages: readonly ClaudeStreamMessage[],
  options?: { force?: boolean },
): CompressionPlan | null {
  if (messages.length <= RECENT_KEEP) return null;
  const older = messages.slice(0, messages.length - RECENT_KEEP);
  const recent = messages.slice(messages.length - RECENT_KEEP);
  if (older.length < MIN_OLDER_MESSAGES) return null;
  // Compression is manual only. Claude Code already compacts near its own
  // context limit, so an early product-layer pass must not run by itself.
  if (!options?.force) return null;
  const transcript = renderTranscript(older);
  if (!transcript.trim()) return null;
  return {
    older: [...older],
    recent: [...recent],
    transcript,
  };
}

export function canOfferCompression(
  messages: readonly ClaudeStreamMessage[],
): boolean {
  return planCompression(messages, { force: true }) != null;
}

export function summarizeTranscriptLocally(transcript: string): string {
  const lines = transcript
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const picked: string[] = [];
  for (const line of lines) {
    if (picked.length >= 12) break;
    if (
      line.startsWith("User:") ||
      line.startsWith("Assistant:") ||
      line.startsWith("Summary:")
    ) {
      picked.push(clip(line, 180));
    }
  }
  if (picked.length > 0) return picked.join("\n");
  const fallback = transcript.trim();
  if (!fallback) {
    throw new Error("Nothing to summarize");
  }
  return clip(fallback, 600);
}

function flattenOriginals(
  messages: readonly ClaudeStreamMessage[],
): ClaudeStreamMessage[] {
  const flattened: ClaudeStreamMessage[] = [];
  for (const message of messages) {
    if (
      message.subtype === "context-summary" &&
      message.contextSummary?.originals?.length
    ) {
      flattened.push(...message.contextSummary.originals);
    } else {
      flattened.push(message);
    }
  }
  return flattened;
}

export function applyCompression(
  plan: CompressionPlan,
  summary: string,
): ClaudeStreamMessage[] {
  const text = summary.trim();
  const originals = flattenOriginals(plan.older);
  const bubble: ClaudeStreamMessage = {
    type: "system",
    subtype: "context-summary",
    result: text,
    contextSummary: {
      text,
      originals,
      coveredCount: originals.length,
    },
  };
  return [bubble, ...plan.recent];
}

export function buildCompressionCarryover(
  summary: string,
  recent: readonly ClaudeStreamMessage[],
): string {
  const recentText = renderTranscript(recent);
  return [
    "The earlier part of this conversation was compressed. Continue from this summary and the recent turns.",
    "",
    "Summary:",
    summary.trim(),
    recentText ? `\nRecent turns:\n${recentText}` : "",
  ]
    .filter((part) => part !== "")
    .join("\n");
}

export function prependCompressionCarryover(
  prompt: string,
  carryover: string | null | undefined,
): string {
  const trimmed = carryover?.trim();
  if (!trimmed) return prompt;
  return `${trimmed}\n\n${prompt}`;
}

export function compressionFailureMessage(
  error: unknown,
  language: UiLanguage = "en",
): string {
  const status =
    error &&
    typeof error === "object" &&
    "status" in error &&
    typeof (error as { status?: unknown }).status === "number"
      ? (error as { status: number }).status
      : undefined;
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  const detail = raw.trim() || "The summary request failed.";
  const is400 = status === 400 || /\b400\b/.test(detail);
  return translate(
    language,
    is400 ? "errors.compressFailed400" : "errors.compressFailed",
    { detail },
  );
}
