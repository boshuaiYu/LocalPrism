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
    expect(polish.description).toContain("你是一个学术 LaTeX 文本润色的智能体");
    expect(polish.description).toContain("你主要负责");
    expect(polish.description).toContain("nature-polishing");
    expect(polish.instructions).toBe(ACADEMIC_POLISH_INSTRUCTIONS);
    expect(polish.instructions).toContain(
      "你是一个学术 LaTeX 论文润色的智能体",
    );
    expect(polish.instructions).toContain("原样保留 LaTeX");
    expect(polish.instructions).toContain("\\cite/\\citet/\\citep");
    expect(polish.instructions).toContain("不编造引用、数据、结果或参考文献。");
    expect(polish.instructions).toContain("不使用引用、BibTeX 或 Zotero");
    expect(polish.instructions).toContain("可直接粘贴的修订文本");
    expect(polish.scope).toBe("user");
    expect(polish.skillIds).toEqual([]);
    expect(polish.runtime).toBe("claude");

    const deAi = buildPresetAgentProfile("de-ai", []);
    expect(deAi.id).toBe("de-ai");
    expect(deAi.name).toBe("AI消除器");
    expect(deAi.description).toContain("你是一个学术文本去模板化的智能体");
    expect(deAi.description).toContain("paper-humanizer");
    expect(deAi.instructions).toBe(DE_AI_INSTRUCTIONS);
    expect(deAi.instructions).toContain("你是一个学术文本去模板化的智能体");
    expect(deAi.instructions).toContain("不编造事实");
    expect(deAi.instructions).toContain("值得注意的是");
    expect(deAi.instructions).toContain("不报告检测分数");
    expect(deAi.instructions).toContain("paper-humanizer");
    expect(deAi.instructions).toContain("不使用 nature-polishing");
    expect(BUILTIN_AGENT_SKILL_FOLDERS["de-ai"]).toEqual([
      "paper-humanizer",
      "paper-humanizer-skill",
    ]);
    expect(deAi.skillIds).toEqual([]);

    const review = buildPresetAgentProfile("peer-review", []);
    expect(review.id).toBe("peer-review");
    expect(review.name).toBe("毒舌审稿官");
    expect(review.description).toContain("你是一个论文审稿的智能体");
    expect(review.description).toContain("可执行");
    expect(review.description).not.toContain("挨顿");
    expect(BUILTIN_AGENT_PRESETS[2]?.titleSecondary).toBe("Review Duo");
    expect(review.instructions).toBe(PEER_REVIEW_INSTRUCTIONS);
    expect(review.instructions).toContain("你是一个论文审稿的智能体");
    expect(review.instructions).toContain("除非用户要求，否则不改写论文。");
    expect(review.instructions).toContain("不编造论文或 DOI。");
    expect(review.instructions).toContain(
      "不检查、不添加、不修复引用、BibTeX 或 Zotero。",
    );
    expect(review.instructions).toContain("严谨、公正");
    expect(review.instructions).not.toMatch(/harsh|fatal|savage|毒舌/);
    expect(BUILTIN_AGENT_PRESET_SEED_VERSION).toBe(6);
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

  it("attaches paper-humanizer to AI消除器 and not to polish or peer review", () => {
    const installed = [
      skill("paper-humanizer", "user"),
      skill("paper-humanizer-skill", "user", { name: "paper-humanizer-skill" }),
      skill("nature-polishing", "user"),
      skill("nature-citation", "user"),
      skill("zotero-cite", "user"),
    ];

    expect(buildPresetAgentProfile("de-ai", installed).skillIds).toEqual([
      "paper-humanizer",
      "paper-humanizer-skill",
    ]);
    expect(
      buildPresetAgentProfile("academic-polish", installed).skillIds,
    ).toEqual(["nature-polishing"]);
    expect(buildPresetAgentProfile("peer-review", installed).skillIds).toEqual(
      [],
    );
  });

  it("attaches shipped writing, polish, and review skills without citation tools", () => {
    const installed = [
      skill("nature-polishing", "user"),
      skill("nature-writing", "user"),
      skill("academic-paper", "user"),
      skill("academic-paper-reviewer", "user"),
      skill("peer-review", "user"),
      skill("nature-reader", "user"),
      skill("paper-humanizer", "user"),
      skill("paper-humanizer-skill", "user"),
      skill("nature-citation", "user"),
      skill("reference-checker", "user"),
      skill("zotero-cite", "user"),
      skill("bibtex-check", "user"),
    ];

    expect(
      buildPresetAgentProfile("academic-polish", installed).skillIds,
    ).toEqual(["nature-polishing", "nature-writing", "academic-paper"]);
    expect(buildPresetAgentProfile("de-ai", installed).skillIds).toEqual([
      "paper-humanizer",
      "paper-humanizer-skill",
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
      "不检查、不添加、不修复引用、BibTeX 或 Zotero。",
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
    expect(updated?.description).toContain(
      "你是一个学术 LaTeX 文本润色的智能体",
    );
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
