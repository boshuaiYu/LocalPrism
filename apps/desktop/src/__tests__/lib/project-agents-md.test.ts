import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENTS_MD,
  decideAgentsMdWrite,
} from "@/lib/project-agents-md";

describe("project AGENTS.md onboarding", () => {
  it("uses the planned Codex bootstrap content", () => {
    expect(DEFAULT_AGENTS_MD).toContain("# Project Instructions");
    expect(DEFAULT_AGENTS_MD).toContain(
      "Preserve existing LaTeX structure and verify generated outputs",
    );
  });

  it("does not write when Codex is disabled (Claude-only)", () => {
    expect(
      decideAgentsMdWrite({ enableCodex: false, agentsMdExists: false }),
    ).toEqual({ shouldWrite: false, reason: "disabled" });
  });

  it("writes when Codex is enabled and AGENTS.md is missing", () => {
    expect(
      decideAgentsMdWrite({ enableCodex: true, agentsMdExists: false }),
    ).toEqual({ shouldWrite: true, reason: "created" });
  });

  it("never overwrites an existing AGENTS.md", () => {
    expect(
      decideAgentsMdWrite({ enableCodex: true, agentsMdExists: true }),
    ).toEqual({ shouldWrite: false, reason: "exists" });
  });

  it("treats enabling Codex later the same as wizard enablement", () => {
    // Later enablement still only writes when the file is absent.
    expect(
      decideAgentsMdWrite({ enableCodex: true, agentsMdExists: false }),
    ).toEqual({ shouldWrite: true, reason: "created" });
    expect(
      decideAgentsMdWrite({ enableCodex: true, agentsMdExists: true }),
    ).toEqual({ shouldWrite: false, reason: "exists" });
  });
});
