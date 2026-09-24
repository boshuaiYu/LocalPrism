import { describe, expect, it } from "vitest";
import { PEER_REVIEW_INSTRUCTIONS } from "@/lib/agent-presets";
import {
  agentFlashAttribute,
  applyReplyStyleToPrompt,
  replyModeForAgent,
  replyStylePrefix,
  shouldFlashPresetAgentSwitch,
} from "@/lib/reply-mode";

describe("replyModeForAgent", () => {
  it("maps each built-in preset to its speaking style", () => {
    expect(replyModeForAgent("academic-polish")).toBe("academic-polish");
    expect(replyModeForAgent("de-ai")).toBe("de-ai");
    expect(replyModeForAgent("peer-review")).toBe("peer-review");
  });

  it("keeps default and custom agents on custom", () => {
    expect(replyModeForAgent(null)).toBe("custom");
    expect(replyModeForAgent("")).toBe("custom");
    expect(replyModeForAgent("  ")).toBe("custom");
    expect(replyModeForAgent("my-reviewer")).toBe("custom");
  });
});

describe("agentFlashAttribute", () => {
  it("uses the chip agent id for each built-in preset", () => {
    expect(agentFlashAttribute("academic-polish")).toBe("academic-polish");
    expect(agentFlashAttribute(" de-ai ")).toBe("de-ai");
    expect(agentFlashAttribute("peer-review")).toBe("peer-review");
  });

  it("leaves custom and default without a flash token", () => {
    expect(agentFlashAttribute(null)).toBeNull();
    expect(agentFlashAttribute("")).toBeNull();
    expect(agentFlashAttribute("my-agent")).toBeNull();
  });
});

describe("shouldFlashPresetAgentSwitch", () => {
  it("flashes only when the selection moves onto a different preset", () => {
    expect(shouldFlashPresetAgentSwitch(null, "academic-polish")).toBe(true);
    expect(shouldFlashPresetAgentSwitch("de-ai", "peer-review")).toBe(true);
    expect(
      shouldFlashPresetAgentSwitch("academic-polish", "academic-polish"),
    ).toBe(false);
    expect(shouldFlashPresetAgentSwitch("academic-polish", null)).toBe(false);
    expect(shouldFlashPresetAgentSwitch(null, "my-agent")).toBe(false);
  });
});

describe("applyReplyStyleToPrompt", () => {
  it("leaves custom turns unchanged", () => {
    expect(applyReplyStyleToPrompt("hello", null)).toBe("hello");
    expect(applyReplyStyleToPrompt("hello", "my-agent")).toBe("hello");
  });

  it("prefixes the next turn with the preset style and does not touch history", () => {
    const styled = applyReplyStyleToPrompt("请审这一段", "peer-review", [
      { id: "peer-review", instructions: "  自定义审稿口吻  " },
    ]);
    expect(styled.startsWith("[Reply mode: peer-review.")).toBe(true);
    expect(styled).toContain("自定义审稿口吻");
    expect(styled.endsWith("请审这一段")).toBe(true);
    expect(styled).not.toContain("earlier user message");
  });

  it("falls back to the built-in instructions when the saved agent is missing", () => {
    const prefix = replyStylePrefix("peer-review", []);
    expect(prefix).toContain(PEER_REVIEW_INSTRUCTIONS.trim());
  });
});
