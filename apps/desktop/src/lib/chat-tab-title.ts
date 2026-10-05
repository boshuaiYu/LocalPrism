import { isPlaceholderChatTitle } from "@/lib/i18n";

/**
 * Persisted stand-in for a chat with no real title.
 * Empty so tabs and history render `t("chat.newChat")` for the active language.
 * Older saves may still say "New Chat" or "新对话"; those stay recognized.
 */
export const STORED_CHAT_TITLE_PLACEHOLDER = "";

/**
 * A title is real when it contains a letter (`\p{L}`), a number (`\p{N}`), or
 * any Han, Hiragana, Katakana, or Hangul character. That includes CJK script
 * symbols that are not letters, such as U+2F00. Marks, format characters,
 * punctuation, and other symbols do not count, so a title made only of those
 * (for example "|", "¥€$", "😀", or a combining mark) is empty.
 */
const HAS_REAL_TITLE_TEXT =
  /[\p{L}\p{N}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * Titles that should not be shown in the tab strip.
 * Blank strings, localized placeholders such as "New Chat" / "新对话", and
 * values with no real title text (see HAS_REAL_TITLE_TEXT) collapse the tab.
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
