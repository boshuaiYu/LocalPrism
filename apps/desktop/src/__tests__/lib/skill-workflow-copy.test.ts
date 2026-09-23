import { describe, expect, it } from "vitest";
import { skillPackDisplayName } from "@/lib/default-skill-packs";
import { skillPaperWorkflowGuidance } from "@/lib/skill-workflow-copy";

describe("skillPaperWorkflowGuidance", () => {
  it("explains that real default packs help paper workflows", () => {
    const text = skillPaperWorkflowGuidance();

    expect(text.toLowerCase()).toContain("paper");
    expect(text).toContain(skillPackDisplayName("paper-spine"));
    expect(text).toContain(skillPackDisplayName("academic-research-skills"));
    expect(text).toContain(skillPackDisplayName("nature-skills"));
    expect(text).toContain(skillPackDisplayName("scientific-agent-skills"));
    expect(text).toMatch(/PaperSpine/);
  });
});
