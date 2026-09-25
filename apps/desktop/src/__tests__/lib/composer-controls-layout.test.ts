import { describe, expect, it } from "vitest";
import {
  COMPOSER_CONTROLS_STACK_BREAKPOINT_PX,
  composerControlsLayout,
} from "@/lib/composer-controls-layout";

describe("composerControlsLayout", () => {
  it("stacks the bottom bar below the sidebar breakpoint", () => {
    expect(composerControlsLayout(230)).toBe("narrow");
    expect(composerControlsLayout(300)).toBe("narrow");
    expect(
      composerControlsLayout(COMPOSER_CONTROLS_STACK_BREAKPOINT_PX - 1),
    ).toBe("narrow");
  });

  it("keeps the model on the control row at and above the breakpoint", () => {
    expect(composerControlsLayout(400)).toBe("narrow");
    expect(composerControlsLayout(COMPOSER_CONTROLS_STACK_BREAKPOINT_PX)).toBe(
      "wide",
    );
    expect(composerControlsLayout(640)).toBe("wide");
  });

  it("stacks before the width has been measured so controls are not clipped", () => {
    expect(composerControlsLayout(0)).toBe("narrow");
    expect(composerControlsLayout(Number.NaN)).toBe("narrow");
  });
});
