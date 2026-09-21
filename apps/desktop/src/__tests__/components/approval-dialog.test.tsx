import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { ApprovalDialog } from "@/components/approvals/approval-dialog";
import type { RuntimeRequest } from "@/runtime/types";
import { useApprovalStore } from "@/stores/approval-store";
import { type TabState, useClaudeChatStore } from "@/stores/claude-chat-store";

function request(
  id: string,
  tabId: string,
  extras: Partial<RuntimeRequest> = {},
): RuntimeRequest {
  return {
    requestId: id,
    method: "claude/can_use_tool",
    runtime: "claude",
    threadId: `${tabId}-thread`,
    turnId: `${tabId}-turn`,
    tabId,
    agentRunId: null,
    title: extras.title ?? `Allow ${tabId}`,
    command: extras.command ?? "Get-Location",
    cwd: null,
    diff: null,
    permissions: null,
    questions: [],
    details: null,
    ...extras,
  };
}

function makeTab(id: string, title: string): TabState {
  const baseTab = useClaudeChatStore.getState().tabs[0];
  return {
    ...baseTab,
    id,
    title,
    projectPath: "C:/project",
    runtime: "claude",
    sessionRef: null,
    sessionId: null,
    messages: [],
    isStreaming: id === "tab-old",
    streamingStartedAt: id === "tab-old" ? 1 : null,
  };
}

describe("ApprovalDialog tab isolation", () => {
  let container: HTMLDivElement;
  let root: Root;
  let chatSnapshot: ReturnType<typeof useClaudeChatStore.getState>;

  beforeEach(() => {
    chatSnapshot = useClaudeChatStore.getState();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    useApprovalStore.getState().reset();
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined);
    useClaudeChatStore.setState({
      tabs: [makeTab("tab-old", "你好"), makeTab("tab-new", "New Chat")],
      activeTabId: "tab-new",
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    useApprovalStore.getState().reset();
    useClaudeChatStore.setState(chatSnapshot, true);
  });

  it("does not show another tab's tool approval on a new chat", async () => {
    useApprovalStore.getState().enqueue(
      request("req-old", "tab-old", {
        title: "PowerShell",
        command: "$config = Join-Path (Get-Location) 'paper'",
      }),
    );

    await act(async () => root.render(<ApprovalDialog />));
    expect(
      container.querySelector('[data-testid="approval-dialog"]'),
    ).toBeNull();
    expect(container.textContent).not.toContain("PowerShell");

    await act(async () => {
      useClaudeChatStore.getState().setActiveTab("tab-old");
    });
    const dialog = container.querySelector('[data-testid="approval-dialog"]');
    expect(dialog).toBeInstanceOf(HTMLElement);
    expect(dialog?.getAttribute("data-tab-id")).toBe("tab-old");
    expect(container.textContent).toContain("PowerShell");
    expect(container.textContent).toContain("Join-Path");
  });
});
