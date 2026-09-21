import { createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  commandHasPreview,
  SlashCommandPicker,
  type SlashCommand,
} from "@/components/claude-chat/slash-command-picker";

function command(overrides: Partial<SlashCommand> = {}): SlashCommand {
  return {
    id: "user-ars-plan",
    name: "ars-plan",
    full_command: "/ars-plan",
    scope: "user",
    namespace: null,
    file_path: "C:/claude-home/slash/ars-plan.md",
    content:
      "Trigger the academic-paper skill in plan mode. Produce a chapter plan.",
    description: "ARS academic-paper plan mode — Socratic chapter planning",
    allowed_tools: [],
    has_bash_commands: false,
    has_file_references: false,
    accepts_arguments: true,
    ...overrides,
  };
}

describe("commandHasPreview", () => {
  it("accepts description-only and content-only commands", () => {
    expect(commandHasPreview(command())).toBe(true);
    expect(
      commandHasPreview(command({ description: null, content: "Body" })),
    ).toBe(true);
    expect(
      commandHasPreview(command({ description: "Explain", content: "" })),
    ).toBe(true);
    expect(commandHasPreview(command({ description: null, content: "" }))).toBe(
      false,
    );
  });
});

describe("SlashCommandPicker", () => {
  let container: HTMLDivElement;
  let root: Root;
  let anchor: HTMLDivElement;

  beforeEach(() => {
    vi.mocked(invoke).mockImplementation(async (name: string) => {
      if (name === "slash_commands_list") {
        return [
          command({
            id: "skill-paper-spine",
            name: "paper-spine",
            full_command: "/paper-spine",
            scope: "skill",
            content: "# PaperSpine Orchestrator\n\nOfficial 17-step handoff.",
            description: "PaperSpine orchestrator",
          }),
          command(),
        ];
      }
      if (name === "get_skill_categories") return [];
      return [];
    });
    container = document.createElement("div");
    document.body.append(container);
    anchor = document.createElement("div");
    document.body.append(anchor);
    vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue({
      left: 40,
      right: 400,
      top: 500,
      bottom: 540,
      width: 360,
      height: 40,
      x: 40,
      y: 500,
      toJSON: () => ({}),
    });
    root = createRoot(container);
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    root.unmount();
    container.remove();
    anchor.remove();
    vi.mocked(invoke).mockReset();
  });

  it("opens a detail pane when a custom slash command is clicked", async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const anchorRef = createRef<HTMLDivElement>();
    Object.defineProperty(anchorRef, "current", {
      value: anchor,
      writable: true,
    });

    root.render(
      <SlashCommandPicker
        projectPath={null}
        query=""
        anchorRef={anchorRef}
        onSelect={onSelect}
        onClose={onClose}
      />,
    );
    await vi.waitFor(() => {
      expect(
        Array.from(document.body.querySelectorAll("button")).some((button) =>
          button.textContent?.includes("Custom"),
        ),
      ).toBe(true);
    });

    const customTab = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Custom"),
    );
    expect(customTab).toBeTruthy();
    customTab?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

    await vi.waitFor(() => {
      expect(
        document.body.querySelector(
          '[data-testid="slash-command-item-user-ars-plan"]',
        ),
      ).toBeTruthy();
    });

    const item = document.body.querySelector(
      '[data-testid="slash-command-item-user-ars-plan"]',
    );
    expect(item).toBeTruthy();
    item?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

    await vi.waitFor(() => {
      expect(
        document.body.querySelector('[data-testid="slash-command-preview"]'),
      ).toBeTruthy();
    });
    const preview = document.body.querySelector(
      '[data-testid="slash-command-preview"]',
    );
    expect(preview?.textContent).toContain("/ars-plan");
    expect(preview?.textContent).toContain(
      "ARS academic-paper plan mode — Socratic chapter planning",
    );
    expect(preview?.textContent).toContain(
      "Trigger the academic-paper skill in plan mode",
    );
    expect(onSelect).not.toHaveBeenCalled();

    item?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await vi.waitFor(() => {
      expect(onSelect).toHaveBeenCalledWith(
        expect.objectContaining({ full_command: "/ars-plan" }),
      );
    });
  });

  it("inserts the highlighted slash command on Enter", async () => {
    const onSelect = vi.fn();
    const anchorRef = createRef<HTMLDivElement>();
    Object.defineProperty(anchorRef, "current", {
      value: anchor,
      writable: true,
    });

    root.render(
      <SlashCommandPicker
        projectPath={null}
        query=""
        anchorRef={anchorRef}
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
    );
    await vi.waitFor(() => {
      expect(
        Array.from(document.body.querySelectorAll("button")).some((button) =>
          button.textContent?.includes("Custom"),
        ),
      ).toBe(true);
    });

    Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Custom"))
      ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

    await vi.waitFor(() => {
      expect(
        document.body.querySelector(
          '[data-testid="slash-command-item-user-ars-plan"]',
        ),
      ).toBeTruthy();
    });

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await vi.waitFor(() => {
      expect(onSelect).toHaveBeenCalledWith(
        expect.objectContaining({ full_command: "/ars-plan" }),
      );
    });
  });
});
