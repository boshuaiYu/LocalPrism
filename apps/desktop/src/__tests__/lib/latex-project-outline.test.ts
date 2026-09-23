import { describe, expect, it } from "vitest";
import {
  buildLatexProjectOutline,
  parseLatexIncludes,
  resolveLatexInclude,
} from "@/lib/latex-project-outline";

describe("latex project outline", () => {
  it("ignores commented includes and resolves paths next to the source", () => {
    expect(
      parseLatexIncludes(
        "% \\input{skip}\n\\input{body/chapter01}\n\\include{appendix}",
      ),
    ).toEqual(["body/chapter01", "appendix"]);
    expect(resolveLatexInclude("main.tex", "body/chapter01")).toBe(
      "body/chapter01.tex",
    );
    expect(resolveLatexInclude("chapters/one.tex", "../front/abstract")).toBe(
      "front/abstract.tex",
    );
  });

  it("walks \\input and \\include from the root and keeps chapter titles", () => {
    const outline = buildLatexProjectOutline([
      {
        relativePath: "main.tex",
        type: "tex",
        content:
          "\\input{front/abstract}\n\\include{body/chapter01}\n\\input{missing-chapter}",
      },
      {
        relativePath: "front/abstract.tex",
        type: "tex",
        content: "\\chapter*{Abstract}\nHello",
      },
      {
        relativePath: "body/chapter01.tex",
        type: "tex",
        content: "\\chapter{Introduction}\nText",
      },
      {
        relativePath: "notes.tex",
        type: "tex",
        content: "orphan",
      },
    ]);

    expect(outline.map((entry) => entry.relativePath)).toEqual([
      "main.tex",
      "front/abstract.tex",
      "body/chapter01.tex",
      "missing-chapter.tex",
    ]);
    expect(outline[2]?.title).toBe("Introduction");
    expect(outline[1]?.title).toBe("Abstract");
    expect(outline[3]?.exists).toBe(false);
    expect(outline.some((entry) => entry.relativePath === "notes.tex")).toBe(
      false,
    );
  });

  it("stays empty for a single file with no includes", () => {
    expect(
      buildLatexProjectOutline([
        { relativePath: "main.tex", type: "tex", content: "\\section{A}" },
      ]),
    ).toEqual([]);
  });
});
