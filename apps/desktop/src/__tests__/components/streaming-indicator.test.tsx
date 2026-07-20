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

  it("escalates generic Codex working status after 45s", async () => {
    const startedAt = Date.now() - 46_000;

    await act(async () => {
      root.render(
        <StreamingIndicator startedAt={startedAt} status="Codex is working…" />,
      );
    });

    expect(container.textContent).toMatch(/Still waiting on Codex/i);
  });
});
