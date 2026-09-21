import { describe, expect, it } from "vitest";
import { emptySkillCategorySnapshot } from "@/lib/skill-categories";
import {
  buildSkillsBrowserCategories,
  installedBrowserCategoryId,
  packIdFromBrowserCategoryId,
} from "@/lib/skills-browser";

describe("buildSkillsBrowserCategories", () => {
  it("lists default packs by project name and drops old user/catalog groups", () => {
    const categories = buildSkillsBrowserCategories({
      installedSkills: [
        { folder: "paper-spine", name: "PaperSpine" },
        { folder: "deep-research", name: "Deep Research" },
        { folder: "nature-polishing", name: "Nature polishing" },
        { folder: "scanpy", name: "Scanpy" },
        { folder: "my-writer", name: "Writer" },
      ],
      snapshot: {
        ...emptySkillCategorySnapshot(),
        categories: [
          { id: "writing", name: "Writing" },
          { id: "custom", name: "Custom" },
          { id: "testo", name: "testo" },
        ],
        assignments: { "my-writer": "writing" },
      },
      catalog: [
        {
          id: "bioinformatics",
          name: "Bioinformatics",
          icon: "dna",
          skill_count: 1,
          skills: [{ folder: "scanpy", name: "Scanpy" }],
        },
      ],
    });

    expect(categories.map((category) => category.id)).toEqual([
      installedBrowserCategoryId("paper-spine"),
      installedBrowserCategoryId("academic-research-skills"),
      installedBrowserCategoryId("nature-skills"),
      installedBrowserCategoryId("scientific-agent-skills"),
    ]);
    expect(categories.map((category) => category.name)).toEqual([
      "PaperSpine",
      "academic-research-skills",
      "nature-skills",
      "scientific-agent-skills",
    ]);
    expect(categories.map((category) => category.sourceUrl)).toEqual([
      "https://github.com/WUBING2023/PaperSpine/tree/main/dist/claude/skills",
      "https://github.com/Imbad0202/academic-research-skills",
      "https://github.com/Yuan1z0825/nature-skills/tree/main/skills",
      "https://github.com/K-Dense-AI/scientific-agent-skills/tree/main/skills",
    ]);
    expect(
      categories.some((category) => category.id.endsWith("imported")),
    ).toBe(false);
    expect(
      categories.flatMap((category) =>
        category.skills.map((skill) => skill.folder),
      ),
    ).not.toContain("my-writer");
    expect(
      categories.some((category) =>
        ["Writing", "Custom", "testo", "Bioinformatics"].includes(
          category.name,
        ),
      ),
    ).toBe(false);
    expect(
      packIdFromBrowserCategoryId(installedBrowserCategoryId("paper-spine")),
    ).toBe("paper-spine");
  });
});
