import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useAgentRunStore } from "@/stores/agent-run-store";
import type { AgentRun } from "@/runtime/types";

const chatState = {
  activeTabId: "tab-1",
  activeProjectPath: "/tmp/paper",
  tabs: [
    {
      id: "tab-1",
      sessionId: "root",
      runtime: "codex" as const,
      chatPeer: "codex" as const,
    },
  ],
};

vi.mock("@/stores/claude-chat-store", () => ({
  useClaudeChatStore: Object.assign(
    (selector: (state: typeof chatState) => unknown) => selector(chatState),
    {
      getState: () => chatState,
      setState: (partial: Partial<typeof chatState>) => {
        Object.assign(chatState, partial);
      },
    },
  ),
}));

import { SubagentPanel } from "@/components/subagents/subagent-panel";

function seedRun(run: AgentRun) {
  useAgentRunStore.getState().applyEvent(
    {
      runtime: run.runtime,
      sessionId: run.rootConversationId,
      projectPath: "",
    },
    { type: "subagentDiscovered", run },
  );
}

describe("SubagentPanel", () => {
  let container: HTMLDivElement;
  let root: Root | undefined;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    useAgentRunStore.getState().reset();
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue([]);
    chatState.activeTabId = "tab-1";
    chatState.activeProjectPath = "/tmp/paper";
    chatState.tabs = [
      {
        id: "tab-1",
        sessionId: "root",
        runtime: "codex",
        chatPeer: "codex",
      },
    ];
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount());
    }
    container.remove();
  });

  it("renders Active section with runtime badge and transcript unavailable", async () => {
    chatState.tabs = [
      {
        id: "tab-1",
        sessionId: "root",
        runtime: "claude",
        chatPeer: "claude",
      },
    ];
    seedRun({
      id: "child-1",
      parentId: "root",
      rootConversationId: "root",
      runtime: "claude",
      agentName: "reviewer",
      agentRole: "reviewer",
      model: "sonnet",
      status: "running",
      startedAt: Date.now() - 1500,
      completedAt: null,
      activity: "editing",
      summary: null,
      error: null,
      transcriptAvailable: false,
    });

    root = createRoot(container);
    await act(async () => {
      root?.render(<SubagentPanel />);
    });

    expect(container.textContent).toContain("Active");
    expect(container.textContent).toContain("reviewer");
    expect(container.textContent).toContain("claude");
    expect(container.textContent).toContain("sonnet");
    expect(container.textContent).toContain("Transcript unavailable");
    expect(container.textContent).not.toContain("Done");

    const button = Array.from(container.querySelectorAll("button")).find(
      (element) => element.textContent?.includes("reviewer"),
    );
    expect(button).toBeTruthy();
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(useAgentRunStore.getState().selectedRunId).toBe("child-1");
    expect(chatState.activeTabId).toBe("tab-1");
  });

  it("renders Done section for terminal children", async () => {
    seedRun({
      id: "done-1",
      parentId: "root",
      rootConversationId: "root",
      runtime: "codex",
      agentName: "writer",
      agentRole: null,
      model: "gpt-5.4",
      status: "completed",
      startedAt: Date.now() - 5000,
      completedAt: Date.now() - 1000,
      activity: null,
      summary: "finished draft",
      error: null,
      transcriptAvailable: true,
    });

    root = createRoot(container);
    await act(async () => {
      root?.render(<SubagentPanel />);
    });

    expect(container.textContent).toContain("Done");
    expect(container.textContent).toContain("writer");
    expect(container.textContent).toContain("finished draft");
    expect(container.textContent).not.toContain("Active");
  });

  it("renders nested indentation without switching the main tab", async () => {
    seedRun({
      id: "parent-agent",
      parentId: "root",
      rootConversationId: "root",
      runtime: "codex",
      agentName: "orchestrator",
      agentRole: null,
      model: "gpt-5.4",
      status: "running",
      startedAt: Date.now() - 3000,
      completedAt: null,
      activity: "delegating",
      summary: null,
      error: null,
      transcriptAvailable: true,
    });
    seedRun({
      id: "nested-agent",
      parentId: "parent-agent",
      rootConversationId: "root",
      runtime: "codex",
      agentName: "nested-reviewer",
      agentRole: "reviewer",
      model: "gpt-5.4",
      status: "queued",
      startedAt: Date.now() - 1000,
      completedAt: null,
      activity: "waiting",
      summary: null,
      error: null,
      transcriptAvailable: true,
    });

    root = createRoot(container);
    await act(async () => {
      root?.render(<SubagentPanel />);
    });

    expect(container.textContent).toContain("orchestrator");
    expect(container.textContent).toContain("nested-reviewer");

    const nestedButton = Array.from(container.querySelectorAll("button")).find(
      (element) => element.textContent?.includes("nested-reviewer"),
    );
    expect(nestedButton).toBeTruthy();
    const padding = Number.parseFloat(
      (nestedButton as HTMLElement).style.paddingLeft || "0",
    );
    expect(padding).toBeGreaterThan(0.5);

    await act(async () => {
      nestedButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(useAgentRunStore.getState().selectedRunId).toBe("nested-agent");
    expect(chatState.activeTabId).toBe("tab-1");
  });
});
