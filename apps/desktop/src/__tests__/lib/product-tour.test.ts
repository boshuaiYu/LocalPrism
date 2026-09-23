import { describe, expect, it } from "vitest";
import {
  PRODUCT_TOUR_STEPS,
  findProductTourElement,
  productTourAfterBack,
  productTourAfterNext,
  productTourAfterSkip,
  productTourCardPosition,
  productTourClickAdvances,
  resolveStoredProductTour,
  shouldAutoShowProductTour,
} from "@/lib/product-tour";

describe("product tour persistence", () => {
  it("shows only while the tour is still pending", () => {
    expect(shouldAutoShowProductTour("pending")).toBe(true);
    expect(shouldAutoShowProductTour(undefined)).toBe(true);
    expect(shouldAutoShowProductTour("completed")).toBe(false);
    expect(shouldAutoShowProductTour("skipped")).toBe(false);
  });

  it("completes on the last next and skips permanently", () => {
    const last = PRODUCT_TOUR_STEPS.length - 1;
    expect(productTourAfterNext(0)).toEqual({ index: 1, status: "pending" });
    expect(productTourAfterNext(last - 1)).toEqual({
      index: last,
      status: "pending",
    });
    expect(productTourAfterNext(last)).toEqual({
      index: last,
      status: "completed",
    });
    expect(productTourAfterBack(0)).toBe(0);
    expect(productTourAfterBack(2)).toBe(1);
    expect(productTourAfterSkip()).toBe("skipped");
  });

  it("walks skills and agents after the workspace and ignores an older tour", () => {
    expect(PRODUCT_TOUR_STEPS.map((step) => step.id)).toEqual([
      "files",
      "zotero",
      "latex",
      "chat",
      "pdf",
      "skills",
      "skill-categories",
      "skill-import",
      "agents",
      "agent-roles",
      "agent-skills",
      "updates",
    ]);
    expect(
      PRODUCT_TOUR_STEPS.find((step) => step.id === "skills")
        ?.advanceOnTargetClick,
    ).toBe(true);
    expect(
      PRODUCT_TOUR_STEPS.find((step) => step.id === "skill-categories")?.enter,
    ).toEqual(["open-skills"]);
    expect(
      PRODUCT_TOUR_STEPS.find((step) => step.id === "agent-roles")?.enter,
    ).toEqual(["open-agents"]);
    expect(
      PRODUCT_TOUR_STEPS.find((step) => step.id === "agent-skills")?.enter,
    ).toEqual(["close-overlays", "show-chat", "open-agent-menu"]);
    expect(resolveStoredProductTour(1, "skipped")).toBe("pending");
    expect(resolveStoredProductTour(2, "completed")).toBe("pending");
    expect(resolveStoredProductTour(undefined, "completed")).toBe("pending");
    expect(resolveStoredProductTour(3, "skipped")).toBe("skipped");
    expect(resolveStoredProductTour(3, "completed")).toBe("completed");
  });
});

function box(node: HTMLElement, width = 48, height = 24) {
  node.getBoundingClientRect = () =>
    ({
      x: 8,
      y: 8,
      top: 8,
      left: 8,
      right: 8 + width,
      bottom: 8 + height,
      width,
      height,
      toJSON() {
        return {};
      },
    }) as DOMRect;
}

describe("product tour anchors", () => {
  it("skips a zero-size renamed control and uses the update button", () => {
    document.body.innerHTML = "";
    const renamed = document.createElement("div");
    renamed.dataset.tour = "tour-update-bar";
    const check = document.createElement("button");
    check.dataset.testid = "check-for-updates";
    document.body.append(renamed, check);
    box(check);
    const step = PRODUCT_TOUR_STEPS.find((item) => item.id === "updates");
    expect(step).toBeDefined();
    expect(findProductTourElement(step!)).toBe(check);
  });

  it("prefers a visible bottom-bar anchor over the header check button", () => {
    document.body.innerHTML = "";
    const bar = document.createElement("div");
    bar.dataset.tour = "tour-update-bar";
    const check = document.createElement("button");
    check.dataset.testid = "check-for-updates";
    document.body.append(bar, check);
    box(bar, 120, 28);
    box(check);
    const step = PRODUCT_TOUR_STEPS.find((item) => item.id === "updates");
    expect(findProductTourElement(step!)).toBe(bar);
  });

  it("advances when the skills hotspot is clicked", () => {
    document.body.innerHTML = "";
    const button = document.createElement("button");
    button.dataset.tour = "tour-skills";
    const label = document.createElement("span");
    label.textContent = "Skills";
    button.append(label);
    document.body.append(button);
    const step = PRODUCT_TOUR_STEPS.find((item) => item.id === "skills");
    expect(productTourClickAdvances(step!, label)).toBe(true);
    expect(productTourClickAdvances(step!, document.body)).toBe(false);
  });

  it("places the card above a hotspot near the bottom edge", () => {
    expect(
      productTourCardPosition(
        { top: 700, left: 20, width: 40, height: 24 },
        { width: 800, height: 760 },
      ).place,
    ).toBe("above");
    expect(
      productTourCardPosition(
        { top: 40, left: 20, width: 80, height: 24 },
        { width: 800, height: 760 },
      ).place,
    ).toBe("below");
  });
});
