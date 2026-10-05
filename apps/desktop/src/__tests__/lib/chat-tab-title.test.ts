import { describe, expect, it } from "vitest";
import { meaningfulChatTitle } from "@/lib/chat-tab-title";
import {
  displayedChatTabTitle,
  useClaudeChatStore,
} from "@/stores/claude-chat-store";

describe("meaningfulChatTitle", () => {
  it("rejects blank, default, and punctuation-only titles", () => {
    expect(meaningfulChatTitle("")).toBeNull();
    expect(meaningfulChatTitle("   ")).toBeNull();
    expect(meaningfulChatTitle("|")).toBeNull();
    expect(meaningfulChatTitle(" | ")).toBeNull();
    expect(meaningfulChatTitle("·")).toBeNull();
    expect(meaningfulChatTitle("New Chat")).toBeNull();
    expect(meaningfulChatTitle("新对话")).toBeNull();
    expect(meaningfulChatTitle("Untitled")).toBeNull();
  });

  it("keeps a real title", () => {
    expect(meaningfulChatTitle("你好")).toBe("你好");
    expect(meaningfulChatTitle("  Literature review  ")).toBe(
      "Literature review",
    );
  });
});

describe("displayedChatTabTitle", () => {
  it("prefers the stored title, then the first user message", () => {
    const messages = [
      {
        type: "user" as const,
        message: { content: [{ type: "text" as const, text: "你好" }] },
      },
    ];
    expect(displayedChatTabTitle("Literature review", messages)).toBe(
      "Literature review",
    );
    expect(displayedChatTabTitle("|", messages)).toBe("你好");
    expect(displayedChatTabTitle("New Chat", messages)).toBe("你好");
    expect(displayedChatTabTitle("", [])).toBe("");
  });

  it("does not replace a real title with a placeholder from the model", () => {
    const snapshot = useClaudeChatStore.getState();
    const tab = snapshot.tabs[0];
    useClaudeChatStore.setState({
      activeProjectPath: "/tmp/project",
      tabs: [
        {
          ...tab,
          title: "你好",
          sessionId: "sess-1",
          projectPath: "/tmp/project",
        },
      ],
    });

    try {
      useClaudeChatStore.getState()._setSessionTitle("sess-1", "|");
      expect(useClaudeChatStore.getState().tabs[0]?.title).toBe("你好");

      useClaudeChatStore
        .getState()
        ._setSessionTitle("sess-1", "Revision notes");
      expect(useClaudeChatStore.getState().tabs[0]?.title).toBe(
        "Revision notes",
      );
    } finally {
      useClaudeChatStore.setState(snapshot, true);
    }
  });
});
