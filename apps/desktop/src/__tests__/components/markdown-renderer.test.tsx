import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { MarkdownRenderer } from "@/components/claude-chat/markdown-renderer";

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
});
