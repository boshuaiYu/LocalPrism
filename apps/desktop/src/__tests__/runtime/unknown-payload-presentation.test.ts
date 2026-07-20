import { describe, expect, it } from "vitest";
import { normalizeRuntimeEnvelope } from "@/runtime/event-normalizer";
import type { RuntimeEventEnvelope } from "@/runtime/types";

const base: RuntimeEventEnvelope = {
  runtime: "codex",
  windowLabel: "main",
  tabId: "tab-1",
  attemptId: "tab-1:1",
  sessionId: "thread-1",
  turnId: "turn-1",
  sequence: 1,
  event: { type: "warning", message: "placeholder" },
};

describe("unknown runtime payload presentation", () => {
  it("does not surface hidden reasoning from unknown native payloads", () => {
    const result = normalizeRuntimeEnvelope({
      ...base,
      event: {
        type: "item/reasoning",
        text: "SECRET_CHAIN_OF_THOUGHT",
        encryptedContent: "sk-live-hidden",
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.event).toEqual({
      type: "warning",
      message: "Unsupported runtime event type: item/reasoning",
    });
    const serialized = JSON.stringify(result.value);
    expect(serialized).not.toContain("SECRET_CHAIN_OF_THOUGHT");
    expect(serialized).not.toContain("sk-live-hidden");
  });

  it("keeps typed unknown events free of arbitrary payload fields", () => {
    const result = normalizeRuntimeEnvelope({
      ...base,
      event: {
        type: "unknown",
        nativeType: "future/tool",
        reasoning: "do-not-render",
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.event).toEqual({
      type: "unknown",
      nativeType: "future/tool",
    });
    expect(JSON.stringify(result.value.event)).not.toContain("do-not-render");
  });
});
