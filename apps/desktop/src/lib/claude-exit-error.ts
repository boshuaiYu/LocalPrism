const MAX_STDERR_CHARS = 500;

export function truncateErrorDetail(
  text: string,
  limit = MAX_STDERR_CHARS,
): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit)}...`;
}

export function classifyClaudeProcessStderr(stderr: string): string | null {
  const trimmed = stderr.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  const detail = truncateErrorDetail(trimmed);

  if (
    lower.includes("429") ||
    lower.includes("too many requests") ||
    lower.includes("rate limit")
  ) {
    return `Rate limited by the API. ${detail}`;
  }
  if (
    lower.includes("prompt is too long") ||
    lower.includes("context length") ||
    lower.includes("context window") ||
    lower.includes("maximum context") ||
    (lower.includes("token") && lower.includes("limit"))
  ) {
    return `The request exceeded the model context limit (often from a huge skill such as PaperSpine). Narrow the request and retry. ${detail}`;
  }
  if (
    lower.includes("unauthorized") ||
    lower.includes("invalid api key") ||
    lower.includes("authentication") ||
    /\b401\b/.test(lower)
  ) {
    return `Authentication failed. Check the provider API key or official account sign-in. ${detail}`;
  }
  if (
    lower.includes("git-bash") ||
    lower.includes("git bash") ||
    lower.includes("bash.exe")
  ) {
    return "Claude Code requires git-bash on Windows. Please install Git for Windows or set the CLAUDE_CODE_GIT_BASH_PATH environment variable.";
  }
  return null;
}

export function formatUnexpectedClaudeExit(input: {
  started: boolean;
  isDirectProvider: boolean;
  isWindows: boolean;
  exitCode?: number | null;
  stderrTail?: string | null;
}): string {
  const stderr = input.stderrTail?.trim() ?? "";
  const classified = classifyClaudeProcessStderr(stderr);
  if (classified) return classified;

  if (!input.started) {
    if (input.isDirectProvider) {
      return "AI provider request failed to start. Check the provider API key, Base URL, model name, and model access.";
    }
    return input.isWindows
      ? "Claude process failed to start. Check that Claude Code CLI is installed and git-bash is available."
      : "Claude process failed to start. Check that Claude Code CLI is installed.";
  }

  const exit =
    input.exitCode != null && input.exitCode !== 0
      ? ` Exit code ${input.exitCode}.`
      : "";
  const detail = stderr ? ` ${truncateErrorDetail(stderr)}` : "";

  if (input.isDirectProvider) {
    return `AI provider request stopped unexpectedly.${exit}${detail} Check the API key, model access, Base URL, tool-call support, or rate limits.`.trim();
  }
  return `Claude process exited unexpectedly.${exit}${detail} Check the process output above; this is often an API, skill, or spawn error rather than a rate limit.`.trim();
}
