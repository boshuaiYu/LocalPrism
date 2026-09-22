export type PdfFitMode = "fit-width" | "fit-height" | null;

/** First open fits the page to the pane so a narrow preview does not crop it. */
export const PDF_PREVIEW_DEFAULT_FIT_MODE: PdfFitMode = "fit-width";

export const PDF_PREVIEW_MIN_SCALE = 0.25;
export const PDF_PREVIEW_MAX_SCALE = 4;
/** Matches the preview surface padding used when measuring the pane. */
export const PDF_PREVIEW_FIT_PADDING = 32;

export interface PdfZoomState {
  scale: number;
  fitMode: PdfFitMode;
}

export function fitPreviewScale(
  mode: Exclude<PdfFitMode, null>,
  container: { width: number; height: number },
  page: { width: number; height: number },
): number {
  const available =
    (mode === "fit-width" ? container.width : container.height) -
    PDF_PREVIEW_FIT_PADDING;
  const basis = mode === "fit-width" ? page.width : page.height;
  if (!(basis > 0) || !Number.isFinite(available)) return 1;
  const raw = available / basis;
  if (!Number.isFinite(raw)) return 1;
  return Math.max(PDF_PREVIEW_MIN_SCALE, Math.min(PDF_PREVIEW_MAX_SCALE, raw));
}

/**
 * Restore a per-document zoom when one was chosen. A document with no saved
 * zoom opens in fit-width instead of inheriting a cropped 100% scale.
 */
export function nextPdfZoomState(
  current: PdfZoomState,
  cached: PdfZoomState | undefined,
  switchedRoot: boolean,
): PdfZoomState {
  if (cached) return { scale: cached.scale, fitMode: cached.fitMode };
  if (switchedRoot) {
    return { scale: current.scale, fitMode: PDF_PREVIEW_DEFAULT_FIT_MODE };
  }
  return current;
}
