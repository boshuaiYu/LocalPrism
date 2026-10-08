import { describe, expect, it } from "vitest";
import { accountHeaderChrome } from "@/components/claude-chat/chat-tab-bar";
import {
  CHAT_TAB_LEARN_CHROME_PX,
  CHAT_TAB_LEARN_SLOT_PX,
  CHAT_TAB_LEARN_STATUS_PX,
  CHAT_TAB_LEARN_TEXT_PX,
  CHAT_TAB_WRITING_MANY_MAX_PX,
  CHAT_TAB_WRITING_SLOT_PX,
  chatTabStripPlan,
  chatTabStripReservedPx,
  defaultThreePaneChatBarPx,
} from "@/lib/chat-tab-strip";

describe("chat tab strip budget", () => {
  it("fits Learn LaTeX and a writing tab in the default 1280 three-pane chat column", () => {
    const barWidth = defaultThreePaneChatBarPx(1280);
    expect(barWidth).toBe(307);
    expect(CHAT_TAB_LEARN_SLOT_PX).toBe(
      CHAT_TAB_LEARN_CHROME_PX +
        CHAT_TAB_LEARN_STATUS_PX +
        CHAT_TAB_LEARN_TEXT_PX,
    );
    // 「边写边学」 is four 12px ems, shorter than the English label.
    expect(CHAT_TAB_LEARN_TEXT_PX).toBeGreaterThanOrEqual(48);

    const chrome = accountHeaderChrome(barWidth);
    const plan = chatTabStripPlan({
      barWidthPx: barWidth,
      writingTabCount: 1,
      hasLearnTab: true,
      chrome,
    });

    expect(plan.pinLearnTab).toBe(true);
    expect(plan.learnSlotPx).toBe(CHAT_TAB_LEARN_SLOT_PX);
    expect(plan.writingTabMinPx).toBe(CHAT_TAB_WRITING_SLOT_PX);
    expect(plan.hideLeadingLabel).toBe(true);
    expect(chatTabStripReservedPx(plan, chrome.utilities)).toBeLessThanOrEqual(
      barWidth,
    );
  });

  it("keeps both labels when the history controls are showing", () => {
    const barWidth = 420;
    const chrome = accountHeaderChrome(barWidth);
    expect(chrome.utilities).toBe(true);
    const plan = chatTabStripPlan({
      barWidthPx: barWidth,
      writingTabCount: 1,
      hasLearnTab: true,
      chrome,
    });
    expect(plan.pinLearnTab).toBe(true);
    expect(plan.learnSlotPx).toBe(CHAT_TAB_LEARN_SLOT_PX);
    expect(plan.writingTabMinPx).toBeGreaterThan(CHAT_TAB_WRITING_SLOT_PX);
    expect(chatTabStripReservedPx(plan, chrome.utilities)).toBeLessThanOrEqual(
      barWidth,
    );
  });

  it("shrinks extra writing tabs without narrowing the learning tab", () => {
    const chrome = accountHeaderChrome(307);
    const one = chatTabStripPlan({
      barWidthPx: 307,
      writingTabCount: 1,
      hasLearnTab: true,
      chrome,
    });
    const many = chatTabStripPlan({
      barWidthPx: 307,
      writingTabCount: 4,
      hasLearnTab: true,
      chrome,
    });
    expect(many.pinLearnTab).toBe(true);
    expect(many.learnSlotPx).toBe(one.learnSlotPx);
    expect(many.writingTabMaxPx).toBe(CHAT_TAB_WRITING_MANY_MAX_PX);
    expect(many.writingTabMaxPx).toBeLessThan(one.writingTabMaxPx);
    expect(chatTabStripReservedPx(many, chrome.utilities)).toBeLessThanOrEqual(
      307,
    );
  });

  it("leaves the single-tab account chrome alone", () => {
    const mid = chatTabStripPlan({
      barWidthPx: 234,
      writingTabCount: 1,
      hasLearnTab: false,
      chrome: accountHeaderChrome(234),
    });
    expect(mid.pinLearnTab).toBe(false);
    expect(mid.learnSlotPx).toBe(0);
    expect(mid.accountMinPx).toBe(160);
    expect(mid.accountDensity).toBe("full");
    expect(mid.hideLeadingLabel).toBe(false);

    const narrow = chatTabStripPlan({
      barWidthPx: 94,
      writingTabCount: 1,
      hasLearnTab: false,
      chrome: accountHeaderChrome(94),
    });
    expect(narrow.accountMinPx).toBe(0);
    expect(narrow.accountDensity).toBe("provider");
    expect(narrow.hideLeadingLabel).toBe(true);
  });
});
