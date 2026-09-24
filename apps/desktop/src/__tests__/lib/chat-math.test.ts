import { describe, expect, it } from "vitest";
import { normalizeChatMath } from "@/lib/chat-math";

describe("normalizeChatMath", () => {
  it("turns bracketed display formulas into display math", () => {
    const source = [
      "需要明确至少一种形式，例如:",
      "[\\Delta_i^t = w_i^t-w_t,]",
      "然后说明服务端如何聚合:",
      "[ w_{t+1}=w_t+\\sum_{i\\in S_t} \\alpha_i^t \\tilde{\\Delta}_i^t. ]",
    ].join("\n");

    const normalized = normalizeChatMath(source);
    expect(normalized).toContain("$$");
    expect(normalized).toContain("\\Delta_i^t = w_i^t-w_t,");
    expect(normalized).toContain("\\sum_{i\\in S_t}");
    expect(normalized).not.toContain("[\\Delta_i^t");
  });

  it("turns a multiline bracket block into display math", () => {
    const source = ["[", "\\min_w F(w)", "]"].join("\n");
    expect(normalizeChatMath(source)).toBe("$$\n\\min_w F(w)\n$$");
  });

  it("wraps a standalone bare formula and inline code math", () => {
    const source = [
      "目标:",
      "\\min_w F(w)",
      "",
      "局部更新 `g_i \\leftarrow \\text{LocalTrain}(...)`.",
    ].join("\n");
    const normalized = normalizeChatMath(source);
    expect(normalized).toContain("$$\n\\min_w F(w)\n$$");
    expect(normalized).toContain("$g_i \\leftarrow \\text{LocalTrain}(...)$");
    expect(normalized).not.toContain("`g_i");
  });

  it("leaves citations, links, vectors, prose, and fenced code alone", () => {
    const source = [
      "See [Nature](https://doi.org/10.1038/s41586-023-00000) and \\cite{smith2020}.",
      "As shown \\[1\\] and [@smith2020].",
      "The vector is [1, 2, 3].",
      "Recent work [1] is not a formula.",
      "",
      "[1] Smith et al. https://doi.org/10.1038/s41586-023-00000",
      "",
      "```latex",
      "\\min_w F(w)",
      "```",
      "",
      "```bash",
      "pdflatex main.tex",
      "```",
      "",
      "Use `npm install` and keep `$E=mc^2$`.",
    ].join("\n");

    expect(normalizeChatMath(source)).toBe(source);
  });

  it("does not rewrite math that is already delimited", () => {
    const source = "Inline $E=mc^2$ and \\[ \\sum_i x_i \\].";
    expect(normalizeChatMath(source)).toBe(source);
  });
});
