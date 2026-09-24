/**
 * Composer width where the bottom bar stacks instead of sharing one row.
 * Wide enough that the model name still fits beside attach / agent / context
 * (a 360px row left the chip as only the effort suffix).
 */
export const COMPOSER_CONTROLS_STACK_BREAKPOINT_PX = 480;

export type ComposerControlsLayout = "wide" | "narrow";

/**
 * Wide: model and strength sit on one row with the other controls.
 * Narrow: model and strength stack so nothing is clipped.
 * An unmeasured width is narrow so the first paint cannot overflow.
 */
export function composerControlsLayout(
  widthPx: number,
): ComposerControlsLayout {
  if (
    !Number.isFinite(widthPx) ||
    widthPx < COMPOSER_CONTROLS_STACK_BREAKPOINT_PX
  ) {
    return "narrow";
  }
  return "wide";
}
