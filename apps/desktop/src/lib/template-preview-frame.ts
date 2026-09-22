export const TEMPLATE_PREVIEW_PADDING = 48;

export type TemplatePreviewStep = "preview" | "details";

export type TemplatePreviewPaint =
  | { action: "skip" }
  | { action: "wait-for-layout" }
  | {
      action: "paint";
      pageIndex: number;
      displayW: number;
      displayH: number;
      dpi: number;
      landscape: boolean;
    };

export type TemplatePreviewOverlay =
  | "hidden"
  | "loading"
  | "load-error"
  | "skeleton"
  | "retry"
  | "none";

export function nextTemplatePreviewPaint(input: {
  step: TemplatePreviewStep;
  docId: number;
  pageCount: number;
  pageIndex: number;
  pageWidth: number;
  pageHeight: number;
  containerWidth: number;
  containerHeight: number;
  devicePixelRatio?: number;
}): TemplatePreviewPaint {
  if (input.step !== "preview") return { action: "skip" };
  if (input.docId <= 0 || input.pageCount <= 0) return { action: "skip" };
  if (input.pageIndex < 0 || input.pageIndex >= input.pageCount) {
    return { action: "skip" };
  }
  if (!(input.pageWidth > 0) || !(input.pageHeight > 0)) {
    return { action: "skip" };
  }

  const maxW = input.containerWidth - TEMPLATE_PREVIEW_PADDING;
  const maxH = input.containerHeight - TEMPLATE_PREVIEW_PADDING;
  if (!(maxW > 0) || !(maxH > 0)) return { action: "wait-for-layout" };

  const pageAspect = input.pageWidth / input.pageHeight;
  let displayW = maxW;
  let displayH = displayW / pageAspect;
  if (displayH > maxH) {
    displayH = maxH;
    displayW = displayH * pageAspect;
  }

  const dpr =
    input.devicePixelRatio && input.devicePixelRatio > 0
      ? input.devicePixelRatio
      : 1;
  return {
    action: "paint",
    pageIndex: input.pageIndex,
    displayW,
    displayH,
    dpi: (displayW / input.pageWidth) * 72 * dpr,
    landscape: input.pageWidth > input.pageHeight,
  };
}

/**
 * Returning from the project-name step remounts an empty canvas. Until that
 * canvas is painted again, show a skeleton (or retry) instead of a blank frame.
 */
export function templatePreviewOverlay(input: {
  step: TemplatePreviewStep;
  loading: boolean;
  error: boolean;
  pageCount: number;
  painted: boolean;
  renderFailed: boolean;
}): TemplatePreviewOverlay {
  if (input.step !== "preview") return "hidden";
  if (input.loading) return "loading";
  if (input.error) return "load-error";
  if (input.pageCount > 0 && input.renderFailed && !input.painted) {
    return "retry";
  }
  if (input.pageCount > 0 && !input.painted) return "skeleton";
  return "none";
}
