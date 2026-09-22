import { describe, expect, it } from "vitest";
import {
  nextTemplatePreviewPaint,
  templatePreviewOverlay,
} from "@/lib/template-preview-frame";

const loadedPage = {
  docId: 4,
  pageCount: 2,
  pageIndex: 0,
  pageWidth: 612,
  pageHeight: 792,
  containerWidth: 640,
  containerHeight: 800,
  devicePixelRatio: 1,
};

describe("template preview frame", () => {
  it("paints a loaded preview and waits when the pane has no size yet", () => {
    expect(
      nextTemplatePreviewPaint({ step: "preview", ...loadedPage }).action,
    ).toBe("paint");
    expect(
      nextTemplatePreviewPaint({
        step: "preview",
        ...loadedPage,
        containerWidth: 40,
        containerHeight: 40,
      }).action,
    ).toBe("wait-for-layout");
  });

  it("does not paint while the project-name step is open", () => {
    expect(
      nextTemplatePreviewPaint({ step: "details", ...loadedPage }).action,
    ).toBe("skip");
  });

  it("shows a skeleton instead of a blank canvas when returning to preview", () => {
    expect(
      templatePreviewOverlay({
        step: "preview",
        loading: false,
        error: false,
        pageCount: 2,
        painted: false,
        renderFailed: false,
      }),
    ).toBe("skeleton");
    expect(
      templatePreviewOverlay({
        step: "preview",
        loading: false,
        error: false,
        pageCount: 2,
        painted: false,
        renderFailed: true,
      }),
    ).toBe("retry");
    expect(
      templatePreviewOverlay({
        step: "preview",
        loading: false,
        error: false,
        pageCount: 2,
        painted: true,
        renderFailed: false,
      }),
    ).toBe("none");
    expect(
      templatePreviewOverlay({
        step: "details",
        loading: false,
        error: false,
        pageCount: 2,
        painted: false,
        renderFailed: false,
      }),
    ).toBe("hidden");
  });
});
