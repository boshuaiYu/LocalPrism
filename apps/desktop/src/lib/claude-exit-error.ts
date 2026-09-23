import { translate, type UiLanguage } from "@/lib/i18n";

const MAX_STDERR_CHARS = 500;

export function truncateErrorDetail(
  text: string,
  limit = MAX_STDERR_CHARS,
): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit)}...`;
}

export function classifyClaudeProcessStderr(
  stderr: string,
  language: UiLanguage = "en",
): string | null {
  const trimmed = stderr.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  const detail = truncateErrorDetail(trimmed);

  if (
    lower.includes("429") ||
    lower.includes("too many requests") ||
    lower.includes("rate limit")
  ) {
    return translate(language, "errors.rateLimited", { detail });
  }
  if (
    lower.includes("prompt is too long") ||
    lower.includes("context length") ||
    lower.includes("context window") ||
    lower.includes("maximum context") ||
    (lower.includes("token") && lower.includes("limit"))
  ) {
    return translate(language, "errors.contextLimit", { detail });
  }
  if (
    lower.includes("unauthorized") ||
    lower.includes("invalid api key") ||
    lower.includes("authentication") ||
    /\b401\b/.test(lower)
  ) {
    return translate(language, "errors.auth", { detail });
  }
  if (/\b400\b/.test(lower) || lower.includes("bad request")) {
    return translate(language, "errors.http400", { detail });
  }
  if (
    lower.includes("git-bash") ||
    lower.includes("git bash") ||
    lower.includes("bash.exe")
  ) {
    return translate(language, "errors.gitBash");
  }
  return null;
}

export function formatUnexpectedClaudeExit(input: {
  started: boolean;
  isDirectProvider: boolean;
  isWindows: boolean;
  exitCode?: number | null;
  stderrTail?: string | null;
  language?: UiLanguage;
}): string {
  const language = input.language ?? "en";
  const stderr = input.stderrTail?.trim() ?? "";
  const classified = classifyClaudeProcessStderr(stderr, language);
  if (classified) return classified;

  if (!input.started) {
    if (input.isDirectProvider) {
      return translate(language, "errors.providerStart");
    }
    return input.isWindows
      ? translate(language, "errors.claudeStartWindows")
      : translate(language, "errors.claudeStart");
  }

  const exit =
    input.exitCode != null && input.exitCode !== 0
      ? ` Exit code ${input.exitCode}.`
      : "";
  const detail = stderr ? ` ${truncateErrorDetail(stderr)}` : "";

  if (input.isDirectProvider) {
    return translate(language, "errors.providerStopped", {
      exit,
      detail,
    }).trim();
  }
  return translate(language, "errors.claudeExited", { exit, detail }).trim();
}
