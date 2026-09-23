import { describe, expect, it } from "vitest";
import {
  assignSkillFolders,
  emptySkillCategorySnapshot,
  groupItemsBySkillCategory,
  parseSkillCategorySnapshot,
  resolveSkillCategory,
  skillFolderFromSlashCommand,
  upsertUserCategory,
} from "@/lib/skill-categories";

const catalog = [
  {
    id: "bioinformatics",
    name: "Bioinformatics & Genomics",
    skills: [{ folder: "scanpy" }],
  },
];

describe("skill categories", () => {
  it("does not keep Writing or Custom as default groups", () => {
    expect(emptySkillCategorySnapshot().categories).toEqual([]);
  });

  it("groups installed skills by default pack name", () => {
    const groups = groupItemsBySkillCategory(
      [
        { folder: "paper-spine", name: "PaperSpine" },
        { folder: "scanpy", name: "Scanpy" },
        { folder: "deep-research", name: "Deep Research" },
        { folder: "nature-polishing", name: "Nature polishing" },
        { folder: "paper-humanizer", name: "paper-humanizer" },
        { folder: "mystery", name: "Mystery" },
      ],
      (item) => item,
      emptySkillCategorySnapshot(),
      catalog,
    );

    expect(groups.map((group) => [group.id, group.name])).toEqual([
      ["paper-spine", "PaperSpine"],
      ["academic-research-skills", "academic-research-skills"],
      ["nature-skills", "nature-skills"],
      ["scientific-agent-skills", "scientific-agent-skills"],
      ["paper-humanizer-skill", "paper-humanizer-skill"],
      ["imported", "Uncategorized"],
    ]);
    expect(groups.find((group) => group.id === "imported")?.items).toEqual([
      { folder: "mystery", name: "Mystery" },
    ]);
    expect(
      resolveSkillCategory(
        { folder: "scanpy", name: "Scanpy" },
        emptySkillCategorySnapshot(),
        catalog,
      ),
    ).toEqual({
      id: "scientific-agent-skills",
      name: "scientific-agent-skills",
      source: "scientific-agent-skills",
    });
  });

  it("ignores leftover user categories such as testo", () => {
    const created = upsertUserCategory(emptySkillCategorySnapshot(), "testo");
    const assigned = assignSkillFolders(
      created!.snapshot,
      ["writer"],
      created!.category.id,
    );
    expect(
      resolveSkillCategory(
        { folder: "writer", name: "Writer" },
        assigned,
        catalog,
      ),
    ).toEqual({
      id: "imported",
      name: "Uncategorized",
      source: "imported",
    });
  });

  it("groups frontmatter and folder categories, and keeps unknown skills visible", () => {
    const groups = groupItemsBySkillCategory(
      [
        { folder: "scanpy", name: "Scanpy", category: "Bioinformatics" },
        {
          folder: "nature-polishing",
          name: "Polish",
          category: "nature-skills",
        },
        { folder: "my-writer", name: "Writer", category: null },
      ],
      (item) => item,
      emptySkillCategorySnapshot(),
      catalog,
    );

    expect(
      groups.map((group) => [group.id, group.items.map((item) => item.folder)]),
    ).toEqual([
      ["nature-skills", ["nature-polishing"]],
      ["category:bioinformatics", ["scanpy"]],
      ["imported", ["my-writer"]],
    ]);
    expect(
      groups.find((group) => group.id === "category:bioinformatics")?.name,
    ).toBe("Bioinformatics");
  });

  it("reads slash skill folders and ignores corrupt storage", () => {
    expect(skillFolderFromSlashCommand("/scanpy")).toBe("scanpy");
    expect(parseSkillCategorySnapshot("{not json")).toEqual(
      emptySkillCategorySnapshot(),
    );
  });
});
