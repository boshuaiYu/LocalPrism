import { describe, expect, it } from "vitest";
import { chatStripTextUpperBoundPx } from "@/lib/chat-tab-strip";
import { translate } from "@/lib/i18n";
import {
  STATUS_NOTICE_BUTTON_PAD_PX,
  STATUS_VERSION_NOTICE_GAP_PX,
  planStatusVersionNotice,
  statusLabelMeasurementPx,
} from "@/lib/status-bar-layout";

const VERSION = "LocalPrism v1.0.8";
/**
 * Project sidebar footer is about 210px. Below 13.75rem the actions wrap,
 * and px-1.5 leaves roughly this content box for the version cluster.
 */
const NARROW_CLUSTER_PX = 198;
const SIDEBAR_FOOTER_PX = 210;
const WIDE_CLUSTER_PX = 720;

const BETA_ZH = translate("zh", "updates.flashBeta", { version: "1.0.9beta2" });
const BETA_EN = translate("en", "updates.flashBeta", { version: "1.0.9beta2" });
const STABLE_ZH = translate("zh", "updates.flashAvailable", {
  version: "1.0.9",
});
const STABLE_EN = translate("en", "updates.flashAvailable", {
  version: "1.0.9",
});

function neededPx(version: string, notice: string): number {
  return (
    chatStripTextUpperBoundPx(version) +
    STATUS_VERSION_NOTICE_GAP_PX +
    chatStripTextUpperBoundPx(notice) +
    STATUS_NOTICE_BUTTON_PAD_PX
  );
}

function planAt(
  availablePx: number,
  notice: string,
  measuredNoticePx?: number,
) {
  return planStatusVersionNotice({
    availablePx,
    versionLabel: VERSION,
    noticeLabel: notice,
    noticeChromePx: STATUS_NOTICE_BUTTON_PAD_PX,
    measuredNoticePx,
  });
}

describe("status bar version hint layout", () => {
  it("uses the real zh and en hint strings", () => {
    expect(BETA_ZH).toBe("测试版 1.0.9beta2");
    expect(BETA_EN).toBe("Beta 1.0.9beta2");
    expect(STABLE_ZH).toBe("新版本 1.0.9");
    expect(STABLE_EN).toBe("Update 1.0.9");
  });

  it("stacks a long beta hint in a narrow sidebar without clipping either line", () => {
    for (const notice of [BETA_ZH, BETA_EN]) {
      expect(neededPx(VERSION, notice)).toBeGreaterThan(SIDEBAR_FOOTER_PX);
      expect(neededPx(VERSION, notice)).toBeGreaterThan(NARROW_CLUSTER_PX);
      const plan = planAt(NARROW_CLUSTER_PX, notice);
      expect(plan.layout).toBe("stacked");
      expect(plan.versionFits).toBe(true);
      expect(plan.noticeFits).toBe(true);
      expect(chatStripTextUpperBoundPx(VERSION)).toBeLessThanOrEqual(
        NARROW_CLUSTER_PX,
      );
      expect(
        chatStripTextUpperBoundPx(notice) + STATUS_NOTICE_BUTTON_PAD_PX,
      ).toBeLessThanOrEqual(NARROW_CLUSTER_PX);
    }
  });

  it("keeps the hint on one line when the footer is wide", () => {
    for (const notice of [BETA_ZH, BETA_EN, STABLE_ZH, STABLE_EN]) {
      expect(neededPx(VERSION, notice)).toBeLessThanOrEqual(WIDE_CLUSTER_PX);
      const plan = planAt(WIDE_CLUSTER_PX, notice);
      expect(plan.layout).toBe("inline");
      expect(plan.versionFits).toBe(true);
      expect(plan.noticeFits).toBe(true);
    }
  });

  it("stays on one line only when the combined text fits", () => {
    const needed = neededPx(VERSION, STABLE_ZH);
    expect(planAt(needed, STABLE_ZH).layout).toBe("inline");
    expect(planAt(needed - 1, STABLE_ZH).layout).toBe("stacked");
    expect(planAt(needed - 1, STABLE_ZH).versionFits).toBe(true);
    expect(planAt(needed - 1, STABLE_ZH).noticeFits).toBe(true);
  });

  it("lets a wider runtime measurement raise the bound and ignores a narrower one", () => {
    const needed = neededPx(VERSION, STABLE_EN);
    expect(planAt(needed, STABLE_EN).layout).toBe("inline");
    expect(planAt(needed, STABLE_EN, 1).layout).toBe("inline");
    expect(planAt(needed, STABLE_EN, needed).layout).toBe("stacked");

    const narrow = planAt(NARROW_CLUSTER_PX, BETA_ZH, 1);
    expect(narrow.layout).toBe("stacked");
    expect(narrow.versionFits).toBe(true);
    expect(narrow.noticeFits).toBe(true);
  });

  it("wraps a single label that is wider than the cluster instead of ellipsizing", () => {
    const versionPx = chatStripTextUpperBoundPx(VERSION);
    const plan = planStatusVersionNotice({
      availablePx: versionPx - 1,
      versionLabel: VERSION,
      noticeLabel: BETA_ZH,
      noticeChromePx: STATUS_NOTICE_BUTTON_PAD_PX,
    });
    expect(plan.layout).toBe("stacked");
    expect(plan.versionFits).toBe(false);
    expect(plan.noticeFits).toBe(
      chatStripTextUpperBoundPx(BETA_ZH) + STATUS_NOTICE_BUTTON_PAD_PX <=
        versionPx - 1,
    );
  });

  it("stays inline until a width is known and when there is no hint", () => {
    expect(
      planStatusVersionNotice({
        availablePx: 0,
        versionLabel: VERSION,
        noticeLabel: BETA_ZH,
        noticeChromePx: STATUS_NOTICE_BUTTON_PAD_PX,
      }).layout,
    ).toBe("inline");
    expect(
      planStatusVersionNotice({
        availablePx: 80,
        versionLabel: VERSION,
      }),
    ).toEqual({
      layout: "inline",
      versionFits: false,
      noticeFits: true,
    });
  });

  it("reads a canvas advance and ignores a context that cannot measure", () => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = (() => ({
      measureText: () => ({ width: 40.2 }),
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    try {
      expect(statusLabelMeasurementPx("Beta 1.0.9beta2", 10)).toBe(41);
      expect(statusLabelMeasurementPx("Beta 1.0.9beta2", 80)).toBe(80);
    } finally {
      HTMLCanvasElement.prototype.getContext = original;
    }

    HTMLCanvasElement.prototype.getContext = (() =>
      null) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    try {
      expect(statusLabelMeasurementPx("Beta 1.0.9beta2")).toBeUndefined();
    } finally {
      HTMLCanvasElement.prototype.getContext = original;
    }
  });
});
