import { describe, expect, it } from "vitest";
import { deriveReasoningStrength } from "@/lib/reasoning-strength";

describe("deriveReasoningStrength", () => {
  it("builds a segmented control from the model's discrete efforts", () => {
    const control = deriveReasoningStrength(
      { id: "gpt-5.6-sol", reasoningEfforts: ["xhigh", "low"] },
      "xhigh",
    );
    expect(control).toEqual({
      kind: "discrete",
      options: [
        { value: "low", label: "Low" },
        { value: "xhigh", label: "Extra high" },
      ],
      value: "xhigh",
    });
  });

  it("uses metadata labels instead of a fixed Low/Medium/High preset", () => {
    const control = deriveReasoningStrength(
      {
        id: "custom-reasoner",
        reasoningEfforts: [],
        metadata: {
          supported_reasoning_efforts: [
            { effort: "brief", label: "Brief" },
            { effort: "deep", label: "Deep dive" },
          ],
        },
      },
      "deep",
    );
    expect(control.kind).toBe("discrete");
    if (control.kind !== "discrete") return;
    expect(control.options.map((option) => option.label)).toEqual([
      "Brief",
      "Deep dive",
    ]);
    expect(control.options.map((option) => option.value)).not.toEqual([
      "low",
      "medium",
      "high",
    ]);
    expect(control.value).toBe("deep");
  });

  it("builds a slider from the model's numeric range", () => {
    const control = deriveReasoningStrength(
      {
        id: "budget-model",
        metadata: {
          capabilities: {
            thinking: { min: 0, max: 64, step: 8, default: 16 },
          },
        },
      },
      "20",
    );
    expect(control).toEqual({
      kind: "continuous",
      min: 0,
      max: 64,
      step: 8,
      value: 24,
    });
  });

  it("does not invent a preset when the model cannot adjust strength", () => {
    const missing = deriveReasoningStrength(
      { id: "embed", reasoningEfforts: [] },
      "medium",
    );
    expect(missing).toEqual({
      kind: "unavailable",
      reason: "This model does not adjust reasoning strength",
      value: null,
    });

    const fixed = deriveReasoningStrength(
      { id: "fixed", reasoningEfforts: ["high"] },
      "low",
    );
    expect(fixed).toEqual({
      kind: "unavailable",
      reason: "Reasoning strength is fixed at High",
      value: "high",
    });
  });
});
