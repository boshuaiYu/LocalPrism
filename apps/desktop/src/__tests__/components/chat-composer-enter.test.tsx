import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ChatComposer,
  slashQueryFromInput,
} from "@/components/claude-chat/chat-composer";
import type { SlashCommand } from "@/components/claude-chat/slash-command-picker";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BUILTIN_AGENT_PRESETS } from "@/lib/agent-presets";
import { isImeComposing } from "@/lib/ime";
import type { AgentProfile } from "@/runtime/types";
import { emptyAgentProfile, useAgentStore } from "@/stores/agent-store";
import {
  CLAUDE_CODE_PROVIDER_ID,
  useClaudeChatStore,
} from "@/stores/claude-chat-store";
import { useClaudeSetupStore } from "@/stores/claude-setup-store";
import { type ProjectFile, useDocumentStore } from "@/stores/document-store";
import { useProviderStore } from "@/stores/provider-store";
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

const planCommand: SlashCommand = {
  id: "user-ars-plan",
  name: "ars-plan",
  full_command: "/ars-plan",
  scope: "user",
  namespace: null,
  file_path: "C:/claude-home/slash/ars-plan.md",
  content: "Plan the paper.",
  description: "Plan mode",
  allowed_tools: [],
  has_bash_commands: false,
  has_file_references: false,
  accepts_arguments: true,
};

const mainTex: ProjectFile = {
  id: "main.tex",
  name: "main.tex",
  relativePath: "main.tex",
  absolutePath: "C:/project/main.tex",
  type: "tex",
  content: "\\documentclass{article}",
  isDirty: false,
};

describe("slashQueryFromInput", () => {
  it("is active only while the whole input is /command without whitespace", () => {
    expect(slashQueryFromInput("/")).toBe("");
    expect(slashQueryFromInput("/ars")).toBe("ars");
    expect(slashQueryFromInput("/xyz hello")).toBeNull();
    expect(slashQueryFromInput("/xyz ")).toBeNull();
    expect(slashQueryFromInput("/xyz\nmore")).toBeNull();
    expect(slashQueryFromInput("hello /xyz")).toBeNull();
    expect(slashQueryFromInput("")).toBeNull();
  });
});

describe("isImeComposing", () => {
  it("treats isComposing and keyCode 229 as an IME keystroke", () => {
    expect(isImeComposing({ isComposing: true, keyCode: 13 })).toBe(true);
    expect(isImeComposing({ isComposing: false, keyCode: 229 })).toBe(true);
    expect(isImeComposing({ isComposing: false, keyCode: 13 })).toBe(false);
    expect(isImeComposing({})).toBe(false);
  });
});

describe("ChatComposer Enter handling", () => {
  let container: HTMLDivElement;
  let root: Root;
  const chatSnapshot = useClaudeChatStore.getState();
  const setupSnapshot = useClaudeSetupStore.getState();
  const documentSnapshot = useDocumentStore.getState();
  const runtimeSnapshot = useRuntimeStore.getState();
  const agentSnapshot = useAgentStore.getState();
  const settingsSnapshot = useSettingsStore.getState();
  const providerSnapshot = useProviderStore.getState();
  const sendPrompt = vi.fn();

  const originalGetContext = HTMLCanvasElement.prototype.getContext;

  beforeEach(() => {
    HTMLCanvasElement.prototype.getContext = (() => ({
      measureText: () => ({ width: 0 }),
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    invokeMock.mockReset();
    invokeMock.mockImplementation((command: string) => {
      if (command === "list_agents") return Promise.resolve(builtinAgents);
      if (command === "slash_commands_list") {
        return Promise.resolve([planCommand]);
      }
      return Promise.resolve([]);
    });
    sendPrompt.mockReset();
    sendPrompt.mockResolvedValue(undefined);
    useProviderStore.setState({ ready: true });
    useDocumentStore.setState({ projectRoot: "C:/project", files: [mainTex] });
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
      sendPrompt,
    } as unknown as Partial<ReturnType<typeof useClaudeChatStore.getState>>);
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
    HTMLCanvasElement.prototype.getContext = originalGetContext;
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
    useProviderStore.setState(providerSnapshot, true);
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

  function field(): HTMLTextAreaElement {
    const textarea = container.querySelector("textarea");
    if (!(textarea instanceof HTMLTextAreaElement)) {
      throw new Error("composer textarea not found");
    }
    return textarea;
  }

  async function type(value: string) {
    const textarea = field();
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      setValue?.call(textarea, value);
      textarea.selectionStart = value.length;
      textarea.selectionEnd = value.length;
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // Let the picker finish loading its command list.
    await act(async () => {
      await Promise.resolve();
    });
  }

  async function pressEnter(init: KeyboardEventInit = {}): Promise<boolean> {
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      keyCode: 13,
      bubbles: true,
      cancelable: true,
      ...init,
    });
    await act(async () => {
      field().dispatchEvent(event);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    return event.defaultPrevented;
  }

  function slashPickerText(): string {
    return document.body.textContent ?? "";
  }

  it("closes the picker once a space follows the command and sends on Enter", async () => {
    await renderComposer();
    await type("/xyz");
    expect(slashPickerText()).toContain('No results for "xyz"');

    await type("/xyz hello");
    expect(slashPickerText()).not.toContain("No results for");

    expect(await pressEnter()).toBe(true);
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(sendPrompt.mock.calls[0]?.[0]).toBe("/xyz hello");
    expect(field().value).toBe("");
  });

  it("sends on Enter when the slash picker has no results", async () => {
    await renderComposer();
    await type("/xyz");
    await vi.waitFor(() => {
      expect(slashPickerText()).toContain('No results for "xyz"');
    });

    expect(await pressEnter()).toBe(true);
    expect(sendPrompt).toHaveBeenCalledTimes(1);
    expect(sendPrompt.mock.calls[0]?.[0]).toBe("/xyz");
    expect(slashPickerText()).not.toContain("No results for");
  });

  it("selects the highlighted slash command on Enter when there are results", async () => {
    await renderComposer();
    await type("/ars");
    await vi.waitFor(() => {
      expect(slashPickerText()).toContain("/ars-plan");
    });

    expect(await pressEnter()).toBe(true);
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(field().value.startsWith("/ars-plan")).toBe(true);
  });

  it("leaves Shift+Enter as a newline while the slash picker has results", async () => {
    await renderComposer();
    await type("/ars");
    await vi.waitFor(() => {
      expect(slashPickerText()).toContain("/ars-plan");
    });

    expect(await pressEnter({ shiftKey: true })).toBe(false);
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(field().value).toBe("/ars");
  });

  it("ignores the Enter that confirms an IME candidate", async () => {
    await renderComposer();
    await type("你好");

    expect(await pressEnter({ isComposing: true })).toBe(false);
    expect(await pressEnter({ keyCode: 229 })).toBe(false);
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(field().value).toBe("你好");

    expect(await pressEnter()).toBe(true);
    expect(sendPrompt).toHaveBeenCalledTimes(1);
  });

  it("does not select a slash command from an IME Enter", async () => {
    await renderComposer();
    await type("/ars");
    await vi.waitFor(() => {
      expect(slashPickerText()).toContain("/ars-plan");
    });

    expect(await pressEnter({ isComposing: true })).toBe(false);
    expect(await pressEnter({ keyCode: 229 })).toBe(false);
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(field().value).toBe("/ars");
  });

  it("selects an @-mention on Enter, keeps Shift+Enter and ignores IME Enter", async () => {
    await renderComposer();
    await type("see @mai");
    await vi.waitFor(() => {
      expect(container.textContent ?? "").toContain("main.tex");
    });

    expect(await pressEnter({ isComposing: true })).toBe(false);
    expect(await pressEnter({ keyCode: 229 })).toBe(false);
    expect(await pressEnter({ shiftKey: true })).toBe(false);
    expect(field().value).toBe("see @mai");

    expect(await pressEnter()).toBe(true);
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(field().value).toBe("see ");
  });
});
