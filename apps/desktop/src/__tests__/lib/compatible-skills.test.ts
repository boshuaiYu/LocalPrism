import { describe, expect, it } from "vitest";
import {
  isFatalSkillDiscoveryError,
  skillAssignmentId,
  skillMatchesAssignmentId,
  skillsCompatibleWith,
} from "@/lib/compatible-skills";
import type { RuntimeSkill } from "@/runtime/types";

function skill(overrides: Partial<RuntimeSkill> = {}): RuntimeSkill {
  return {
    id: "claude:user:writer",
    name: "Writer",
    description: "Writes prose",
    folder: "writer",
    sourcePath: "C:/skills/writer",
    targets: [{ runtime: "claude", scope: "user" }],
    managed: true,
    compatibleRuntimes: ["claude", "codex"],
    enabled: true,
    discoveryError: null,
    ...overrides,
  };
}

describe("compatible skills for agent assignment", () => {
  it("keeps only skills with a matching runtime/scope destination", () => {
    const catalog = [
      skill(),
      skill({
        id: "codex:user:writer",
        targets: [{ runtime: "codex", scope: "user" }],
      }),
      skill({
        id: "claude:project:lint",
        folder: "lint",
        name: "Lint",
        targets: [{ runtime: "claude", scope: "project" }],
      }),
      skill({
        id: "claude:user:broken",
        folder: "broken",
        discoveryError: "missing SKILL.md",
      }),
    ];

    expect(
      skillsCompatibleWith(catalog, "claude", "user").map((item) => item.id),
    ).toEqual(["claude:user:writer"]);
    expect(
      skillsCompatibleWith(catalog, "codex", "user").map((item) => item.id),
    ).toEqual([]);
    expect(
      skillsCompatibleWith(catalog, "claude", "project").map((item) => item.id),
    ).toEqual(["claude:project:lint"]);
  });

  it("still lists legacy Claude skills that only have a compatibility note", () => {
    const catalog = [
      skill({
        id: "claude:user:legacy",
        folder: "legacy",
        name: "Legacy",
        discoveryError:
          "Legacy Claude skill is missing a standard description and can only target Claude.",
      }),
      skill({
        id: "claude:user:legacy-name",
        folder: "legacy-name",
        name: "Legacy Name",
        discoveryError:
          "Legacy Claude skill is missing a standard name frontmatter field and can only target Claude.",
      }),
    ];
    expect(
      skillsCompatibleWith(catalog, "claude", "user").map(
        (item) => item.folder,
      ),
    ).toEqual(["legacy", "legacy-name"]);
    expect(
      isFatalSkillDiscoveryError(
        "Legacy Claude skill is missing a standard name frontmatter field and can only target Claude.",
      ),
    ).toBe(false);
  });

  it("matches assignment ids by folder or stable id, not display name", () => {
    const item = skill({ name: "Writer", folder: "writer" });
    expect(skillMatchesAssignmentId(item, "writer")).toBe(true);
    expect(skillMatchesAssignmentId(item, "claude:user:writer")).toBe(true);
    expect(skillMatchesAssignmentId(item, "Writer")).toBe(false);
  });

  it("uses the native folder name for assignment persistence", () => {
    expect(skillAssignmentId(skill())).toBe("writer");
    expect(
      skillAssignmentId(
        skill({ folder: "", id: "claude:user:legacy", name: "Legacy" }),
      ),
    ).toBe("claude:user:legacy");
  });
});
