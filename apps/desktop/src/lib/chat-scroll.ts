export const CHAT_NEAR_BOTTOM_PX = 50;

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
