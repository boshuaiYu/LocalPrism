import { describe, expect, it } from "vitest";
import {
  isPaperSpineSkill,
  isPaperSpineSlashCommand,
  PAPERSPINE_SKILLS_URL,
} from "@/lib/paperspine";

describe("PaperSpine skill detection", () => {
  it("points at the Claude skill folder in the PaperSpine repo", () => {
    expect(PAPERSPINE_SKILLS_URL).toContain("WUBING2023/PaperSpine");
    expect(PAPERSPINE_SKILLS_URL).toContain("dist/claude/skills");
  });

  it("recognizes PaperSpine folders and names", () => {
    expect(
      isPaperSpineSkill({ folder: "paper-spine", name: "Paper writing" }),
    ).toBe(true);
    expect(
      isPaperSpineSkill({ folder: "writer", name: "PaperSpine academic" }),
    ).toBe(true);
    expect(isPaperSpineSkill({ folder: "scanpy", name: "Scanpy" })).toBe(false);
  });

  it("recognizes PaperSpine slash invocations", () => {
    expect(isPaperSpineSlashCommand("/paper-spine")).toBe(true);
    expect(isPaperSpineSlashCommand("paper-spine-intake")).toBe(true);
    expect(isPaperSpineSlashCommand("/scanpy")).toBe(false);
  });
});
