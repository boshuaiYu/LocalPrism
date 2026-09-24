import { translate, type UiLanguage } from "@/lib/i18n";

/** Marker emitted by the Codex Responses proxy when a turn has no visible output. */
export const EMPTY_REPLY_TOKEN = "localprism:empty-reply";

/** Marker prefix for a provider timeout. The model id follows the colon. */
export const NO_OUTPUT_TIMEOUT_PREFIX = "localprism:no-output-timeout:";

const LEGACY_EMPTY_REPLY =
  "The model finished without any visible text. Switch to GPT-5.5 or GPT-5.6 Sol and try again.";

const LEGACY_TIMEOUT =
  /^Codex Responses produced no output for (.+) within \d+s\. Switch to GPT-5\.5 or GPT-5\.6 Sol\.?$/;

export function localizeChatNotice(text: string, language: UiLanguage): string {
  const trimmed = text.trim();
  if (
    trimmed === EMPTY_REPLY_TOKEN ||
    trimmed === LEGACY_EMPTY_REPLY ||
    trimmed === "Codex finished without a reply. Stop and retry."
  ) {
    return translate(language, "errors.emptyReply");
  }
  if (trimmed.startsWith(NO_OUTPUT_TIMEOUT_PREFIX)) {
    const model = trimmed.slice(NO_OUTPUT_TIMEOUT_PREFIX.length).trim();
    return translate(language, "errors.noOutputTimeout", {
      model: model || "model",
    });
  }
  const legacyTimeout = trimmed.match(LEGACY_TIMEOUT);
  if (legacyTimeout) {
    return translate(language, "errors.noOutputTimeout", {
      model: legacyTimeout[1] ?? "model",
    });
  }
  return text;
}
