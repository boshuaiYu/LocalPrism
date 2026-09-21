import { describe, expect, it } from "vitest";
import {
  isFastModelId,
  resolveFastModelPair,
  stripFastModelSuffix,
} from "@/lib/fast-model";

describe("resolveFastModelPair", () => {
  it("returns null when the catalog has no distinct fast sibling", () => {
    expect(
      resolveFastModelPair("gpt-5.6-luna", [
        { id: "gpt-5.6-sol" },
        { id: "gpt-5.6-terra" },
        { id: "gpt-5.6-luna" },
      ]),
    ).toBeNull();
    expect(
      resolveFastModelPair("sonnet", [
        { id: "sonnet" },
        { id: "opus" },
        { id: "haiku" },
      ]),
    ).toBeNull();
  });

  it("pairs a base model with a distinct fast sibling", () => {
    expect(
      resolveFastModelPair("gpt-5.6-luna", [
        { id: "gpt-5.6-luna" },
        { id: "gpt-5.6-luna-fast" },
      ]),
    ).toEqual({
      baseId: "gpt-5.6-luna",
      fastId: "gpt-5.6-luna-fast",
    });
    expect(
      resolveFastModelPair("gpt-5.6-luna-fast", [
        { id: "gpt-5.6-luna" },
        { id: "gpt-5.6-luna-fast" },
      ]),
    ).toEqual({
      baseId: "gpt-5.6-luna",
      fastId: "gpt-5.6-luna-fast",
    });
  });
});

describe("fast model id helpers", () => {
  it("strips known speed suffixes", () => {
    expect(stripFastModelSuffix("gpt-5.6-luna-fast")).toBe("gpt-5.6-luna");
    expect(stripFastModelSuffix("gpt-5.6-luna")).toBe("gpt-5.6-luna");
    expect(isFastModelId("gpt-5.6-luna-fast")).toBe(true);
    expect(isFastModelId("gpt-5.6-luna-turbo")).toBe(false);
    expect(isFastModelId("gpt-5.6-luna")).toBe(false);
    expect(
      resolveFastModelPair("gpt-4", [{ id: "gpt-4" }, { id: "gpt-4-turbo" }]),
    ).toBeNull();
  });
});
