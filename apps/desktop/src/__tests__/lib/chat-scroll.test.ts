import { describe, expect, it } from "vitest";
import { transcriptHasContentBelow } from "@/lib/chat-scroll";

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
