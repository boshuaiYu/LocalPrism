import { describe, expect, it } from "vitest";
import {
  pdfChromeCompactStatus,
  pdfZoomLabel,
  previewSurfaceForFileType,
  showsPdfPageChrome,
} from "@/lib/pdf-chrome-status";

describe("pdf chrome status", () => {
  it("prefers compile activity over page and zoom", () => {
    expect(
      pdfChromeCompactStatus({
        isSaving: false,
        isCompiling: true,
        hasError: false,
        currentPage: 2,
        numPages: 10,
        surface: "compiled-pdf",
      }),
    ).toBe("Compiling");
    expect(
      pdfChromeCompactStatus({
        isSaving: false,
        isCompiling: false,
        hasError: true,
        currentPage: 2,
        numPages: 10,
        surface: "compiled-pdf",
      }),
    ).toBe("Compile failed");
  });

  it("shows only a light page indicator when the preview is idle", () => {
    expect(pdfZoomLabel({ fitMode: "fit-width", scale: 1.2 })).toBe(
      "Fit width",
    );
    expect(pdfZoomLabel({ fitMode: "fit-height", scale: 0.8 })).toBe(
      "Fit height",
    );
    expect(pdfZoomLabel({ fitMode: null, scale: 1.2 })).toBe("120%");
    const status = pdfChromeCompactStatus({
      isSaving: false,
      isCompiling: false,
      hasError: false,
      currentPage: 1,
      numPages: 3,
      surface: "compiled-pdf",
    });
    expect(status).toBe("1/3");
    expect(status).not.toMatch(/fit|page|%/i);
  });

  it("does not inherit the compiled pdf page count for markdown", () => {
    expect(previewSurfaceForFileType("markdown")).toBe("markdown");
    expect(previewSurfaceForFileType("pdf")).toBe("source-pdf");
    expect(previewSurfaceForFileType("tex")).toBe("compiled-pdf");
    expect(previewSurfaceForFileType("image")).toBe("compiled-pdf");
    expect(showsPdfPageChrome("markdown")).toBe(false);
    expect(showsPdfPageChrome("source-pdf")).toBe(false);
    expect(showsPdfPageChrome("compiled-pdf")).toBe(true);

    const inheritedPage = {
      isSaving: false,
      isCompiling: false,
      hasError: false,
      currentPage: 1,
      numPages: 3,
    };
    expect(
      pdfChromeCompactStatus({ ...inheritedPage, surface: "markdown" }),
    ).toBeNull();
    expect(
      pdfChromeCompactStatus({ ...inheritedPage, surface: "source-pdf" }),
    ).toBeNull();
    expect(
      pdfChromeCompactStatus({
        ...inheritedPage,
        numPages: 0,
        surface: "markdown",
      }),
    ).toBeNull();
    expect(
      pdfChromeCompactStatus({
        isSaving: true,
        isCompiling: false,
        hasError: false,
        currentPage: 1,
        numPages: 3,
        surface: "markdown",
      }),
    ).toBe("Saving");
  });
});
