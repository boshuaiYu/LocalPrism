import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolWidget } from "@/components/claude-chat/tool-widgets";
import { useClaudeChatStore } from "@/stores/claude-chat-store";
import { useSettingsStore } from "@/stores/settings-store";

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

describe("ExitPlanModeWidget", () => {
  let container: HTMLDivElement;
  let root: Root;
  const sendPrompt = vi.fn();

  beforeEach(() => {
    sendPrompt.mockReset();
    useSettingsStore.setState({ permissionMode: "plan" });
    useClaudeChatStore.setState({
      isStreaming: false,
      sendPrompt: sendPrompt as never,
    });
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

  function renderPlan() {
    root.render(
      <ToolWidget
        toolUse={{
          type: "tool_use",
          id: "plan-1",
          name: "ExitPlanMode",
          input: { plan: "Rewrite the abstract." },
        }}
      />,
    );
  }

  it("switches Plan only to Allow edits when the plan is approved", async () => {
    await act(async () => {
      renderPlan();
    });
    const approve = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Approve and edit",
    );
    expect(approve).toBeTruthy();
    await act(async () => {
      approve?.click();
    });
    expect(useSettingsStore.getState().permissionMode).toBe("acceptEdits");
    expect(sendPrompt).toHaveBeenCalledWith(
      "Approved. Continue implementing the plan.",
    );
  });

  it("stays in Plan only when the plan is revised", async () => {
    await act(async () => {
      renderPlan();
    });
    const revise = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Revise",
    );
    await act(async () => {
      revise?.click();
    });
    expect(useSettingsStore.getState().permissionMode).toBe("plan");
    expect(sendPrompt).toHaveBeenCalledWith(
      "Revise the plan before implementing. Keep it concise and address any missing risks.",
    );
  });
});
