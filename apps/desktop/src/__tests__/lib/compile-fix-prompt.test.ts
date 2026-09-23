import { describe, expect, it } from "vitest";
import {
  COMPILE_FIX_WITH_AI_LABEL,
  buildCompileFixPrompt,
  compileErrorSummaries,
  parseCompileLogAnchors,
  parseDisplayedCompileBullet,
} from "@/lib/compile-fix-prompt";

const introTex = [
  "\\documentclass{article}",
  "\\begin{document}",
  "Hello $",
  "\\end{document}",
].join("\n");

describe("parseCompileLogAnchors", () => {
  it("anchors file and line when the log reports them", () => {
    const anchors = parseCompileLogAnchors(
      "error: ./sections/intro.tex:12: Undefined control sequence",
    );

    expect(anchors).toEqual([
      {
        file: "sections/intro.tex",
        line: 12,
        message: "Undefined control sequence",
      },
    ]);
  });

  it("keeps a classic l.N line without inventing a file", () => {
    const anchors = parseCompileLogAnchors(
      [
        "! Undefined control sequence.",
        "l.15 \\foo",
        "",
        "The control sequence at the end of the top line",
      ].join("\n"),
    );

    expect(anchors).toEqual([
      {
        line: 15,
        message: "Undefined control sequence.",
      },
    ]);
    expect(anchors[0]?.file).toBeUndefined();
  });

  it("binds l.N to the single file the same error block names", () => {
    const anchors = parseCompileLogAnchors(
      ["! Missing $ inserted.", "(./main.tex", "l.3 Hello $"].join("\n"),
    );

    expect(anchors).toEqual([
      {
        file: "main.tex",
        line: 3,
        message: "Missing $ inserted.",
      },
    ]);
  });

  it("does not bind l.N when the block names more than one file", () => {
    const anchors = parseCompileLogAnchors(
      [
        "(./chapters/a.tex",
        "(./chapters/b.tex",
        "! Undefined control sequence.",
        "l.4 \\bad",
      ].join("\n"),
    );

    expect(anchors).toEqual([
      {
        line: 4,
        message: "Undefined control sequence.",
      },
    ]);
  });

  it("does not treat page counts or help text as locations", () => {
    const anchors = parseCompileLogAnchors(
      "! Emergency stop.\nOutput written on main.pdf (1 page).",
    );

    expect(anchors).toEqual([{ message: "Emergency stop." }]);
    expect(anchors[0]?.line).toBeUndefined();
    expect(anchors[0]?.file).toBeUndefined();
  });

  it("reads a Windows path:line location", () => {
    const anchors = parseCompileLogAnchors(
      String.raw`C:\papers\main.tex:8: File ended while scanning use of \foo`,
    );

    expect(anchors).toEqual([
      {
        file: "papers/main.tex",
        line: 8,
        message: String.raw`File ended while scanning use of \foo`,
      },
    ]);
  });
});

describe("buildCompileFixPrompt", () => {
  it("sends the compile log and a source excerpt around the reported line", () => {
    const result = buildCompileFixPrompt({
      log: "Compilation failed (tectonic)\n\n./main.tex:3: Missing $ inserted.",
      files: [{ relativePath: "main.tex", content: introTex }],
    });

    expect(result.displayPrompt).toContain("[Compilation errors]");
    expect(result.displayPrompt).toContain(
      "- main.tex:3 — Missing $ inserted.",
    );
    expect(result.displayPrompt).not.toContain("Hello $");
    expect(result.prompt).toContain("./main.tex:3: Missing $ inserted.");
    expect(result.prompt).toContain("Hello $");
    expect(result.prompt).toContain("main.tex");
    expect(result.anchors).toEqual([
      { file: "main.tex", line: 3, message: "Missing $ inserted." },
    ]);
    expect(result.displayPrompt).toMatch(
      /^\[Compilation errors\]\n((?:- .+\n?)+)\n([\s\S]*)$/,
    );
  });

  it("does not excerpt a different file when the reported path is not in the project", () => {
    const result = buildCompileFixPrompt({
      log: "./other/missing.tex:2: LaTeX Error: File not found.",
      files: [
        { relativePath: "main.tex", content: introTex },
        {
          relativePath: "chapters/intro.tex",
          content: "not the reported file",
        },
      ],
    });

    expect(result.prompt).not.toContain("not the reported file");
    expect(result.prompt).not.toContain("Hello $");
    expect(result.prompt).toContain("other/missing.tex:2");
    expect(result.displayPrompt).toContain("other/missing.tex:2");
    expect(result.displayPrompt).not.toMatch(/main\.tex:\d+/);
  });

  it("does not guess a file for a line-only log", () => {
    const result = buildCompileFixPrompt({
      log: "! Undefined control sequence.\nl.15 \\foo",
      files: [{ relativePath: "main.tex", content: introTex }],
    });

    expect(result.anchors[0]?.file).toBeUndefined();
    expect(result.anchors[0]?.line).toBe(15);
    expect(result.prompt).not.toContain("\\documentclass");
    expect(result.displayPrompt).toContain("line 15");
    expect(result.displayPrompt).not.toContain("main.tex:15");
  });

  it("skips an excerpt when the reported line is outside the loaded file", () => {
    const result = buildCompileFixPrompt({
      log: "./main.tex:400: Undefined control sequence.",
      files: [{ relativePath: "main.tex", content: introTex }],
    });

    expect(result.prompt).not.toContain("\\documentclass");
    expect(result.prompt).toContain("main.tex:400");
    expect(result.prompt).toMatch(/outside|not attached|no excerpt/i);
  });

  it("keeps a usable prompt when the log has no location", () => {
    const result = buildCompileFixPrompt({
      log: "Compilation failed (tectonic)\n\nNo pages of output. Add visible content to the document body.",
      files: [{ relativePath: "main.tex", content: introTex }],
    });

    expect(result.anchors).toEqual([]);
    expect(result.displayPrompt).toContain("No pages of output");
    expect(result.displayPrompt).not.toMatch(/:\d+/);
    expect(result.prompt).toContain("No pages of output");
    expect(result.prompt).not.toContain("\\documentclass");
  });
});

describe("compileErrorSummaries", () => {
  it("summarizes a classic error without splitting on every bang", () => {
    const summaries = compileErrorSummaries(
      [
        "! Undefined control sequence.",
        "l.15 \\foo",
        "",
        "If you have misspelled it (e.g., `\\hobx'), type `I' and the correct spelling.",
      ].join("\n"),
    );

    expect(summaries).toEqual(["line 15 — Undefined control sequence."]);
  });
});

describe("parseDisplayedCompileBullet", () => {
  it("reads a file:line bullet and leaves unlocated text alone", () => {
    expect(
      parseDisplayedCompileBullet("- main.tex:3 — Missing $ inserted."),
    ).toEqual({
      message: "Missing $ inserted.",
      location: "main.tex:3",
    });
    expect(
      parseDisplayedCompileBullet("- line 15 — Undefined control sequence."),
    ).toEqual({
      message: "Undefined control sequence.",
      location: "line 15",
    });
    expect(parseDisplayedCompileBullet("- No pages of output.")).toEqual({
      message: "No pages of output.",
    });
  });
});

describe("COMPILE_FIX_WITH_AI_LABEL", () => {
  it("names the existing compile action as Fix with AI", () => {
    expect(COMPILE_FIX_WITH_AI_LABEL).toBe("Fix with AI");
  });
});
