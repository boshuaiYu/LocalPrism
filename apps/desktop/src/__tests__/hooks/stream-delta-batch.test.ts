import { afterEach, describe, expect, it, vi } from "vitest";
import { createStreamDeltaBatcher } from "@/hooks/stream-delta-batch";

describe("createStreamDeltaBatcher", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("coalesces text and thinking deltas until an explicit flush", () => {
    const append = vi.fn();
    const batcher = createStreamDeltaBatcher(append);

    batcher.enqueue("tab-1", "thinking", "Look");
    batcher.enqueue("tab-1", "thinking", "ing");
    batcher.enqueue("tab-1", "text", "Hel");
    batcher.enqueue("tab-1", "text", "lo");

    expect(append).not.toHaveBeenCalled();

    batcher.flush("tab-1");

    expect(append).toHaveBeenCalledTimes(2);
    expect(append.mock.calls[0][1]).toEqual({
      type: "assistant",
      subtype: "streaming_delta",
      message: { content: [{ type: "thinking", thinking: "Looking" }] },
    });
    expect(append.mock.calls[1][1]).toEqual({
      type: "assistant",
      subtype: "streaming_delta",
      message: { content: [{ type: "text", text: "Hello" }] },
    });
  });

  it("discards unflushed deltas without appending them", () => {
    const append = vi.fn();
    const batcher = createStreamDeltaBatcher(append);
    batcher.enqueue("tab-1", "text", "stale");
    batcher.discard("tab-1");
    batcher.flush("tab-1");
    expect(append).not.toHaveBeenCalled();
  });
});
