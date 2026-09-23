import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useClaudeChatStore,
  type ClaudeStreamMessage,
} from "@/stores/claude-chat-store";

function user(text: string, codexTurnId?: string): ClaudeStreamMessage {
  return {
    type: "user",
    ...(codexTurnId ? { codexTurnId } : {}),
    message: { content: [{ type: "text", text }] },
  };
}

function assistant(text: string, codexTurnId?: string): ClaudeStreamMessage {
  return {
    type: "assistant",
    ...(codexTurnId ? { codexTurnId } : {}),
    message: {
      content: [{ type: "text", text }],
      usage: { input_tokens: 100, output_tokens: 20 },
    },
  };
}

describe("rewindToMessage", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined);
    useClaudeChatStore.getState().resetForProject("/project-a");
  });

  it("truncates a local draft without calling the runtime", async () => {
    const tab = useClaudeChatStore.getState().tabs[0];
    const messages = [user("First prompt"), assistant("Answer"), user("Next")];
    useClaudeChatStore.setState({
      tabs: [{ ...tab, messages, projectPath: "/project-a" }],
      messages,
      sessionId: null,
    });

    const result = await useClaudeChatStore.getState().rewindToMessage(0);
    expect(result).toBe("rewound");
    expect(
      useClaudeChatStore.getState().messages.map((message) => message.type),
    ).toEqual(["user"]);
    expect(invoke).not.toHaveBeenCalledWith(
      "runtime_rewind_conversation",
      expect.anything(),
    );
  });

  it("keeps the Claude session id after the transcript is truncated", async () => {
    const tab = useClaudeChatStore.getState().tabs[0];
    const messages = [
      user("Rewrite the abstract"),
      assistant("Done"),
      user("Again"),
    ];
    const reference = {
      runtime: "claude" as const,
      sessionId: "session-a",
      projectPath: "/project-a",
    };
    useClaudeChatStore.setState({
      tabs: [
        {
          ...tab,
          messages,
          projectPath: "/project-a",
          runtime: "claude",
          sessionId: "session-a",
          sessionRef: reference,
        },
      ],
      messages,
      sessionId: "session-a",
    });
    vi.mocked(invoke).mockResolvedValueOnce(reference);

    const result = await useClaudeChatStore.getState().rewindToMessage(0);
    expect(result).toBe("rewound");
    expect(useClaudeChatStore.getState().messages).toHaveLength(1);
    expect(useClaudeChatStore.getState().sessionId).toBe("session-a");
    expect(invoke).toHaveBeenCalledWith("runtime_rewind_conversation", {
      request: expect.objectContaining({
        reference,
        role: "user",
        ordinal: 1,
      }),
    });
  });

  it("points a Codex tab at the forked thread", async () => {
    const tab = useClaudeChatStore.getState().tabs[0];
    const messages = [
      user("Review the proof", "turn-1"),
      assistant("Looks sound", "turn-1"),
      user("Now the appendix", "turn-2"),
    ];
    const reference = {
      runtime: "codex" as const,
      sessionId: "thread-old",
      projectPath: "/project-a",
    };
    useClaudeChatStore.setState({
      tabs: [
        {
          ...tab,
          messages,
          projectPath: "/project-a",
          runtime: "codex",
          sessionId: "thread-old",
          sessionRef: reference,
          activeCodexTurnId: "turn-2",
        },
      ],
      messages,
      sessionId: "thread-old",
    });
    vi.mocked(invoke).mockResolvedValueOnce({
      ...reference,
      sessionId: "thread-fork",
    });

    const result = await useClaudeChatStore.getState().rewindToMessage(0);
    const state = useClaudeChatStore.getState();
    expect(result).toBe("rewound");
    expect(state.messages).toHaveLength(2);
    expect(state.sessionId).toBe("thread-fork");
    expect(state.tabs[0]?.activeCodexTurnId ?? null).toBeNull();
    expect(invoke).toHaveBeenCalledWith("runtime_rewind_conversation", {
      request: expect.objectContaining({
        codexTurnId: "turn-1",
        userTurnOrdinal: 1,
      }),
    });
  });

  it("leaves the chat in place when the runtime rewind fails", async () => {
    const tab = useClaudeChatStore.getState().tabs[0];
    const messages = [user("Keep me"), assistant("Still here"), user("Later")];
    useClaudeChatStore.setState({
      tabs: [
        {
          ...tab,
          messages,
          projectPath: "/project-a",
          sessionId: "session-a",
          sessionRef: {
            runtime: "claude",
            sessionId: "session-a",
            projectPath: "/project-a",
          },
        },
      ],
      messages,
      sessionId: "session-a",
    });
    vi.mocked(invoke).mockRejectedValueOnce("disk busy");

    const result = await useClaudeChatStore.getState().rewindToMessage(0);
    expect(result).toBe("failed");
    expect(useClaudeChatStore.getState().messages).toEqual(messages);
    expect(useClaudeChatStore.getState().error).toMatch(/Couldn't rewind/);
    expect(useClaudeChatStore.getState().error).toMatch(/disk busy/);
  });

  it("refuses a send while rewind is still writing the transcript", async () => {
    const tab = useClaudeChatStore.getState().tabs[0];
    const messages = [user("Keep me"), assistant("Still here"), user("Later")];
    const reference = {
      runtime: "claude" as const,
      sessionId: "session-a",
      projectPath: "/project-a",
    };
    useClaudeChatStore.setState({
      tabs: [
        {
          ...tab,
          messages,
          projectPath: "/project-a",
          runtime: "claude",
          sessionId: "session-a",
          sessionRef: reference,
          isStreaming: false,
        },
      ],
      messages,
      sessionId: "session-a",
      isStreaming: false,
    });
    let release: (value: typeof reference) => void = () => {};
    vi.mocked(invoke).mockImplementation((command: string) => {
      if (command === "runtime_rewind_conversation") {
        return new Promise((resolve) => {
          release = resolve;
        });
      }
      return Promise.resolve(undefined);
    });

    const pending = useClaudeChatStore.getState().rewindToMessage(0);
    await Promise.resolve();
    await useClaudeChatStore.getState().sendPrompt("Do not send this");

    expect(useClaudeChatStore.getState().messages).toHaveLength(3);
    expect(useClaudeChatStore.getState().isStreaming).toBe(false);
    expect(useClaudeChatStore.getState().error).toMatch(/rewind/i);
    expect(invoke).not.toHaveBeenCalledWith(
      "runtime_start_turn",
      expect.anything(),
    );

    release(reference);
    await expect(pending).resolves.toBe("rewound");
    expect(useClaudeChatStore.getState().messages).toHaveLength(1);
    expect(useClaudeChatStore.getState().error).toBeNull();
  });

  it("does not rewind while a turn is streaming", async () => {
    const tab = useClaudeChatStore.getState().tabs[0];
    const messages = [user("First"), user("Second")];
    useClaudeChatStore.setState({
      tabs: [
        { ...tab, messages, isStreaming: true, projectPath: "/project-a" },
      ],
      messages,
      isStreaming: true,
    });

    const result = await useClaudeChatStore.getState().rewindToMessage(0);
    expect(result).toBe("skipped");
    expect(useClaudeChatStore.getState().messages).toEqual(messages);
  });
});
