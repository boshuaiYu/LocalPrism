import { describe, expect, it } from "vitest";
import { pdfChromeCompactStatus, pdfZoomLabel } from "@/lib/pdf-chrome-status";

describe("pdf chrome status", () => {
  it("prefers compile activity over the page indicator", () => {
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

  it("shows a light page indicator and keeps fit wording on the zoom control", () => {
    expect(pdfZoomLabel({ fitMode: "fit-width", scale: 1.2 })).toBe(
      "Fit width",
    );
    expect(pdfZoomLabel({ fitMode: "fit-height", scale: 1 })).toBe(
      "Fit height",
    );
    expect(
      pdfChromeCompactStatus({
        isSaving: false,
        isCompiling: false,
        hasError: false,
        currentPage: 1,
        numPages: 3,
      }),
    ).toBe("1/3");
    expect(
      pdfChromeCompactStatus({
        isSaving: false,
        isCompiling: false,
        hasError: false,
        currentPage: 2,
        numPages: 10,
      }),
    ).toBe("2/10");
  });
});
