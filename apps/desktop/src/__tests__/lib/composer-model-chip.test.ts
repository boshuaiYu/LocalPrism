import { describe, expect, it } from "vitest";
import {
  composerModelChipChevronPx,
  composerModelChipFullLabel,
  composerModelChipPlan,
} from "@/lib/composer-model-chip";
import { chatStripTextUpperBoundPx } from "@/lib/chat-tab-strip";

const DEEPSEEK = {
  modelLabel: "deepseek-v4-flash",
  effortLabel: "Low",
  hasIcon: true,
};

describe("composer model chip", () => {
  it("names the whole model and effort for the tooltip", () => {
    expect(composerModelChipFullLabel("deepseek-v4-flash", "Low")).toBe(
      "deepseek-v4-flash · Low",
    );
    expect(composerModelChipFullLabel("Opus", null)).toBe("Opus");
    expect(composerModelChipFullLabel("  ", "Low")).toBe("Low");
  });

  it("shows the full name when the slot can hold it and a complete shorter form when it cannot", () => {
    expect(composerModelChipPlan({ ...DEEPSEEK, slotPx: 0 })).toBe("full");
    expect(composerModelChipPlan({ ...DEEPSEEK, slotPx: 800 })).toBe("full");

    const forms = new Set<string>();
    for (let slot = 40; slot <= 400; slot += 1) {
      forms.add(composerModelChipPlan({ ...DEEPSEEK, slotPx: slot }));
    }
    expect(forms.has("full")).toBe(true);
    expect(forms.has("icon")).toBe(true);
    expect(forms.has("effort")).toBe(true);
    expect(forms.has("chevron")).toBe(true);

    const iconSlot = Array.from({ length: 361 }, (_, index) => index + 40).find(
      (slot) => composerModelChipPlan({ ...DEEPSEEK, slotPx: slot }) === "icon",
    );
    expect(iconSlot).toBeTypeOf("number");
    expect(
      composerModelChipPlan({
        ...DEEPSEEK,
        hasIcon: false,
        slotPx: iconSlot ?? 0,
      }),
    ).not.toBe("icon");
    const chevronPx = composerModelChipChevronPx();
    expect(composerModelChipPlan({ ...DEEPSEEK, slotPx: chevronPx })).toBe(
      "chevron",
    );
    expect(composerModelChipPlan({ ...DEEPSEEK, slotPx: 1 })).toBe("chevron");
    expect(composerModelChipPlan({ ...DEEPSEEK, slotPx: chevronPx - 1 })).toBe(
      "chevron",
    );
  });

  it("does not let a narrow measurement reveal a label the shared bound would clip", () => {
    const bound = chatStripTextUpperBoundPx("deepseek-v4-flash");
    const ignored = composerModelChipPlan({
      ...DEEPSEEK,
      slotPx: 800,
      textPx: { model: 8 },
    });
    const raised = composerModelChipPlan({
      ...DEEPSEEK,
      slotPx: bound + 80,
      textPx: { model: bound + 200 },
    });
    expect(ignored).toBe("full");
    expect(raised).not.toBe("full");
  });
});
