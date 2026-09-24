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
        {
          folder: "waypoint-bio",
          name: "Waypoint Bio",
          sourceUrl: "https://github.com/K-Dense-AI/scientific-agent-skills",
        },
        {
          folder: "lab-notes",
          name: "Lab notes",
          sourceUrl: "https://github.com/example/lab-notes",
        },
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
      ["category:lab-notes", "lab-notes"],
      ["category:mystery", "mystery"],
    ]);
    expect(
      groups
        .find((group) => group.id === "scientific-agent-skills")
        ?.items.map((item) => item.folder),
    ).toEqual(["scanpy", "waypoint-bio"]);
    expect(
      groups.find((group) => group.id === "category:mystery")?.items,
    ).toEqual([{ folder: "mystery", name: "Mystery" }]);
    expect(
      resolveSkillCategory(
        {
          folder: "literature-review",
          name: "Literature review",
          sourceUrl: "https://github.com/K-Dense-AI/scientific-agent-skills",
        },
        emptySkillCategorySnapshot(),
        catalog,
      ).id,
    ).toBe("scientific-agent-skills");
    expect(
      resolveSkillCategory(
        {
          folder: "scanpy",
          name: "Scanpy",
          sourceUrl: "https://github.com/example/scanpy",
        },
        emptySkillCategorySnapshot(),
        catalog,
      ),
    ).toEqual({
      id: "category:scanpy",
      name: "scanpy",
      source: "custom",
    });
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
      id: "category:writer",
      name: "writer",
      source: "custom",
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
      ["scientific-agent-skills", ["scanpy"]],
      ["category:my-writer", ["my-writer"]],
    ]);
  });

  it("uses the skill folder only after frontmatter, parent folder, and built-in packs", () => {
    const snapshot = emptySkillCategorySnapshot();

    expect(
      resolveSkillCategory(
        {
          folder: "editaplot",
          name: "EditaPlot",
          category: "Academic Writing",
        },
        snapshot,
        catalog,
      ),
    ).toEqual({
      id: "category:academic-writing",
      name: "Academic Writing",
      source: "custom",
    });

    expect(
      resolveSkillCategory(
        { folder: "editaplot", name: "EditaPlot", category: "写作" },
        snapshot,
        catalog,
      ),
    ).toEqual({
      id: "category:写作",
      name: "写作",
      source: "custom",
    });

    expect(
      resolveSkillCategory(
        { folder: "scanpy", name: "Scanpy", category: "写作" },
        snapshot,
        catalog,
      ).id,
    ).toBe("scientific-agent-skills");
    expect(
      resolveSkillCategory(
        {
          folder: "nature-new-skill",
          name: "Nature new skill",
          category: "Other",
        },
        snapshot,
        catalog,
      ).id,
    ).toBe("nature-skills");
    expect(
      resolveSkillCategory(
        { folder: "lab-helper", name: "literature-review" },
        snapshot,
        catalog,
      ).id,
    ).toBe("academic-research-skills");

    expect(
      resolveSkillCategory(
        { folder: "editaplot", name: "EditaPlot", category: null },
        snapshot,
        catalog,
      ),
    ).toEqual({
      id: "category:editaplot",
      name: "editaplot",
      source: "custom",
    });

    expect(
      resolveSkillCategory(
        { folder: "scanpy", name: "Scanpy" },
        snapshot,
        catalog,
      ).id,
    ).toBe("scientific-agent-skills");
    expect(
      resolveSkillCategory(
        { folder: "nature-polishing", name: "Nature polishing" },
        snapshot,
        catalog,
      ).id,
    ).toBe("nature-skills");
    expect(
      resolveSkillCategory(
        { folder: "paper-spine", name: "PaperSpine" },
        snapshot,
        catalog,
      ).id,
    ).toBe("paper-spine");
    expect(
      resolveSkillCategory(
        { folder: "deep-research", name: "Deep Research" },
        snapshot,
        catalog,
      ).id,
    ).toBe("academic-research-skills");
    expect(
      resolveSkillCategory(
        { folder: "paper-humanizer", name: "paper-humanizer" },
        snapshot,
        catalog,
      ).id,
    ).toBe("paper-humanizer-skill");

    expect(
      resolveSkillCategory({ folder: "  ", name: "Blank" }, snapshot, catalog)
        .id,
    ).toBe("imported");
  });

  it("reads slash skill folders and ignores corrupt storage", () => {
    expect(skillFolderFromSlashCommand("/scanpy")).toBe("scanpy");
    expect(parseSkillCategorySnapshot("{not json")).toEqual(
      emptySkillCategorySnapshot(),
    );
  });
});
