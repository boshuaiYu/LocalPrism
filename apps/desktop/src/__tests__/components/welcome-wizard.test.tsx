import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WelcomeWizard } from "@/components/welcome-wizard";
import {
  resetDefaultSkillPacksForTests,
  useSkillStore,
} from "@/stores/skill-store";
import type { RuntimeSkill } from "@/runtime/types";
import {
  resetClaudeEngineAutoInstallForTests,
  useClaudeSetupStore,
} from "@/stores/claude-setup-store";
import {
  isWelcomeCompleted,
  markWelcomeCompleted,
  resetWelcomeCompletedForTests,
  WELCOME_COMPLETED_KEY,
} from "@/lib/welcome";

vi.mock("@/components/runtime/runtime-settings", () => ({
  RuntimeSettings: () => (
    <div data-testid="runtime-settings">Runtime settings</div>
  ),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));

describe("WelcomeWizard", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetWelcomeCompletedForTests();
    resetClaudeEngineAutoInstallForTests();
    useClaudeSetupStore.setState({
      status: "not-installed",
      isInstalling: false,
      error: null,
      version: null,
      ensureEngine: vi.fn(async () => undefined),
    });
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "check_uv_status") {
        return { installed: false, binary_path: null, version: null };
      }
      if (command === "check_skills_installed") {
        return { installed: false, skill_count: 0, location: "" };
      }
      if (command === "skill_list") {
        return [];
      }
      return undefined;
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
    resetWelcomeCompletedForTests();
    resetClaudeEngineAutoInstallForTests();
    useClaudeSetupStore.setState({
      ensureEngine: useClaudeSetupStore.getInitialState().ensureEngine,
    });
  });

  async function renderWizard(onComplete?: () => void): Promise<void> {
    await act(async () => {
      root.render(<WelcomeWizard onComplete={onComplete} />);
      await Promise.resolve();
    });
  }

  function buttonNamed(name: string): HTMLButtonElement {
    const button = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === name,
    );
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error(`${name} button was not rendered`);
    }
    return button;
  }

  it("shows the wizard on first launch", async () => {
    await renderWizard();

    expect(
      container.querySelector('[data-testid="welcome-wizard"]'),
    ).not.toBeNull();
    expect(container.textContent).toMatch(/Welcome/i);
    expect(container.textContent).toMatch(/Python \(uv\)/);
    expect(container.textContent).toMatch(/Writing engine/);
    expect(container.textContent).toMatch(/PaperSpine/);
    expect(container.textContent).not.toMatch(/Scientific Skills/);
    expect(
      Array.from(container.querySelectorAll("button")).some(
        (button) => button.textContent?.trim() === "Manage",
      ),
    ).toBe(false);
    expect(
      container.querySelector('[data-testid="runtime-settings"]'),
    ).not.toBeNull();
  });

  it("shows scientific pack status on the default packs row", async () => {
    resetDefaultSkillPacksForTests();
    useSkillStore.setState({
      skills: [],
      loading: false,
      error: null,
      installingPackId: null,
    });
    const folders = [
      "paper-spine",
      "deep-research",
      "nature-polishing",
      "scanpy",
      "biopython",
      "rdkit",
      "paper-humanizer",
    ];
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "check_uv_status") {
        return { installed: true, binary_path: "uv", version: "uv 0.11.19" };
      }
      if (command === "skill_list") {
        return folders.map(
          (folder): RuntimeSkill => ({
            id: folder,
            name: folder,
            description: "",
            folder,
            sourcePath: folder,
            targets: [],
            managed: true,
            compatibleRuntimes: ["claude"],
            enabled: true,
            discoveryError: null,
          }),
        );
      }
      if (command === "slash_commands_list") {
        return [
          { name: "paperspine", scope: "user" },
          { name: "ars-plan", scope: "user" },
          { name: "ars-lit-review", scope: "user" },
        ];
      }
      if (command === "list_agents") {
        return [];
      }
      return undefined;
    });

    await renderWizard();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).not.toMatch(/Scientific Skills/);
    expect(container.textContent).toMatch(/7 skills/);
    expect(container.textContent).toMatch(
      /PaperSpine and default skill packs installed/,
    );
    expect(
      Array.from(container.querySelectorAll("button")).some(
        (button) => button.textContent?.trim() === "Manage",
      ),
    ).toBe(false);
  });

  it("marks welcome completed and hides the wizard on skip", async () => {
    let completed = false;
    await renderWizard(() => {
      completed = true;
    });

    await act(async () => buttonNamed("Skip").click());

    expect(completed).toBe(true);
    expect(isWelcomeCompleted()).toBe(true);
    expect(localStorage.getItem(WELCOME_COMPLETED_KEY)).toBe("true");
    expect(
      container.querySelector('[data-testid="welcome-wizard"]'),
    ).toBeNull();
  });

  it("does not show paper templates that already live in New Project", async () => {
    await renderWizard();

    expect(container.textContent).not.toMatch(/Paper templates/i);
    expect(container.textContent).not.toMatch(/IEEE Conference/i);
    expect(container.textContent).not.toMatch(/Elsevier/);
    expect(
      Array.from(container.querySelectorAll("button")).some(
        (button) => button.textContent?.trim() === "Continue",
      ),
    ).toBe(false);
  });

  it("finishes from the setup step", async () => {
    let completed = false;
    await renderWizard(() => {
      completed = true;
    });

    await act(async () => buttonNamed("Get started").click());

    expect(completed).toBe(true);
    expect(isWelcomeCompleted()).toBe(true);
    expect(
      container.querySelector('[data-testid="welcome-wizard"]'),
    ).toBeNull();
  });
});

describe("welcome persistence", () => {
  beforeEach(() => {
    resetWelcomeCompletedForTests();
  });

  it("treats a missing key as first launch", () => {
    expect(isWelcomeCompleted()).toBe(false);
  });

  it("persists completion under localprism-welcome-v1", () => {
    markWelcomeCompleted();
    expect(localStorage.getItem(WELCOME_COMPLETED_KEY)).toBe("true");
    expect(isWelcomeCompleted()).toBe(true);
  });
});
