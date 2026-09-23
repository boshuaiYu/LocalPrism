import { describe, expect, it } from "vitest";
import {
  ACADEMIC_RESEARCH_SKILLS_URL,
  areDefaultSkillPacksReady,
  DEFAULT_SKILL_PACKS,
  NATURE_SKILLS_URL,
  isDefaultPackSkill,
  resolveSkillPackId,
  SCIENTIFIC_AGENT_SKILLS_URL,
  githubRepoLabel,
  skillGithubUrl,
  shouldInstallDefaultPack,
} from "@/lib/default-skill-packs";
import { PAPERSPINE_SKILLS_URL } from "@/lib/paperspine";

describe("default skill packs", () => {
  it("points at the public GitHub sources used by onboarding", () => {
    const byId = Object.fromEntries(
      DEFAULT_SKILL_PACKS.map((pack) => [pack.id, pack]),
    );
    expect(byId["academic-research-skills"]?.sourceUrl).toBe(
      ACADEMIC_RESEARCH_SKILLS_URL,
    );
    expect(ACADEMIC_RESEARCH_SKILLS_URL).toContain(
      "Imbad0202/academic-research-skills",
    );
    expect(byId["nature-skills"]?.sourceUrl).toBe(NATURE_SKILLS_URL);
    expect(NATURE_SKILLS_URL).toContain("Yuan1z0825/nature-skills");
    expect(NATURE_SKILLS_URL).toContain("tree/main/skills");
    expect(byId["scientific-agent-skills"]?.sourceUrl).toBe(
      SCIENTIFIC_AGENT_SKILLS_URL,
    );
    expect(SCIENTIFIC_AGENT_SKILLS_URL).toContain(
      "K-Dense-AI/scientific-agent-skills",
    );
    expect(byId["paper-spine"]?.sourceUrl).toContain("WUBING2023/PaperSpine");
    expect(byId["scientific-agent-skills"]?.sourceUrl).toContain(
      "K-Dense-AI/scientific-agent-skills",
    );
    expect(githubRepoLabel(PAPERSPINE_SKILLS_URL)).toBe(
      "WUBING2023/PaperSpine",
    );
    expect(skillGithubUrl(PAPERSPINE_SKILLS_URL)).toBe(
      "https://github.com/WUBING2023/PaperSpine",
    );
    expect(skillGithubUrl(PAPERSPINE_SKILLS_URL, "paper-spine")).toBe(
      "https://github.com/WUBING2023/PaperSpine/tree/main/dist/claude/skills/paper-spine",
    );
    expect(skillGithubUrl(ACADEMIC_RESEARCH_SKILLS_URL, "deep-research")).toBe(
      "https://github.com/Imbad0202/academic-research-skills/tree/main/deep-research",
    );
    expect(skillGithubUrl(NATURE_SKILLS_URL, "nature-polishing")).toBe(
      "https://github.com/Yuan1z0825/nature-skills/tree/main/skills/nature-polishing",
    );
    expect(
      skillGithubUrl(
        "https://github.com/K-Dense-AI/scientific-agent-skills/tree/main/skills",
        "scanpy",
      ),
    ).toBe(
      "https://github.com/K-Dense-AI/scientific-agent-skills/tree/main/skills/scanpy",
    );
  });

  it("skips a pack when a marker skill is already present", () => {
    const academic = DEFAULT_SKILL_PACKS.find(
      (pack) => pack.id === "academic-research-skills",
    )!;
    expect(
      shouldInstallDefaultPack(
        [{ folder: "deep-research" }],
        [{ id: "research_architect_agent" }],
        academic,
        [
          { name: "ars-plan", full_command: "/ars-plan", scope: "user" },
          {
            name: "ars-lit-review",
            full_command: "/ars-lit-review",
            scope: "user",
          },
        ],
      ),
    ).toBe(false);
  });

  it("does not reimport academic-research-skills just because pack agents are hidden", () => {
    const academic = DEFAULT_SKILL_PACKS.find(
      (pack) => pack.id === "academic-research-skills",
    )!;
    expect(
      shouldInstallDefaultPack([{ folder: "academic-paper" }], [], academic, [
        { name: "ars-plan", full_command: "/ars-plan", scope: "user" },
        {
          name: "ars-lit-review",
          full_command: "/ars-lit-review",
          scope: "user",
        },
      ]),
    ).toBe(false);
  });

  it("reimports a pack when official slash commands are still missing", () => {
    const academic = DEFAULT_SKILL_PACKS.find(
      (pack) => pack.id === "academic-research-skills",
    )!;
    const paper = DEFAULT_SKILL_PACKS.find(
      (pack) => pack.id === "paper-spine",
    )!;
    expect(
      shouldInstallDefaultPack(
        [{ folder: "academic-paper" }],
        [],
        academic,
        [],
      ),
    ).toBe(true);
    expect(
      shouldInstallDefaultPack([{ folder: "paper-spine" }], [], paper, [
        { name: "paperspine", full_command: "/paperspine", scope: "user" },
      ]),
    ).toBe(false);
    expect(
      shouldInstallDefaultPack([{ folder: "paperspine" }], [], paper, [
        {
          name: "PaperSpine",
          full_command: "/paperspine",
          scope: "skill",
        },
      ]),
    ).toBe(true);
    expect(
      shouldInstallDefaultPack(
        [{ folder: "academic-paper" }],
        [],
        academic,
        [{ name: "ars-plan", full_command: "/ars-plan", scope: "user" }],
        false,
      ),
    ).toBe(false);
  });

  it("does not treat PaperSpine alone as a scientific pack", () => {
    const scientific = DEFAULT_SKILL_PACKS.find(
      (pack) => pack.id === "scientific-agent-skills",
    )!;
    expect(
      shouldInstallDefaultPack([{ folder: "paper-spine" }], [], scientific),
    ).toBe(true);
    expect(
      shouldInstallDefaultPack([{ folder: "scanpy" }], [], scientific),
    ).toBe(false);
  });

  it("is ready only when PaperSpine and the three default packs are present", () => {
    expect(resolveSkillPackId({ folder: "paper-spine" })).toBe("paper-spine");
    expect(resolveSkillPackId({ folder: "deep-research" })).toBe(
      "academic-research-skills",
    );
    expect(resolveSkillPackId({ folder: "nature-figure" })).toBe(
      "nature-skills",
    );
    expect(resolveSkillPackId({ folder: "scanpy" }, new Set(["scanpy"]))).toBe(
      "scientific-agent-skills",
    );
    expect(resolveSkillPackId({ folder: "paper-humanizer" })).toBe(
      "paper-humanizer-skill",
    );
    expect(resolveSkillPackId({ folder: "paper-humanizer-skill" })).toBe(
      "paper-humanizer-skill",
    );
    expect(resolveSkillPackId({ folder: "my-writer" })).toBe("imported");
    expect(
      resolveSkillPackId({ folder: "lab-helper", name: "nature-figure" }),
    ).toBe("nature-skills");
    expect(
      resolveSkillPackId(
        { folder: "notes", name: "Scanpy" },
        new Set(["scanpy"]),
      ),
    ).toBe("scientific-agent-skills");
    expect(isDefaultPackSkill({ folder: "my-writer" })).toBe(false);
    expect(isDefaultPackSkill({ folder: "scanpy" }, new Set(["scanpy"]))).toBe(
      true,
    );
    expect(areDefaultSkillPacksReady([], [])).toBe(false);
    expect(
      areDefaultSkillPacksReady(
        [
          { folder: "paper-spine" },
          { folder: "deep-research" },
          { folder: "nature-polishing" },
          { folder: "scanpy" },
          { folder: "paper-humanizer" },
        ],
        [],
      ),
    ).toBe(true);
  });
});
