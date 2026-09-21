import { describe, expect, it } from "vitest";
import {
  isOpenableChatHref,
  normalizeChatHref,
  promoteChatCitations,
  transformChatUrl,
} from "@/lib/chat-citations";

describe("normalizeChatHref", () => {
  it("keeps http(s) and lifts protocol-less citation hrefs", () => {
    expect(normalizeChatHref("https://doi.org/10.1038/s41586-023-00000")).toBe(
      "https://doi.org/10.1038/s41586-023-00000",
    );
    expect(normalizeChatHref("www.nature.com/articles/s41586-023-00000")).toBe(
      "https://www.nature.com/articles/s41586-023-00000",
    );
    expect(normalizeChatHref("doi:10.1038/s41586-023-00000")).toBe(
      "https://doi.org/10.1038/s41586-023-00000",
    );
    expect(normalizeChatHref("10.1038/s41586-023-00000")).toBe(
      "https://doi.org/10.1038/s41586-023-00000",
    );
    expect(normalizeChatHref("arxiv:2301.12345")).toBe(
      "https://arxiv.org/abs/2301.12345",
    );
    expect(isOpenableChatHref(normalizeChatHref("doi:10.1038/abc"))).toBe(true);
    expect(isOpenableChatHref("./notes.md")).toBe(false);
  });
});

describe("transformChatUrl", () => {
  it("normalizes citation protocols and blocks unsafe schemes", () => {
    expect(transformChatUrl("doi:10.1038/s41586-023-00000")).toBe(
      "https://doi.org/10.1038/s41586-023-00000",
    );
    expect(transformChatUrl("www.nature.com/articles/s41586-023-00000")).toBe(
      "https://www.nature.com/articles/s41586-023-00000",
    );
    expect(transformChatUrl("#cite:smith2020")).toBe("#cite:smith2020");
    expect(transformChatUrl("./references.md")).toBe("./references.md");
    expect(transformChatUrl("javascript:alert(1)")).toBe("");
    expect(transformChatUrl("java\tscript:alert(1)")).toBe("");
    expect(transformChatUrl("data:text/html,hi")).toBe("");
    expect(transformChatUrl("#cite:foo\njavascript:alert(1)")).toBe("");
    expect(transformChatUrl("//evil.com")).toBe("");
  });
});

describe("promoteChatCitations", () => {
  it("turns latex cites and numbered refs into markdown links", () => {
    expect(promoteChatCitations("see \\cite{smith2020}")).toContain(
      "[smith2020](#cite:smith2020)",
    );
    expect(promoteChatCitations("see \\citep{a, b}")).toContain("[a](#cite:a)");
    expect(promoteChatCitations("see \\citep{a, b}")).toContain("[b](#cite:b)");
    expect(promoteChatCitations("see \\parencite{smith2020}")).toContain(
      "[smith2020](#cite:smith2020)",
    );
    expect(promoteChatCitations("see [@smith2020]")).toContain(
      "[smith2020](#cite:smith2020)",
    );
    expect(promoteChatCitations("see \\citep[p.~12]{smith2020}")).toContain(
      "[smith2020](#cite:smith2020)",
    );
    expect(promoteChatCitations("as shown \\[1\\]")).toBe(
      "as shown [1](#cite-num:1)",
    );
    expect(promoteChatCitations("\\[ E = mc^2 \\]")).toBe("\\[ E = mc^2 \\]");
    expect(promoteChatCitations("\\[1, 2\\]")).toBe("\\[1, 2\\]");
  });

  it("promotes in-text [1] when a bibliography line exists", () => {
    const source = [
      "Recent work [1] shows this.",
      "",
      "[1] Smith et al. Nature. https://doi.org/10.1038/s41586-023-00000",
    ].join("\n");
    const promoted = promoteChatCitations(source);
    expect(promoted).toContain("[1](https://doi.org/10.1038/s41586-023-00000)");
    expect(promoted).not.toMatch(/(?<!\()\[1\](?!\()/);
  });

  it("does not rewrite vectors or reference-style labels when a bibliography exists", () => {
    const source = [
      "See [Nature][1] and the vector [1, 2, 3].",
      "",
      "[1] Smith et al. Nature. https://doi.org/10.1038/s41586-023-00000",
    ].join("\n");
    const promoted = promoteChatCitations(source);
    expect(promoted).toContain("[Nature][1]");
    expect(promoted).toContain("[1, 2, 3]");
  });

  it("expands [1-3] only when every number has a bibliography line", () => {
    const source = [
      "See [1-3].",
      "",
      "[1] A https://doi.org/10.1038/a",
      "[2] B https://doi.org/10.1038/b",
      "[3] C https://doi.org/10.1038/c",
    ].join("\n");
    const promoted = promoteChatCitations(source);
    expect(promoted).toContain(
      "See [1](https://doi.org/10.1038/a) [2](https://doi.org/10.1038/b) [3](https://doi.org/10.1038/c).",
    );
    expect(promoted).not.toContain(")(https://");
  });

  it("promotes bare doi, parenthesized doi, arxiv, and www citations", () => {
    expect(promoteChatCitations("see doi:10.1038/s41586-023-00000")).toContain(
      "https://doi.org/10.1038/s41586-023-00000",
    );
    expect(promoteChatCitations("see 10.1016/S0140-6736(20)30567-5")).toContain(
      "https://doi.org/10.1016/S0140-6736(20)30567-5",
    );
    expect(promoteChatCitations("see arXiv:2301.12345")).toContain(
      "https://arxiv.org/abs/2301.12345",
    );
    expect(
      promoteChatCitations("see www.nature.com/articles/s41586-023-00000"),
    ).toContain("https://www.nature.com/articles/s41586-023-00000");
    expect(promoteChatCitations("$10.1234/56$")).toBe("$10.1234/56$");
  });

  it("does not rewrite cites already inside a markdown link, code, or GFM definition", () => {
    expect(
      promoteChatCitations(
        "[Nature](https://doi.org/10.1038/s41586-023-00000)",
      ),
    ).toBe("[Nature](https://doi.org/10.1038/s41586-023-00000)");
    expect(promoteChatCitations("`\\cite{smith2020}`")).toBe(
      "`\\cite{smith2020}`",
    );
    const gfm = [
      "See [1].",
      "",
      "[1]: https://doi.org/10.1038/s41586-023-00000",
    ].join("\n");
    expect(promoteChatCitations(gfm)).toBe(gfm);
  });
});
