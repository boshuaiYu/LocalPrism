import { describe, expect, it } from "vitest";
import {
  productTourAfterBack,
  productTourAfterNext,
  productTourAfterSkip,
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
    expect(productTourAfterNext(3)).toEqual({ index: 3, status: "completed" });
    expect(productTourAfterBack(0)).toBe(0);
    expect(productTourAfterBack(2)).toBe(1);
    expect(productTourAfterSkip()).toBe("skipped");
  });
});
