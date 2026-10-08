import { describe, expect, it } from "vitest";
import {
  CHAT_SCROLL_JUMP_INSET_PX,
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
    expect(chatScrollJumpRightPx(0)).toBe(12);
    expect(chatScrollJumpRightPx(-4)).toBe(12);
    expect(chatScrollJumpRightPx(Number.NaN)).toBe(12);
  });
});
