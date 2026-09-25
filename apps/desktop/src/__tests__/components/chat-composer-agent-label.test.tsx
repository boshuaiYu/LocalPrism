import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatComposer } from "@/components/claude-chat/chat-composer";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BUILTIN_AGENT_PRESETS } from "@/lib/agent-presets";
import type { AgentProfile } from "@/runtime/types";
import { emptyAgentProfile, useAgentStore } from "@/stores/agent-store";
import {
  CLAUDE_CODE_PROVIDER_ID,
  useClaudeChatStore,
} from "@/stores/claude-chat-store";
import { useClaudeSetupStore } from "@/stores/claude-setup-store";
import { useDocumentStore } from "@/stores/document-store";
import { useRuntimeStore } from "@/stores/runtime-store";
import { useSettingsStore } from "@/stores/settings-store";

const invokeMock = vi.mocked(invoke);

function presetAgent(id: string, name: string): AgentProfile {
  return {
    ...emptyAgentProfile("claude", "user"),
    id,
    name,
    sourcePath: `/agents/${id}.md`,
  };
}

const builtinAgents = BUILTIN_AGENT_PRESETS.map((preset) =>
  presetAgent(preset.id, preset.name),
);

describe("ChatComposer agent label", () => {
  let container: HTMLDivElement;
  let root: Root;
  const chatSnapshot = useClaudeChatStore.getState();
  const setupSnapshot = useClaudeSetupStore.getState();
  const documentSnapshot = useDocumentStore.getState();
  const runtimeSnapshot = useRuntimeStore.getState();
  const agentSnapshot = useAgentStore.getState();
  const settingsSnapshot = useSettingsStore.getState();

  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_agents") return Promise.resolve(builtinAgents);
      return Promise.resolve([]);
    });
    useDocumentStore.setState({ projectRoot: "C:/project" });
    useClaudeSetupStore.setState({
      status: "ready",
      providerKind: "claude-code",
      claudeProviderConfigured: true,
      openAiCredentials: [],
      activeOpenAiCredentialId: null,
    });
    useRuntimeStore.setState({
      accounts: {
        claude: {
          runtime: "claude",
          installed: true,
          authenticated: true,
          version: "1.0.0",
          accountLabel: null,
          authMode: null,
          capabilities: {
            models: true,
            skills: true,
            customAgents: true,
            subagents: true,
            approvals: true,
          },
          error: null,
        },
        codex: {
          runtime: "codex",
          installed: true,
          authenticated: true,
          version: "1.0.0",
          accountLabel: null,
          authMode: null,
          capabilities: {
            models: true,
            skills: true,
            customAgents: true,
            subagents: true,
            approvals: true,
          },
          error: null,
        },
      },
      models: { claude: [], codex: [] },
      loading: {},
      login: {},
    });
    const baseTab = chatSnapshot.tabs[0];
    useClaudeChatStore.setState({
      tabs: [
        {
          ...baseTab,
          id: "tab-agent",
          projectPath: "C:/project",
          runtime: "claude",
          chatPeer: "claude",
          providerKey: null,
          agentId: "de-ai",
          isStreaming: false,
        },
      ],
      activeTabId: "tab-agent",
      activeProjectPath: "C:/project",
      selectedProviderCredentialId: CLAUDE_CODE_PROVIDER_ID,
      selectedProviderModels: {},
      messages: [],
      sessionId: null,
      isStreaming: false,
    });
    useAgentStore.setState({
      agents: builtinAgents,
      loading: false,
      error: null,
    });
    useSettingsStore.setState({ uiLanguage: "en" });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    useClaudeChatStore.setState(chatSnapshot, true);
    useClaudeSetupStore.setState(setupSnapshot, true);
    useDocumentStore.setState(documentSnapshot, true);
    useRuntimeStore.setState(runtimeSnapshot, true);
    useAgentStore.setState(agentSnapshot, true);
    useSettingsStore.setState(settingsSnapshot, true);
  });

  async function renderComposer() {
    await act(async () => {
      root.render(
        <TooltipProvider>
          <ChatComposer />
        </TooltipProvider>,
      );
    });
  }

  function agentButton(): HTMLButtonElement {
    const button = document.querySelector('[data-tour="tour-agent-switch"]');
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error("Agent switch button not found");
    }
    return button;
  }

  it("shows only the selected agent name, without an English secondary", async () => {
    await renderComposer();

    await vi.waitFor(() => {
      expect(agentButton().textContent?.trim()).toBe("AI消除器");
    });

    expect(document.querySelector('[data-testid="reply-mode"]')).toBeNull();
    const leading = container.querySelector(
      '[data-testid="composer-controls-leading"]',
    );
    for (const extra of [
      "De-AI",
      "Polish Lab",
      "Review Duo",
      "Polish",
      "Review",
      "Custom",
    ]) {
      expect(leading?.textContent ?? "").not.toContain(extra);
    }

    await act(async () => {
      agentButton().click();
    });

    const menu = document.querySelector('[data-tour="tour-agent-menu"]');
    expect(menu).toBeTruthy();
    const labels = [
      ...(menu?.querySelectorAll('[role="menuitemradio"]') ?? []),
    ].map((item) => item.textContent?.replace("✓", "").trim());
    expect(labels).toEqual(["Default", "论文抛光机", "AI消除器", "毒舌审稿官"]);
    for (const preset of BUILTIN_AGENT_PRESETS) {
      expect(menu?.textContent ?? "").not.toContain(preset.titleSecondary);
    }

    const polish = [...(menu?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent?.includes("论文抛光机"),
    );
    expect(polish).toBeInstanceOf(HTMLButtonElement);
    await act(async () => {
      (polish as HTMLButtonElement).click();
    });

    expect(
      useClaudeChatStore.getState().tabs.find((tab) => tab.id === "tab-agent")
        ?.agentId,
    ).toBe("academic-polish");
    expect(agentButton().textContent?.trim()).toBe("论文抛光机");
    expect(document.querySelector('[data-testid="reply-mode"]')).toBeNull();
  });
});
