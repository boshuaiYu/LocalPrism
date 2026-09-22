import { describe, expect, it } from "vitest";
import { pdfChromeCompactStatus, pdfZoomLabel } from "@/lib/pdf-chrome-status";

describe("pdf chrome status", () => {
  it("prefers compile activity over page and zoom", () => {
    expect(
      pdfChromeCompactStatus({
        isSaving: false,
        isCompiling: true,
        hasError: false,
        currentPage: 2,
        numPages: 10,
        zoomLabel: "Fit width",
      }),
    ).toBe("Compiling");
    expect(
      pdfChromeCompactStatus({
        isSaving: false,
        isCompiling: false,
        hasError: true,
        currentPage: 2,
        numPages: 10,
        zoomLabel: "Fit width",
      }),
    ).toBe("Compile failed");
  });

  it("shows page and zoom when the preview is idle", () => {
    expect(pdfZoomLabel({ fitMode: "fit-width", scale: 1.2 })).toBe(
      "Fit width",
    );
    expect(
      pdfChromeCompactStatus({
        isSaving: false,
        isCompiling: false,
        hasError: false,
        currentPage: 2,
        numPages: 10,
        zoomLabel: "120%",
      }),
    ).toBe("Page 2/10 · 120%");
  });
});
