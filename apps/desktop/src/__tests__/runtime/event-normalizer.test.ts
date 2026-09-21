import { describe, expect, it } from "vitest";
import {
  normalizeRuntimeEnvelope,
  RuntimeEventReducer,
} from "@/runtime/event-normalizer";
import type { RuntimeEventEnvelope } from "@/runtime/types";
import { routeRuntimeSideEffects } from "@/hooks/use-runtime-events";
import { useApprovalStore } from "@/stores/approval-store";

const validCodexDelta: RuntimeEventEnvelope = {
  runtime: "codex",
  windowLabel: "main",
  tabId: "tab-1",
  attemptId: "tab-1:1",
  sessionId: "thread-1",
  turnId: "turn-1",
  sequence: 1,
  event: {
    type: "assistantDelta",
    itemId: "item-1",
    delta: "partial ",
  },
};

describe("normalizeRuntimeEnvelope", () => {
  it("accepts valid Claude and Codex envelopes", () => {
    expect(normalizeRuntimeEnvelope(validCodexDelta).ok).toBe(true);
    expect(
      normalizeRuntimeEnvelope({
        ...validCodexDelta,
        runtime: "claude",
        event: { type: "sessionStarted", sessionId: "session-1" },
      }).ok,
    ).toBe(true);
  });

  it("rejects missing runtime, tab, or sequence", () => {
    expect(normalizeRuntimeEnvelope({ ...validCodexDelta, tabId: "" }).ok).toBe(
      false,
    );
    expect(
      normalizeRuntimeEnvelope({ ...validCodexDelta, runtime: "gemini" }).ok,
    ).toBe(false);
    expect(
      normalizeRuntimeEnvelope({ ...validCodexDelta, sequence: "1" }).ok,
    ).toBe(false);
  });

  it("turns unknown event types into warning events", () => {
    const result = normalizeRuntimeEnvelope({
      ...validCodexDelta,
      event: { type: "future/item", secret: "sk-test" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.event).toEqual({
      type: "warning",
      message: "Unsupported runtime event type: future/item",
    });
    expect(JSON.stringify(result.value)).not.toContain("sk-test");
  });

  it("validates approval and subagent payloads", () => {
    const approval = normalizeRuntimeEnvelope({
      ...validCodexDelta,
      event: {
        type: "approvalRequested",
        requestId: 7,
        method: "item/commandExecution/requestApproval",
        title: "Run command",
        command: "cargo test",
      },
    });
    expect(approval.ok).toBe(true);
    if (!approval.ok) return;
    expect(approval.value.event.type).toBe("approvalRequested");

    const resolved = normalizeRuntimeEnvelope({
      ...validCodexDelta,
      event: {
        type: "approvalResolved",
        requestId: "req_1",
      },
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.value.event).toEqual({
        type: "approvalResolved",
        requestId: "req_1",
      });
    }

    const nested = normalizeRuntimeEnvelope({
      ...validCodexDelta,
      runtime: "claude",
      event: {
        type: "approvalRequested",
        request: {
          requestId: "req_1",
          method: "claude/can_use_tool",
          runtime: "claude",
          title: "Allow Bash?",
          command: "ls",
        },
      },
    });
    expect(nested.ok).toBe(true);
    if (!nested.ok) return;
    expect(nested.value.event).toMatchObject({
      type: "approvalRequested",
      request: {
        requestId: "req_1",
        method: "claude/can_use_tool",
        command: "ls",
      },
    });

    const subagent = normalizeRuntimeEnvelope({
      ...validCodexDelta,
      event: {
        type: "subagentDiscovered",
        run: {
          id: "child-1",
          parentId: "thread-1",
          rootConversationId: "thread-1",
          runtime: "codex",
          agentName: "reviewer",
          agentRole: "reviewer",
          model: "gpt-5.4",
          status: "running",
          startedAt: 1,
          completedAt: null,
          activity: "spawned",
          summary: null,
          error: null,
          transcriptAvailable: true,
        },
      },
    });
    expect(subagent.ok).toBe(true);
  });
});

describe("RuntimeEventReducer", () => {
  it("ignores older sequences and replaces deltas with completed content", () => {
    const reducer = new RuntimeEventReducer();
    reducer.apply(validCodexDelta);
    reducer.apply({
      ...validCodexDelta,
      sequence: 1,
      event: { type: "assistantDelta", itemId: "item-1", delta: "ignored" },
    });
    reducer.apply({
      ...validCodexDelta,
      sequence: 2,
      event: { type: "assistantDelta", itemId: "item-1", delta: "text" },
    });
    expect(reducer.items["codex:thread-1:item-1"]?.text).toBe("partial text");

    const completed: RuntimeEventEnvelope = {
      ...validCodexDelta,
      sequence: 3,
      event: {
        type: "assistantCompleted",
        itemId: "item-1",
        content: "authoritative text",
      },
    };
    reducer.apply(completed);
    reducer.apply({
      ...validCodexDelta,
      sequence: 4,
      event: { type: "assistantDelta", itemId: "item-1", delta: "late" },
    });
    expect(reducer.items["codex:thread-1:item-1"]?.text).toBe(
      "authoritative text",
    );
    expect(reducer.items["codex:thread-1:item-1"]?.completed).toBe(true);
  });
});

describe("routeRuntimeSideEffects", () => {
  it("queues Claude tool permission prompts", () => {
    useApprovalStore.getState().reset();
    routeRuntimeSideEffects({
      runtime: "claude",
      windowLabel: "main",
      tabId: "tab-1",
      attemptId: "attempt-1",
      sessionId: null,
      turnId: "attempt-1",
      sequence: 2,
      event: {
        type: "approvalRequested",
        request: {
          requestId: "req_1",
          method: "claude/can_use_tool",
          runtime: "claude",
          threadId: "attempt-1",
          turnId: "attempt-1",
          tabId: "tab-1",
          agentRunId: null,
          title: "Allow Bash?",
          command: "ls",
          cwd: null,
          diff: null,
          permissions: null,
          questions: [],
          details: { command: "ls" },
        },
      },
    });
    expect(useApprovalStore.getState().pending["s:req_1"]?.method).toBe(
      "claude/can_use_tool",
    );
    routeRuntimeSideEffects({
      runtime: "claude",
      windowLabel: "main",
      tabId: "tab-1",
      attemptId: "attempt-1",
      sessionId: null,
      turnId: "attempt-1",
      sequence: 3,
      event: { type: "approvalResolved", requestId: "req_1" },
    });
    expect(useApprovalStore.getState().pending["s:req_1"]).toBeUndefined();
  });
});
