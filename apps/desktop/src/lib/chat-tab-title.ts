const PLACEHOLDER_TITLES = new Set([
  "new chat",
  "untitled",
  "untitled chat",
  "untitled session",
  "新对话",
  "未命名",
  "未命名对话",
]);

/**
 * Titles that should not be shown in the tab strip.
 * Blank strings, the default "New Chat", and punctuation-only values such as
 * "|" collapse the tab to an empty box.
 */
export function meaningfulChatTitle(
  title: string | null | undefined,
): string | null {
  const cleaned = (title ?? "").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  if (PLACEHOLDER_TITLES.has(cleaned.toLowerCase())) return null;
  if (/^[\p{P}\p{S}]+$/u.test(cleaned)) return null;
  return cleaned;
}
