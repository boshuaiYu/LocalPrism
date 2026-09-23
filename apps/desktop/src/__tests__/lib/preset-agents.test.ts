import { describe, expect, it } from "vitest";
import {
  PRESET_AGENTS,
  appendPeerReviewBibliography,
  buildPresetAgentProfile,
  presetSkillIds,
} from "@/lib/preset-agents";
import type { RuntimeSkill } from "@/runtime/types";

function skill(overrides: Partial<RuntimeSkill> = {}): RuntimeSkill {
  return {
    id: "claude:user:writer",
    name: "Writer",
    description: "Writes prose",
    folder: "writer",
    sourcePath: "C:/skills/writer",
    targets: [{ runtime: "claude", scope: "user" }],
    managed: true,
    compatibleRuntimes: ["claude"],
    enabled: true,
    discoveryError: null,
    ...overrides,
  };
}

describe("built-in agent presets", () => {
  it("ships polish, de-ai, and peer review with bilingual blurbs and embedded prompts", () => {
    expect(PRESET_AGENTS.map((preset) => preset.id)).toEqual([
      "academic-polish",
      "de-ai",
      "peer-review",
    ]);

    const polish = PRESET_AGENTS[0];
    expect(polish.name).toBe("润色");
    expect(polish.summaryZh).toContain("清晰度");
    expect(polish.summaryEn.toLowerCase()).toContain("clarity");
    expect(polish.instructions).toContain(
      "You are an expert academic editor for LaTeX research papers",
    );
    expect(polish.instructions).toContain("Preserve LaTeX exactly");
    expect(polish.instructions).toContain("\\cite/\\citet/\\citep");

    const deAi = PRESET_AGENTS[1];
    expect(deAi.name).toBe("去AI");
    expect(deAi.summaryZh).toContain("AI");
    expect(deAi.summaryEn.toLowerCase()).toContain("template-like");
    expect(deAi.instructions).toContain("You humanize academic prose");
    expect(deAi.instructions).toContain(
      "此外/值得注意的是/综上所述/具有重要意义",
    );
    expect(deAi.instructions).toContain("Do NOT: invent facts");

    const review = PRESET_AGENTS[2];
    expect(review.name).toBe("Peer Review");
    expect(review.summaryZh).toContain("审稿");
    expect(review.summaryEn.toLowerCase()).toContain("peer review");
    expect(review.instructions).toContain(
      "You are a senior peer reviewer for a top venue",
    );
    expect(review.instructions).toContain("Never invent papers or DOIs.");
    expect(review.instructions).toContain("project .bib");
  });

  it("fills a preset profile from the spec even when no skills are installed", () => {
    const profile = buildPresetAgentProfile("academic-polish", []);
    expect(profile).toMatchObject({
      id: "academic-polish",
      runtime: "claude",
      scope: "user",
      name: "润色",
      skillIds: [],
      model: null,
      tools: [],
    });
    expect(profile.description).toContain(PRESET_AGENTS[0].summaryZh);
    expect(profile.description).toContain(PRESET_AGENTS[0].summaryEn);
    expect(profile.instructions).toBe(PRESET_AGENTS[0].instructions);
  });

  it("attaches installed user and project skills that match each preset", () => {
    const catalog = [
      skill({
        id: "claude:user:nature-polishing",
        name: "Nature Polishing",
        folder: "nature-polishing",
      }),
      skill({
        id: "claude:user:latex-guard",
        name: "LaTeX Guard",
        folder: "latex-guard",
      }),
      skill({
        id: "claude:user:writing-coach",
        name: "Writing Coach",
        folder: "writing-coach",
      }),
      skill({
        id: "claude:project:nature-citation",
        name: "Nature Citation",
        folder: "nature-citation",
        sourcePath: "/paper/.localprism/skills/nature-citation",
        targets: [{ runtime: "claude", scope: "project" }],
      }),
      skill({
        id: "claude:user:humanizer-academic-zh",
        name: "Humanizer",
        folder: "humanizer-academic-zh",
      }),
      skill({
        id: "claude:user:reduce-ai-style",
        name: "Reduce AI Style",
        folder: "reduce-ai-style",
      }),
      skill({
        id: "claude:project:academic-de-ai",
        name: "Academic De-AI",
        folder: "academic-de-ai",
        targets: [{ runtime: "claude", scope: "project" }],
      }),
      skill({
        id: "claude:user:zotero-cite",
        name: "Zotero Cite",
        folder: "zotero-cite",
      }),
      skill({
        id: "claude:project:bibtex-lint",
        name: "BibTeX Lint",
        folder: "bibtex-lint",
        targets: [{ runtime: "claude", scope: "project" }],
      }),
      skill({
        id: "claude:user:peer-review",
        name: "Peer Review",
        folder: "peer-review",
      }),
      skill({
        id: "claude:user:latex-posters",
        name: "LaTeX Posters",
        folder: "latex-posters",
      }),
      skill({
        id: "claude:user:markdown-mermaid-writing",
        name: "Markdown & Mermaid",
        folder: "markdown-mermaid-writing",
      }),
      skill({
        id: "claude:user:scanpy",
        name: "Scanpy",
        folder: "scanpy",
        description: "citation polish humanizer bibliography",
      }),
      skill({
        id: "codex:user:humanizer",
        name: "Humanizer Codex",
        folder: "humanizer",
        targets: [{ runtime: "codex", scope: "user" }],
        compatibleRuntimes: ["codex"],
        enabled: false,
      }),
      skill({
        id: "claude:user:broken-citation",
        name: "Broken Citation",
        folder: "citation-broken",
        discoveryError: "missing SKILL.md",
      }),
    ];

    expect(presetSkillIds("academic-polish", catalog)).toEqual([
      "nature-polishing",
      "latex-guard",
      "writing-coach",
      "nature-citation",
    ]);
    expect(presetSkillIds("de-ai", catalog)).toEqual([
      "humanizer-academic-zh",
      "reduce-ai-style",
      "academic-de-ai",
    ]);
    expect(presetSkillIds("peer-review", catalog)).toEqual([
      "nature-citation",
      "zotero-cite",
      "bibtex-lint",
      "peer-review",
    ]);

    const polish = buildPresetAgentProfile("academic-polish", catalog, {
      projectPath: "/paper",
    });
    expect(polish.scope).toBe("user");
    expect(polish.skillIds).toEqual([
      "nature-polishing",
      "latex-guard",
      "writing-coach",
      "nature-citation",
    ]);

    const projectOnly = buildPresetAgentProfile(
      "peer-review",
      catalog.filter((item) =>
        item.targets.every((target) => target.scope === "project"),
      ),
      { projectPath: "/paper" },
    );
    expect(projectOnly.scope).toBe("user");
    expect(projectOnly.skillIds).toEqual(["nature-citation", "bibtex-lint"]);
    expect(
      buildPresetAgentProfile(
        "peer-review",
        catalog.filter((item) =>
          item.targets.every((target) => target.scope === "project"),
        ),
      ).skillIds,
    ).toEqual([]);
  });

  it("keeps peer review usable from embedded instructions when no bibliography is loaded", () => {
    const profile = buildPresetAgentProfile("peer-review", [], {
      projectPath: "/paper",
    });
    expect(profile.instructions).toBe(PRESET_AGENTS[2].instructions);
    expect(profile.skillIds).toEqual([]);
  });

  it("appends project .bib citekeys for peer review when files are already loaded", () => {
    const files = [
      {
        name: "main.tex",
        relativePath: "main.tex",
        type: "tex",
        content: "See \\cite{smith2020}.",
      },
      {
        name: "references.bib",
        relativePath: "references.bib",
        type: "bib",
        content: "@article{smith2020,\n  title = {Example}\n}\n",
      },
    ];
    const profile = buildPresetAgentProfile("peer-review", [], {
      projectPath: "/paper",
    });
    expect(profile.scope).toBe("user");
    expect(profile.instructions).toBe(PRESET_AGENTS[2].instructions);
    expect(profile.instructions).not.toContain("smith2020");

    const turn = appendPeerReviewBibliography(
      "Review this draft",
      "peer-review",
      files,
    );
    expect(turn).toContain("Review this draft");
    expect(turn).toContain("smith2020");
    expect(appendPeerReviewBibliography("Review this draft", null, files)).toBe(
      "Review this draft",
    );
    expect(
      appendPeerReviewBibliography(
        "Review this draft",
        "academic-polish",
        files,
      ),
    ).toBe("Review this draft");
  });
});
