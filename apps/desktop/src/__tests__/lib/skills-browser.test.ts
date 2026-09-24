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
        {
          folder: "methods-notes",
          name: "Methods notes",
          category: "Methods",
        },
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

    expect(categories.slice(0, 5).map((category) => category.id)).toEqual([
      installedBrowserCategoryId("paper-spine"),
      installedBrowserCategoryId("academic-research-skills"),
      installedBrowserCategoryId("nature-skills"),
      installedBrowserCategoryId("scientific-agent-skills"),
      installedBrowserCategoryId("paper-humanizer-skill"),
    ]);
    expect(categories.slice(0, 5).map((category) => category.name)).toEqual([
      "PaperSpine",
      "academic-research-skills",
      "nature-skills",
      "scientific-agent-skills",
      "paper-humanizer-skill",
    ]);
    expect(categories.slice(5).map((category) => category.name)).toEqual([
      "Methods",
      "my-writer",
    ]);
    expect(
      categories.slice(0, 5).map((category) => category.sourceUrl),
    ).toEqual([
      "https://github.com/WUBING2023/PaperSpine/tree/main/dist/claude/skills",
      "https://github.com/Imbad0202/academic-research-skills",
      "https://github.com/Yuan1z0825/nature-skills/tree/main/skills",
      "https://github.com/K-Dense-AI/scientific-agent-skills/tree/main/skills",
      "https://github.com/crabin/paper-humanizer-skill",
    ]);
    expect(
      categories
        .find((category) => category.name === "Methods")
        ?.skills.map((skill) => skill.folder),
    ).toEqual(["methods-notes"]);
    expect(
      categories.find((category) => category.name === "my-writer")?.skills,
    ).toEqual([{ name: "Writer", folder: "my-writer", category: undefined }]);
    expect(
      categories.find((category) => category.name === "Uncategorized"),
    ).toBeUndefined();
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

  it("keeps scientific-pack imports in one pack and other URLs in a new category", () => {
    const categories = buildSkillsBrowserCategories({
      installedSkills: [
        {
          folder: "waypoint-bio",
          name: "Waypoint Bio",
          sourceUrl: "https://github.com/K-Dense-AI/scientific-agent-skills",
        },
        {
          folder: "docx",
          name: "Docx",
          sourceUrl:
            "https://github.com/K-Dense-AI/claude-scientific-skills/tree/main/skills/docx",
        },
        {
          folder: "lab-notes",
          name: "Lab notes",
          sourceUrl: "https://github.com/example/lab-notes",
        },
      ],
      catalog: [],
    });

    expect(
      categories
        .find((category) => category.name === "scientific-agent-skills")
        ?.skills.map((skill) => skill.folder),
    ).toEqual(["waypoint-bio", "docx"]);
    expect(
      categories
        .find((category) => category.name === "lab-notes")
        ?.skills.map((skill) => skill.folder),
    ).toEqual(["lab-notes"]);
  });
});
