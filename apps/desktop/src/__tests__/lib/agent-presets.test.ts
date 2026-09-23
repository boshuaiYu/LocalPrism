import { describe, expect, it } from "vitest";
import {
  ACADEMIC_POLISH_INSTRUCTIONS,
  BUILTIN_AGENT_PRESETS,
  DE_AI_INSTRUCTIONS,
  PEER_REVIEW_INSTRUCTIONS,
  buildPresetAgentProfile,
} from "@/lib/agent-presets";
import type { RuntimeSkill, SkillScope } from "@/runtime/types";

function skill(
  folder: string,
  scope: SkillScope,
  overrides: Partial<RuntimeSkill> = {},
): RuntimeSkill {
  return {
    id: `claude:${scope}:${folder}`,
    name: folder,
    description: `${folder} skill`,
    folder,
    sourcePath: `/skills/${scope}/${folder}`,
    targets: [{ runtime: "claude", scope }],
    managed: true,
    compatibleRuntimes: ["claude"],
    enabled: true,
    discoveryError: null,
    ...overrides,
  };
}

describe("builtin agent presets", () => {
  it("offers polish, de-ai, and peer review with bilingual copy and embedded prompts", () => {
    expect(BUILTIN_AGENT_PRESETS.map((preset) => preset.id)).toEqual([
      "academic-polish",
      "de-ai",
      "peer-review",
    ]);

    const polish = buildPresetAgentProfile("academic-polish", []);
    expect(polish.id).toBe("academic-polish");
    expect(polish.name).toBe("润色");
    expect(polish.description).toContain("提升清晰度");
    expect(polish.description).toContain("academic tone");
    expect(polish.instructions).toBe(ACADEMIC_POLISH_INSTRUCTIONS);
    expect(polish.instructions).toContain(
      "You are an expert academic editor for LaTeX research papers",
    );
    expect(polish.instructions).toContain("Preserve LaTeX exactly");
    expect(polish.instructions).toContain("\\cite/\\citet/\\citep");
    expect(polish.instructions).toContain(
      "Do not fabricate citations, data, results, or references.",
    );
    expect(polish.scope).toBe("user");
    expect(polish.skillIds).toEqual([]);
    expect(polish.runtime).toBe("claude");

    const deAi = buildPresetAgentProfile("de-ai", []);
    expect(deAi.id).toBe("de-ai");
    expect(deAi.name).toBe("去AI");
    expect(deAi.description).toContain("模板化");
    expect(deAi.description).toContain("template-like");
    expect(deAi.instructions).toBe(DE_AI_INSTRUCTIONS);
    expect(deAi.instructions).toContain("You humanize academic prose");
    expect(deAi.instructions).toContain("Do NOT: invent facts");
    expect(deAi.skillIds).toEqual([]);

    const review = buildPresetAgentProfile("peer-review", []);
    expect(review.id).toBe("peer-review");
    expect(review.name).toBe("Peer Review");
    expect(review.description).toContain("审稿");
    expect(review.description).toContain("actionable");
    expect(review.instructions).toBe(PEER_REVIEW_INSTRUCTIONS);
    expect(review.instructions).toContain(
      "You are a senior peer reviewer for a top venue",
    );
    expect(review.instructions).toContain(
      "Do not rewrite the whole paper unless asked",
    );
    expect(review.instructions).toContain("Never invent papers or DOIs.");
    expect(review.skillIds).toEqual([]);
  });

  it("attaches installed writing and polish skills and skips citation tooling", () => {
    const profile = buildPresetAgentProfile(
      "academic-polish",
      [
        skill("academic-polish", "user"),
        skill("latex-guard", "user"),
        skill("writing-clarity", "user", { name: "Writing Clarity" }),
        skill("nature-writing", "user", { name: "Nature Writing" }),
        skill("humanizer-academic", "user"),
        skill("citation-writing", "user", { name: "Citation Writing" }),
        skill("zotero-cite", "user"),
        skill("bibtex-check", "user"),
        skill("my-bib", "user"),
        skill("scanpy", "user"),
      ],
      { projectPath: "/papers/demo" },
    );

    expect(profile.scope).toBe("user");
    expect(profile.skillIds).toEqual([
      "academic-polish",
      "latex-guard",
      "writing-clarity",
      "nature-writing",
    ]);
  });

  it("attaches humanizer and de-ai skills without polish or citation skills", () => {
    const profile = buildPresetAgentProfile("de-ai", [
      skill("humanizer-academic-zh", "user"),
      skill("reduce-ai-style", "user"),
      skill("de-ai-prose", "user"),
      skill("deai-pass", "user", { name: "DeAI Pass" }),
      skill("academic-polish", "user"),
      skill("zotero", "user"),
      skill("citation-check", "user"),
    ]);

    expect(profile.skillIds).toEqual([
      "humanizer-academic-zh",
      "reduce-ai-style",
      "de-ai-prose",
      "deai-pass",
    ]);
  });

  it("keeps peer review critique-only and does not bind citation or writing skills", () => {
    const profile = buildPresetAgentProfile(
      "peer-review",
      [
        skill("academic-polish", "user"),
        skill("humanizer-academic", "user"),
        skill("zotero-cite", "user"),
        skill("citation-check", "project"),
        skill("paper-bib", "project"),
      ],
      { projectPath: "/papers/demo" },
    );

    expect(profile.scope).toBe("user");
    expect(profile.skillIds).toEqual([]);
  });

  it("uses a project skill when that is the only installed match", () => {
    const profile = buildPresetAgentProfile(
      "de-ai",
      [
        skill("humanizer-zh", "project", { name: "Humanizer ZH" }),
        skill("zotero", "project"),
      ],
      { projectPath: "/papers/demo" },
    );

    expect(profile.scope).toBe("project");
    expect(profile.skillIds).toEqual(["humanizer-zh"]);
  });

  it("prefers user-scope matches when both user and project skills are installed", () => {
    const profile = buildPresetAgentProfile(
      "academic-polish",
      [skill("latex-guard", "user"), skill("writing-style", "project")],
      { projectPath: "/papers/demo" },
    );

    expect(profile.scope).toBe("user");
    expect(profile.skillIds).toEqual(["latex-guard"]);
  });

  it("ignores disabled skills and skills with fatal discovery errors", () => {
    const profile = buildPresetAgentProfile("academic-polish", [
      skill("academic-polish", "user", { enabled: false }),
      skill("writing-clarity", "user", {
        discoveryError: "missing SKILL.md",
      }),
      skill("legacy-writing", "user", {
        name: "Legacy Writing",
        discoveryError:
          "Legacy Claude skill is missing a standard description and can only target Claude.",
      }),
    ]);

    expect(profile.scope).toBe("user");
    expect(profile.skillIds).toEqual(["legacy-writing"]);
  });

  it("does not treat project skills as installed when no project is open", () => {
    const profile = buildPresetAgentProfile("de-ai", [
      skill("humanizer-zh", "project"),
    ]);

    expect(profile.scope).toBe("user");
    expect(profile.skillIds).toEqual([]);
  });
});
