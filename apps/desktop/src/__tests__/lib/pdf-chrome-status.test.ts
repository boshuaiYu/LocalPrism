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
      }),
    ).toBe("Compiling");
    expect(
      pdfChromeCompactStatus({
        isSaving: false,
        isCompiling: false,
        hasError: true,
        currentPage: 2,
        numPages: 10,
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
    });
    expect(status).toBe("1/3");
    expect(status).not.toMatch(/fit|page|%/i);
  });
});
