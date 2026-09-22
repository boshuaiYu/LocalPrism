import { describe, expect, it } from "vitest";
import {
  chatTerminalState,
  settleChatMessages,
  type SettlableMessage,
} from "@/lib/chat-turn-settlement";

const history: SettlableMessage[] = [
  {
    type: "user",
    message: { content: [{ type: "text", text: "Explain the proof" }] },
  },
  {
    type: "assistant",
    subtype: "streaming_delta",
    message: {
      content: [
        { type: "thinking", thinking: "Thinking..." },
        { type: "text", text: "No response requested." },
        { type: "thinking", thinking: "Check the lemma first." },
        { type: "text", text: "The lemma holds." },
        { type: "tool_use", id: "tool-1" },
      ],
    },
  },
  {
    type: "result",
    result: "No response requested.",
  },
];

describe("settleChatMessages", () => {
  it("clears thinking and no-response residue when a turn finishes", () => {
    const settled = settleChatMessages(history);
    expect(settled).toHaveLength(2);
    const assistant = settled[1];
    expect(assistant?.subtype).toBe("streaming_delta");
    expect(assistant?.message?.content).toEqual([
      { type: "thinking", thinking: "Check the lemma first." },
      { type: "text", text: "The lemma holds." },
      { type: "tool_use", id: "tool-1" },
    ]);
    expect(settled.some((message) => message.type === "result")).toBe(false);
  });

  it("drops an assistant bubble that is only residue after an error", () => {
    const settled = settleChatMessages([
      {
        type: "assistant",
        subtype: "streaming_delta",
        is_error: true,
        message: {
          content: [{ type: "text", text: "No response requested." }],
        },
      },
    ]);
    expect(settled).toEqual([]);
  });
});

describe("chatTerminalState", () => {
  it("keeps a live turn streaming and finishes the others", () => {
    expect(chatTerminalState({ live: true, unfinished: true })).toBe(
      "streaming",
    );
    expect(chatTerminalState({ live: false, error: true })).toBe("error");
    expect(chatTerminalState({ live: false, unfinished: true })).toBe(
      "cancelled",
    );
    expect(chatTerminalState({ live: false })).toBe("completed");
  });
});
