/**
 * Composer width where the bottom bar stacks instead of sharing one row.
 * Wide enough that the model name still fits beside attach / agent controls
 * (a 360px row left the chip as only the effort suffix).
 */
export const COMPOSER_CONTROLS_STACK_BREAKPOINT_PX = 480;

export type ComposerControlsLayout = "wide" | "narrow";

/**
 * Wide: model sits with the leading controls; the context ring anchors the row end.
 * Narrow: model stays on the control row and truncates; the context ring stacks.
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
