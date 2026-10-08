import { describe, expect, it } from "vitest";
import { accountHeaderChrome } from "@/components/claude-chat/chat-tab-bar";
import {
  CHAT_STRIP_FONT_STACK,
  CHAT_TAB_ACCOUNT_GAP_PX,
  CHAT_TAB_ACCOUNT_ICON_PX,
  CHAT_TAB_CLUSTER_PAD_PX,
  CHAT_TAB_LEARN_CHROME_PX,
  CHAT_TAB_LEADING_ICON_PX,
  CHAT_TAB_UTILITIES_PX,
  CHAT_TAB_WRITING_MANY_MAX_PX,
  CHAT_TAB_WRITING_MAX_PX,
  CHAT_TAB_WRITING_MIN_PX,
  CHAT_TAB_WRITING_TARGET,
  type ChatTabStripLabels,
  chatStripLabelPx,
  chatStripTextUpperBoundPx,
  chatTabAccountSlotPx,
  chatTabStripPlan,
  chatTabStripReservedPx,
  chatTabWritingPreferredPx,
  defaultThreePaneChatBarPx,
  measureChatStripCanvasPx,
} from "@/lib/chat-tab-strip";

const EN: ChatTabStripLabels = {
  learn: "Learn LaTeX",
  leading: "Hide",
  accountFull: "DeepSeek",
  accountProvider: "DeepSeek",
};

const ZH: ChatTabStripLabels = {
  learn: "边写边学",
  leading: "隐藏",
  accountFull: "DeepSeek",
  accountProvider: "DeepSeek",
};

const LONG_ACCOUNT: ChatTabStripLabels = {
  learn: "Learn LaTeX",
  leading: "Hide",
  accountFull: "SiliconFlow · Qwen/Qwen3.6-35B-A3B",
  accountProvider: "SiliconFlow",
};

function planAt(
  bar: number,
  labels: ChatTabStripLabels,
  extra?: {
    writingTabCount?: number;
    hasLearnTab?: boolean;
    textPx?: Parameters<typeof chatTabStripPlan>[0]["textPx"];
  },
) {
  return chatTabStripPlan({
    barWidthPx: bar,
    writingTabCount: extra?.writingTabCount ?? 1,
    hasLearnTab: extra?.hasLearnTab ?? true,
    labels,
    textPx: extra?.textPx,
  });
}

describe("chat tab strip budget", () => {
  it("uses one font stack and a shared upper bound instead of one OS's glyphs", () => {
    expect(CHAT_STRIP_FONT_STACK).toContain("Segoe UI");
    expect(CHAT_STRIP_FONT_STACK).toContain("SF Pro Text");
    expect(CHAT_STRIP_FONT_STACK).toContain("Cantarell");
    expect(CHAT_STRIP_FONT_STACK).toContain("Noto Sans");
    expect(CHAT_STRIP_FONT_STACK).toContain("PingFang SC");
    expect(CHAT_STRIP_FONT_STACK).toContain("Microsoft YaHei");
    expect(chatStripTextUpperBoundPx("边写边学")).toBe(48);
    expect(chatStripTextUpperBoundPx("隐藏")).toBe(24);
    expect(chatStripTextUpperBoundPx("Learn LaTeX")).toBeGreaterThan(
      chatStripTextUpperBoundPx("边写边学"),
    );
    expect(chatTabWritingPreferredPx()).toBe(
      chatStripTextUpperBoundPx(CHAT_TAB_WRITING_TARGET) + 28,
    );
    expect(chatStripLabelPx("Learn LaTeX", 10)).toBe(
      chatStripTextUpperBoundPx("Learn LaTeX"),
    );
    expect(chatStripLabelPx("Learn LaTeX", 120)).toBe(120);
  });

  it("reads a canvas advance and ignores a context that cannot measure", () => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = (() => ({
      measureText: () => ({ width: 88.2 }),
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    try {
      expect(measureChatStripCanvasPx("Learn LaTeX")).toBe(88.2);
    } finally {
      HTMLCanvasElement.prototype.getContext = original;
    }

    HTMLCanvasElement.prototype.getContext = (() =>
      null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    try {
      expect(measureChatStripCanvasPx("DeepSeek")).toBe(0);
    } finally {
      HTMLCanvasElement.prototype.getContext = original;
    }
  });

  it("fits the learning label and a writing tab in the default 1280 three-pane column", () => {
    const barWidth = defaultThreePaneChatBarPx(1280);
    expect(barWidth).toBe(307);

    for (const labels of [EN, ZH]) {
      const plan = planAt(barWidth, labels);
      expect(plan.pinLearnTab, labels.learn).toBe(true);
      expect(plan.resolvedBarPx, labels.learn).toBe(307);
      expect(plan.showUtilities, labels.learn).toBe(false);
      expect(plan.hideLeadingLabel, labels.learn).toBe(true);
      expect(plan.accountDensity, labels.learn).toBe("icon");
      expect(plan.accountMinPx, labels.learn).toBe(
        CHAT_TAB_ACCOUNT_ICON_PX + CHAT_TAB_CLUSTER_PAD_PX,
      );
      expect(plan.learnSlotPx, labels.learn).toBe(
        CHAT_TAB_LEARN_CHROME_PX + chatStripTextUpperBoundPx(labels.learn),
      );
      expect(plan.leadingPx, labels.learn).toBe(CHAT_TAB_LEADING_ICON_PX);
      expect(plan.writingTabMinPx, labels.learn).toBe(CHAT_TAB_WRITING_MIN_PX);
      expect(plan.writingTabMinPx, labels.learn).toBeGreaterThan(0);
      expect(plan.writingTabMaxPx, labels.learn).toBe(plan.writingRoomPx);
      expect(plan.writingRoomPx, labels.learn).toBeGreaterThan(
        CHAT_TAB_WRITING_MIN_PX,
      );
      expect(plan.writingScrollerMinPx, labels.learn).toBe(
        plan.writingTabMinPx,
      );
      expect(chatTabStripReservedPx(plan), labels.learn).toBeLessThanOrEqual(
        barWidth,
      );
    }

    const english = planAt(307, EN);
    const chinese = planAt(307, ZH);
    expect(chinese.learnSlotPx).toBeLessThan(english.learnSlotPx);
    expect(chinese.writingRoomPx).toBeGreaterThan(english.writingRoomPx);
  });

  it("plans an unmeasured learning strip as the default column, not the roomy truncation", () => {
    const measured = planAt(307, EN);
    const unmeasured = planAt(0, EN);
    expect(unmeasured.resolvedBarPx).toBe(307);
    expect(unmeasured.accountDensity).toBe(measured.accountDensity);
    expect(unmeasured.hideLeadingLabel).toBe(true);
    expect(unmeasured.showUtilities).toBe(false);
    expect(unmeasured.writingTabMaxPx).toBe(measured.writingTabMaxPx);
  });

  it("collapses optional chrome across widths without slicing the provider name", () => {
    const widths = [280, 307, 360, 420, 450, 600];
    for (const bar of widths) {
      for (const labels of [EN, ZH]) {
        const plan = planAt(bar, labels);
        const label =
          plan.accountDensity === "full"
            ? labels.accountFull
            : labels.accountProvider;
        expect(plan.showUtilities, `${bar} ${labels.learn}`).toBe(bar >= 420);
        expect(plan.utilitiesPx, `${bar}`).toBe(
          plan.showUtilities ? CHAT_TAB_UTILITIES_PX : 0,
        );
        expect(plan.accountMinPx, `${bar} ${labels.learn}`).toBe(
          chatTabAccountSlotPx(plan.accountDensity, label),
        );
        expect(plan.writingTabMinPx, `${bar}`).toBeGreaterThan(0);
        expect(plan.writingTabMinPx, `${bar}`).toBeLessThanOrEqual(
          plan.writingTabMaxPx,
        );
        expect(plan.learnSlotPx).toBe(
          CHAT_TAB_LEARN_CHROME_PX + chatStripTextUpperBoundPx(labels.learn),
        );
        expect(chatTabStripReservedPx(plan), `${bar}`).toBeLessThanOrEqual(bar);
        if (plan.accountDensity !== "icon") {
          expect(plan.accountMinPx).toBeGreaterThan(
            CHAT_TAB_ACCOUNT_ICON_PX +
              CHAT_TAB_ACCOUNT_GAP_PX +
              CHAT_TAB_CLUSTER_PAD_PX,
          );
        }
      }
    }

    for (const bar of [280, 307, 360, 420, 450]) {
      expect(planAt(bar, EN).accountDensity, String(bar)).toBe("icon");
      expect(planAt(bar, EN).hideLeadingLabel, String(bar)).toBe(true);
      expect(planAt(bar, ZH).accountDensity, String(bar)).toBe("icon");
      expect(planAt(bar, ZH).hideLeadingLabel, String(bar)).toBe(true);
    }

    const wide = planAt(600, EN);
    expect(wide.accountDensity).toBe("full");
    expect(wide.hideLeadingLabel).toBe(false);
    expect(wide.showUtilities).toBe(true);
    expect(wide.writingRoomPx).toBeGreaterThanOrEqual(
      chatTabWritingPreferredPx(),
    );
    expect(planAt(600, ZH).accountDensity).toBe("full");
    expect(planAt(600, ZH).hideLeadingLabel).toBe(false);
  });

  it("gives a long model the whole provider name or the icon, never a fragment width", () => {
    const narrow = planAt(307, LONG_ACCOUNT);
    expect(narrow.accountDensity).toBe("icon");
    expect(narrow.accountMinPx).toBe(
      CHAT_TAB_ACCOUNT_ICON_PX + CHAT_TAB_CLUSTER_PAD_PX,
    );

    const wide = planAt(600, LONG_ACCOUNT);
    const shown =
      wide.accountDensity === "full"
        ? LONG_ACCOUNT.accountFull
        : LONG_ACCOUNT.accountProvider;
    expect(wide.accountDensity).not.toBe("icon");
    expect(wide.accountMinPx).toBe(
      chatTabAccountSlotPx(wide.accountDensity, shown),
    );
    expect(wide.writingRoomPx).toBeGreaterThanOrEqual(CHAT_TAB_WRITING_MIN_PX);
    expect(chatTabStripReservedPx(wide)).toBeLessThanOrEqual(600);
  });

  it("lets a live measurement raise the bound without revealing a clipped label", () => {
    const bound = chatStripTextUpperBoundPx("Learn LaTeX");
    const raised = planAt(307, EN, { textPx: { learn: bound + 40 } });
    const ignored = planAt(307, EN, { textPx: { learn: 12, leading: 4 } });
    expect(raised.learnSlotPx).toBe(CHAT_TAB_LEARN_CHROME_PX + bound + 40);
    expect(ignored.learnSlotPx).toBe(planAt(307, EN).learnSlotPx);
    expect(raised.accountDensity).toBe("icon");
    expect(raised.writingTabMinPx).toBeGreaterThan(0);
  });

  it("shrinks extra writing tabs without narrowing the learning tab", () => {
    const one = planAt(600, EN);
    const many = planAt(600, EN, { writingTabCount: 4 });
    expect(many.pinLearnTab).toBe(true);
    expect(many.learnSlotPx).toBe(one.learnSlotPx);
    expect(many.accountDensity).toBe(one.accountDensity);
    expect(many.writingTabMaxPx).toBe(CHAT_TAB_WRITING_MANY_MAX_PX);
    expect(one.writingTabMaxPx).toBeLessThanOrEqual(CHAT_TAB_WRITING_MAX_PX);
    expect(many.writingTabMaxPx).toBeLessThan(one.writingTabMaxPx);
    expect(many.writingTabMinPx).toBeGreaterThan(0);

    const tight = planAt(307, EN);
    const tightMany = planAt(307, EN, { writingTabCount: 4 });
    expect(tightMany.learnSlotPx).toBe(tight.learnSlotPx);
    expect(tightMany.writingTabMaxPx).toBeLessThanOrEqual(
      tight.writingTabMaxPx,
    );
    expect(tightMany.writingTabMinPx).toBeGreaterThan(0);
  });

  it("keeps a single writing tab's account readable when the lesson tab is closed", () => {
    const mid = planAt(234, EN, { hasLearnTab: false });
    expect(mid.pinLearnTab).toBe(false);
    expect(mid.learnSlotPx).toBe(0);
    expect(mid.showUtilities).toBe(false);
    expect(mid.accountDensity).toBe("full");
    expect(mid.hideLeadingLabel).toBe(false);
    expect(mid.accountMinPx).toBe(chatTabAccountSlotPx("full", EN.accountFull));
    expect(mid.writingTabMinPx).toBe(CHAT_TAB_WRITING_MIN_PX);
    expect(mid.writingTabMinPx).toBeGreaterThan(0);

    const narrow = planAt(94, EN, { hasLearnTab: false });
    expect(narrow.accountDensity).toBe("icon");
    expect(narrow.hideLeadingLabel).toBe(true);
    expect(narrow.accountMinPx).toBe(
      CHAT_TAB_ACCOUNT_ICON_PX + CHAT_TAB_CLUSTER_PAD_PX,
    );
    expect(narrow.writingTabMinPx).toBeGreaterThan(0);
    expect(narrow.writingTabMaxPx).toBe(narrow.writingRoomPx);

    const roomy = planAt(0, EN, { hasLearnTab: false });
    expect(roomy.hideLeadingLabel).toBe(false);
    expect(roomy.accountDensity).toBe("full");
    expect(roomy.showUtilities).toBe(true);
  });

  it("does not icon-collapse the account when there is no writing tab to widen", () => {
    const lessonOnly = planAt(307, EN, { writingTabCount: 0 });
    expect(lessonOnly.writingTabMinPx).toBe(0);
    expect(lessonOnly.accountDensity).not.toBe("icon");
    expect(lessonOnly.accountMinPx).toBe(
      chatTabAccountSlotPx(lessonOnly.accountDensity, EN.accountFull),
    );
  });

  it("still treats column width, not glyph width, as the utility threshold", () => {
    expect(accountHeaderChrome(0).utilities).toBe(true);
    expect(accountHeaderChrome(420).utilities).toBe(true);
    expect(accountHeaderChrome(419).utilities).toBe(false);
    expect(accountHeaderChrome(94).hideLabel).toBe(true);
  });
});
