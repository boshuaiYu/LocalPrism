import { describe, expect, it } from "vitest";
import {
  applyCompactEvent,
  compactUsageUpdate,
  dropPendingCompactNotices,
  parseCompactStreamMessage,
  usageAfterCompact,
  type CompactStreamEvent,
} from "@/lib/chat-compact";
import { translate } from "@/lib/i18n";
import type { ClaudeStreamMessage } from "@/stores/claude-chat-store";
import type { TokenUsageSnapshot } from "@/lib/chat-token-usage";

const largeUsage: TokenUsageSnapshot = {
  inputTokens: 180_000,
  outputTokens: 2_000,
  cacheReadTokens: 10_000,
  cacheCreationTokens: 0,
};

describe("parseCompactStreamMessage", () => {
  it("reads snake_case and camelCase compact boundaries", () => {
    expect(
      parseCompactStreamMessage({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: {
          trigger: "auto",
          pre_tokens: 190_000,
          post_tokens: 14_684,
        },
      }),
    ).toEqual({
      kind: "boundary",
      trigger: "auto",
      preTokens: 190_000,
      postTokens: 14_684,
    });
    expect(
      parseCompactStreamMessage({
        type: "system",
        subtype: "compact_boundary",
        compactMetadata: {
          trigger: "manual",
          preTokens: 80_000,
          postTokens: 9_000,
        },
      }),
    ).toEqual({
      kind: "boundary",
      trigger: "manual",
      preTokens: 80_000,
      postTokens: 9_000,
    });
  });

  it("recognizes compacting status and the idle clear", () => {
    expect(
      parseCompactStreamMessage({
        type: "system",
        subtype: "status",
        status: "compacting",
      }),
    ).toEqual({ kind: "compacting" });
    expect(
      parseCompactStreamMessage({
        type: "system",
        subtype: "status",
        status: null,
      }),
    ).toEqual({ kind: "compact-idle" });
    expect(
      parseCompactStreamMessage({
        type: "system",
        subtype: "status",
        status: "thinking",
      }),
    ).toBeNull();
  });

  it("reads a compact summary and ignores a normal user message", () => {
    const summary =
      "This session is being continued from a previous conversation.";
    expect(
      parseCompactStreamMessage({
        type: "user",
        isCompactSummary: true,
        message: { content: [{ type: "text", text: summary }] },
      }),
    ).toEqual({ kind: "summary", text: summary });
    expect(
      parseCompactStreamMessage({
        type: "user",
        is_visible_in_transcript_only: true,
        message: { content: [{ type: "text", text: summary }] },
      }),
    ).toEqual({ kind: "summary", text: summary });
    expect(
      parseCompactStreamMessage({
        type: "user",
        message: { content: [{ type: "text", text: "hello" }] },
      }),
    ).toBeNull();
  });
});

describe("applyCompactEvent", () => {
  it("keeps one divider from compacting through the summary", () => {
    const compacting: CompactStreamEvent = { kind: "compacting" };
    const started = applyCompactEvent([], compacting);
    const again = applyCompactEvent(started, compacting);
    expect(again).toBe(started);
    expect(started).toHaveLength(1);
    expect(started[0]?.compactNotice?.pending).toBe(true);

    const bounded = applyCompactEvent(started, {
      kind: "boundary",
      trigger: "auto",
      preTokens: 190_000,
      postTokens: 14_684,
    });
    expect(bounded).toHaveLength(1);
    expect(bounded[0]?.compactNotice).toMatchObject({
      pending: false,
      trigger: "auto",
      preTokens: 190_000,
      postTokens: 14_684,
    });

    const summary = "Kept the research plan and the open questions.";
    const done = applyCompactEvent(bounded, { kind: "summary", text: summary });
    expect(done).toHaveLength(1);
    expect(done[0]?.subtype).toBe("compact-notice");
    expect(done[0]?.compactNotice?.summary).toBe(summary);
    expect(done[0]?.compactNotice?.pending).toBe(false);
  });

  it("accepts a boundary that arrives before the compacting status", () => {
    const messages = applyCompactEvent([], {
      kind: "boundary",
      trigger: "manual",
      preTokens: 50_000,
      postTokens: null,
    });
    expect(messages[0]?.compactNotice).toMatchObject({
      pending: false,
      trigger: "manual",
      preTokens: 50_000,
      postTokens: null,
    });
  });

  it("drops an unfinished notice and keeps a completed one", () => {
    const pending = applyCompactEvent([], { kind: "compacting" });
    const dropped = dropPendingCompactNotices(pending);
    expect(dropped).toEqual([]);
    const done = applyCompactEvent(pending, {
      kind: "boundary",
      trigger: "auto",
      preTokens: 10,
      postTokens: 4,
    });
    expect(dropPendingCompactNotices(done)).toBe(done);
  });
});

describe("usageAfterCompact", () => {
  it("replaces the pre-compact total with post tokens", () => {
    expect(
      usageAfterCompact(largeUsage, {
        preTokens: 192_000,
        postTokens: 14_684,
      }),
    ).toEqual({
      inputTokens: 14_684,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });

  it("estimates from the summary when post tokens are absent", () => {
    const summary = "x".repeat(40);
    const next = usageAfterCompact(largeUsage, { summaryText: summary });
    expect(next?.inputTokens).toBe(10);
    expect(next?.outputTokens).toBe(0);
  });

  it("leaves the current snapshot when compact has no size to show", () => {
    expect(usageAfterCompact(largeUsage, { preTokens: 192_000 })).toBeNull();
    expect(usageAfterCompact(null, {})).toBeNull();
  });

  it("does not let a summary estimate overwrite an already-small snapshot", () => {
    const alreadySmall: TokenUsageSnapshot = {
      inputTokens: 14_684,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
    expect(
      usageAfterCompact(alreadySmall, {
        preTokens: 192_000,
        summaryText: "x".repeat(80),
      }),
    ).toBeNull();
    expect(
      compactUsageUpdate(
        alreadySmall,
        { kind: "summary", text: "x".repeat(80) },
        [
          {
            type: "system",
            subtype: "compact-notice",
            compactNotice: {
              pending: false,
              trigger: "auto",
              preTokens: 192_000,
              postTokens: 14_684,
              summary: null,
            },
          } satisfies ClaudeStreamMessage,
        ],
      ),
    ).toBeNull();
  });

  it("translates the compact notices in English and Chinese", () => {
    expect(translate("en", "chat.compacting")).toBe("Auto-compacting context…");
    expect(translate("zh", "chat.compacting")).toBe("正在自动压缩上下文…");
    expect(translate("en", "chat.compacted")).toBe("Context compacted");
    expect(translate("zh", "chat.compacted")).toBe("上下文已压缩");
    expect(translate("en", "chat.previousTurn")).toBe(
      "Previous turn · model window",
    );
    expect(translate("zh", "chat.previousTurn")).toBe("上一轮 · 模型窗口");
    expect(translate("zh", "chat.compactedBefore", { tokens: "192,000" })).toBe(
      "压缩前 · 192,000",
    );
  });
});
