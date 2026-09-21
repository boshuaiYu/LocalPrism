import { describe, expect, it } from "vitest";

import {
  parentDirectory,
  resolveMarkdownAssetUrl,
  resolveRelativePath,
} from "@/lib/markdown-preview-assets";

describe("markdown preview asset paths", () => {
  it("resolves parent directories on Windows and POSIX paths", () => {
    expect(parentDirectory("F:\\Projects\\paper\\notes.md")).toBe(
      "F:\\Projects\\paper",
    );
    expect(parentDirectory("/Users/me/paper/notes.md")).toBe("/Users/me/paper");
  });

  it("resolves relative image paths against the markdown file directory", () => {
    expect(
      resolveRelativePath("F:\\Projects\\paper", "./figures/fig1.png"),
    ).toBe("F:\\Projects\\paper\\figures\\fig1.png");
    expect(
      resolveRelativePath("F:\\Projects\\paper\\draft", "../img.png"),
    ).toBe("F:\\Projects\\paper\\img.png");
    expect(resolveRelativePath("/Users/me/paper", "assets/plot.svg")).toBe(
      "/Users/me/paper/assets/plot.svg",
    );
  });

  it("leaves remote, data, and hash sources unchanged", () => {
    expect(
      resolveMarkdownAssetUrl("https://example.com/a.png", "F:\\a\\b.md"),
    ).toBe("https://example.com/a.png");
    expect(
      resolveMarkdownAssetUrl("data:image/png;base64,abc", "F:\\a\\b.md"),
    ).toBe("data:image/png;base64,abc");
    expect(resolveMarkdownAssetUrl("#section", "F:\\a\\b.md")).toBe("#section");
  });

  it("converts local relative paths through convertFileSrc", () => {
    expect(
      resolveMarkdownAssetUrl("./fig.png", "F:\\Projects\\paper\\notes.md"),
    ).toBe("asset://localhost/F:\\Projects\\paper\\fig.png");
  });
});
