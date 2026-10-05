import { isPlaceholderChatTitle } from "@/lib/i18n";

/**
 * Letters, digits, and CJK count as a real title. Currency, math, and emoji
 * beside that text stay. A title is empty only when nothing remains except
 * punctuation, symbols, and whitespace (for example "|" or "¥€").
 */
const HAS_REAL_TITLE_TEXT =
  /[\p{L}\p{N}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * Titles that should not be shown in the tab strip.
 * Blank strings, localized placeholders such as "New Chat" / "新对话", and
 * values made only of punctuation or symbols (such as "|") collapse the tab.
 */
export function meaningfulChatTitle(
  title: string | null | undefined,
): string | null {
  const cleaned = (title ?? "").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  if (isPlaceholderChatTitle(cleaned)) return null;
  if (!HAS_REAL_TITLE_TEXT.test(cleaned)) return null;
  return cleaned;
}
