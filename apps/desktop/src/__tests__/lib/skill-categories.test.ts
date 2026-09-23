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
    ]);
    expect(groups.some((group) => group.id === "imported")).toBe(false);
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
      name: "Imported",
      source: "imported",
    });
  });

  it("reads slash skill folders and ignores corrupt storage", () => {
    expect(skillFolderFromSlashCommand("/scanpy")).toBe("scanpy");
    expect(parseSkillCategorySnapshot("{not json")).toEqual(
      emptySkillCategorySnapshot(),
    );
  });
});
