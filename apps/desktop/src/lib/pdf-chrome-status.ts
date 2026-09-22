export function pdfChromeCompactStatus(input: {
  isSaving: boolean;
  isCompiling: boolean;
  hasError: boolean;
  currentPage: number;
  numPages: number;
  zoomLabel: string;
}): string {
  if (input.isSaving) return "Saving";
  if (input.isCompiling) return "Compiling";
  if (input.hasError) return "Compile failed";
  if (input.numPages > 0) {
    return `Page ${input.currentPage}/${input.numPages} · ${input.zoomLabel}`;
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
