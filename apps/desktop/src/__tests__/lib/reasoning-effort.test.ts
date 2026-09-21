import { describe, expect, it } from "vitest";
import {
  formatReasoningEffortLabel,
  formatReasoningEffortShortLabel,
  normalizeReasoningEffortOptions,
  resolveReasoningEffort,
  reasoningEffortSliderIndex,
} from "@/lib/reasoning-effort";

describe("normalizeReasoningEffortOptions", () => {
  it("keeps the parsed model list, aliases max/ultra, and drops unsupported wire efforts", () => {
    expect(
      normalizeReasoningEffortOptions([
        "minimal",
        "low",
        "max",
        "high",
        "ultra",
      ]),
    ).toEqual(["low", "high", "xhigh"]);
  });

  it("orders known efforts from weaker to stronger", () => {
    expect(
      normalizeReasoningEffortOptions(["xhigh", "none", "medium", "low"]),
    ).toEqual(["none", "low", "medium", "xhigh"]);
  });

  it("returns an empty list when the catalog has no usable efforts", () => {
    expect(normalizeReasoningEffortOptions(["minimal"])).toEqual([]);
    expect(normalizeReasoningEffortOptions([])).toEqual([]);
  });
});

describe("resolveReasoningEffort", () => {
  it("keeps a current effort that the parsed model still supports", () => {
    expect(resolveReasoningEffort("high", ["low", "medium", "high"])).toBe(
      "high",
    );
  });

  it("snaps an unsupported current effort to the closest parsed option", () => {
    expect(resolveReasoningEffort("medium", ["low", "xhigh"])).toBe("low");
    expect(resolveReasoningEffort("high", ["low", "xhigh"])).toBe("xhigh");
    expect(resolveReasoningEffort("minimal", ["low", "medium", "high"])).toBe(
      "low",
    );
  });

  it("snaps an unsupported current effort before using the catalog default", () => {
    expect(
      resolveReasoningEffort("minimal", ["low", "medium", "high"], "medium"),
    ).toBe("low");
  });

  it("uses the catalog default, then medium, then the middle option", () => {
    expect(
      resolveReasoningEffort(null, ["low", "medium", "high"], "high"),
    ).toBe("high");
    expect(resolveReasoningEffort(null, ["low", "medium", "high"])).toBe(
      "medium",
    );
    expect(resolveReasoningEffort("max", ["none", "low", "xhigh"])).toBe(
      "xhigh",
    );
    expect(resolveReasoningEffort(null, ["low", "xhigh"])).toBe("low");
    expect(resolveReasoningEffort("medium", [])).toBeNull();
  });
});

describe("reasoningEffortSliderIndex", () => {
  it("maps the resolved effort onto the discrete slider steps", () => {
    const options = ["low", "medium", "high", "xhigh"];
    expect(reasoningEffortSliderIndex("medium", options)).toBe(1);
    expect(reasoningEffortSliderIndex("xhigh", options)).toBe(3);
    expect(reasoningEffortSliderIndex("missing", options)).toBe(1);
  });
});

describe("formatReasoningEffortLabel", () => {
  it("uses short labels for the known ladder", () => {
    expect(formatReasoningEffortLabel("none")).toBe("None");
    expect(formatReasoningEffortLabel("low")).toBe("Low");
    expect(formatReasoningEffortLabel("xhigh")).toBe("Extra high");
    expect(formatReasoningEffortLabel("max")).toBe("Extra high");
    expect(formatReasoningEffortLabel("custom-tier")).toBe("custom-tier");
  });
});

describe("formatReasoningEffortShortLabel", () => {
  it("uses compact tick labels", () => {
    expect(formatReasoningEffortShortLabel("medium")).toBe("Med");
    expect(formatReasoningEffortShortLabel("xhigh")).toBe("Max");
    expect(formatReasoningEffortShortLabel("max")).toBe("Max");
  });
});
