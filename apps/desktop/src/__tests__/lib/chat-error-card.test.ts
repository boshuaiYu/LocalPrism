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

  it("reads string content and skips file-context wrappers", () => {
    expect(
      lastUserPrompt([
        {
          type: "user",
          message: {
            content:
              "[Currently open file: main.tex]\n[Selection: @main.tex:1:1-1:4]\n\nfix the proof",
          },
        },
      ]),
    ).toBe("fix the proof");
    expect(
      lastUserPrompt([
        {
          type: "user",
          message: {
            content: [
              { type: "text", text: "@main.tex:3:1-3:8\nexplain this line" },
            ],
          },
        },
      ]),
    ).toBe("explain this line");
    expect(
      lastUserPrompt([
        {
          type: "user",
          message: {
            content: [
              {
                type: "text",
                text: "~@PDF page 3, Pasted image 1\nwhat is this figure",
              },
            ],
          },
        },
      ]),
    ).toBe("what is this figure");
    expect(
      lastUserPrompt([
        {
          type: "user",
          message: {
            content: [
              {
                type: "text",
                text: "@referee 2 wants a clearer lemma\nRewrite the opening.",
              },
            ],
          },
        },
      ]),
    ).toBe("@referee 2 wants a clearer lemma\nRewrite the opening.");
  });

  it("collapses long errors until details are requested", () => {
    const error = "x".repeat(180);
    expect(chatErrorSummary(error, false).canExpand).toBe(true);
    expect(chatErrorSummary(error, false).text.endsWith("…")).toBe(true);
    expect(chatErrorSummary(error, true).text).toBe(error);
  });
});
