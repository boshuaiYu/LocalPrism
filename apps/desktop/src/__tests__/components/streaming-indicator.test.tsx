import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StreamingIndicator } from "@/components/claude-chat/streaming-indicator";

describe("StreamingIndicator", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("escalates Claude waiting copy after 45s without mentioning reconnects", async () => {
    const startedAt = Date.now() - 46_000;

    await act(async () => {
      root.render(
        <StreamingIndicator
          startedAt={startedAt}
          status="Thinking..."
          runtime="claude"
        />,
      );
    });

    expect(container.textContent).toMatch(/Still waiting for the first reply/i);
    expect(container.textContent).not.toMatch(/reconnect/i);
  });

  it("keeps Codex reconnect copy after 45s", async () => {
    const startedAt = Date.now() - 46_000;

    await act(async () => {
      root.render(
        <StreamingIndicator
          startedAt={startedAt}
          status="Thinking..."
          runtime="codex"
        />,
      );
    });

    expect(container.textContent).toMatch(
      /Still waiting \(reconnects can take 1–2 minutes\)/i,
    );
  });
});
