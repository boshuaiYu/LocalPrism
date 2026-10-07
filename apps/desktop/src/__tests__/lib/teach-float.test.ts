import { describe, expect, it } from "vitest";
import {
  clampTeachFloat,
  placeTeachFloat,
  TEACH_FLOAT_HEIGHT,
  TEACH_FLOAT_WIDTH,
} from "@/lib/teach-float";

const view = {
  viewportWidth: 1200,
  viewportHeight: 800,
  cardWidth: TEACH_FLOAT_WIDTH,
  cardHeight: TEACH_FLOAT_HEIGHT,
};

describe("teach float placement", () => {
  it("sits beside a selection when there is room on the right", () => {
    const pos = placeTeachFloat({
      ...view,
      anchor: { x: 40, y: 120, width: 80, height: 18 },
    });
    expect(pos).toEqual({ left: 40 + 80 + 12, top: 120 });
  });

  it("moves to the left when the right side is too narrow", () => {
    const pos = placeTeachFloat({
      ...view,
      anchor: { x: 900, y: 120, width: 80, height: 18 },
    });
    expect(pos).toEqual({ left: 900 - TEACH_FLOAT_WIDTH - 12, top: 120 });
  });

  it("drops below the anchor when neither side fits", () => {
    const pos = placeTeachFloat({
      ...view,
      viewportWidth: 400,
      anchor: { x: 20, y: 80, width: 300, height: 16 },
    });
    expect(pos).toEqual({ left: 20, top: 80 + 16 + 12 });
  });

  it("uses a default spot when there is no anchor", () => {
    const pos = placeTeachFloat({ ...view, anchor: null });
    expect(pos).toEqual({ left: Math.round(1200 * 0.28), top: 80 });
  });

  it("clamps a drag so the card stays on screen", () => {
    expect(clampTeachFloat(-40, 900, 360, 420, 800, 600)).toEqual({
      left: 8,
      top: 600 - 420 - 8,
    });
  });
});
