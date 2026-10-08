import { describe, expect, it } from "vitest";
import { accountHeaderChrome } from "@/components/claude-chat/chat-tab-bar";
import {
  CHAT_TAB_LEARN_CHROME_PX,
  CHAT_TAB_LEARN_SLOT_PX,
  CHAT_TAB_LEARN_STATUS_PX,
  CHAT_TAB_LEARN_TEXT_PX,
  CHAT_TAB_WRITING_MANY_MAX_PX,
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
    expect(plan.learnSlotPx).toBe(134);
    // One spare pixel above the 92px floor stays on the writing tab.
    expect(plan.writingTabMinPx).toBe(93);
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
    expect(plan.accountMinPx).toBe(72);
    expect(plan.accountDensity).toBe("full");
    expect(plan.hideLeadingLabel).toBe(true);
    expect(plan.writingTabMinPx).toBe(94);
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

  it("collapses the account and leading label like main, then gives leftover width to the writing tab", () => {
    const cases = [
      {
        bar: 280,
        accountMinPx: 40,
        accountDensity: "provider" as const,
        hideLeadingLabel: true,
        writingTabMinPx: 66,
      },
      {
        bar: 300,
        accountMinPx: 40,
        accountDensity: "provider" as const,
        hideLeadingLabel: true,
        writingTabMinPx: 86,
      },
      {
        bar: 360,
        accountMinPx: 72,
        accountDensity: "full" as const,
        hideLeadingLabel: true,
        writingTabMinPx: 114,
      },
      {
        bar: 400,
        accountMinPx: 72,
        accountDensity: "full" as const,
        hideLeadingLabel: false,
        writingTabMinPx: 118,
      },
      {
        bar: 450,
        accountMinPx: 72,
        accountDensity: "full" as const,
        hideLeadingLabel: false,
        writingTabMinPx: 88,
      },
      {
        bar: 600,
        accountMinPx: 72,
        accountDensity: "full" as const,
        hideLeadingLabel: false,
        writingTabMinPx: 128,
      },
    ];

    for (const expected of cases) {
      const chrome = accountHeaderChrome(expected.bar);
      const plan = chatTabStripPlan({
        barWidthPx: expected.bar,
        writingTabCount: 1,
        hasLearnTab: true,
        chrome,
      });
      expect(plan.accountMinPx, String(expected.bar)).toBe(
        expected.accountMinPx,
      );
      expect(plan.accountDensity, String(expected.bar)).toBe(
        expected.accountDensity,
      );
      expect(plan.hideLeadingLabel, String(expected.bar)).toBe(
        expected.hideLeadingLabel,
      );
      expect(plan.writingTabMinPx, String(expected.bar)).toBe(
        expected.writingTabMinPx,
      );
      expect(plan.writingScrollerMinPx, String(expected.bar)).toBe(
        plan.writingTabMinPx,
      );
      expect(plan.writingTabMinPx, String(expected.bar)).toBeGreaterThan(0);
      expect(plan.writingTabMinPx, String(expected.bar)).toBeLessThanOrEqual(
        128,
      );
      expect(plan.learnSlotPx).toBe(134);
      expect(
        chatTabStripReservedPx(plan, chrome.utilities),
        String(expected.bar),
      ).toBeLessThanOrEqual(expected.bar);
    }
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
