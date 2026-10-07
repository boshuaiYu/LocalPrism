import { beforeEach, describe, expect, it } from "vitest";
import { emptyAgentProfile, useAgentStore } from "@/stores/agent-store";
import { useClaudeChatStore } from "@/stores/claude-chat-store";
import type { AgentProfile } from "@/runtime/types";

function claudeAgent(id: string, name: string): AgentProfile {
  return {
    ...emptyAgentProfile("claude", "user"),
    id,
    name,
    sourcePath: `/agents/${id}.md`,
  };
}

describe("fresh chat selects the built-in default agent", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    const base = useClaudeChatStore.getState().tabs[0];
    useClaudeChatStore.setState({
      tabs: [
        {
          ...base,
          agentId: "academic-polish",
          isStreaming: false,
          cancelledAttempts: [],
          messages: [],
          sessionId: null,
          sessionRef: null,
        },
      ],
      activeTabId: base.id,
      isStreaming: false,
      messages: [],
      sessionId: null,
    });
    useAgentStore.setState({
      agents: [
        claudeAgent("academic-polish", "论文抛光机"),
        claudeAgent("default-agent", "默认智能体"),
        claudeAgent("de-ai", "AI消除器"),
      ],
      loading: false,
      error: null,
    });
  });

  it("replaces another agent when a new session starts on the same tab", () => {
    useClaudeChatStore.getState().newSession();

    expect(useClaudeChatStore.getState().tabs[0]?.agentId).toBe(
      "default-agent",
    );
  });

  it("does not copy the previous agent onto a new tab", () => {
    const previousId = useClaudeChatStore.getState().activeTabId;
    const createdId = useClaudeChatStore.getState().createTab();
    const created = useClaudeChatStore
      .getState()
      .tabs.find((tab) => tab.id === createdId);

    expect(created?.agentId).toBe("default-agent");
    expect(
      useClaudeChatStore.getState().tabs.find((tab) => tab.id === previousId)
        ?.agentId,
    ).toBe("academic-polish");
  });

  it("opens a new tab on the default agent while the previous tab is streaming", () => {
    const previousId = useClaudeChatStore.getState().activeTabId;
    useClaudeChatStore.setState((state) => ({
      isStreaming: true,
      tabs: state.tabs.map((tab) =>
        tab.id === previousId
          ? {
              ...tab,
              isStreaming: true,
              streamingStartedAt: 1,
              activeAttemptId: "attempt-live",
            }
          : tab,
      ),
    }));

    useClaudeChatStore.getState().newSession();

    const active = useClaudeChatStore
      .getState()
      .tabs.find((tab) => tab.id === useClaudeChatStore.getState().activeTabId);
    expect(active?.id).not.toBe(previousId);
    expect(active?.agentId).toBe("default-agent");
    expect(
      useClaudeChatStore.getState().tabs.find((tab) => tab.id === previousId)
        ?.agentId,
    ).toBe("academic-polish");
  });

  it("falls back to the synthetic default when 默认智能体 is not installed", () => {
    useAgentStore.setState({
      agents: [claudeAgent("academic-polish", "论文抛光机")],
    });

    useClaudeChatStore.getState().newSession();

    expect(useClaudeChatStore.getState().tabs[0]?.agentId).toBeNull();
  });
});
