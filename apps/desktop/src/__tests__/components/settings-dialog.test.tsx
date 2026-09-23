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
  });

  it("omits the language switch and keeps updates inside the Providers tab", async () => {
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
    const parkedUpdates = document.body.querySelector(
      '[data-testid="update-settings"]',
    );
    if (parkedUpdates) {
      expect(parkedUpdates.closest('[role="tabpanel"]')).not.toBe(agents);
    }

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
    ).toBeTruthy();
    expect(providers.textContent).toContain("Debian");
    expect(providers.textContent).toContain("Updates");
    expect(providers.textContent).not.toContain("Agents body");
  });
});
