import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkillLibrary } from "@/components/skills/skill-library";
import { useSkillStore } from "@/stores/skill-store";
import type { RuntimeSkill } from "@/runtime/types";

function skill(overrides: Partial<RuntimeSkill> = {}): RuntimeSkill {
  return {
    id: "claude:user:paper-spine",
    name: "paper-spine",
    description: "Paper workflow helper",
    folder: "paper-spine",
    sourcePath: "D:\\LocalPrism\\claude-home\\skills\\paper-spine",
    targets: [{ runtime: "claude", scope: "user" }],
    managed: false,
    compatibleRuntimes: ["claude"],
    enabled: true,
    discoveryError: null,
    ...overrides,
  };
}

describe("SkillLibrary", () => {
  let container: HTMLDivElement;
  let root: Root;
  let snapshot: ReturnType<typeof useSkillStore.getState>;
  const removeManaged = vi.fn(async () => undefined);

  beforeEach(() => {
    snapshot = useSkillStore.getState();
    removeManaged.mockReset();
    useSkillStore.setState({
      skills: [
        skill(),
        skill({
          id: "claude:user:academic-paper",
          name: "academic-paper",
          description: "",
          folder: "academic-paper",
          sourcePath: "D:\\LocalPrism\\claude-home\\skills\\academic-paper",
          managed: true,
        }),
        skill({
          id: "claude:project:nature-polishing",
          name: "nature-polishing",
          description: "Polish prose",
          folder: "nature-polishing",
          sourcePath: "D:\\LocalPrism\\claude-home\\skills\\nature-polishing",
          targets: [{ runtime: "claude", scope: "project" }],
          enabled: false,
          discoveryError: "missing SKILL.md",
        }),
      ],
      loading: false,
      error: null,
      selectedTargets: [{ runtime: "claude", scope: "user" }],
      refresh: async () => undefined,
      removeManaged,
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
    useSkillStore.setState(snapshot, true);
  });

  it("starts with collapsed packs and hides path and default status noise", async () => {
    await act(async () => {
      root.render(<SkillLibrary projectPath="/papers/demo" />);
    });

    expect(
      container.querySelector('[data-testid="skill-paper-workflow-hint"]'),
    ).toBeNull();
    expect(container.textContent).not.toContain("claude-home/skills");
    expect(container.textContent).not.toContain("GitHub repo, skill folder");
    expect(container.textContent).toContain("Import folder");
    expect(container.textContent).toContain("Refresh");
    expect(container.textContent).toContain("Add URL");
    expect(container.textContent).toContain("PaperSpine");
    expect(container.textContent).toContain("academic-research-skills");
    expect(container.textContent).not.toContain("paper-spine");
    expect(container.textContent).not.toContain("unmanaged");
    expect(container.textContent).not.toContain("enabled");
    expect(container.textContent).not.toContain("D:\\LocalPrism");

    const toggle = container.querySelector(
      '[data-testid="skill-pack-toggle-paper-spine"]',
    );
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    await act(async () => {
      (toggle as HTMLButtonElement).click();
    });

    const row = container.querySelector(
      '[data-testid="skill-row-paper-spine"]',
    );
    expect(row?.textContent).toContain("paper-spine");
    expect(row?.textContent).toContain("Paper workflow helper");
    expect(row?.textContent).not.toContain("LocalPrism / user");
    expect(row?.textContent).not.toContain("unmanaged");
    expect(row?.textContent).not.toContain("D:\\LocalPrism");
    expect(row?.getAttribute("title")).toContain("paper-spine");

    const pathToggle = container.querySelector(
      '[data-testid="skill-path-toggle-paper-spine"]',
    );
    await act(async () => {
      (pathToggle as HTMLButtonElement).click();
    });
    expect(
      container.querySelector('[data-testid="skill-path-paper-spine"]')
        ?.textContent,
    ).toContain("D:\\LocalPrism");
  });

  it("shows project scope, disabled state, errors, and remove only as exceptions", async () => {
    await act(async () => {
      root.render(<SkillLibrary projectPath="/papers/demo" />);
    });

    const nature = container.querySelector(
      '[data-testid="skill-pack-toggle-nature-skills"]',
    );
    const research = container.querySelector(
      '[data-testid="skill-pack-toggle-academic-research-skills"]',
    );
    await act(async () => {
      (nature as HTMLButtonElement).click();
      (research as HTMLButtonElement).click();
    });

    const exception = container.querySelector(
      '[data-testid="skill-row-nature-polishing"]',
    );
    expect(exception?.textContent).toContain("LocalPrism / project");
    expect(exception?.textContent).toContain("disabled");
    expect(exception?.textContent).toContain("missing SKILL.md");
    expect(exception?.textContent).not.toContain("Remove");

    const managed = container.querySelector(
      '[data-testid="skill-row-academic-paper"]',
    );
    expect(managed?.textContent).toContain("Remove");
    expect(managed?.textContent).not.toContain("unmanaged");
    const remove = [...(managed?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent === "Remove",
    );
    await act(async () => {
      (remove as HTMLButtonElement).click();
    });
    expect(removeManaged).toHaveBeenCalledWith(
      "claude:user:academic-paper",
      false,
    );
  });

  it("shows frontmatter categories and keeps uncategorized skills expanded", async () => {
    useSkillStore.setState({
      skills: [
        skill({
          id: "claude:user:methods",
          name: "Methods",
          folder: "methods",
          description: "Method notes",
          sourcePath: "C:/skills/methods",
          category: "Methods",
        }),
        skill({
          id: "claude:user:mystery",
          name: "Mystery",
          folder: "mystery",
          description: "No category",
          sourcePath: "C:/skills/mystery",
          category: null,
        }),
      ],
    });

    await act(async () => {
      root.render(<SkillLibrary projectPath="/papers/demo" />);
    });

    const methods = container.querySelector(
      '[data-testid="skill-pack-toggle-category:methods"]',
    );
    const uncategorized = container.querySelector(
      '[data-testid="skill-pack-toggle-imported"]',
    );
    expect(methods?.textContent).toContain("Methods");
    expect(methods?.getAttribute("aria-expanded")).toBe("true");
    expect(uncategorized?.textContent).toContain("Uncategorized");
    expect(uncategorized?.getAttribute("aria-expanded")).toBe("true");
    expect(
      container.querySelector('[data-testid="skill-row-methods"]')?.textContent,
    ).toContain("Methods");
    expect(
      container.querySelector('[data-testid="skill-row-mystery"]')?.textContent,
    ).toContain("Mystery");
  });
});
