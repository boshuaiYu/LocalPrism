import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { AgentLibrary } from "@/components/agents/agent-library";
import { emptyAgentProfile, useAgentStore } from "@/stores/agent-store";
import { useProviderStore } from "@/stores/provider-store";
import { useSkillStore } from "@/stores/skill-store";
import type { AgentProfile, RuntimeSkill } from "@/runtime/types";

const invokeMock = vi.mocked(invoke);

function skill(
  folder: string,
  scope: "user" | "project",
  overrides: Partial<RuntimeSkill> = {},
): RuntimeSkill {
  return {
    id: `claude:${scope}:${folder}`,
    name: folder,
    description: `${folder} skill`,
    folder,
    sourcePath: `/skills/${scope}/${folder}`,
    targets: [{ runtime: "claude", scope }],
    managed: true,
    compatibleRuntimes: ["claude"],
    enabled: true,
    discoveryError: null,
    ...overrides,
  };
}

const catalog: RuntimeSkill[] = [
  skill("academic-polish", "user", { name: "Academic Polish" }),
  skill("writing-clarity", "user", { name: "Writing Clarity" }),
  skill("citation-check", "user", { name: "Citation Check" }),
  skill("zotero-cite", "user", { name: "Zotero Cite" }),
  skill("humanizer-academic", "user", { name: "Humanizer Academic" }),
  skill("latex-guard", "project", { name: "Latex Guard" }),
];

function installedAgent(): AgentProfile {
  return {
    ...emptyAgentProfile("claude", "user"),
    id: "existing",
    name: "Existing Agent",
    description: "Already saved",
    sourcePath: "/agents/existing.md",
  };
}

describe("AgentLibrary presets", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation((command: string, args?: unknown) => {
      if (command === "skill_list") return Promise.resolve(catalog);
      if (command === "list_agents") return Promise.resolve([]);
      if (command === "save_agent") {
        return Promise.resolve((args as { profile: AgentProfile }).profile);
      }
      return Promise.resolve([]);
    });
    useAgentStore.setState({ agents: [], loading: false, error: null });
    useSkillStore.setState({
      skills: [],
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
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("shows three bilingual presets and custom create when no agents exist", async () => {
    await act(async () => {
      root.render(<AgentLibrary projectPath="/papers/demo" />);
    });

    await vi.waitFor(() => {
      expect(
        container.querySelector("[data-testid='agent-preset-empty']"),
      ).toBeTruthy();
    });
    const empty = container.querySelector("[data-testid='agent-preset-empty']");
    expect(empty?.textContent).toContain("润色");
    expect(empty?.textContent).toContain("Academic Polish");
    expect(empty?.textContent).toContain("提升清晰度");
    expect(empty?.textContent).toContain("academic tone");
    expect(empty?.textContent).toContain("去AI");
    expect(empty?.textContent).toContain("De-AI");
    expect(empty?.textContent).toContain("模板化");
    expect(empty?.textContent).toContain("template-like");
    expect(empty?.textContent).toContain("Peer Review");
    expect(empty?.textContent).toContain("审稿模拟");
    expect(empty?.textContent).toContain("审稿");
    expect(empty?.textContent).toContain("actionable");
    expect(
      container.querySelector("[data-testid='agent-preset-custom']"),
    ).toBeTruthy();
  });

  it("hides preset cards when the built-in agents are already installed", async () => {
    const installed = ["academic-polish", "de-ai", "peer-review"].map((id) => ({
      ...installedAgent(),
      id,
      name: id,
    }));
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_agents") return Promise.resolve(installed);
      return Promise.resolve([]);
    });

    await act(async () => {
      root.render(<AgentLibrary />);
    });

    await vi.waitFor(() => {
      expect(container.textContent).toContain("academic-polish");
    });
    expect(
      container.querySelector("[data-testid='agent-preset-empty']"),
    ).toBeNull();
  });

  it("keeps a card for a built-in preset that was deleted", async () => {
    const installed = ["academic-polish", "de-ai"].map((id) => ({
      ...installedAgent(),
      id,
      name: id,
    }));
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_agents") return Promise.resolve(installed);
      return Promise.resolve([]);
    });

    await act(async () => {
      root.render(<AgentLibrary />);
    });

    await vi.waitFor(() => {
      expect(
        container.querySelector("[data-testid='agent-preset-peer-review']"),
      ).toBeTruthy();
    });
    expect(container.textContent).toContain(
      "Built-in presets you can add back.",
    );
    expect(
      container.querySelector("[data-testid='agent-preset-academic-polish']"),
    ).toBeNull();
    expect(
      container.querySelector("[data-testid='agent-preset-de-ai']"),
    ).toBeNull();
  });

  it("fills the editor from the polish preset and saves matched skills only", async () => {
    await act(async () => {
      root.render(<AgentLibrary projectPath="/papers/demo" />);
    });
    const polish = await vi.waitFor(() => {
      const node = container.querySelector(
        "[data-testid='agent-preset-academic-polish']",
      );
      if (!(node instanceof HTMLButtonElement)) {
        throw new Error("polish preset missing");
      }
      return node;
    });

    await act(async () => {
      polish.click();
    });

    const name = await vi.waitFor(() => {
      const node = container.querySelector("#agent-name");
      if (!(node instanceof HTMLInputElement) || node.value !== "润色") {
        throw new Error("preset name not applied");
      }
      return node;
    });
    const description = container.querySelector("#agent-description");
    const instructions = container.querySelector("#agent-instructions");
    expect(name.value).toBe("润色");
    expect(description).toBeInstanceOf(HTMLInputElement);
    expect((description as HTMLInputElement).value).toContain("提升清晰度");
    expect((description as HTMLInputElement).value).toContain("academic tone");
    expect(instructions).toBeInstanceOf(HTMLTextAreaElement);
    expect((instructions as HTMLTextAreaElement).value).toContain(
      "You are an expert academic editor for LaTeX research papers",
    );
    expect((instructions as HTMLTextAreaElement).value).toContain(
      "Preserve LaTeX exactly",
    );

    await vi.waitFor(() => {
      expect(checkboxFor("Academic Polish").checked).toBe(true);
    });
    expect(checkboxFor("Writing Clarity").checked).toBe(true);
    expect(checkboxFor("Citation Check").checked).toBe(false);
    expect(checkboxFor("Zotero Cite").checked).toBe(false);
    expect(checkboxFor("Humanizer Academic").checked).toBe(false);
    expect(container.textContent).not.toContain("Latex Guard");

    const save = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Save agent"),
    );
    expect(save).toBeInstanceOf(HTMLButtonElement);
    await act(async () => {
      (save as HTMLButtonElement).click();
    });

    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "save_agent",
        expect.objectContaining({
          overwrite: false,
          projectPath: "/papers/demo",
          profile: expect.objectContaining({
            id: "academic-polish",
            name: "润色",
            scope: "user",
            runtime: "claude",
            skillIds: ["academic-polish", "writing-clarity"],
          }),
        }),
      );
    });
    const saved = invokeMock.mock.calls.find(
      ([command]) => command === "save_agent",
    )?.[1] as { profile: AgentProfile };
    expect(saved.profile.instructions).toContain("Preserve LaTeX exactly");
    expect(saved.profile.description).toContain("academic tone");
    expect(saved.profile.skillIds).not.toEqual(
      expect.arrayContaining(["citation-check", "zotero-cite", "latex-guard"]),
    );
  });

  it("opens a blank editor from custom create", async () => {
    await act(async () => {
      root.render(<AgentLibrary />);
    });
    const custom = await vi.waitFor(() => {
      const node = container.querySelector(
        "[data-testid='agent-preset-custom']",
      );
      if (!(node instanceof HTMLButtonElement)) {
        throw new Error("custom create missing");
      }
      return node;
    });
    await act(async () => {
      custom.click();
    });
    const name = await vi.waitFor(() => {
      const node = container.querySelector("#agent-name");
      if (!(node instanceof HTMLInputElement)) {
        throw new Error("name input missing");
      }
      return node;
    });
    expect(name.value).toBe("");
    const instructions = container.querySelector("#agent-instructions");
    expect((instructions as HTMLTextAreaElement).value).toBe("");
  });

  it("does not attach citation skills when creating the peer review preset", async () => {
    await act(async () => {
      root.render(<AgentLibrary projectPath="/papers/demo" />);
    });
    const review = await vi.waitFor(() => {
      const node = container.querySelector(
        "[data-testid='agent-preset-peer-review']",
      );
      if (!(node instanceof HTMLButtonElement)) {
        throw new Error("peer review preset missing");
      }
      return node;
    });
    await act(async () => {
      review.click();
    });

    const name = await vi.waitFor(() => {
      const node = container.querySelector("#agent-name");
      if (!(node instanceof HTMLInputElement) || node.value !== "Peer Review") {
        throw new Error("peer review name not applied");
      }
      return node;
    });
    expect(name.value).toBe("Peer Review");
    const instructions = container.querySelector("#agent-instructions");
    expect((instructions as HTMLTextAreaElement).value).toContain(
      "You are a senior peer reviewer for a top venue",
    );
    await vi.waitFor(() => {
      expect(container.textContent).toContain("0 selected");
    });
    expect(checkboxFor("Zotero Cite").checked).toBe(false);
    expect(checkboxFor("Citation Check").checked).toBe(false);
    expect(checkboxFor("Academic Polish").checked).toBe(false);
  });
});

function checkboxFor(labelText: string): HTMLInputElement {
  const label = [...document.body.querySelectorAll("label")].find((node) =>
    node.textContent?.includes(labelText),
  );
  const input = label?.querySelector('input[type="checkbox"]');
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`checkbox missing for ${labelText}`);
  }
  return input;
}
