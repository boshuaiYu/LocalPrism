import { describe, expect, it } from "vitest";
import {
  applyCompression,
  canOfferCompression,
  compressionFailureMessage,
  planCompression,
  prependCompressionCarryover,
  summarizeTranscriptLocally,
} from "@/lib/chat-compression";
import type { ClaudeStreamMessage } from "@/stores/claude-chat-store";

function turn(index: number, type: "user" | "assistant"): ClaudeStreamMessage {
  return {
    type,
    message: {
      content: [
        { type: "text", text: `${type} message ${index} about the proof` },
      ],
    },
  };
}

function longThread(count: number): ClaudeStreamMessage[] {
  return Array.from({ length: count }, (_, index) =>
    turn(index, index % 2 === 0 ? "user" : "assistant"),
  );
}

describe("chat compression", () => {
  it("plans compression only when the user asks", () => {
    const huge = longThread(40);
    expect(canOfferCompression(longThread(9))).toBe(false);
    expect(canOfferCompression(longThread(10))).toBe(true);
    expect(planCompression(huge)).toBeNull();
    expect(planCompression(huge, { force: false })).toBeNull();
    expect(planCompression(huge, { force: true })).not.toBeNull();
  });

  it("folds older turns into a summary and keeps the originals", () => {
    const messages = longThread(12);
    const plan = planCompression(messages, { force: true });
    expect(plan).not.toBeNull();
    const summary = summarizeTranscriptLocally(plan!.transcript);
    const next = applyCompression(plan!, summary);
    expect(next[0]?.subtype).toBe("context-summary");
    expect(next[0]?.contextSummary?.originals.length).toBe(plan!.older.length);
    expect(next.slice(1)).toEqual(plan!.recent);
    expect(next[0]?.contextSummary?.text).toMatch(/User:|Assistant:/);
  });

  it("describes HTTP 400 failures without dropping the detail", () => {
    const message = compressionFailureMessage(
      Object.assign(new Error("bad request from provider"), { status: 400 }),
      "en",
    );
    expect(message).toMatch(/HTTP 400/);
    expect(message).toMatch(/bad request from provider/);
    expect(message).toMatch(/kept/i);
    expect(
      compressionFailureMessage(new Error(""), "zh").length,
    ).toBeGreaterThan(8);
  });

  it("prepends carryover once", () => {
    expect(prependCompressionCarryover("hello", " Summary ")).toBe(
      "Summary\n\nhello",
    );
    expect(prependCompressionCarryover("hello", "  ")).toBe("hello");
  });
});
