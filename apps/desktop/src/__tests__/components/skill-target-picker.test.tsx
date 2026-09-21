import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SkillTargetPicker } from "@/components/skills/skill-target-picker";

describe("SkillTargetPicker", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("only offers Claude skill targets", async () => {
    await act(async () => {
      root.render(
        <SkillTargetPicker
          value={[{ runtime: "claude", scope: "user" }]}
          projectPath="/paper"
          onChange={() => undefined}
        />,
      );
    });

    expect(container.textContent).toContain("LocalPrism / user");
    expect(container.textContent).toContain("LocalPrism / project");
    expect(container.textContent).not.toMatch(/Codex/i);
  });
});
