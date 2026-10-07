import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CompactNotice } from "@/components/claude-chat/compact-notice";
import type { ClaudeStreamMessage } from "@/stores/claude-chat-store";
import { useSettingsStore } from "@/stores/settings-store";

function message(
  notice: ClaudeStreamMessage["compactNotice"],
): ClaudeStreamMessage {
  return { type: "system", subtype: "compact-notice", compactNotice: notice };
}

describe("CompactNotice", () => {
  let container: HTMLDivElement;
  let root: Root;
  let language: ReturnType<typeof useSettingsStore.getState>["uiLanguage"];

  beforeEach(() => {
    language = useSettingsStore.getState().uiLanguage;
    useSettingsStore.setState({ uiLanguage: "en" });
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
    useSettingsStore.setState({ uiLanguage: language });
  });

  it("shows the in-progress compact line", async () => {
    await act(async () => {
      root.render(
        <CompactNotice
          message={message({
            pending: true,
            trigger: "auto",
            preTokens: null,
            postTokens: null,
            summary: null,
          })}
        />,
      );
    });
    const notice = container.querySelector('[data-testid="compact-notice"]');
    expect(notice?.getAttribute("data-state")).toBe("pending");
    expect(notice?.textContent).toContain("Auto-compacting context…");
  });

  it("keeps a completed divider and expands the summary", async () => {
    await act(async () => {
      root.render(
        <CompactNotice
          message={message({
            pending: false,
            trigger: "auto",
            preTokens: 192_000,
            postTokens: 14_684,
            summary: "Kept the open questions.",
          })}
        />,
      );
    });
    const notice = container.querySelector('[data-testid="compact-notice"]');
    expect(notice?.getAttribute("data-state")).toBe("done");
    expect(notice?.textContent).toContain("Context compacted");
    expect(notice?.textContent).toContain("Before compact · 192,000");
    expect(
      container.querySelector('[data-testid="compact-summary"]'),
    ).toBeNull();

    const button = container.querySelector("button");
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error("summary toggle missing");
    }
    await act(async () => button.click());
    expect(
      container.querySelector('[data-testid="compact-summary"]')?.textContent,
    ).toBe("Kept the open questions.");
    expect(button.textContent).toBe("Hide summary");
  });

  it("uses the Chinese copy", async () => {
    useSettingsStore.setState({ uiLanguage: "zh" });
    await act(async () => {
      root.render(
        <CompactNotice
          message={message({
            pending: false,
            trigger: "manual",
            preTokens: 1_000,
            postTokens: 100,
            summary: null,
          })}
        />,
      );
    });
    expect(container.textContent).toContain("上下文已压缩");
    expect(container.textContent).toContain("压缩前 · 1,000");
  });
});
