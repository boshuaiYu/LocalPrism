export interface ChatErrorMessage {
  type: string;
  message?: {
    content?: { type?: string; text?: string }[];
  };
}

export function lastUserPrompt(messages: ChatErrorMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.type !== "user") continue;
    const text = (message.message?.content ?? [])
      .map((block) => (block.type === "text" ? (block.text ?? "").trim() : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
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
