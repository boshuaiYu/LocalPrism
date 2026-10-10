import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

const { toastSuccess } = vi.hoisted(() => ({ toastSuccess: vi.fn() }));

vi.mock("sonner", () => ({
  toast: {
    success: toastSuccess,
    error: vi.fn(),
    message: vi.fn(),
  },
}));
import { ScientificSkillsOnboarding } from "@/components/scientific-skills/scientific-skills-onboarding";
import { PAPERSPINE_SKILLS_URL } from "@/lib/paperspine";
import { SCIENTIFIC_AGENT_SKILLS_URL } from "@/lib/default-skill-packs";
import { useSettingsStore } from "@/stores/settings-store";
import { defaultSkillTargets, useSkillStore } from "@/stores/skill-store";
import type { RuntimeSkill } from "@/runtime/types";

function refreshReport(sourceUrl: string) {
  if (sourceUrl.includes("nature-skills")) {
    return {
      id: "nature-skills",
      name: "nature-skills",
      added: ["nature-polishing"],
      updated: ["nature-figure", "nature-writing", "nature-citation"],
      removed: [],
      unchanged: ["nature-data"],
    };
  }
  if (sourceUrl.includes("paper-humanizer")) {
    return Promise.reject(new Error("network down"));
  }
  if (sourceUrl.includes("PaperSpine")) {
    return {
      id: "paper-spine",
      name: "PaperSpine",
      added: [],
      updated: ["PaperSpine"],
      removed: [],
      unchanged: [],
    };
  }
  return {
    id: "",
    name: "",
    added: [],
    updated: [],
    removed: [],
    unchanged: ["kept"],
  };
}

function mockSkillsCommands(
  refresh: (sourceUrl: string) => unknown = () => ({
    id: "paper-spine",
    name: "PaperSpine",
    added: [],
    updated: ["PaperSpine"],
    removed: [],
    unchanged: [],
  }),
) {
  vi.mocked(invoke).mockImplementation(
    async (command: string, args?: unknown) => {
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
        const sourceUrl = String(
          (args as { sourceUrl?: string } | undefined)?.sourceUrl ?? "",
        );
        return refresh(sourceUrl);
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
    },
  );
}

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
    mockSkillsCommands();
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
    toastSuccess.mockReset();
  });

  async function renderDialog() {
    await act(async () => {
      root.render(<ScientificSkillsOnboarding onClose={() => undefined} />);
    });
  }

  async function confirmUpdate(buttonSelector: string) {
    await act(async () => {
      (
        document.body.querySelector(buttonSelector) as HTMLButtonElement
      ).click();
    });
    await act(async () => {
      (
        document.body.querySelector(
          '[data-testid="skill-download-confirm-action"]',
        ) as HTMLButtonElement
      ).click();
    });
  }

  function packRows(): HTMLDetailsElement[] {
    return [
      ...document.body.querySelectorAll('[data-testid="skill-update-pack"]'),
    ] as HTMLDetailsElement[];
  }

  function summaryText(row: Element | null | undefined): string {
    return (
      row?.querySelector('[data-testid="skill-update-pack-summary"]')
        ?.textContent ?? ""
    );
  }

  function listedNames(
    row: Element | null | undefined,
    testId: string,
  ): string[] {
    return [
      ...(row?.querySelectorAll(`[data-testid="${testId}"] li`) ?? []),
    ].map((item) => item.textContent ?? "");
  }

  function sectionLabel(
    row: Element | null | undefined,
    testId: string,
  ): string {
    return row?.querySelector(`[data-testid="${testId}"] p`)?.textContent ?? "";
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
    const row = document.body.querySelector(
      '[data-testid="skill-update-pack"]',
    ) as HTMLDetailsElement | null;
    expect(row?.open).toBe(true);
    expect(
      row?.querySelector('[data-testid="skill-update-pack-summary"]')
        ?.textContent,
    ).toBe("PaperSpine · Added 0 · Updated 1 · Removed 0");
    expect(listedNames(row, "skill-update-updated")).toEqual(["PaperSpine"]);
    expect(listedNames(row, "skill-update-added")).toEqual([]);
    expect(listedNames(row, "skill-update-removed")).toEqual([]);
    expect(listedNames(row, "skill-update-unchanged")).toEqual([]);
  });

  it("shows an already-current pack in the selected language and lists unchanged skills", async () => {
    useSettingsStore.setState({ uiLanguage: "zh" });
    mockSkillsCommands(() => ({
      id: "nature-skills",
      name: "nature-skills",
      added: [],
      updated: [],
      removed: [],
      unchanged: ["nature-polishing", "nature-figure"],
    }));
    await renderDialog();
    await confirmUpdate('[data-testid="skill-pack-update"]');

    const row = packRows()[0];
    expect(row?.open).toBe(true);
    expect(summaryText(row)).toBe("nature-skills · 已是最新");
    expect(listedNames(row, "skill-update-unchanged")).toEqual([
      "nature-polishing",
      "nature-figure",
    ]);
    expect(row?.textContent).toContain("未变化");
    expect(row?.textContent).toContain("无");
  });

  it("lists skill names under each change group for one pack", async () => {
    useSettingsStore.setState({ uiLanguage: "zh" });
    mockSkillsCommands(() => ({
      id: "nature-skills",
      name: "nature-skills",
      added: ["nature-polishing"],
      updated: ["nature-figure", "nature-writing", "nature-citation"],
      removed: [],
      unchanged: ["nature-data"],
    }));
    await renderDialog();
    await confirmUpdate('[data-testid="skill-pack-update"]');

    const row = packRows()[0];
    expect(row?.open).toBe(true);
    expect(summaryText(row)).toBe("nature-skills · 新增 1 · 更新 3 · 移除 0");
    expect(sectionLabel(row, "skill-update-added")).toBe("新增");
    expect(listedNames(row, "skill-update-added")).toEqual([
      "nature-polishing",
    ]);
    expect(sectionLabel(row, "skill-update-updated")).toBe("已更新");
    expect(listedNames(row, "skill-update-updated")).toEqual([
      "nature-figure",
      "nature-writing",
      "nature-citation",
    ]);
    expect(sectionLabel(row, "skill-update-removed")).toBe("已移除");
    expect(listedNames(row, "skill-update-removed")).toEqual([]);
    expect(sectionLabel(row, "skill-update-unchanged")).toBe("未变化");
    expect(listedNames(row, "skill-update-unchanged")).toEqual(["nature-data"]);
  });

  it("collapses many packs and still shows each count on the row", async () => {
    mockSkillsCommands(refreshReport);
    await renderDialog();
    await confirmUpdate('[data-testid="skill-pack-update-all"]');

    const rows = packRows();
    expect(rows.map((row) => summaryText(row))).toEqual([
      "PaperSpine · Added 0 · Updated 1 · Removed 0",
      "academic-research-skills · Already up to date",
      "nature-skills · Added 1 · Updated 3 · Removed 0",
      "paper-humanizer-skill — Error: network down",
      "scientific-agent-skills · Already up to date",
    ]);
    expect(rows.map((row) => row.open)).toEqual([
      false,
      false,
      false,
      true,
      false,
    ]);
    expect(listedNames(rows[2], "skill-update-added")).toEqual([
      "nature-polishing",
    ]);
    expect(listedNames(rows[2], "skill-update-updated")).toEqual([
      "nature-figure",
      "nature-writing",
      "nature-citation",
    ]);
    expect(summaryText(rows[3])).toContain("network down");
    expect(summaryText(rows[3])).not.toContain("Added");
    expect(sectionLabel(rows[3], "skill-update-added")).toBe("Added");
  });

  it("keeps the update-failed dialog when every pack fails", async () => {
    mockSkillsCommands(() => Promise.reject(new Error("network down")));
    await renderDialog();
    await confirmUpdate('[data-testid="skill-pack-update"]');

    expect(document.body.textContent).toContain("Update Failed");
    const row = packRows()[0];
    expect(row?.open).toBe(true);
    expect(summaryText(row)).toBe("PaperSpine — Error: network down");
    expect(summaryText(row)).not.toContain("Added");
    expect(document.body.textContent).toContain("network down");
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
    expect(toastSuccess).toHaveBeenCalledWith("Uninstalled PaperSpine");
  });

  it("deletes one managed skill through the manifest command", async () => {
    await renderDialog();
    await act(async () => {
      (
        document.body.querySelector(
          '[aria-label="Delete PaperSpine"]',
        ) as HTMLButtonElement
      ).click();
    });
    await act(async () => {
      (
        document.body.querySelector(
          '[data-testid="skill-delete-confirm"]',
        ) as HTMLButtonElement
      ).click();
    });
    expect(invoke).toHaveBeenCalledWith("skill_delete_managed", {
      entryId: "claude:user:paper-spine",
      confirmModified: false,
    });
    expect(
      vi
        .mocked(invoke)
        .mock.calls.some(([command]) => command === "delete_installed_skill"),
    ).toBe(false);
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
