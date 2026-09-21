import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolWidget } from "@/components/claude-chat/tool-widgets";

const dump = [
  "Base directory for this skill: D:\\LocalPrism\\claude-home\\skills\\academic-pipeline",
  "Academic Pipeline v3.22.0 — Full Academic Research Workflow Orchestrator",
  "Routing discipline (v3.9.2): see CLAUDE.md",
].join("\n");

describe("ToolWidget skill", () => {
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

  it("shows a compact skill chip and hides the SKILL.md body", async () => {
    root.render(
      <ToolWidget
        toolUse={{
          type: "tool_use",
          id: "tool-1",
          name: "Skill",
          input: { skill: "academic-pipeline" },
        }}
        toolResult={{
          type: "tool_result",
          tool_use_id: "tool-1",
          content: dump,
        }}
      />,
    );

    const chip = await vi.waitFor(() => {
      const node = container.querySelector('[data-testid="chat-skill-widget"]');
      if (!(node instanceof HTMLElement)) {
        throw new Error("skill widget missing");
      }
      return node;
    });

    expect(chip.textContent).toContain("Ran skill");
    expect(chip.textContent).toContain("academic-pipeline");
    expect(container.textContent).not.toContain(
      "Base directory for this skill",
    );
    expect(container.textContent).not.toContain("Routing discipline");
  });
});
