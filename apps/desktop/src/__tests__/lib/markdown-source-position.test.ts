import { describe, expect, it } from "vitest";
import {
  markdownClickSourceOffset,
  markdownSourceOffset,
  rehypeMarkdownSourcePositions,
} from "@/lib/markdown-source-position";

describe("markdown source positions", () => {
  const content = "# Title\n\nBody text.";

  it("maps 1-based lines and columns onto editor offsets", () => {
    expect(markdownSourceOffset(content, 1, 1)).toBe(0);
    expect(markdownSourceOffset(content, 1, 3)).toBe(2);
    expect(markdownSourceOffset(content, 3, 1)).toBe(9);
    expect(markdownSourceOffset(content, 1, 99)).toBe("# Title".length);
    expect(markdownSourceOffset(content, 0, 1)).toBeNull();
    expect(markdownSourceOffset(content, 4, 1)).toBeNull();
  });

  it("resolves a clicked block and ignores links and selections", () => {
    const root = document.createElement("div");
    const paragraph = document.createElement("p");
    paragraph.setAttribute("data-source-line", "3");
    paragraph.setAttribute("data-source-column", "1");
    paragraph.textContent = "Body text.";
    const link = document.createElement("a");
    link.href = "https://example.com";
    link.setAttribute("data-source-line", "3");
    link.textContent = "Docs";
    paragraph.append(link);
    root.append(paragraph);
    document.body.append(root);

    expect(markdownClickSourceOffset(content, paragraph, root)).toBe(9);
    expect(markdownClickSourceOffset(content, link, root)).toBeNull();

    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    expect(markdownClickSourceOffset(content, paragraph, root)).toBeNull();
    selection?.removeAllRanges();
    root.remove();
  });

  it("stamps hast elements with their source line", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "h1",
          properties: {},
          position: { start: { line: 4, column: 2 } },
          children: [],
        },
      ],
    };
    rehypeMarkdownSourcePositions()(tree);
    expect(tree.children[0]?.properties).toMatchObject({
      dataSourceLine: 4,
      dataSourceColumn: 2,
    });
  });
});
