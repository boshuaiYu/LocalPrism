import { describe, expect, it } from "vitest";
import { CHAT_COMPOSER_FRAME_CLASS } from "@/components/claude-chat/chat-composer";

describe("chat composer frame", () => {
  it("uses normal bottom padding instead of a fixed 3rem strip", () => {
    expect(CHAT_COMPOSER_FRAME_CLASS).toContain(
      "pb-[max(0.75rem,var(--chat-bottom-gutter,0px))]",
    );
    expect(CHAT_COMPOSER_FRAME_CLASS).not.toContain("3rem");
    expect(CHAT_COMPOSER_FRAME_CLASS).not.toContain("safe-area-inset-bottom");
    expect(CHAT_COMPOSER_FRAME_CLASS).toContain("h-full");
    expect(CHAT_COMPOSER_FRAME_CLASS).toContain("max-w-[44rem]");
  });
});
