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

  it("does not wrap Chinese or short English prose that mentions a symbol", () => {
    const lines = [
      "其中 \\alpha 为学习率。",
      "例如这里用 \\alpha 表示",
      "在联邦学习中，我们通常用 \\alpha 表示学习率，并用 \\beta 表示动量。",
      "目标是 \\min_w F(w) 的最优解",
      "其中 \\alpha 为学习率 \\cite{smith2020}.",
      "This uses \\alpha.",
      "Let \\alpha be the step size.",
      "Here \\theta is temperature.",
    ];
    for (const line of lines) {
      expect(normalizeChatMath(line)).toBe(line);
    }
  });

  it("does not treat identifier underscores as math", () => {
    expect(normalizeChatMath("error_code = 1")).toBe("error_code = 1");
    expect(normalizeChatMath("learning_rate = 0.01")).toBe(
      "learning_rate = 0.01",
    );
    expect(normalizeChatMath("[1]")).toBe("[1]");
    expect(normalizeChatMath("[1, 2, 3]")).toBe("[1, 2, 3]");
  });

  it("wraps a bare align or equation as one block", () => {
    const align = [
      "\\begin{align}",
      "x &= y_{1} \\\\",
      "z &= w_{2}",
      "\\end{align}",
    ].join("\n");
    expect(normalizeChatMath(align)).toBe(`$$\n${align}\n$$`);

    const equation = [
      "\\begin{equation}",
      "\\min_w F(w)",
      "\\end{equation}",
    ].join("\n");
    const wrapped = normalizeChatMath(equation);
    expect(wrapped).toBe(`$$\n${equation}\n$$`);
    expect(wrapped.match(/\$\$/g)).toHaveLength(2);

    const oneLine = "\\begin{equation} \\min_w F(w) \\end{equation}";
    expect(normalizeChatMath(oneLine)).toBe(`$$\n${oneLine}\n$$`);
  });

  it("does not rewrite an unclosed fence or display math while streaming", () => {
    const fence = "```latex\n\\min_w F(w)";
    expect(normalizeChatMath(fence)).toBe(fence);
    const math = "$$\n\\min_w F(w)";
    expect(normalizeChatMath(math)).toBe(math);

    const mixed = "\\min_w F(w)\n\n```latex\n\\alpha";
    expect(normalizeChatMath(mixed)).toBe(
      "$$\n\\min_w F(w)\n$$\n\n```latex\n\\alpha",
    );
  });
});
