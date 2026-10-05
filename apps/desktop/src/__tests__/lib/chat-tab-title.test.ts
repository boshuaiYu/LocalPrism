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
    expect(meaningfulChatTitle("未命名")).toBeNull();
    expect(meaningfulChatTitle("未命名对话")).toBeNull();
    expect(meaningfulChatTitle("未命名会话")).toBeNull();
    expect(meaningfulChatTitle("Untitled session")).toBeNull();
    expect(meaningfulChatTitle("Untitled conversation")).toBeNull();
    expect(meaningfulChatTitle("UNTITLED CONVERSATION")).toBeNull();
    expect(
      meaningfulChatTitle("a1b2c3d4-e5f6-7890-abcd-ef1234567890"),
    ).toBeNull();
    expect(
      meaningfulChatTitle("  A1B2C3D4-E5F6-7890-ABCD-EF1234567890  "),
    ).toBeNull();
    expect(meaningfulChatTitle("!!!")).toBeNull();
    expect(meaningfulChatTitle("| |")).toBeNull();
    expect(meaningfulChatTitle("¥€$")).toBeNull();
    expect(meaningfulChatTitle("😀")).toBeNull();
    expect(meaningfulChatTitle("\u0301")).toBeNull();
    expect(meaningfulChatTitle("\u200b")).toBeNull();
  });

  it("keeps a real title, including symbols beside text", () => {
    expect(meaningfulChatTitle("你好")).toBe("你好");
    expect(meaningfulChatTitle("  Literature review  ")).toBe(
      "Literature review",
    );
    expect(meaningfulChatTitle("$100")).toBe("$100");
    expect(meaningfulChatTitle("E = mc²")).toBe("E = mc²");
    expect(meaningfulChatTitle("C++")).toBe("C++");
    expect(meaningfulChatTitle("∑x")).toBe("∑x");
    expect(meaningfulChatTitle("你好 😀")).toBe("你好 😀");
    expect(meaningfulChatTitle("价格：¥100")).toBe("价格：¥100");
    expect(meaningfulChatTitle("⼀")).toBe("⼀");
    expect(
      meaningfulChatTitle("Notes a1b2c3d4-e5f6-7890-abcd-ef1234567890"),
    ).toBe("Notes a1b2c3d4-e5f6-7890-abcd-ef1234567890");
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
    expect(displayedChatTabTitle("Untitled conversation", [])).toBe("");
    expect(
      displayedChatTabTitle("a1b2c3d4-e5f6-7890-abcd-ef1234567890", messages),
    ).toBe("你好");
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
