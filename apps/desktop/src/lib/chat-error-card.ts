export interface ChatErrorContentBlock {
  type?: string;
  text?: string;
}

export interface ChatErrorMessage {
  type: string;
  message?: {
    content?: string | ChatErrorContentBlock[];
  };
}

function textFromUserContent(
  content: string | ChatErrorContentBlock[] | undefined,
): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block?.type === "text" ? (block.text ?? "").trim() : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

/** Drop the engine file-context wrapper so Retry resends the user text. */
function stripEngineContext(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!/^\[(?:Currently open file|File): [^\]\n]*\]/.test(normalized)) {
    return normalized.trim();
  }
  const contextEnd = normalized.lastIndexOf("]\n\n");
  if (contextEnd < 0) return normalized.trim();
  return normalized.slice(contextEnd + 3).trim();
}

function isContextChip(part: string): boolean {
  const chip = part.trim();
  if (!chip) return false;
  if (/^Pasted image(?: \d+)?$/.test(chip)) return true;
  if (/^~@.+$/.test(chip)) return true;
  return /^@.+:\d+:\d+-\d+:\d+$/.test(chip);
}

/** Drop an app context chip (`@file:1:1-1:4`, `~@PDF page 3`, pasted image) above the prompt. */
function stripDisplayContextLabel(text: string): string {
  const newline = text.indexOf("\n");
  if (newline < 0) return text.trim();
  const firstLine = text.slice(0, newline).trim();
  const rest = text.slice(newline + 1).trim();
  if (!rest) return text.trim();
  const parts = firstLine
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0 || !parts.every(isContextChip)) return text.trim();
  return rest;
}

export function lastUserPrompt(messages: ChatErrorMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.type !== "user") continue;
    const text = stripDisplayContextLabel(
      stripEngineContext(textFromUserContent(message.message?.content)),
    );
    if (text) return text;
  }
  return null;
}

export function chatErrorSummary(
  error: string,
  expanded: boolean,
  limit = 160,
): { text: string; canExpand: boolean } {
  const trimmed = error.trim();
  if (expanded || trimmed.length <= limit) {
    return { text: trimmed, canExpand: trimmed.length > limit };
  }
  return { text: `${trimmed.slice(0, limit).trimEnd()}…`, canExpand: true };
}
