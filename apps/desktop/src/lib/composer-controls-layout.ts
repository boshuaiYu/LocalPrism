/** Sidebar composer width where the bottom bar stacks instead of clipping. */
export const COMPOSER_CONTROLS_STACK_BREAKPOINT_PX = 360;

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
