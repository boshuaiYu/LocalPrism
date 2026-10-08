export const CHAT_NEAR_BOTTOM_PX = 50;

/**
 * Gap between the jump control and the scrollbar gutter, and between the
 * control and the composer row. The same CSS pixels on every platform.
 */
export const CHAT_SCROLL_JUMP_INSET_PX = 12;

/** Classic scrollbar width reserved by `scrollbar-gutter: stable`. */
export function scrollbarGutterPx(
  offsetWidth: number,
  clientWidth: number,
): number {
  if (!Number.isFinite(offsetWidth) || !Number.isFinite(clientWidth)) return 0;
  return Math.max(0, Math.round(offsetWidth - clientWidth));
}

/**
 * Right inset of the jump control from the transcript frame.
 * `scrollbar-gutter: stable` reserves the same gutter for overlay and classic
 * scrollbars, so the control does not jump between WebView2, WKWebView, and
 * WebKitGTK.
 */
export function chatScrollJumpRightPx(scrollbarGutter: number): number {
  const gutter = Number.isFinite(scrollbarGutter)
    ? Math.max(0, Math.round(scrollbarGutter))
    : 0;
  return gutter + CHAT_SCROLL_JUMP_INSET_PX;
}

export interface TranscriptViewport {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

/** True when newer transcript content sits below the visible pane. */
export function transcriptHasContentBelow(
  viewport: TranscriptViewport,
): boolean {
  if (viewport.scrollHeight <= viewport.clientHeight + 1) return false;
  const distance =
    viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
  return distance >= CHAT_NEAR_BOTTOM_PX;
}
