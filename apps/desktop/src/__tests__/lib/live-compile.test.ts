import { describe, expect, it } from "vitest";
import { shouldScheduleLiveCompile } from "@/lib/live-compile";

const ready = {
  autoCompile: true,
  isTexPreview: true,
  isProjectMutating: false,
  isCompiling: false,
  pendingRecompile: false,
  contentGeneration: 4,
  lastCompiledGeneration: 3,
};

describe("shouldScheduleLiveCompile", () => {
  it("schedules when tex content is newer than the last compile", () => {
    expect(shouldScheduleLiveCompile(ready)).toBe(true);
  });

  it("skips when live preview is off", () => {
    expect(shouldScheduleLiveCompile({ ...ready, autoCompile: false })).toBe(
      false,
    );
  });

  it("skips markdown or source-pdf preview", () => {
    expect(shouldScheduleLiveCompile({ ...ready, isTexPreview: false })).toBe(
      false,
    );
  });

  it("skips while a compile is already running or queued", () => {
    expect(shouldScheduleLiveCompile({ ...ready, isCompiling: true })).toBe(
      false,
    );
    expect(
      shouldScheduleLiveCompile({ ...ready, pendingRecompile: true }),
    ).toBe(false);
  });

  it("skips when this generation already compiled", () => {
    expect(
      shouldScheduleLiveCompile({
        ...ready,
        lastCompiledGeneration: 4,
      }),
    ).toBe(false);
  });

  it("skips while the project is mutating", () => {
    expect(
      shouldScheduleLiveCompile({ ...ready, isProjectMutating: true }),
    ).toBe(false);
  });
});
