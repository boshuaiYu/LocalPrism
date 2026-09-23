import { describe, expect, it } from "vitest";
import {
  PRODUCT_TOUR_STEPS,
  productTourAfterBack,
  productTourAfterNext,
  productTourAfterSkip,
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
    expect(productTourAfterNext(0)).toEqual({ index: 1, status: "pending" });
    expect(productTourAfterNext(5)).toEqual({ index: 5, status: "completed" });
    expect(productTourAfterBack(0)).toBe(0);
    expect(productTourAfterBack(2)).toBe(1);
    expect(productTourAfterSkip()).toBe("skipped");
  });

  it("walks the LaTeX workspace and ignores an older stored tour", () => {
    expect(PRODUCT_TOUR_STEPS.map((step) => step.anchor)).toEqual([
      "tour-files",
      "tour-zotero",
      "tour-latex",
      "tour-chat",
      "tour-pdf",
      "tour-agents-skills",
    ]);
    expect(resolveStoredProductTour(1, "skipped")).toBe("pending");
    expect(resolveStoredProductTour(undefined, "completed")).toBe("pending");
    expect(resolveStoredProductTour(2, "skipped")).toBe("skipped");
    expect(resolveStoredProductTour(2, "completed")).toBe("completed");
  });
});
