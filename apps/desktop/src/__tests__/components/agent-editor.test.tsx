import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { AgentEditor } from "@/components/agents/agent-editor";
import { useSkillStore } from "@/stores/skill-store";
import { emptyAgentProfile, useAgentStore } from "@/stores/agent-store";
import { useProviderStore } from "@/stores/provider-store";
import type { RuntimeSkill } from "@/runtime/types";

function skill(overrides: Partial<RuntimeSkill> = {}): RuntimeSkill {
  return {
    id: "claude:user:my-reviewer",
    name: "My Reviewer",
    description: "A user-imported review skill",
    folder: "my-reviewer",
    sourcePath: "C:/skills/my-reviewer",
    targets: [{ runtime: "claude", scope: "user" }],
    managed: true,
    compatibleRuntimes: ["claude"],
    enabled: true,
    discoveryError: null,
    ...overrides,
  };
}

const catalog = [
  skill(),
  skill({
    id: "claude:user:legacy",
    name: "Legacy Writer",
    folder: "legacy-writer",
    description: "Legacy Claude skill",
    sourcePath: "C:/skills/legacy-writer",
    discoveryError:
      "Legacy Claude skill is missing a standard description and can only target Claude.",
  }),
];

describe("AgentEditor skill assignment", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation((command: string) => {
      if (command === "skill_list") return Promise.resolve(catalog);
      return Promise.resolve([]);
    });
    useSkillStore.setState({
      skills: catalog,
      loading: false,
      error: null,
    });
    useAgentStore.setState({
      agents: [],
      loading: false,
      error: null,
    });
    useProviderStore.setState({ models: [] });
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

  it("lists imported and legacy skills when creating an agent", async () => {
    root.render(<AgentEditor />);

    await vi.waitFor(() => {
      expect(container.textContent).toContain("My Reviewer");
    });
    expect(container.textContent).toContain("Legacy Writer");
    expect(container.textContent).not.toContain("No compatible skills");

    const checkbox = container.querySelector('input[type="checkbox"]');
    expect(checkbox).toBeInstanceOf(HTMLInputElement);
    (checkbox as HTMLInputElement).click();

    await vi.waitFor(() => {
      expect(container.textContent).toContain("1 selected");
    });
  });

  it("defaults new agents to user scope so installed skills stay assignable", async () => {
    root.render(<AgentEditor projectPath="C:/proj" />);

    const scope = await vi.waitFor(() => {
      const node = container.querySelector("#agent-scope");
      if (!(node instanceof HTMLSelectElement)) {
        throw new Error("scope select missing");
      }
      return node;
    });
    expect(scope.value).toBe("user");
    await vi.waitFor(() => {
      expect(container.textContent).toContain("My Reviewer");
    });
  });

  it("disables save until the skill catalog finishes loading", async () => {
    let resolveList: ((value: RuntimeSkill[]) => void) | undefined;
    invoke.mockImplementation((command: string) => {
      if (command === "skill_list") {
        return new Promise<RuntimeSkill[]>((resolve) => {
          resolveList = resolve;
        });
      }
      return Promise.resolve([]);
    });
    useSkillStore.setState({ skills: [], loading: true, error: null });

    root.render(<AgentEditor />);

    const name = await vi.waitFor(() => {
      const node = container.querySelector("#agent-name");
      if (!(node instanceof HTMLInputElement)) {
        throw new Error("name input missing");
      }
      return node;
    });
    name.value = "Reviewer";
    name.dispatchEvent(new Event("input", { bubbles: true }));

    await vi.waitFor(() => {
      expect(container.textContent).toContain("Loading skills…");
    });
    const save = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Save agent"),
    );
    expect(save).toBeInstanceOf(HTMLButtonElement);
    expect((save as HTMLButtonElement).disabled).toBe(true);

    resolveList?.(catalog);
    useSkillStore.setState({ skills: catalog, loading: false, error: null });
    await vi.waitFor(() => {
      expect(container.textContent).toContain("My Reviewer");
    });
  });

  it("shows one row when the same folder is installed for user and project", async () => {
    const duplicated = [
      skill({
        id: "claude:user:writer",
        name: "Writer",
        folder: "writer",
        sourcePath: "C:/skills/writer",
      }),
      skill({
        id: "claude:project:writer",
        name: "Writer",
        folder: "writer",
        sourcePath: "/paper/.localprism/skills/writer",
        targets: [{ runtime: "claude", scope: "project" }],
      }),
    ];
    useSkillStore.setState({
      skills: duplicated,
      loading: false,
      error: null,
    });
    invoke.mockImplementation((command: string) => {
      if (command === "skill_list") return Promise.resolve(duplicated);
      return Promise.resolve([]);
    });

    root.render(
      <AgentEditor
        projectPath="/paper"
        initial={{
          ...emptyAgentProfile("claude", "user"),
          id: "academic-polish",
          name: "润色",
          skillIds: ["writer"],
        }}
      />,
    );

    await vi.waitFor(() => {
      expect(container.textContent).toContain("1 selected");
    });
    const checked = [
      ...container.querySelectorAll('input[type="checkbox"]'),
    ].filter((node) => (node as HTMLInputElement).checked);
    expect(checked).toHaveLength(1);
    expect(container.textContent?.match(/Writer/g)).toHaveLength(1);
  });
});
