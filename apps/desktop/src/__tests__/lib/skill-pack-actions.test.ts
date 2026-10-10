import { describe, expect, it } from "vitest";
import {
  packUpdateRowOpen,
  packUpdateSummary,
  withPackListName,
  type SkillPackUpdateReport,
} from "@/lib/skill-pack-actions";

function report(
  overrides: Partial<SkillPackUpdateReport> = {},
): SkillPackUpdateReport {
  return {
    id: "nature-skills",
    name: "nature-skills",
    added: [],
    updated: [],
    removed: [],
    unchanged: [],
    ...overrides,
  };
}

describe("pack update result rows", () => {
  it("summarizes added, updated, and removed counts", () => {
    expect(
      packUpdateSummary(
        report({
          added: ["nature-polishing"],
          updated: ["nature-figure", "nature-writing", "nature-citation"],
          removed: [],
          unchanged: ["nature-data"],
        }),
      ),
    ).toEqual({
      kind: "counts",
      name: "nature-skills",
      added: 1,
      updated: 3,
      removed: 0,
    });
  });

  it("treats a pack with no adds, updates, or removals as already current", () => {
    expect(
      packUpdateSummary(report({ unchanged: ["nature-polishing"] })),
    ).toEqual({
      kind: "latest",
      name: "nature-skills",
    });
  });

  it("keeps a failure as the pack name and error", () => {
    expect(
      packUpdateSummary(
        report({
          added: ["nature-polishing"],
          error: "network down",
        }),
      ),
    ).toEqual({
      kind: "error",
      name: "nature-skills",
      error: "network down",
    });
  });

  it("uses the pack list name when a refresh report lowercases it", () => {
    expect(
      withPackListName(
        report({ id: "paper-spine", name: "paperspine" }),
        "PaperSpine",
      ).name,
    ).toBe("PaperSpine");
    expect(withPackListName(report({ name: "skills" }), "  ").name).toBe(
      "skills",
    );
  });

  it("expands a single pack and a failed pack, and collapses many packs", () => {
    const current = report();
    const failed = report({ error: "network down" });
    expect(packUpdateRowOpen(1, current)).toBe(true);
    expect(packUpdateRowOpen(4, current)).toBe(false);
    expect(packUpdateRowOpen(4, failed)).toBe(true);
    expect(packUpdateRowOpen(1, failed)).toBe(true);
  });
});
