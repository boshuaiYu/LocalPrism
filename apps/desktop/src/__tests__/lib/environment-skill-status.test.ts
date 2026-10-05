import { describe, expect, it } from "vitest";
import {
  environmentSkillInline,
  environmentSkillProblem,
  environmentSkillShowRetry,
} from "@/lib/environment-skill-status";

describe("environment skill status", () => {
  it("shows a retry when some skills exist but a pack download failed", () => {
    const problem = environmentSkillProblem(
      null,
      "Could not download skills from https://github.com/example\nsecond pack failed",
    );
    expect(problem).toContain("Could not download");
    expect(environmentSkillShowRetry(true, problem)).toBe(true);
    expect(environmentSkillInline(problem ?? "")).toBe(
      "Could not download skills from https://github.com/example",
    );
    const long = "x".repeat(90);
    const inline = environmentSkillInline(long);
    expect(inline.endsWith("…")).toBe(true);
    expect(inline.length).toBeLessThanOrEqual(72);
  });

  it("hides retry once skills are installed and nothing failed", () => {
    expect(environmentSkillProblem(null, null)).toBeNull();
    expect(environmentSkillShowRetry(true, null)).toBe(false);
    expect(environmentSkillShowRetry(false, null)).toBe(true);
  });
});
