export const CHAT_NEAR_BOTTOM_PX = 50;

/**
 * Gap between the jump control and the scrollbar lane, between the control
 * and the transcript text, and between the control and the composer row.
 * The same CSS pixels on every platform.
 */
export const CHAT_SCROLL_JUMP_INSET_PX = 12;

/**
 * The control's own box (`size-9`). A live measurement may only raise this.
 * It is the button we draw, not a font or OS scrollbar width.
 */
export const CHAT_SCROLL_JUMP_BUTTON_PX = 36;

/**
 * Lane used when `scrollbar-gutter: stable` still reports 0, which overlay
 * scrollbars do on some WebKit builds. The control stays clear of a thumb
 * painted on top of the content. Classic gutters that measure above this
 * floor keep the measured width.
 */
export const CHAT_SCROLL_JUMP_GUTTER_FLOOR_PX = 12;

/** `px-5` on the transcript. The right side grows to clear the jump control. */
export const CHAT_TRANSCRIPT_PADDING_PX = 20;

/** Classic scrollbar width reserved by `scrollbar-gutter: stable`. */
export function scrollbarGutterPx(
  offsetWidth: number,
  clientWidth: number,
): number {
  if (!Number.isFinite(offsetWidth) || !Number.isFinite(clientWidth)) return 0;
  return Math.max(0, Math.round(offsetWidth - clientWidth));
}

function measuredGutterPx(scrollbarGutter: number): number {
  if (!Number.isFinite(scrollbarGutter)) return 0;
  return Math.max(0, Math.round(scrollbarGutter));
}

function jumpButtonPx(buttonPx?: number): number {
  if (
    buttonPx != null &&
    Number.isFinite(buttonPx) &&
    buttonPx > CHAT_SCROLL_JUMP_BUTTON_PX
  ) {
    return Math.ceil(buttonPx);
  }
  return CHAT_SCROLL_JUMP_BUTTON_PX;
}

/** Scrollbar lane the control sits beside. Measured gutter, or the floor. */
export function chatScrollJumpLanePx(scrollbarGutter: number): number {
  const gutter = measuredGutterPx(scrollbarGutter);
  return gutter > 0 ? gutter : CHAT_SCROLL_JUMP_GUTTER_FLOOR_PX;
}

/**
 * Right inset of the jump control from the transcript frame.
 * `scrollbar-gutter: stable` reserves the same gutter for overlay and classic
 * scrollbars, so the control does not jump between WebView2, WKWebView, and
 * WebKitGTK. A zero measurement still keeps the floor lane.
 */
export function chatScrollJumpRightPx(scrollbarGutter: number): number {
  return chatScrollJumpLanePx(scrollbarGutter) + CHAT_SCROLL_JUMP_INSET_PX;
}

/**
 * Right padding of the transcript content, always, so a line cannot run
 * under the control. Reserving the lane only while the control is visible
 * would reflow the transcript as it appears. The padding is the control's
 * box plus the gap, shifted by any gutter the content box already lost.
 */
export function chatScrollJumpContentInsetPx(
  scrollbarGutter: number,
  buttonPx?: number,
): number {
  const gutter = measuredGutterPx(scrollbarGutter);
  const right = chatScrollJumpRightPx(gutter);
  const needed =
    right + jumpButtonPx(buttonPx) + CHAT_SCROLL_JUMP_INSET_PX - gutter;
  return Math.max(CHAT_TRANSCRIPT_PADDING_PX, needed);
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
