import { describe, expect, it } from "vitest";
import { contentPaneSize } from "@/stores/chat-layout-store";

describe("contentPaneSize", () => {
  it("gives editor and preview equal leftover width when chat is hidden", () => {
    expect(
      contentPaneSize({
        code: true,
        chat: false,
        pdf: true,
        pane: "code",
      }),
    ).toBe(42.5);
    expect(
      contentPaneSize({
        code: true,
        chat: false,
        pdf: true,
        pane: "pdf",
      }),
    ).toBe(42.5);
    expect(
      contentPaneSize({
        code: true,
        chat: false,
        pdf: true,
        pane: "chat",
      }),
    ).toBe(0);
  });

  it("gives the remaining workspace width to a single content pane", () => {
    expect(
      contentPaneSize({
        code: true,
        chat: false,
        pdf: false,
        pane: "code",
      }),
    ).toBe(85);
  });

  it("keeps chat narrower than the editor or preview when two panes are open", () => {
    expect(
      contentPaneSize({
        code: true,
        chat: true,
        pdf: false,
        pane: "chat",
      }),
    ).toBe(32);
    expect(
      contentPaneSize({
        code: true,
        chat: true,
        pdf: false,
        pane: "code",
      }),
    ).toBe(53);
  });

  it("reserves room for editor, chat, and preview together", () => {
    expect(
      contentPaneSize({
        code: true,
        chat: true,
        pdf: true,
        pane: "code",
      }) +
        contentPaneSize({
          code: true,
          chat: true,
          pdf: true,
          pane: "chat",
        }) +
        contentPaneSize({
          code: true,
          chat: true,
          pdf: true,
          pane: "pdf",
        }),
    ).toBe(85);
  });
});
