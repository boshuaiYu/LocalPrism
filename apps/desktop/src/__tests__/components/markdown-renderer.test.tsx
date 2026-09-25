import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { MarkdownRenderer } from "@/components/claude-chat/markdown-renderer";
import { useDocumentStore } from "@/stores/document-store";

describe("MarkdownRenderer links", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.mocked(shellOpen).mockReset();
    vi.mocked(shellOpen).mockResolvedValue(undefined);
  });

  afterEach(() => {
    root.unmount();
    container.remove();
  });

  it("renders markdown citations as visible link chips and opens them", async () => {
    root.render(
      <MarkdownRenderer content="See [Nature paper](https://doi.org/10.1038/s41586-023-00000-0)." />,
    );

    const link = await vi.waitFor(() => {
      const node = container.querySelector(
        'a[href="https://doi.org/10.1038/s41586-023-00000-0"]',
      );
      if (!(node instanceof HTMLAnchorElement)) {
        throw new Error("citation link missing");
      }
      return node;
    });
    expect(link.getAttribute("data-testid")).toBe("chat-markdown-link");
    expect(link.className).toMatch(/rounded/);
    expect(link.textContent).toContain("Nature paper");

    link.click();
    expect(shellOpen).toHaveBeenCalledWith(
      "https://doi.org/10.1038/s41586-023-00000-0",
    );
  });

  it("does not navigate the webview for non-http citations", async () => {
    root.render(
      <MarkdownRenderer content="See [notes](./references.md) for the list." />,
    );

    const link = await vi.waitFor(() => {
      const node = container.querySelector('a[href="./references.md"]');
      if (!(node instanceof HTMLAnchorElement)) {
        throw new Error("relative citation missing");
      }
      return node;
    });
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(shellOpen).not.toHaveBeenCalled();
  });

  it("renders latex, numbered, and protocol-less citations as chips", async () => {
    root.render(
      <MarkdownRenderer
        content={[
          "See \\cite{smith2020} and \\[1\\] plus [Nature](doi:10.1038/s41586-023-00000).",
          "",
          "[1] Smith et al. https://doi.org/10.1038/s41586-023-00000",
        ].join("\n")}
      />,
    );

    const { cite, numbered, nature } = await vi.waitFor(() => {
      const citeLink = container.querySelector('a[href="#cite:smith2020"]');
      const natureLink = Array.from(container.querySelectorAll("a")).find(
        (node) => node.textContent?.includes("Nature"),
      );
      const numberedLink = Array.from(container.querySelectorAll("a")).find(
        (node) => node.textContent?.trim() === "1",
      );
      if (
        !(citeLink instanceof HTMLAnchorElement) ||
        !(natureLink instanceof HTMLAnchorElement) ||
        !(numberedLink instanceof HTMLAnchorElement)
      ) {
        throw new Error("citation chips missing");
      }
      return { cite: citeLink, numbered: numberedLink, nature: natureLink };
    });

    expect(cite.textContent).toContain("smith2020");
    expect(numbered.getAttribute("href")).toBe(
      "https://doi.org/10.1038/s41586-023-00000",
    );
    expect(nature.getAttribute("href")).toBe(
      "https://doi.org/10.1038/s41586-023-00000",
    );
    expect(container.querySelector(".katex")).toBeNull();

    nature.click();
    expect(shellOpen).toHaveBeenCalledWith(
      "https://doi.org/10.1038/s41586-023-00000",
    );
  });

  it("strips unsafe javascript hrefs", async () => {
    root.render(
      <MarkdownRenderer content="See [x](javascript:alert(1)) and [y](java\tscript:alert(1))." />,
    );

    await vi.waitFor(() => {
      expect(container.textContent).toContain("x");
    });
    expect(container.querySelector('a[href^="javascript"]')).toBeNull();
    expect(container.querySelector('a[href*="script:"]')).toBeNull();
  });

  it("keeps math, code, and tables inside a narrow chat column", async () => {
    await act(async () => {
      root.render(
        <MarkdownRenderer
          content={[
            "Inline $E=mc^2$ and",
            "",
            "$$",
            "\\frac{a}{b+c}",
            "$$",
            "",
            "```python",
            "print('a-very-long-token-that-should-scroll-inside-the-chat-column')",
            "```",
            "",
            "| Method | Score | Notes |",
            "| --- | --- | --- |",
            "| Spectral | 0.91 | narrow sidebar |",
          ].join("\n")}
        />,
      );
    });

    const markdown = container.querySelector(".chat-markdown");
    if (!(markdown instanceof HTMLElement)) {
      throw new Error("chat markdown root missing");
    }

    expect(markdown.className).not.toContain("[&_*]:max-w-full");
    expect(markdown.querySelector(".katex")).toBeTruthy();
    expect(markdown.querySelector(".katex-display")).toBeTruthy();
    const code = markdown.querySelector("pre");
    expect(code?.className).toMatch(/overflow-x-auto/);
    expect(code?.className).toMatch(/chat-markdown-code/);
    const table = markdown.querySelector(".chat-markdown-table");
    expect(table).toBeTruthy();
    expect(table?.className).toMatch(/overflow-x-auto/);
    expect(table?.querySelector("table")).toBeTruthy();
  });

  it("renders latex fences as KaTeX and still inserts the source", async () => {
    const insertAtCursor = vi.fn();
    useDocumentStore.setState({ insertAtCursor });

    await act(async () => {
      root.render(
        <MarkdownRenderer
          content={["```latex", "\\min_w F(w)", "```"].join("\n")}
        />,
      );
    });

    const preview = await vi.waitFor(() => {
      const node = container.querySelector(
        "[data-testid='chat-latex-preview']",
      );
      if (!(node instanceof HTMLElement))
        throw new Error("latex preview missing");
      return node;
    });
    expect(preview.querySelector(".katex")).toBeTruthy();
    expect(preview.querySelector(".katex-html")?.textContent).toContain("F");
    expect(preview.querySelector(".katex-html")?.textContent).not.toContain(
      "\\min",
    );

    const insert = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Insert"),
    );
    if (!(insert instanceof HTMLButtonElement)) {
      throw new Error("Insert button missing");
    }
    insert.click();
    expect(insertAtCursor).toHaveBeenCalledWith("\\min_w F(w)");
  });

  it("renders bracket and bare formulas that models emit without delimiters", async () => {
    await act(async () => {
      root.render(
        <MarkdownRenderer
          content={[
            "\\min_w F(w)",
            "",
            "[\\Delta_i^t = w_i^t-w_t,]",
            "",
            "[ w_{t+1}=w_t+\\sum_{i\\in S_t} \\alpha_i^t \\tilde{\\Delta}_i^t. ]",
          ].join("\n")}
        />,
      );
    });

    await vi.waitFor(() => {
      expect(
        container.querySelectorAll(".katex-display").length,
      ).toBeGreaterThanOrEqual(3);
    });
    const visible = Array.from(container.querySelectorAll(".katex-html")).map(
      (node) => node.textContent ?? "",
    );
    expect(visible.some((text) => text.includes("F"))).toBe(true);
    expect(
      visible.some((text) => text.includes("∑") || text.includes("Δ")),
    ).toBe(true);
    expect(visible.join("")).not.toContain("\\sum");
    expect(container.querySelector(".chat-markdown-code")).toBeNull();
  });

  it("renders screenshot bracket display math and \\[...\\] with KaTeX", async () => {
    const formula = "x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}";
    await act(async () => {
      root.render(
        <MarkdownRenderer
          content={[
            "行内 $E=mc^2$ 与 \\(a \\neq 0\\)。",
            "",
            `独立公式：[ ${formula} ]`,
            "",
            `\\[ ${formula} \\]`,
            "",
            "$$",
            "y = \\frac{1}{x}",
            "$$",
          ].join("\n")}
        />,
      );
    });

    await vi.waitFor(() => {
      expect(
        container.querySelectorAll(".katex-display").length,
      ).toBeGreaterThanOrEqual(3);
    });
    const html = Array.from(container.querySelectorAll(".katex-html"))
      .map((node) => node.textContent ?? "")
      .join("");
    expect(html).not.toContain("\\frac");
    expect(html).not.toContain("\\sqrt");
    expect(container.textContent).not.toContain(`[ ${formula} ]`);
    expect(container.querySelector(".katex")).toBeTruthy();
  });

  it("keeps a non-formula latex document as insertable source", async () => {
    await act(async () => {
      root.render(
        <MarkdownRenderer
          content={[
            "```tex",
            "\\documentclass{article}",
            "\\begin{document}",
            "Hi",
            "\\end{document}",
            "```",
          ].join("\n")}
        />,
      );
    });

    const code = await vi.waitFor(() => {
      const node = container.querySelector(".chat-markdown-code");
      if (!(node instanceof HTMLElement))
        throw new Error("source block missing");
      return node;
    });
    expect(code.textContent).toContain("\\documentclass{article}");
    expect(
      container.querySelector("[data-testid='chat-latex-preview']"),
    ).toBeNull();
    expect(
      Array.from(container.querySelectorAll("button")).some((button) =>
        button.textContent?.includes("Insert"),
      ),
    ).toBe(true);
  });
});
