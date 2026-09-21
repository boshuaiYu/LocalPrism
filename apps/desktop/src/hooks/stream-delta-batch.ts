import type { ClaudeStreamMessage } from "@/stores/claude-chat-store";

type DeltaKind = "text" | "thinking";

interface PendingDelta {
  text: string;
  thinking: string;
}

export function createStreamDeltaBatcher(
  append: (tabId: string, message: ClaudeStreamMessage) => void,
) {
  const pending = new Map<string, PendingDelta>();
  let frame = 0;

  function take(tabId: string): PendingDelta | null {
    const next = pending.get(tabId);
    if (!next) return null;
    pending.delete(tabId);
    return next;
  }

  function flushTab(tabId: string) {
    const next = take(tabId);
    if (!next) return;
    if (next.thinking) {
      append(tabId, {
        type: "assistant",
        subtype: "streaming_delta",
        message: { content: [{ type: "thinking", thinking: next.thinking }] },
      });
    }
    if (next.text) {
      append(tabId, {
        type: "assistant",
        subtype: "streaming_delta",
        message: { content: [{ type: "text", text: next.text }] },
      });
    }
  }

  function cancelScheduledFlush() {
    if (!frame) return;
    if (typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(frame);
    } else {
      window.clearTimeout(frame);
    }
    frame = 0;
  }

  function flush(tabId?: string) {
    if (tabId) {
      flushTab(tabId);
      if (pending.size === 0) cancelScheduledFlush();
      return;
    }
    cancelScheduledFlush();
    for (const id of [...pending.keys()]) {
      flushTab(id);
    }
  }

  function enqueue(tabId: string, kind: DeltaKind, chunk: string) {
    if (!chunk) return;
    const current = pending.get(tabId) ?? { text: "", thinking: "" };
    if (kind === "text") current.text += chunk;
    else current.thinking += chunk;
    pending.set(tabId, current);
    if (frame) return;
    const schedule =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame
        : (cb: FrameRequestCallback) =>
            window.setTimeout(() => cb(performance.now()), 16);
    frame = schedule(() => {
      frame = 0;
      flush();
    });
  }

  function discard(tabId?: string) {
    if (tabId) {
      pending.delete(tabId);
      if (pending.size === 0) cancelScheduledFlush();
      return;
    }
    cancelScheduledFlush();
    pending.clear();
  }

  function dispose() {
    discard();
  }

  return { enqueue, flush, discard, dispose };
}
