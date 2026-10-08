import { describe, expect, it } from "vitest";
import {
  CHAT_SCROLL_JUMP_BUTTON_PX,
  CHAT_SCROLL_JUMP_GUTTER_FLOOR_PX,
  CHAT_SCROLL_JUMP_INSET_PX,
  chatScrollJumpContentInsetPx,
  chatScrollJumpRightPx,
  scrollbarGutterPx,
  transcriptHasContentBelow,
} from "@/lib/chat-scroll";

describe("transcriptHasContentBelow", () => {
  it("is false when the transcript fits or the reader is on the latest messages", () => {
    expect(
      transcriptHasContentBelow({
        scrollHeight: 200,
        clientHeight: 200,
        scrollTop: 0,
      }),
    ).toBe(false);
    expect(
      transcriptHasContentBelow({
        scrollHeight: 249,
        clientHeight: 200,
        scrollTop: 0,
      }),
    ).toBe(false);
    expect(
      transcriptHasContentBelow({
        scrollHeight: 400,
        clientHeight: 200,
        scrollTop: 160,
      }),
    ).toBe(false);
  });

  it("is true when the reader is scrolled up or newer messages sit below the viewport", () => {
    expect(
      transcriptHasContentBelow({
        scrollHeight: 250,
        clientHeight: 200,
        scrollTop: 0,
      }),
    ).toBe(true);
    expect(
      transcriptHasContentBelow({
        scrollHeight: 900,
        clientHeight: 200,
        scrollTop: 100,
      }),
    ).toBe(true);
  });
});

describe("chat scroll jump placement", () => {
  it("insets the control by the stable scrollbar gutter plus a fixed gap", () => {
    expect(CHAT_SCROLL_JUMP_INSET_PX).toBe(12);
    expect(scrollbarGutterPx(317, 300)).toBe(17);
    expect(scrollbarGutterPx(300, 300)).toBe(0);
    expect(scrollbarGutterPx(10, 30)).toBe(0);
    expect(scrollbarGutterPx(Number.NaN, 30)).toBe(0);
    expect(chatScrollJumpRightPx(17)).toBe(29);
    expect(chatScrollJumpRightPx(0)).toBe(
      CHAT_SCROLL_JUMP_GUTTER_FLOOR_PX + 12,
    );
    expect(chatScrollJumpRightPx(0)).toBe(24);
    expect(chatScrollJumpRightPx(-4)).toBe(24);
    expect(chatScrollJumpRightPx(Number.NaN)).toBe(24);
  });

  it("always reserves a text lane that clears the control, including a zero gutter", () => {
    for (const gutter of [0, 8, 15, 17]) {
      const right = chatScrollJumpRightPx(gutter);
      const inset = chatScrollJumpContentInsetPx(gutter);
      const measured = gutter > 0 ? gutter : 0;
      const buttonLeftFromContentEdge =
        right + CHAT_SCROLL_JUMP_BUTTON_PX - measured;
      expect(inset, String(gutter)).toBeGreaterThanOrEqual(
        buttonLeftFromContentEdge + CHAT_SCROLL_JUMP_INSET_PX,
      );
    }
    expect(chatScrollJumpContentInsetPx(0)).toBe(72);
    expect(chatScrollJumpContentInsetPx(17)).toBe(60);
    expect(chatScrollJumpContentInsetPx(17, 48)).toBe(72);
    expect(chatScrollJumpContentInsetPx(17, 20)).toBe(60);
  });
});
