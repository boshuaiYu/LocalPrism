import { describe, expect, it } from "vitest";
import { chatErrorSummary, lastUserPrompt } from "@/lib/chat-error-card";

describe("chat error card", () => {
  it("uses the latest user prompt for retry", () => {
    expect(
      lastUserPrompt([
        {
          type: "user",
          message: { content: [{ type: "text", text: "first" }] },
        },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "ok" }] },
        },
        {
          type: "user",
          message: { content: [{ type: "text", text: " retry me " }] },
        },
      ]),
    ).toBe("retry me");
  });

  it("returns null when there is no user text to resend", () => {
    expect(lastUserPrompt([{ type: "assistant" }])).toBeNull();
  });

  it("reads string user content and skips a later tool-result turn", () => {
    expect(
      lastUserPrompt([
        {
          type: "user",
          message: { content: " fix the lemma " },
        },
        {
          type: "user",
          message: {
            content: [{ type: "tool_result", content: "tool output" }],
          },
        },
      ]),
    ).toBe("fix the lemma");
  });

  it("collapses long errors until details are requested", () => {
    const error = "x".repeat(180);
    expect(chatErrorSummary(error, false).canExpand).toBe(true);
    expect(chatErrorSummary(error, false).text.endsWith("…")).toBe(true);
    expect(chatErrorSummary(error, true).text).toBe(error);
  });
});
