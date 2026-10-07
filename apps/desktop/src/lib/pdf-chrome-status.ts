export type PreviewSurface = "compiled-pdf" | "markdown" | "source-pdf";

/**
 * The preview chrome is shared. Only the compiled PDF surface owns page
 * navigation; markdown and an opened PDF file must not inherit that page count.
 */
export function previewSurfaceForFileType(
  fileType: string | null | undefined,
): PreviewSurface {
  if (fileType === "markdown") return "markdown";
  if (fileType === "pdf") return "source-pdf";
  return "compiled-pdf";
}

export function showsPdfPageChrome(surface: PreviewSurface): boolean {
  return surface === "compiled-pdf";
}

/**
 * Compact label for the compiled-PDF preview chrome.
 * Non-PDF surfaces keep compile activity, but never the PDF page count.
 */
export function pdfChromeCompactStatus(input: {
  isSaving: boolean;
  isCompiling: boolean;
  hasError: boolean;
  currentPage: number;
  numPages: number;
  surface: PreviewSurface;
}): string | null {
  if (input.isSaving) return "Saving";
  if (input.isCompiling) return "Compiling";
  if (input.hasError) return "Compile failed";
  if (!showsPdfPageChrome(input.surface)) return null;
  if (input.numPages > 0) {
    return `${input.currentPage}/${input.numPages}`;
  }
  return "No PDF yet";
}

export function pdfZoomLabel(input: {
  fitMode: "fit-width" | "fit-height" | null;
  scale: number;
}): string {
  if (input.fitMode === "fit-width") return "Fit width";
  if (input.fitMode === "fit-height") return "Fit height";
  return `${Math.round(input.scale * 100)}%`;
}
