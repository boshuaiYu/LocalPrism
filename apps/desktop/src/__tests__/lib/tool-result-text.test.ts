import { describe, expect, it } from "vitest";
import { toolResultDisplayText, toolResultText } from "@/lib/tool-result-text";

describe("tool result text", () => {
  it("reads string and anthropic text blocks", () => {
    expect(
      toolResultText({
        type: "tool_result",
        content: "ENOENT: no such file",
      }),
    ).toBe("ENOENT: no such file");
    expect(
      toolResultText({
        type: "tool_result",
        content: [{ type: "text", text: "File too large" }],
      }),
    ).toBe("File too large");
  });

  it("falls back when Read is marked error without body", () => {
    expect(
      toolResultDisplayText({
        type: "tool_result",
        is_error: true,
      }),
    ).toBe("Read failed");
    expect(
      toolResultDisplayText({
        type: "tool_result",
        is_error: false,
      }),
    ).toBe("");
  });
});
