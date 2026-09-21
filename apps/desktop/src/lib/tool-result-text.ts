import type { ContentBlock } from "@/stores/claude-chat-store";

function partText(part: unknown): string {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  const record = part as { text?: unknown; content?: unknown };
  if (typeof record.text === "string") return record.text;
  if (typeof record.content === "string") return record.content;
  return "";
}

export function toolResultText(result?: ContentBlock | null): string {
  if (!result) return "";
  const content = result.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(partText).filter(Boolean).join("\n");
  }
  return partText(content);
}

export function toolResultDisplayText(result?: ContentBlock | null): string {
  const text = toolResultText(result).trim();
  if (text) return text;
  if (result?.is_error) return "Read failed";
  return "";
}
