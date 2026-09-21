import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchTemplatePdf,
  getTemplatePdfUrl,
  isPdfBuffer,
} from "@/lib/template-preview-cache";

function bytesFrom(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer;
}

describe("template-preview-cache", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("recognizes PDF magic even after leading whitespace", () => {
    expect(isPdfBuffer(bytesFrom("%PDF-1.7\n%..."))).toBe(true);
    expect(isPdfBuffer(bytesFrom("\n\n  %PDF-1.4\n"))).toBe(true);
  });

  it("rejects the SPA loading page that Tauri serves for missing PDFs", () => {
    expect(
      isPdfBuffer(
        bytesFrom("<!doctype html>\n<html><p>Loading LocalPrism...</p></html>"),
      ),
    ).toBe(false);
    expect(isPdfBuffer(bytesFrom(""))).toBe(false);
  });

  it("builds the static example URL", () => {
    expect(getTemplatePdfUrl("letter-hit-recommendation")).toBe(
      "/examples/letter-hit-recommendation/main.pdf",
    );
  });

  it("rejects an HTML 200 from a missing example PDF", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () =>
          bytesFrom("<!doctype html><p>Loading LocalPrism...</p>"),
      }),
    );

    await expect(fetchTemplatePdf("poster-hitsz")).rejects.toThrow(/Not a PDF/);
  });
});
