import { beforeEach, describe, expect, it } from "vitest";
import { useClaudeChatStore } from "@/stores/claude-chat-store";
import type { ClaudeStreamMessage } from "@/stores/claude-chat-store";

function textMessage(text: string): ClaudeStreamMessage {
  return {
    type: "user",
    message: { content: [{ type: "text", text }] },
  };
}

describe("project-scoped new chat and compression", () => {
  beforeEach(() => {
    localStorage.clear();
    useClaudeChatStore.getState().resetForProject("/project-a");
  });

  it("starts a new thread for the active project without clearing another project's tab", () => {
    const foreign = useClaudeChatStore.getState().tabs[0];
    const kept = [textMessage("project A draft")];
    useClaudeChatStore.setState({
      activeProjectPath: "/project-b",
      activeTabId: foreign.id,
      tabs: [{ ...foreign, projectPath: "/project-a", messages: kept }],
      messages: kept,
    });

    useClaudeChatStore.getState().newSession();

    const state = useClaudeChatStore.getState();
    const untouched = state.tabs.find(
      (tab) => tab.projectPath === "/project-a",
    );
    const active = state.tabs.find((tab) => tab.id === state.activeTabId);
    expect(untouched?.messages).toEqual(kept);
    expect(active?.projectPath).toBe("/project-b");
    expect(active?.id).not.toBe(foreign.id);
    expect(active?.messages).toEqual([]);
    expect(state.messages).toEqual([]);
  });

  it("compresses the active project's earlier messages and reports a 400 instead of dropping them", async () => {
    const tab = useClaudeChatStore.getState().tabs[0];
    const messages = Array.from({ length: 12 }, (_, index) =>
      textMessage(`turn ${index} ${"detail ".repeat(8)}`),
    );
    useClaudeChatStore.setState({
      tabs: [
        { ...tab, messages, sessionId: "session-a", projectPath: "/project-a" },
      ],
      messages,
      sessionId: "session-a",
    });

    const automatic = await useClaudeChatStore
      .getState()
      .compressEarlierMessages();
    expect(automatic).toBe("skipped");
    expect(useClaudeChatStore.getState().messages).toEqual(messages);
    expect(useClaudeChatStore.getState().error).toBeNull();

    const failed = await useClaudeChatStore.getState().compressEarlierMessages({
      force: true,
      summarize: async () => {
        throw Object.assign(new Error("provider returned 400"), {
          status: 400,
        });
      },
    });
    expect(failed).toBe("failed");
    expect(useClaudeChatStore.getState().messages).toEqual(messages);
    expect(useClaudeChatStore.getState().error).toMatch(/HTTP 400/);
    expect(useClaudeChatStore.getState().error).toMatch(/kept/i);

    const compressed = await useClaudeChatStore
      .getState()
      .compressEarlierMessages({
        force: true,
        summarize: async () =>
          "Users discussed the proof and the next experiment.",
      });
    expect(compressed).toBe("compressed");
    const next = useClaudeChatStore.getState();
    expect(next.messages[0]?.subtype).toBe("context-summary");
    expect(next.messages[0]?.contextSummary?.originals.length).toBeGreaterThan(
      0,
    );
    expect(next.messages.length).toBeLessThan(messages.length);
    expect(next.sessionId).toBeNull();
    expect(next.tabs[0]?.compressionCarryover).toMatch(/Summary:/);
    expect(next.error).toBeNull();
  });
});
