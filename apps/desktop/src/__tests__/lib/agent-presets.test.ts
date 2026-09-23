import { describe, expect, it } from "vitest";
import {
  ACADEMIC_POLISH_INSTRUCTIONS,
  BUILTIN_AGENT_PRESETS,
  DE_AI_INSTRUCTIONS,
  PEER_REVIEW_INSTRUCTIONS,
  BUILTIN_AGENT_PRESET_SEED_VERSION,
  BUILTIN_AGENT_SKILL_FOLDERS,
  buildPresetAgentProfile,
  builtinPresetContentUpdate,
  builtinPresetProfilesToSeed,
} from "@/lib/agent-presets";
import { emptyAgentProfile } from "@/stores/agent-store";
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
    expect(polish.name).toBe("论文抛光机");
    expect(polish.description).toContain("贴回 LaTeX");
    expect(polish.instructions).toBe(ACADEMIC_POLISH_INSTRUCTIONS);
    expect(polish.instructions).toContain(
      "You are an academic editor for LaTeX research papers",
    );
    expect(polish.instructions).toContain("Preserve LaTeX exactly");
    expect(polish.instructions).toContain("\\cite/\\citet/\\citep");
    expect(polish.instructions).toContain(
      "Do not fabricate citations, data, results, or references.",
    );
    expect(polish.instructions).toContain("What NOT to do");
    expect(polish.instructions).toContain("Output format");
    expect(polish.scope).toBe("user");
    expect(polish.skillIds).toEqual([]);
    expect(polish.runtime).toBe("claude");

    const deAi = buildPresetAgentProfile("de-ai", []);
    expect(deAi.id).toBe("de-ai");
    expect(deAi.name).toBe("AI消除器");
    expect(deAi.description).toContain("模板腔");
    expect(deAi.instructions).toBe(DE_AI_INSTRUCTIONS);
    expect(deAi.instructions).toContain("You humanize academic prose");
    expect(deAi.instructions).toContain("Do NOT: invent facts");
    expect(deAi.instructions).toContain("值得注意的是");
    expect(deAi.instructions).toContain("detector scores");
    expect(deAi.skillIds).toEqual([]);

    const review = buildPresetAgentProfile("peer-review", []);
    expect(review.id).toBe("peer-review");
    expect(review.name).toBe("毒舌审稿官");
    expect(review.description).toContain("苛刻审稿人");
    expect(BUILTIN_AGENT_PRESETS[2]?.titleSecondary).toBe("Review Duo");
    expect(review.instructions).toBe(PEER_REVIEW_INSTRUCTIONS);
    expect(review.instructions).toContain(
      "You are two harsh, independent reviewers plus the editor",
    );
    expect(review.instructions).toContain(
      "Do not rewrite the whole paper unless asked",
    );
    expect(review.instructions).toContain("Never invent papers or DOIs.");
    expect(review.instructions).toContain(
      "Do not check, add, or repair citations",
    );
    expect(review.instructions).toContain("What NOT to do");
    expect(BUILTIN_AGENT_PRESET_SEED_VERSION).toBe(3);
    expect(BUILTIN_AGENT_SKILL_FOLDERS["peer-review"].join(" ")).not.toMatch(
      /citation|zotero|bibtex|bib/,
    );
    expect(review.instructions).not.toContain(
      "flag missing/unused/inconsistent citations",
    );
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
        skill("cite-writing", "user", { name: "Cite Writing" }),
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

  it("does not treat lookalike names as de-ai skills", () => {
    const profile = buildPresetAgentProfile("de-ai", [
      skill("code-ai", "user"),
      skill("guide-ai", "user"),
      skill("upgrade-ai", "user"),
      skill("dehumanize", "user"),
      skill("de-ai-prose", "user"),
    ]);

    expect(profile.skillIds).toEqual(["de-ai-prose"]);
  });

  it("attaches shipped writing, polish, and review skills without citation tools", () => {
    const installed = [
      skill("nature-polishing", "user"),
      skill("nature-writing", "user"),
      skill("academic-paper", "user"),
      skill("academic-paper-reviewer", "user"),
      skill("peer-review", "user"),
      skill("nature-reader", "user"),
      skill("nature-citation", "user"),
      skill("reference-checker", "user"),
      skill("zotero-cite", "user"),
      skill("bibtex-check", "user"),
    ];

    expect(
      buildPresetAgentProfile("academic-polish", installed).skillIds,
    ).toEqual(["nature-polishing", "nature-writing", "academic-paper"]);
    expect(buildPresetAgentProfile("de-ai", installed).skillIds).toEqual([
      "nature-polishing",
    ]);
    expect(buildPresetAgentProfile("peer-review", installed).skillIds).toEqual([
      "academic-paper-reviewer",
      "peer-review",
      "nature-reader",
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

  it("seeds the three missing user presets and skips ids that already exist", () => {
    const skills = [
      skill("academic-polish", "user"),
      skill("writing-clarity", "user", { name: "Writing Clarity" }),
      skill("humanizer-academic", "user"),
      skill("citation-check", "user", { name: "Citation Check" }),
      skill("zotero-cite", "user"),
      skill("bibtex-check", "user"),
      skill("latex-guard", "project"),
    ];
    const profiles = builtinPresetProfilesToSeed(
      [
        {
          id: "academic-polish",
          scope: "user",
        },
        {
          id: "peer-review",
          scope: "project",
        },
      ],
      skills,
    );

    expect(profiles.map((profile) => profile.id)).toEqual([
      "de-ai",
      "peer-review",
    ]);
    expect(profiles.every((profile) => profile.scope === "user")).toBe(true);
    expect(
      profiles.find((profile) => profile.id === "de-ai")?.skillIds,
    ).toEqual(["humanizer-academic"]);
    const review = profiles.find((profile) => profile.id === "peer-review");
    expect(review?.skillIds).toEqual([]);
    expect(review?.instructions).toBe(PEER_REVIEW_INSTRUCTIONS);
    expect(review?.instructions).toContain(
      "Do not check, add, or repair citations",
    );
    expect(
      profiles.flatMap((profile) => profile.skillIds).join(" "),
    ).not.toMatch(/citation|zotero|bibtex/);
  });

  it("seeds all three presets when the agent list is empty", () => {
    expect(
      builtinPresetProfilesToSeed([], []).map((profile) => profile.id),
    ).toEqual(["academic-polish", "de-ai", "peer-review"]);
  });

  it("refreshes builtin copy without touching skill toggles or custom agents", () => {
    const polish = {
      ...emptyAgentProfile("claude", "user"),
      id: "academic-polish",
      name: "润色",
      description: "old",
      instructions: "old prompt",
      skillIds: ["writer", "my-toggle"],
      model: "opus",
    };
    const custom = {
      ...emptyAgentProfile("claude", "user"),
      id: "reviewer",
      name: "Reviewer",
      skillIds: ["keep-me"],
    };
    const projectCopy = {
      ...polish,
      scope: "project" as const,
      name: "项目里的抛光",
    };

    const updated = builtinPresetContentUpdate(polish, [
      skill("academic-polish", "user"),
      skill("nature-writing", "user"),
      skill("zotero-cite", "user"),
      skill("my-toggle", "user", { name: "My Toggle" }),
    ]);
    expect(updated?.name).toBe("论文抛光机");
    expect(updated?.description).toContain("贴回 LaTeX");
    expect(updated?.instructions).toBe(ACADEMIC_POLISH_INSTRUCTIONS);
    expect(updated?.skillIds).toEqual(["academic-polish", "nature-writing"]);
    expect(updated?.model).toBe("opus");
    expect(builtinPresetContentUpdate(custom, [])).toBeNull();
    expect(builtinPresetContentUpdate(projectCopy, [])).toBeNull();
    expect(
      builtinPresetContentUpdate(updated!, [
        skill("academic-polish", "user"),
        skill("nature-writing", "user"),
      ]),
    ).toBeNull();
  });
});
