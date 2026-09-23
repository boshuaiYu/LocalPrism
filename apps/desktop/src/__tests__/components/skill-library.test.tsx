import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { open } from "@tauri-apps/plugin-dialog";
import {
  SkillLibrary,
  targetsForSkillImport,
} from "@/components/skills/skill-library";
import { useSettingsStore } from "@/stores/settings-store";
import { useSkillStore } from "@/stores/skill-store";
import type { RuntimeSkill, SkillTarget } from "@/runtime/types";

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

describe("targetsForSkillImport", () => {
  it("defaults to the user library and adds project only when asked", () => {
    const user: SkillTarget[] = [{ runtime: "claude", scope: "user" }];
    const both: SkillTarget[] = [
      { runtime: "claude", scope: "user" },
      { runtime: "claude", scope: "project" },
    ];

    expect(targetsForSkillImport(false, "/papers/demo")).toEqual(user);
    expect(targetsForSkillImport(true, null)).toEqual(user);
    expect(targetsForSkillImport(true, "/papers/demo")).toEqual(both);
    expect(targetsForSkillImport(true, undefined)).toEqual(user);
  });
});

describe("SkillLibrary", () => {
  let container: HTMLDivElement;
  let root: Root;
  let snapshot: ReturnType<typeof useSkillStore.getState>;
  const removeManaged = vi.fn(async () => undefined);

  beforeEach(() => {
    snapshot = useSkillStore.getState();
    removeManaged.mockReset();
    useSettingsStore.setState({ uiLanguage: "en" });
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
    expect(container.textContent).not.toContain("Import destination");
    expect(container.textContent).not.toContain("LocalPrism / user");
    expect(
      container.querySelector('[data-testid="skill-target-picker"]'),
    ).toBeNull();
    const addCard = container.querySelector('[data-testid="skill-add-card"]');
    expect(addCard?.textContent).toContain("Add skills");
    expect(addCard?.textContent).toContain("Import folder");
    expect(addCard?.textContent).toContain("Add from GitHub or URL");
    expect(addCard?.textContent).toContain(
      "GitHub repo, folder URL, .tar.gz archive, or a raw SKILL.md link.",
    );
    expect(addCard?.textContent).not.toContain("LocalPrism / project");
    expect(container.textContent).toContain("Refresh list");
    expect(container.textContent).toContain(
      "Rescan installed skills. This does not reinstall default packs.",
    );
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

  it("shows frontmatter categories and expands a folder-named category", async () => {
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
          id: "claude:user:editaplot",
          name: "EditaPlot",
          folder: "editaplot",
          description: "No category",
          sourcePath: "C:/skills/editaplot",
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
    const editaplot = container.querySelector(
      '[data-testid="skill-pack-toggle-category:editaplot"]',
    );
    expect(methods?.textContent).toContain("Methods");
    expect(methods?.getAttribute("aria-expanded")).toBe("true");
    expect(editaplot?.textContent).toContain("editaplot");
    expect(editaplot?.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).not.toContain("Uncategorized");
    expect(
      container.querySelector('[data-testid="skill-row-methods"]')?.textContent,
    ).toContain("Methods");
    expect(
      container.querySelector('[data-testid="skill-row-editaplot"]')
        ?.textContent,
    ).toContain("EditaPlot");
  });

  it("imports a folder and a URL into the user library", async () => {
    const importFolder = vi.fn(async () => undefined);
    const importUrl = vi.fn(async () => undefined);
    useSkillStore.setState({ importFolder, importUrl });
    vi.mocked(open).mockResolvedValue("/skills/demo");

    await act(async () => {
      root.render(<SkillLibrary projectPath="/papers/demo" />);
    });

    await act(async () => {
      (
        container.querySelector(
          '[data-testid="skill-import-folder"]',
        ) as HTMLButtonElement
      ).click();
    });
    expect(importFolder).toHaveBeenCalledWith(
      "/skills/demo",
      [{ runtime: "claude", scope: "user" }],
      "/papers/demo",
    );

    const input = container.querySelector(
      '[data-testid="skill-import-url-input"]',
    ) as HTMLInputElement;
    const assign = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      assign?.call(input, "https://github.com/owner/skill-repo");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      (
        container.querySelector(
          '[data-testid="skill-import-url"]',
        ) as HTMLButtonElement
      ).click();
    });
    expect(importUrl).toHaveBeenCalledWith(
      "https://github.com/owner/skill-repo",
      [{ runtime: "claude", scope: "user" }],
      "/papers/demo",
    );
  });

  it("rescans the installed list without a full reload", async () => {
    const refresh = vi.fn(async () => undefined);
    useSkillStore.setState({ refresh });

    await act(async () => {
      root.render(<SkillLibrary projectPath="/papers/demo" />);
    });
    refresh.mockClear();

    await act(async () => {
      (
        container.querySelector(
          '[data-testid="skill-refresh-list"]',
        ) as HTMLButtonElement
      ).click();
    });

    expect(refresh).toHaveBeenCalledWith("/papers/demo", { silent: true });
    expect(container.textContent).not.toContain("Loading skills…");
  });

  it("keeps project install behind an advanced option", async () => {
    const importFolder = vi.fn(async () => undefined);
    useSkillStore.setState({ importFolder });
    vi.mocked(open).mockResolvedValue("/skills/demo");

    await act(async () => {
      root.render(<SkillLibrary projectPath="/papers/demo" />);
    });

    const advanced = container.querySelector(
      '[data-testid="skill-import-advanced"]',
    ) as HTMLDetailsElement;
    expect(advanced.tagName).toBe("DETAILS");
    expect(advanced.open).toBe(false);
    const addCard = container.querySelector('[data-testid="skill-add-card"]');
    expect(addCard?.querySelectorAll("button[data-variant]").length).toBe(2);

    await act(async () => {
      (
        container.querySelector(
          '[data-testid="skill-also-project"]',
        ) as HTMLInputElement
      ).click();
    });
    await act(async () => {
      (
        container.querySelector(
          '[data-testid="skill-import-folder"]',
        ) as HTMLButtonElement
      ).click();
    });

    expect(importFolder).toHaveBeenCalledWith(
      "/skills/demo",
      [
        { runtime: "claude", scope: "user" },
        { runtime: "claude", scope: "project" },
      ],
      "/papers/demo",
    );
    expect(useSkillStore.getState().selectedTargets).toEqual([
      { runtime: "claude", scope: "user" },
    ]);
  });

  it("forgets the project copy when the open paper changes", async () => {
    const importFolder = vi.fn(async () => undefined);
    useSkillStore.setState({ importFolder });
    vi.mocked(open).mockResolvedValue("/skills/demo");

    await act(async () => {
      root.render(<SkillLibrary projectPath="/papers/demo" />);
    });
    await act(async () => {
      (
        container.querySelector(
          '[data-testid="skill-also-project"]',
        ) as HTMLInputElement
      ).click();
    });

    await act(async () => {
      root.render(<SkillLibrary projectPath="/papers/other" />);
    });
    expect(
      (
        container.querySelector(
          '[data-testid="skill-also-project"]',
        ) as HTMLInputElement
      ).checked,
    ).toBe(false);

    await act(async () => {
      (
        container.querySelector(
          '[data-testid="skill-import-folder"]',
        ) as HTMLButtonElement
      ).click();
    });
    expect(importFolder).toHaveBeenCalledWith(
      "/skills/demo",
      [{ runtime: "claude", scope: "user" }],
      "/papers/other",
    );
  });

  it("applies a project choice made while the folder dialog is open", async () => {
    const importFolder = vi.fn(async () => undefined);
    useSkillStore.setState({ importFolder });
    vi.mocked(open).mockImplementation(async () => {
      (
        document.querySelector(
          '[data-testid="skill-also-project"]',
        ) as HTMLInputElement
      ).click();
      return "/skills/demo";
    });

    await act(async () => {
      root.render(<SkillLibrary projectPath="/papers/demo" />);
    });
    await act(async () => {
      (
        container.querySelector(
          '[data-testid="skill-import-folder"]',
        ) as HTMLButtonElement
      ).click();
    });

    expect(importFolder).toHaveBeenCalledWith(
      "/skills/demo",
      [
        { runtime: "claude", scope: "user" },
        { runtime: "claude", scope: "project" },
      ],
      "/papers/demo",
    );
    expect(useSkillStore.getState().selectedTargets).toEqual([
      { runtime: "claude", scope: "user" },
    ]);
  });

  it("hides the project option when no paper is open", async () => {
    await act(async () => {
      root.render(<SkillLibrary projectPath={null} />);
    });
    expect(
      container.querySelector('[data-testid="skill-import-advanced"]'),
    ).toBeNull();
  });

  it("uses Chinese labels for the add and refresh controls", async () => {
    useSettingsStore.setState({ uiLanguage: "zh" });
    await act(async () => {
      root.render(<SkillLibrary projectPath="/papers/demo" />);
    });
    expect(container.textContent).toContain("添加技能");
    expect(container.textContent).toContain("导入文件夹");
    expect(container.textContent).toContain("从 GitHub 或链接添加");
    expect(container.textContent).toContain("刷新列表");
    expect(container.textContent).toContain(
      "重新扫描已安装的技能，不会重新安装默认技能包。",
    );
    expect(container.textContent).not.toContain("导入位置");
    expect(container.textContent).not.toContain("LocalPrism / 用户");
  });
});
