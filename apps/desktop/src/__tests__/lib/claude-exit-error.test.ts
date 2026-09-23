import { describe, expect, it } from "vitest";
import {
  classifyClaudeProcessStderr,
  formatUnexpectedClaudeExit,
} from "@/lib/claude-exit-error";

describe("formatUnexpectedClaudeExit", () => {
  it("does not blame rate limits when the process started and left no stderr", () => {
    expect(
      formatUnexpectedClaudeExit({
        started: true,
        isDirectProvider: false,
        isWindows: true,
        exitCode: 1,
      }),
    ).toMatch(/Exit code 1/);
    expect(
      formatUnexpectedClaudeExit({
        started: true,
        isDirectProvider: false,
        isWindows: true,
        exitCode: 1,
      }),
    ).not.toMatch(/This may be due to rate limiting or an API error/);
  });

  it("classifies context overflow from PaperSpine-sized prompts", () => {
    expect(
      formatUnexpectedClaudeExit({
        started: true,
        isDirectProvider: false,
        isWindows: true,
        exitCode: 1,
        stderrTail: "Error: prompt is too long (tokens=210000)",
      }),
    ).toMatch(/context limit/i);
  });

  it("tells API-key users to check the key before Claude login", () => {
    expect(
      classifyClaudeProcessStderr("Error: 401 unauthorized invalid api key"),
    ).toMatch(/API key/i);
    expect(
      classifyClaudeProcessStderr("Error: 401 unauthorized invalid api key"),
    ).not.toMatch(/Check the Claude login/i);
  });

  it("surfaces an HTTP 400 instead of returning nothing", () => {
    expect(classifyClaudeProcessStderr("Error: 400 Bad Request")).toMatch(
      /HTTP 400/,
    );
    expect(classifyClaudeProcessStderr("Error: 1400 tokens left")).toBeNull();
  });

  it("classifies an actual rate limit from stderr", () => {
    expect(
      classifyClaudeProcessStderr("API Error: 429 too many requests"),
    ).toMatch(/Rate limited/i);
  });

  it("keeps the failed-to-start wording when Claude never emitted a message", () => {
    expect(
      formatUnexpectedClaudeExit({
        started: false,
        isDirectProvider: false,
        isWindows: true,
      }),
    ).toMatch(/failed to start/i);
  });
});
