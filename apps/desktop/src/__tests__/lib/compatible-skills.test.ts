import { describe, expect, it } from "vitest";
import {
  skillAssignmentId,
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
    ).toEqual(["codex:user:writer"]);
    expect(
      skillsCompatibleWith(catalog, "claude", "project").map((item) => item.id),
    ).toEqual(["claude:project:lint"]);
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
