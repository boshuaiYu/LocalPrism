import { describe, expect, it } from "vitest";
import {
  PRODUCT_TOUR_STEPS,
  applyProductTourCue,
  findProductTourElement,
  initialTourWorkspaceChrome,
  isVisibleTourElement,
  productTourAfterBack,
  productTourAfterNext,
  productTourAfterSkip,
  productTourCardPosition,
  productTourClickAdvances,
  productTourRetryCues,
  productTourSelectors,
  productTourShieldRects,
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
    ).toEqual(["close-overlays", "show-chat"]);
    expect(
      PRODUCT_TOUR_STEPS.find((step) => step.id === "agent-roles")?.anchors,
    ).toEqual(["tour-agent-list"]);
    expect(
      PRODUCT_TOUR_STEPS.find((step) => step.id === "agent-skills")?.anchors,
    ).toEqual(["tour-agent-switch"]);
    expect(
      productTourRetryCues(
        PRODUCT_TOUR_STEPS.find((step) => step.id === "skill-categories")!,
      ),
    ).toEqual(["open-skills"]);
    expect(
      productTourRetryCues(
        PRODUCT_TOUR_STEPS.find((step) => step.id === "updates")!,
      ),
    ).toEqual([]);
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
  it("targets the mounted check-update control and ignores hidden copies", () => {
    document.body.innerHTML = "";
    const faded = document.createElement("button");
    faded.dataset.tour = "tour-updates";
    faded.style.opacity = "0";
    const buried = document.createElement("div");
    buried.style.display = "none";
    const buriedButton = document.createElement("button");
    buriedButton.dataset.testid = "check-for-updates";
    buried.append(buriedButton);
    const check = document.createElement("button");
    check.dataset.tour = "tour-updates";
    check.dataset.testid = "check-for-updates";
    document.body.append(faded, buried, check);
    box(faded);
    box(buriedButton);
    box(check);
    const step = PRODUCT_TOUR_STEPS.find((item) => item.id === "updates");
    expect(productTourSelectors(step!)).toEqual([
      '[data-tour="tour-updates"]',
      '[data-testid="check-for-updates"]',
    ]);
    expect(isVisibleTourElement(faded)).toBe(false);
    expect(isVisibleTourElement(buriedButton)).toBe(false);
    expect(findProductTourElement(step!)).toBe(check);
  });

  it("treats an ancestor with opacity 0 as not visible", () => {
    document.body.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.style.opacity = "0";
    const button = document.createElement("button");
    button.dataset.tour = "tour-skills";
    wrap.append(button);
    document.body.append(wrap);
    box(button);
    expect(isVisibleTourElement(button)).toBe(false);
    const step = PRODUCT_TOUR_STEPS.find((item) => item.id === "skills");
    expect(findProductTourElement(step!)).toBeNull();
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

  it("blocks the viewport and leaves a hole only for a click-through step", () => {
    expect(productTourShieldRects({ width: 800, height: 600 }, null)).toEqual([
      { top: 0, left: 0, width: 800, height: 600 },
    ]);
    const hole = { top: 100, left: 40, width: 80, height: 28 };
    const shields = productTourShieldRects({ width: 800, height: 600 }, hole);
    const covers = (x: number, y: number) =>
      shields.some(
        (shield) =>
          x >= shield.left &&
          x < shield.left + shield.width &&
          y >= shield.top &&
          y < shield.top + shield.height,
      );
    expect(covers(10, 10)).toBe(true);
    expect(covers(80, 114)).toBe(false);
    expect(covers(790, 590)).toBe(true);
  });

  it("closes panels the tour opened and keeps a chat the user already had", () => {
    const opened = applyProductTourCue(
      initialTourWorkspaceChrome(),
      "show-chat",
    );
    expect(opened.chatVisible).toBe(true);
    expect(opened.tourOpenedChat).toBe(true);
    expect(applyProductTourCue(opened, "close-overlays").chatVisible).toBe(
      false,
    );

    const already = initialTourWorkspaceChrome({ chatVisible: true });
    const kept = applyProductTourCue(already, "show-chat");
    expect(kept.tourOpenedChat).toBe(false);
    expect(applyProductTourCue(kept, "close-overlays").chatVisible).toBe(true);

    const agents = applyProductTourCue(
      initialTourWorkspaceChrome({ skillsOpen: true }),
      "open-agents",
    );
    expect(agents).toMatchObject({
      skillsOpen: false,
      settingsOpen: true,
      settingsTab: "agents",
      agentMenuOpen: false,
    });
    expect(applyProductTourCue(agents, "close-overlays")).toMatchObject({
      settingsOpen: false,
      settingsTab: "runtimes",
      skillsOpen: false,
    });
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
