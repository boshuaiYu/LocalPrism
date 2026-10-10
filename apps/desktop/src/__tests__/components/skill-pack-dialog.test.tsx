import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { ScientificSkillsOnboarding } from "@/components/scientific-skills/scientific-skills-onboarding";
import { PAPERSPINE_SKILLS_URL } from "@/lib/paperspine";
import { SCIENTIFIC_AGENT_SKILLS_URL } from "@/lib/default-skill-packs";
import { useSettingsStore } from "@/stores/settings-store";
import { defaultSkillTargets, useSkillStore } from "@/stores/skill-store";
import type { RuntimeSkill } from "@/runtime/types";

function skill(overrides: Partial<RuntimeSkill> = {}): RuntimeSkill {
  return {
    id: "claude:user:paper-spine",
    name: "PaperSpine",
    description: "Paper workflow",
    folder: "paper-spine",
    sourcePath: "/skills/paper-spine",
    sourceUrl: PAPERSPINE_SKILLS_URL,
    targets: [{ runtime: "claude", scope: "user" }],
    managed: true,
    compatibleRuntimes: ["claude"],
    enabled: true,
    discoveryError: null,
    ...overrides,
  };
}

describe("ScientificSkillsOnboarding pack actions", () => {
  let container: HTMLDivElement;
  let root: Root;
  let snapshot: ReturnType<typeof useSkillStore.getState>;

  beforeEach(() => {
    snapshot = useSkillStore.getState();
    useSettingsStore.setState({ uiLanguage: "en" });
    useSkillStore.setState({
      skills: [
        skill(),
        skill({
          id: "claude:user:scanpy",
          name: "Scanpy",
          folder: "scanpy",
          sourcePath: "/skills/scanpy",
          sourceUrl: SCIENTIFIC_AGENT_SKILLS_URL,
        }),
      ],
      loading: false,
      error: null,
      selectedTargets: defaultSkillTargets(),
      refresh: async () => undefined,
      importFolder: async () => ({
        skills: [],
        added: [],
        updated: [],
        unchanged: [],
        removed: [],
        errors: [],
      }),
      importUrl: async () => ({
        skills: [],
        added: [],
        updated: [],
        unchanged: [],
        removed: [],
        errors: [],
      }),
    });
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === "check_skills_installed") {
        return { installed: true, skill_count: 2, location: "/skills" };
      }
      if (command === "list_installed_skills") {
        return [
          {
            id: "paper-spine",
            name: "PaperSpine",
            domain: "",
            description: "",
            folder: "paper-spine",
          },
          {
            id: "scanpy",
            name: "Scanpy",
            domain: "",
            description: "",
            folder: "scanpy",
          },
        ];
      }
      if (command === "get_skill_categories") return [];
      if (command === "skill_pack_preferences") {
        return { version: 1, optedOutPackIds: [], retiredPacksPurged: [] };
      }
      if (command === "skill_refresh_pack") {
        return {
          id: "paper-spine",
          name: "PaperSpine",
          added: [],
          updated: ["PaperSpine"],
          removed: [],
          unchanged: [],
        };
      }
      if (command === "skill_remove_pack") {
        return {
          id: "paper-spine",
          name: "PaperSpine",
          added: [],
          updated: [],
          removed: ["PaperSpine"],
          unchanged: [],
        };
      }
      return [];
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
    document.body.innerHTML = "";
    useSkillStore.setState(snapshot, true);
    vi.mocked(invoke).mockReset();
  });

  async function renderDialog() {
    await act(async () => {
      root.render(<ScientificSkillsOnboarding onClose={() => undefined} />);
    });
  }

  it("updates only the selected pack after naming it in the download confirm", async () => {
    await renderDialog();
    await act(async () => {
      (
        document.body.querySelector(
          '[data-testid="skill-pack-update"]',
        ) as HTMLButtonElement
      ).click();
    });

    const confirm = document.body.querySelector(
      '[data-testid="skill-download-confirm"]',
    );
    expect(confirm?.textContent).toContain("PaperSpine");
    expect(confirm?.textContent).not.toContain("scientific-agent-skills");

    await act(async () => {
      (
        document.body.querySelector(
          '[data-testid="skill-download-confirm-action"]',
        ) as HTMLButtonElement
      ).click();
    });

    expect(invoke).toHaveBeenCalledWith("skill_refresh_pack", {
      sourceUrl: PAPERSPINE_SKILLS_URL,
      sourceFolder: null,
      targets: [{ runtime: "claude", scope: "user" }],
      projectPath: null,
    });
    expect(
      vi
        .mocked(invoke)
        .mock.calls.some(
          ([command, args]) =>
            command === "skill_refresh_pack" &&
            String((args as { sourceUrl?: string }).sourceUrl ?? "").includes(
              "scientific-agent-skills",
            ),
        ),
    ).toBe(false);
    expect(
      document.body.querySelector('[data-testid="skill-update-summary"]')
        ?.textContent,
    ).toContain("PaperSpine");
  });

  it("uninstalls the selected pack after confirming its name and skill count", async () => {
    await renderDialog();
    await act(async () => {
      (
        document.body.querySelector(
          '[data-testid="skill-pack-uninstall"]',
        ) as HTMLButtonElement
      ).click();
    });

    const confirm = document.body.querySelector(
      '[data-testid="skill-pack-uninstall-confirm"]',
    );
    expect(confirm?.textContent).toContain("PaperSpine");
    expect(confirm?.textContent).toContain("1");

    await act(async () => {
      (
        document.body.querySelector(
          '[data-testid="skill-pack-uninstall-confirm-action"]',
        ) as HTMLButtonElement
      ).click();
    });

    expect(invoke).toHaveBeenCalledWith("skill_remove_pack", {
      sourceUrl: PAPERSPINE_SKILLS_URL,
      sourceFolder: null,
      defaultPackId: "paper-spine",
      optOut: true,
    });
  });

  it("keeps uninstall-all inside the overflow menu and offers folder, zip, and link import", async () => {
    await renderDialog();
    const more = document.body.querySelector('[data-testid="skill-pack-more"]');
    expect(
      more?.querySelector('[data-testid="skill-pack-uninstall-all"]'),
    ).toBeTruthy();
    expect(
      document.body
        .querySelector('[data-testid="skill-pack-update"]')
        ?.parentElement?.querySelector(
          ":scope > [data-testid='skill-pack-uninstall-all']",
        ),
    ).toBeNull();

    await act(async () => {
      (
        document.body.querySelector(
          '[data-testid="skill-import-open"]',
        ) as HTMLButtonElement
      ).click();
    });
    expect(
      document.body.querySelector('[data-testid="skill-dialog-import-folder"]'),
    ).toBeTruthy();
    expect(
      document.body.querySelector(
        '[data-testid="skill-dialog-import-archive"]',
      ),
    ).toBeTruthy();
    expect(
      document.body.querySelector('[data-testid="skill-dialog-import-url"]'),
    ).toBeTruthy();
  });
});
