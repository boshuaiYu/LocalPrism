import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MarkdownDocument } from "@/components/workspace/preview/markdown-document";
import { MarkdownPreviewPane } from "@/components/workspace/preview/markdown-preview-pane";
import type { ProjectFile } from "@/stores/document-store";

const stores = vi.hoisted(() => {
  const loadFileContent = vi.fn(async () => undefined);
  return {
    loadFileContent,
    files: [] as ProjectFile[],
  };
});

vi.mock("@/stores/document-store", () => ({
  useDocumentStore: (
    selector: (state: {
      files: ProjectFile[];
      loadFileContent: typeof stores.loadFileContent;
    }) => unknown,
  ) =>
    selector({
      files: stores.files,
      loadFileContent: stores.loadFileContent,
    }),
}));

const SAMPLE_MARKDOWN = `# Spectral Methods

A short paragraph with an [external link](https://example.com) and a footnote.[^1]

## Results

- Item one
- Item two

1. First
2. Second

> An academic aside should read as a block quotation.

| Method | Score |
| --- | --- |
| Baseline | 0.71 |
| Ours | 0.84 |

- [x] Write the theorem
- [ ] Check the proof

![Figure](./figures/plot.png)

\`inline\` and a fence:

\`\`\`python
print("hello")
\`\`\`

$$
E = mc^2
$$

---

[^1]: Footnotes should appear beneath a rule.
`;

describe("MarkdownDocument", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("renders academic document structure instead of a plain dump", async () => {
    await act(async () => {
      root.render(
        <MarkdownDocument
          content={SAMPLE_MARKDOWN}
          filePath="F:\\Projects\\paper\\notes.md"
        />,
      );
    });

    const documentRoot = container.querySelector("[data-testid='md-document']");
    expect(documentRoot).toBeTruthy();
    expect(documentRoot?.classList.contains("md-document")).toBe(true);
    expect(container.querySelector("h1")?.textContent).toMatch(
      /Spectral Methods/,
    );
    expect(container.querySelector("h2")?.textContent).toMatch(/Results/);
    expect(container.querySelector("blockquote")?.textContent).toMatch(
      /academic aside/,
    );
    expect(container.querySelector("table thead th")?.textContent).toMatch(
      /Method/,
    );
    expect(container.querySelector("ol")?.textContent).toMatch(/First/);
    expect(container.querySelector("ul")?.textContent).toMatch(/Item one/);
    expect(
      container.querySelector("input[type='checkbox'][disabled]"),
    ).toBeTruthy();
    expect(container.querySelector("hr")).toBeTruthy();
    expect(container.querySelector(".md-document-code-lang")?.textContent).toBe(
      "python",
    );
    expect(container.querySelector(".katex")).toBeTruthy();
    expect(container.querySelector(".footnotes")).toBeTruthy();

    const image = container.querySelector("img");
    expect(image?.getAttribute("src")).toBe(
      "asset://localhost/F:\\Projects\\paper\\figures\\plot.png",
    );

    const external = container.querySelector("a[href='https://example.com']");
    expect(external?.getAttribute("target")).toBe("_blank");
  });
});

describe("MarkdownPreviewPane", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    stores.files = [];
    stores.loadFileContent.mockClear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("shows empty and missing-file states", async () => {
    await act(async () => {
      root.render(<MarkdownPreviewPane file={null} />);
    });
    expect(container.textContent).toMatch(/No markdown file selected/);

    const emptyFile: ProjectFile = {
      id: "notes.md",
      name: "notes.md",
      relativePath: "notes.md",
      absolutePath: "F:\\Projects\\paper\\notes.md",
      type: "markdown",
      content: "   ",
      isDirty: false,
    };
    stores.files = [emptyFile];
    await act(async () => {
      root.render(<MarkdownPreviewPane file={emptyFile} />);
    });
    expect(container.textContent).toMatch(/This markdown file is empty/);
  });

  it("wraps rendered markdown in a paper-like preview stage", async () => {
    const file: ProjectFile = {
      id: "notes.md",
      name: "notes.md",
      relativePath: "notes.md",
      absolutePath: "F:\\Projects\\paper\\notes.md",
      type: "markdown",
      content: "# Title\n\nBody text.",
      isDirty: false,
    };
    stores.files = [file];

    await act(async () => {
      root.render(<MarkdownPreviewPane file={file} />);
    });

    expect(
      container.querySelector("[data-testid='md-preview-stage']"),
    ).toBeTruthy();
    expect(
      container.querySelector("[data-testid='md-preview-paper']"),
    ).toBeTruthy();
    expect(container.querySelector("h1")?.textContent).toBe("Title");
    expect(container.textContent).toMatch(/Body text/);
  });
});
