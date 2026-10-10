import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsDialog } from "@/components/settings/settings-dialog";
import { useSettingsStore } from "@/stores/settings-store";

vi.mock("@/components/runtime/runtime-settings", () => ({
  RuntimeSettings: () => (
    <div data-testid="runtime-settings">Providers body</div>
  ),
}));

vi.mock("@/components/skills/skill-library", () => ({
  SkillLibrary: () => <div data-testid="skill-library">Skills body</div>,
}));

vi.mock("@/components/agents/agent-library", () => ({
  AgentLibrary: () => <div data-testid="agent-library">Agents body</div>,
}));

function activePanel(): HTMLElement {
  const panel = document.body.querySelector(
    '[role="tabpanel"][data-state="active"]',
  );
  if (!(panel instanceof HTMLElement)) {
    throw new Error("Missing active tab panel");
  }
  return panel;
}

function tabLabels(): string[] {
  return [...document.body.querySelectorAll('[role="tab"]')].map(
    (tab) => tab.textContent?.trim() ?? "",
  );
}

async function activateTab(label: string) {
  const tab = [...document.body.querySelectorAll('[role="tab"]')].find(
    (node) => node.textContent?.trim() === label,
  );
  if (!(tab instanceof HTMLElement)) {
    throw new Error(`Missing tab ${label}`);
  }
  await act(async () => {
    tab.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0 }),
    );
  });
}

describe("SettingsDialog", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    useSettingsStore.setState({ uiLanguage: "en" });
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
    document.body.querySelector("[role='dialog']")?.remove();
    useSettingsStore.setState({ latexTeaching: false, uiLanguage: "en" });
  });

  it("omits the language switch and does not put updates in Providers", async () => {
    await act(async () => {
      root.render(
        <SettingsDialog open onOpenChange={vi.fn()} defaultTab="agents" />,
      );
    });

    expect(
      document.body.querySelector('[data-testid="settings-language"]'),
    ).toBeNull();
    expect(
      document.body.querySelector('[data-testid="language-switch"]'),
    ).toBeNull();

    const agents = activePanel();
    expect(agents.textContent).toContain("Agents body");
    expect(agents.querySelector('[data-testid="update-settings"]')).toBeNull();
    expect(agents.textContent).not.toContain("Debian");
    expect(
      document.body.querySelector('[data-testid="update-settings"]'),
    ).toBeNull();

    const providersTab = [
      ...document.body.querySelectorAll('[role="tab"]'),
    ].find((tab) => tab.textContent?.trim() === "Providers");
    if (!(providersTab instanceof HTMLElement)) {
      throw new Error("Providers tab missing");
    }
    await act(async () => {
      providersTab.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, button: 0 }),
      );
    });

    const providers = activePanel();
    expect(providers.textContent).toContain("Providers body");
    expect(
      providers.querySelector('[data-testid="update-settings"]'),
    ).toBeNull();
    expect(providers.textContent).not.toContain("Debian");
    expect(providers.textContent).not.toContain("Check for updates");
    expect(providers.textContent).not.toContain("Agents body");
    expect(tabLabels()).toEqual(["Providers", "Skills", "Agents", "Preview"]);
    expect(
      document.body.querySelector('[data-testid="latex-teaching-settings"]'),
    ).toBeNull();
    expect(agents.textContent).not.toContain("Enable LaTeX teaching");
  });

  it("keeps LaTeX teaching on the Preview tab and persists the toggle", async () => {
    useSettingsStore.setState({ latexTeaching: false, uiLanguage: "zh" });
    await act(async () => {
      root.render(<SettingsDialog open onOpenChange={vi.fn()} />);
    });

    expect(tabLabels()).toEqual(["服务商", "技能", "智能体", "实验功能"]);
    expect(tabLabels()).not.toContain("编辑器");
    expect(
      document.body.querySelector('[data-testid="latex-teaching-settings"]'),
    ).toBeNull();
    expect(document.body.textContent).not.toContain("启用 LaTeX 教学");

    await activateTab("实验功能");

    const preview = activePanel();
    const teaching = preview.querySelector(
      '[data-testid="latex-teaching-settings"]',
    );
    const tablist = document.body.querySelector('[role="tablist"]');
    expect(teaching).toBeInstanceOf(HTMLElement);
    expect(
      tablist &&
        teaching &&
        tablist.compareDocumentPosition(teaching) &
          Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(preview.textContent).toContain("启用 LaTeX 教学");
    expect(preview.textContent).toContain("预览 · 超前功能");
    expect(preview.textContent).toContain("校对");
    expect(preview.textContent).toContain("讲解");
    expect(preview.textContent).not.toContain("不报错也会讲");
    expect(preview.querySelector(".border-amber-500\\/35")).toBeNull();
    expect(activePanel().textContent).not.toContain("Providers body");

    const toggle = preview.querySelector(
      '[data-testid="latex-teaching-toggle"]',
    );
    expect(toggle?.getAttribute("aria-checked")).toBe("false");

    await act(async () => {
      if (toggle instanceof HTMLButtonElement) toggle.click();
    });
    expect(useSettingsStore.getState().latexTeaching).toBe(true);
    expect(toggle?.getAttribute("aria-checked")).toBe("true");

    await act(async () => {
      if (toggle instanceof HTMLButtonElement) toggle.click();
    });
    expect(useSettingsStore.getState().latexTeaching).toBe(false);

    await activateTab("服务商");
    expect(
      document.body.querySelector('[data-testid="latex-teaching-settings"]'),
    ).toBeNull();
    expect(activePanel().textContent).toContain("Providers body");
  });

  it("opens Preview directly when that tab is requested", async () => {
    useSettingsStore.setState({ latexTeaching: false, uiLanguage: "en" });
    await act(async () => {
      root.render(
        <SettingsDialog open onOpenChange={vi.fn()} defaultTab="preview" />,
      );
    });

    const preview = activePanel();
    expect(preview.textContent).toContain("Enable LaTeX teaching");
    expect(preview.textContent).toContain("Explain beside Proofread");
    expect(
      preview.querySelector('[data-testid="latex-teaching-toggle"]'),
    ).not.toBeNull();
    expect(preview.textContent).not.toContain("Editor and teaching");
  });
});
