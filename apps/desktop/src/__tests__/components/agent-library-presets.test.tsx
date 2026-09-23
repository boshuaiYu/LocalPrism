import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { AgentLibrary } from "@/components/agents/agent-library";
import { useAgentStore } from "@/stores/agent-store";
import { useDocumentStore } from "@/stores/document-store";
import { useSkillStore } from "@/stores/skill-store";
import type { RuntimeSkill } from "@/runtime/types";

function skill(overrides: Partial<RuntimeSkill> = {}): RuntimeSkill {
  return {
    id: "claude:user:nature-polishing",
    name: "Nature Polishing",
    description: "LaTeX-safe academic polish",
    folder: "nature-polishing",
    sourcePath: "C:/skills/nature-polishing",
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
    id: "claude:user:humanizer-academic-zh",
    name: "Humanizer",
    folder: "humanizer-academic-zh",
    description: "Reduce AI-like academic prose",
    sourcePath: "C:/skills/humanizer-academic-zh",
  }),
  skill({
    id: "claude:project:zotero-cite",
    name: "Zotero Cite",
    folder: "zotero-cite",
    description: "Check cite keys against the library",
    sourcePath: "/paper/.localprism/skills/zotero-cite",
    targets: [{ runtime: "claude", scope: "project" }],
  }),
];

describe("AgentLibrary presets", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation((command: string, args?: unknown) => {
      if (command === "skill_list") return Promise.resolve(catalog);
      if (command === "list_agents") return Promise.resolve([]);
      if (command === "save_agent") {
        const profile = (args as { profile: { id: string } }).profile;
        return Promise.resolve({
          ...profile,
          sourcePath: `C:/agents/${profile.id}.md`,
        });
      }
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
    useDocumentStore.setState({
      projectRoot: "/paper",
      files: [
        {
          id: "references.bib",
          name: "references.bib",
          relativePath: "references.bib",
          absolutePath: "/paper/references.bib",
          type: "bib",
          content: "@article{doe2019,\n  title = {Sample}\n}\n",
          isDirty: false,
        },
      ],
    });
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

  it("offers the three presets and a custom agent on an empty list", async () => {
    root.render(<AgentLibrary projectPath="/paper" />);

    await vi.waitFor(() => {
      expect(container.textContent).toContain("润色");
    });
    expect(container.textContent).toContain("去AI");
    expect(container.textContent).toContain("Peer Review");
    expect(container.textContent).toContain("清晰度");
    expect(container.textContent?.toLowerCase()).toContain("clarity");
    expect(container.textContent).toContain("审稿");
    expect(container.textContent?.toLowerCase()).toContain("peer review");
    expect(container.textContent).toContain("Custom agent");
    expect(
      container.querySelector("[data-testid='agent-preset-academic-polish']"),
    ).toBeTruthy();
    expect(
      container.querySelector("[data-testid='agent-preset-custom']"),
    ).toBeTruthy();
  });

  it("creates a preset with the embedded prompt and matching installed skills", async () => {
    root.render(<AgentLibrary projectPath="/paper" />);

    const polish = await vi.waitFor(() => {
      const node = container.querySelector(
        "[data-testid='agent-preset-academic-polish']",
      );
      if (!(node instanceof HTMLButtonElement)) {
        throw new Error("polish preset missing");
      }
      return node;
    });
    polish.click();

    await vi.waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalledWith(
        "save_agent",
        expect.objectContaining({
          overwrite: false,
          projectPath: "/paper",
          profile: expect.objectContaining({
            id: "academic-polish",
            name: "润色",
            skillIds: ["nature-polishing"],
            instructions: expect.stringContaining(
              "You are an expert academic editor for LaTeX research papers",
            ),
          }),
        }),
      );
    });

    const saved = vi
      .mocked(invoke)
      .mock.calls.find((call) => call[0] === "save_agent")?.[1] as {
      profile: { description: string; skillIds: string[] };
    };
    expect(saved.profile.description).toContain("清晰度");
    expect(saved.profile.description.toLowerCase()).toContain("clarity");
    expect(saved.profile.skillIds).not.toContain("humanizer-academic-zh");
    expect(vi.mocked(invoke).mock.calls.map((call) => call[0])).not.toContain(
      "skill_import",
    );
  });

  it("attaches a project citation skill and bib context when creating peer review", async () => {
    root.render(<AgentLibrary projectPath="/paper" />);

    const review = await vi.waitFor(() => {
      const node = container.querySelector(
        "[data-testid='agent-preset-peer-review']",
      );
      if (!(node instanceof HTMLButtonElement)) {
        throw new Error("peer review preset missing");
      }
      return node;
    });
    review.click();

    await vi.waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalledWith(
        "save_agent",
        expect.objectContaining({
          profile: expect.objectContaining({
            id: "peer-review",
            name: "Peer Review",
            scope: "user",
            skillIds: ["zotero-cite"],
            instructions: expect.stringContaining(
              "Never invent papers or DOIs.",
            ),
          }),
        }),
      );
    });
    const saved = vi
      .mocked(invoke)
      .mock.calls.find((call) => call[0] === "save_agent")?.[1] as {
      profile: { instructions: string };
    };
    expect(saved.profile.instructions).not.toContain("doe2019");
  });
});
