import { describe, expect, it } from "vitest";
import {
  PDF_PREVIEW_DEFAULT_FIT_MODE,
  fitPreviewScale,
  nextPdfZoomState,
  type PdfZoomState,
} from "@/lib/pdf-preview-zoom";

describe("pdf preview zoom", () => {
  it("defaults to fit-width so a narrow pane does not crop the page", () => {
    expect(PDF_PREVIEW_DEFAULT_FIT_MODE).toBe("fit-width");

    const page = { width: 612, height: 792 };
    const narrowPane = { width: 400, height: 700 };
    const scale = fitPreviewScale("fit-width", narrowPane, page);

    expect(scale).toBeLessThan(1);
    expect(scale * page.width).toBeLessThanOrEqual(narrowPane.width);
  });

  it("restores a chosen zoom and opens an unsaved document fit-to-width", () => {
    const chosen: PdfZoomState = { scale: 1, fitMode: null };
    expect(
      nextPdfZoomState({ scale: 0.5, fitMode: "fit-width" }, chosen, true),
    ).toEqual(chosen);
    expect(
      nextPdfZoomState({ scale: 1, fitMode: null }, undefined, true).fitMode,
    ).toBe("fit-width");
    expect(
      nextPdfZoomState(
        { scale: 1, fitMode: PDF_PREVIEW_DEFAULT_FIT_MODE },
        undefined,
        false,
      ),
    ).toEqual({ scale: 1, fitMode: "fit-width" });
  });
});
