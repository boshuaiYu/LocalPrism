import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSkillPicker } from "@/components/agents/agent-skill-picker";
import type { RuntimeSkill } from "@/runtime/types";

function skill(overrides: Partial<RuntimeSkill> = {}): RuntimeSkill {
  return {
    id: "claude:user:paper-spine-intake",
    name: "Paper Spine Intake",
    description: "Collect paper intake details and source files",
    folder: "paper-spine-intake",
    sourcePath: "C:/skills/paper-spine-intake",
    targets: [{ runtime: "claude", scope: "user" }],
    managed: true,
    compatibleRuntimes: ["claude"],
    enabled: true,
    discoveryError: null,
    ...overrides,
  };
}

describe("AgentSkillPicker", () => {
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

  afterEach(() => {
    root.unmount();
    container.remove();
  });

  it("shows each skill description so assignments can be judged", async () => {
    const onToggle = vi.fn();
    root.render(
      <AgentSkillPicker
        skills={[
          skill(),
          skill({
            id: "claude:user:nature-writing",
            name: "Nature Writing",
            folder: "nature-writing",
            description: "Polish prose toward Nature-style writing",
            sourcePath: "C:/skills/nature-writing",
          }),
        ]}
        selectedIds={[]}
        onToggle={onToggle}
      />,
    );

    await vi.waitFor(() => {
      expect(container.textContent).toContain("Paper Spine Intake");
    });
    expect(container.textContent).toContain(
      "Collect paper intake details and source files",
    );
    expect(container.textContent).toContain("Nature Writing");
    expect(container.textContent).toContain(
      "Polish prose toward Nature-style writing",
    );
  });

  it("lists imported skills and toggles a checkbox", async () => {
    const onToggle = vi.fn();
    root.render(
      <AgentSkillPicker
        skills={[
          skill({
            id: "claude:user:my-reviewer",
            name: "My Reviewer",
            folder: "my-reviewer",
            description: "A user-imported review skill",
            sourcePath: "C:/skills/my-reviewer",
          }),
        ]}
        selectedIds={[]}
        onToggle={onToggle}
      />,
    );

    const checkbox = await vi.waitFor(() => {
      const node = container.querySelector('input[type="checkbox"]');
      if (!(node instanceof HTMLInputElement)) {
        throw new Error("skill checkbox missing");
      }
      return node;
    });
    expect(container.textContent).toContain("Imported");
    expect(container.textContent).toContain("My Reviewer");
    checkbox.click();
    expect(onToggle).toHaveBeenCalledWith("my-reviewer", true);
  });
});
