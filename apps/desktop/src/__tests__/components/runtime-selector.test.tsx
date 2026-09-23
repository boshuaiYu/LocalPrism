import { act, type ComponentType, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatComposer } from "@/components/claude-chat/chat-composer";
import * as runtimeSelectorModule from "@/components/runtime/runtime-selector";
import {
  CLAUDE_MODEL_OPTIONS,
  coerceCodexReasoningEffort,
  filterRuntimeConversations,
  getCodexModelOptions,
  getReasoningEffortOptions,
  matchesConversationReference,
  normalizeReasoningEffort,
} from "@/components/runtime/runtime-selector";
import { TooltipProvider } from "@/components/ui/tooltip";
import type {
  ChangeTabRuntimeResult,
  ChatRuntimePeer,
  ConversationRef,
  RuntimeAccount,
  RuntimeKind,
  RuntimeConversation,
  RuntimeModel,
} from "@/runtime/types";
import {
  CLAUDE_CODE_PROVIDER_ID,
  useClaudeChatStore,
} from "@/stores/claude-chat-store";
import { useClaudeSetupStore } from "@/stores/claude-setup-store";
import { useDocumentStore } from "@/stores/document-store";
import { useRuntimeStore } from "@/stores/runtime-store";
import {
  resetProviderStoreForTests,
  useProviderStore,
} from "@/stores/provider-store";

const codexModel: RuntimeModel = {
  runtime: "codex",
  id: "gpt-5.4",
  displayName: "GPT-5.4",
  description: "General-purpose coding model",
  reasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
  defaultReasoningEffort: "minimal",
  inputModalities: ["text", "image"],
  isDefault: true,
};

function runtimeAccount(
  runtime: RuntimeKind,
  authenticated: boolean,
): RuntimeAccount {
  return {
    runtime,
    installed: true,
    authenticated,
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
  };
}

const secondCodexModel: RuntimeModel = {
  runtime: "codex",
  id: "gpt-5.4-mini",
  displayName: "GPT-5.4 Mini",
  description: null,
  reasoningEfforts: ["low", "high"],
  defaultReasoningEffort: "high",
  inputModalities: ["text"],
  isDefault: false,
};

const backendClaudeModel: RuntimeModel = {
  runtime: "claude",
  id: "backend-claude-model",
  displayName: "Backend Claude model",
  description: "Must not appear in Codex options",
  reasoningEfforts: ["high"],
  defaultReasoningEffort: "high",
  inputModalities: ["text"],
  isDefault: false,
};

function conversation(
  runtime: ConversationRef["runtime"],
  projectPath: string,
  sessionId: string,
): RuntimeConversation {
  return {
    reference: { runtime, projectPath, sessionId },
    title: `${runtime}:${projectPath}:${sessionId}`,
    status: "idle",
    updatedAt: 1,
  };
}

describe("runtime selector helpers", () => {
  it("keeps Stop usable but blocks prompt dispatch without runtime readiness", () => {
    const isRuntimeSendDisabled = (
      runtimeSelectorModule as typeof runtimeSelectorModule & {
        isRuntimeSendDisabled?: (
          isStreaming: boolean,
          hasInput: boolean,
          runtimeReady: boolean,
        ) => boolean;
      }
    ).isRuntimeSendDisabled;

    expect(isRuntimeSendDisabled?.(false, false, true)).toBe(true);
    expect(isRuntimeSendDisabled?.(false, true, false)).toBe(true);
    expect(isRuntimeSendDisabled?.(false, true, true)).toBe(false);
    expect(isRuntimeSendDisabled?.(true, false, false)).toBe(false);
    expect(isRuntimeSendDisabled?.(true, true, false)).toBe(true);
    expect(isRuntimeSendDisabled?.(true, true, true)).toBe(false);
  });

  it("exposes the stable Claude aliases, labels, and descriptions", () => {
    expect(CLAUDE_MODEL_OPTIONS).toEqual([
      {
        id: "sonnet",
        displayName: "Sonnet",
        description: "Fast, efficient for most tasks",
      },
      {
        id: "opus",
        displayName: "Opus",
        description: "Most capable, complex reasoning",
      },
      {
        id: "haiku",
        displayName: "Haiku",
        description: "Fastest, simple tasks",
      },
      {
        id: "opusplan",
        displayName: "OpusPlan",
        description: "Opus for planning, Sonnet for execution",
      },
    ]);
  });

  it("keeps only Codex models in backend order without changing metadata", () => {
    const result = getCodexModelOptions([
      backendClaudeModel,
      codexModel,
      secondCodexModel,
    ]);

    expect(result).toEqual([codexModel, secondCodexModel]);
    expect(result[0]).toBe(codexModel);
    expect(result[1]).toBe(secondCodexModel);
  });

  it("keeps an empty Codex model list empty without a fallback", () => {
    expect(getCodexModelOptions([])).toEqual([]);
    expect(getCodexModelOptions([backendClaudeModel])).toEqual([]);
  });

  it("does not invent low, medium, and high when the catalog lists no efforts", () => {
    const empty = { ...backendClaudeModel, reasoningEfforts: [] as string[] };
    expect(getReasoningEffortOptions("claude", null)).toEqual([]);
    expect(getReasoningEffortOptions("api", null)).toEqual([]);
    expect(getReasoningEffortOptions("claude", empty)).toEqual([]);
    expect(getReasoningEffortOptions("api", empty)).toEqual([]);
    expect(normalizeReasoningEffort("claude", "low", null)).toBeNull();
    expect(normalizeReasoningEffort("api", null, empty)).toBeNull();
  });

  it("uses the parsed model's efforts for Claude and API peers", () => {
    const parsed = {
      ...backendClaudeModel,
      reasoningEfforts: ["low", "max", "high"],
    };
    expect(getReasoningEffortOptions("claude", parsed)).toEqual([
      "low",
      "high",
      "xhigh",
    ]);
    expect(getReasoningEffortOptions("api", parsed)).toEqual([
      "low",
      "high",
      "xhigh",
    ]);
    expect(normalizeReasoningEffort("claude", "max", parsed)).toBe("xhigh");
  });

  it("uses only the selected Codex model's arbitrary backend efforts", () => {
    expect(getReasoningEffortOptions("codex", codexModel)).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(getReasoningEffortOptions("codex", null)).toEqual([]);
    expect(getReasoningEffortOptions("codex", backendClaudeModel)).toEqual([]);
  });

  it("coerces Codex catalog minimal effort to an API-stable effort", () => {
    const model = {
      ...codexModel,
      id: "gpt-5.6-sol",
      reasoningEfforts: ["minimal", "low", "medium", "high", "xhigh"],
      defaultReasoningEffort: "minimal",
    };
    expect(coerceCodexReasoningEffort("minimal", model)).toBe("low");
    expect(normalizeReasoningEffort("codex", "minimal", model)).toBe("low");
  });

  it("keeps low when already API-stable", () => {
    const model = {
      ...codexModel,
      id: "gpt-5.6-sol",
      reasoningEfforts: ["low", "medium", "high", "xhigh"],
      defaultReasoningEffort: "low",
    };
    expect(coerceCodexReasoningEffort("low", model)).toBe("low");
  });

  it("keeps a supported effort and otherwise uses the supported backend default", () => {
    expect(normalizeReasoningEffort("codex", "xhigh", codexModel)).toBe(
      "xhigh",
    );
    // Catalog aliases max/ultra → API-stable xhigh.
    expect(normalizeReasoningEffort("codex", "ultra", codexModel)).toBe(
      "xhigh",
    );
    expect(normalizeReasoningEffort("codex", "max", codexModel)).toBe("xhigh");
    // Catalog default "minimal" is not API-stable; coerce to first stable option.
    expect(normalizeReasoningEffort("codex", null, codexModel)).toBe("none");
  });

  it("falls back to the first supported effort and then null", () => {
    const unsupportedDefault: RuntimeModel = {
      ...codexModel,
      reasoningEfforts: ["none", "xhigh"],
      defaultReasoningEffort: "medium",
    };
    const noEfforts: RuntimeModel = {
      ...codexModel,
      reasoningEfforts: [],
      defaultReasoningEffort: "minimal",
    };

    expect(
      normalizeReasoningEffort("codex", "minimal", unsupportedDefault),
    ).toBe("none");
    expect(normalizeReasoningEffort("codex", "xhigh", unsupportedDefault)).toBe(
      "xhigh",
    );
    expect(normalizeReasoningEffort("codex", "high", noEfforts)).toBeNull();
  });

  it("resolves Claude and API efforts only from the model's own list", () => {
    const advertised = {
      ...backendClaudeModel,
      reasoningEfforts: ["low", "medium", "high"],
    };
    expect(normalizeReasoningEffort("claude", "low", advertised)).toBe("low");
    expect(normalizeReasoningEffort("claude", "minimal", advertised)).toBe(
      "low",
    );
    expect(normalizeReasoningEffort("claude", null, advertised)).toBe("medium");
    expect(normalizeReasoningEffort("api", null, null)).toBeNull();
  });

  it("filters conversations by both runtime and project path", () => {
    const wanted = conversation("codex", "C:/work/paper", "shared-id");
    const conversations = [
      conversation("claude", "C:/work/paper", "shared-id"),
      conversation("codex", "C:/work/other", "shared-id"),
      wanted,
      conversation("codex", "C:/work/paper", "second-id"),
    ];

    expect(
      filterRuntimeConversations(conversations, "codex", "C:/work/paper"),
    ).toEqual([wanted, conversations[3]]);
  });

  it("matches an active conversation by the full reference triple", () => {
    const active = conversation("codex", "C:/work/paper", "shared-id");

    expect(matchesConversationReference(active, active.reference)).toBe(true);
    expect(
      matchesConversationReference(active, {
        ...active.reference,
        runtime: "claude",
      }),
    ).toBe(false);
    expect(
      matchesConversationReference(active, {
        ...active.reference,
        projectPath: "C:/work/other",
      }),
    ).toBe(false);
    expect(
      matchesConversationReference(active, {
        ...active.reference,
        sessionId: "other-session",
      }),
    ).toBe(false);
    expect(matchesConversationReference(active, null)).toBe(false);
  });
});

type RuntimeSelection = {
  runtimeModel: string | null;
  reasoningEffort: string | null;
  agentId: string | null;
};

interface RuntimeSelectorTestProps {
  peer: ChatRuntimePeer;
  claudeAvailable: boolean;
  apiAvailable: boolean;
  codexAvailable: boolean;
  codexModels: RuntimeModel[];
  codexModelsLoading: boolean;
  selectedModelId: string | null;
  reasoningEffort: string | null;
  busy: boolean;
  apiProviderControls: ReactNode;
  apiModelControls?: ReactNode;
  selectedClaudeModel: string;
  selectedClaudeEffort: "low" | "medium" | "high";
  onPeerChange: (
    peer: ChatRuntimePeer,
    options?: { confirmSessionReset?: boolean },
  ) => ChangeTabRuntimeResult;
  onSelectionChange: (selection: RuntimeSelection) => string;
  onClaudeModelChange: (model: string) => void;
  onClaudeEffortChange: (effort: "low" | "medium" | "high") => void;
  onRefreshCodexModels: () => Promise<void>;
}

const defaultSelectorProps: RuntimeSelectorTestProps = {
  peer: "codex",
  claudeAvailable: true,
  apiAvailable: true,
  codexAvailable: true,
  codexModels: [codexModel, secondCodexModel],
  codexModelsLoading: false,
  selectedModelId: "gpt-5.4",
  reasoningEffort: "low",
  busy: false,
  apiProviderControls: <button type="button">API provider</button>,
  selectedClaudeModel: "sonnet",
  selectedClaudeEffort: "medium",
  onPeerChange: () => "unchanged",
  onSelectionChange: () => "unchanged",
  onClaudeModelChange: () => undefined,
  onClaudeEffortChange: () => undefined,
  onRefreshCodexModels: () => Promise.resolve(),
};

function runtimeSelectorComponent(): ComponentType<RuntimeSelectorTestProps> | null {
  return (
    (
      runtimeSelectorModule as typeof runtimeSelectorModule & {
        RuntimeSelector?: ComponentType<RuntimeSelectorTestProps>;
      }
    ).RuntimeSelector ?? null
  );
}

async function mountSelector(
  overrides: Partial<RuntimeSelectorTestProps> = {},
): Promise<{
  container: HTMLDivElement;
  root: Root;
  rerender: (next?: Partial<RuntimeSelectorTestProps>) => Promise<void>;
  unmount: () => Promise<void>;
}> {
  const RuntimeSelector = runtimeSelectorComponent();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  useProviderStore.setState({
    ready: true,
    cards: [
      {
        id: "chatgpt-official",
        kind: "official-chatgpt",
        name: "ChatGPT Official",
        authenticated: true,
        isActive: true,
        accountLabel: null,
      },
    ],
    models: [
      {
        id: "gpt-5.6-sol",
        displayName: "GPT-5.6 Sol",
        reasoningEfforts: ["low", "medium", "high", "xhigh"],
        isDefault: true,
      },
      {
        id: "gpt-5.6-terra",
        displayName: "GPT-5.6 Terra",
        reasoningEfforts: ["low", "medium", "high"],
        isDefault: false,
      },
    ],
  });
  let props = { ...defaultSelectorProps, ...overrides };
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;

  const rerender = async (next: Partial<RuntimeSelectorTestProps> = {}) => {
    props = { ...props, ...next };
    await act(async () => {
      root.render(
        RuntimeSelector ? (
          <RuntimeSelector {...props} />
        ) : (
          <div data-missing-runtime-selector />
        ),
      );
      await Promise.resolve();
    });
  };
  await rerender();

  return {
    container,
    root,
    rerender,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
      resetProviderStoreForTests();
    },
  };
}

function buttonByLabel(
  container: HTMLElement,
  label: string,
): HTMLButtonElement {
  const button = container.querySelector(`button[aria-label="${label}"]`);
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${label}`);
  }
  return button;
}

describe("RuntimeSelector", () => {
  it("shows the active provider and no Claude/API/Codex peer buttons", async () => {
    const view = await mountSelector();
    try {
      expect(view.container.textContent).toContain(
        "ChatGPT Official · switch providers in Settings",
      );
      expect(
        view.container.querySelector('button[aria-label="Claude peer"]'),
      ).toBeNull();
      expect(
        view.container.querySelector('button[aria-label="API peer"]'),
      ).toBeNull();
      expect(
        view.container.querySelector('button[aria-label="Codex peer"]'),
      ).toBeNull();
      expect(view.container.textContent).toContain("GPT-5.6 Sol");
      expect(view.container.textContent).toContain("GPT-5.6 Terra");
    } finally {
      await view.unmount();
    }
  });

  it("selects a provider model and effort", async () => {
    const onSelectionChange = vi.fn().mockReturnValue("changed");
    const view = await mountSelector({
      selectedModelId: "gpt-5.6-sol",
      reasoningEffort: "low",
      onSelectionChange,
    });
    try {
      expect(
        buttonByLabel(view.container, "Select model GPT-5.6 Sol").getAttribute(
          "aria-pressed",
        ),
      ).toBe("true");
      await act(async () =>
        buttonByLabel(view.container, "Select model GPT-5.6 Terra").click(),
      );
      expect(onSelectionChange).toHaveBeenCalledWith({
        runtimeModel: "gpt-5.6-terra",
        reasoningEffort: "low",
        agentId: null,
      });
    } finally {
      await view.unmount();
    }
  });

  it("shows an empty catalog when no provider models are loaded", async () => {
    const view = await mountSelector();
    useProviderStore.setState({ models: [], ready: false });
    await view.rerender();
    try {
      expect(view.container.textContent).toContain(
        "Choose a provider in Settings → Providers",
      );
      expect(view.container.textContent).not.toContain("reasoning strength");
      expect(
        view.container.querySelector(
          '[data-testid="reasoning-strength-control"]',
        ),
      ).toBeNull();
      expect(
        view.container
          .querySelector('[aria-label="Runtime controls"]')
          ?.getAttribute("data-runtime-ready"),
      ).toBe("false");
    } finally {
      await view.unmount();
    }
  });

  it("keeps approvals and agents out of the model list", async () => {
    const view = await mountSelector();
    try {
      expect(view.container.textContent).toContain("Model");
      expect(
        view.container.querySelector(
          '[data-testid="reasoning-strength-control"]',
        ),
      ).not.toBeNull();
      expect(view.container.textContent).not.toContain("Approvals");
      expect(view.container.textContent).not.toContain("Ask each time");
      expect(view.container.querySelector("#composer-agent-select")).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it("hides strength when the selected model cannot adjust it", async () => {
    const view = await mountSelector({ selectedModelId: "embed-model" });
    try {
      useProviderStore.setState({
        models: [
          {
            id: "embed-model",
            displayName: "Embed",
            reasoningEfforts: [],
            isDefault: true,
          },
        ],
      });
      await view.rerender({ selectedModelId: "embed-model" });
      expect(
        view.container.querySelector(
          '[data-testid="reasoning-strength-control"]',
        ),
      ).toBeNull();
      expect(view.container.textContent?.toLowerCase()).not.toContain(
        "reasoning strength",
      );
      expect(view.container.textContent).not.toContain("Low");
      expect(view.container.textContent).not.toContain("Medium");
      expect(view.container.textContent).not.toContain("High");

      useProviderStore.setState({
        models: [
          {
            id: "fixed-model",
            displayName: "Fixed",
            reasoningEfforts: ["high"],
            isDefault: true,
          },
        ],
      });
      await view.rerender({ selectedModelId: "fixed-model" });
      expect(
        view.container.querySelector(
          '[data-testid="reasoning-strength-control"]',
        ),
      ).toBeNull();
      expect(view.container.textContent).not.toContain("fixed at");
      expect(view.container.textContent).not.toContain("High");
    } finally {
      await view.unmount();
    }
  });

  it("uses the selected model's parsed efforts as a segmented control", async () => {
    const onSelectionChange = vi.fn().mockReturnValue("changed");
    const view = await mountSelector({
      selectedModelId: "gpt-5.6-sol",
      reasoningEffort: "medium",
      onSelectionChange,
    });
    try {
      const selected = view.container.querySelector(
        '[aria-label="Reasoning strength Medium"]',
      );
      if (!(selected instanceof HTMLButtonElement)) {
        throw new Error("Reasoning strength control missing");
      }
      expect(selected.getAttribute("aria-checked")).toBe("true");
      expect(
        view.container.querySelector('[data-testid="reasoning-effort-slider"]'),
      ).toBeNull();

      await act(async () => {
        buttonByLabel(view.container, "Reasoning strength Extra high").click();
      });
      expect(onSelectionChange).toHaveBeenCalledWith({
        runtimeModel: "gpt-5.6-sol",
        reasoningEffort: "xhigh",
        agentId: null,
      });

      await view.rerender({
        selectedModelId: "gpt-5.6-terra",
        reasoningEffort: "medium",
      });
      expect(
        view.container.querySelector(
          '[aria-label="Reasoning strength Extra high"]',
        ),
      ).toBeNull();
      expect(
        view.container.querySelector('[aria-label="Reasoning strength High"]'),
      ).not.toBeNull();
      expect(
        view.container.querySelector(
          '[data-testid="reasoning-effort-fast-toggle"]',
        ),
      ).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it("shows a fast toggle only when the catalog has a distinct sibling", async () => {
    const onSelectionChange = vi.fn().mockReturnValue("changed");
    const view = await mountSelector({
      selectedModelId: "gpt-5.6-luna",
      reasoningEffort: "medium",
      onSelectionChange,
    });
    try {
      useProviderStore.setState({
        models: [
          {
            id: "gpt-5.6-luna",
            displayName: "GPT-5.6 Luna",
            reasoningEfforts: ["low", "medium", "high", "xhigh"],
            isDefault: true,
          },
          {
            id: "gpt-5.6-luna-fast",
            displayName: "GPT-5.6 Luna Fast",
            reasoningEfforts: ["low", "medium", "high", "xhigh"],
            isDefault: false,
          },
        ],
      });
      await view.rerender({ selectedModelId: "gpt-5.6-luna" });
      const toggle = view.container.querySelector(
        '[data-testid="reasoning-effort-fast-toggle"]',
      );
      if (!(toggle instanceof HTMLButtonElement)) {
        throw new Error("fast toggle missing");
      }
      expect(toggle.getAttribute("aria-pressed")).toBe("false");
      await act(async () => {
        toggle.click();
      });
      expect(onSelectionChange).toHaveBeenCalledWith({
        runtimeModel: "gpt-5.6-luna-fast",
        reasoningEffort: "medium",
        agentId: null,
      });
    } finally {
      await view.unmount();
    }
  });

  it("disables model changes while busy", async () => {
    const onSelectionChange = vi.fn();
    const view = await mountSelector({ busy: true, onSelectionChange });
    try {
      expect(
        buttonByLabel(view.container, "Select model GPT-5.6 Terra").disabled,
      ).toBe(true);
      await act(async () =>
        buttonByLabel(view.container, "Select model GPT-5.6 Terra").click(),
      );
      expect(onSelectionChange).not.toHaveBeenCalled();
    } finally {
      await view.unmount();
    }
  });
});

describe("ChatComposer provider wiring", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue([] as never);
  });

  function seedClaudeProvider() {
    useProviderStore.setState({
      ready: true,
      cards: [
        {
          id: "claude-official",
          kind: "official-claude",
          name: "Claude Official",
          authenticated: true,
          isActive: true,
          accountLabel: null,
        },
      ],
      models: [
        {
          id: "opus",
          displayName: "Opus",
          reasoningEfforts: ["low", "medium", "high"],
          isDefault: false,
        },
        {
          id: "haiku",
          displayName: "Haiku",
          reasoningEfforts: ["low", "medium", "high"],
          isDefault: true,
        },
      ],
    });
  }

  it("shows the active tab model after switching tabs", async () => {
    const chatSnapshot = useClaudeChatStore.getState();
    const setupSnapshot = useClaudeSetupStore.getState();
    const documentSnapshot = useDocumentStore.getState();
    const runtimeSnapshot = useRuntimeStore.getState();
    const baseTab = chatSnapshot.tabs[0];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    seedClaudeProvider();

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
        claude: runtimeAccount("claude", true),
        codex: runtimeAccount("codex", true),
      },
      models: { claude: [], codex: [codexModel] },
      loading: {},
      login: {},
    });
    useClaudeChatStore.setState({
      tabs: [
        {
          ...baseTab,
          id: "tab-a",
          projectPath: "C:/project",
          runtime: "claude",
          chatPeer: "claude",
          runtimeModel: "opus",
          reasoningEffort: "high",
          providerKey: null,
        },
        {
          ...baseTab,
          id: "tab-b",
          projectPath: "C:/project",
          runtime: "claude",
          chatPeer: "claude",
          runtimeModel: "haiku",
          reasoningEffort: "low",
          providerKey: null,
        },
      ],
      activeTabId: "tab-b",
      activeProjectPath: "C:/project",
      selectedModel: "haiku",
      effortLevel: "low",
      selectedProviderCredentialId: CLAUDE_CODE_PROVIDER_ID,
      selectedProviderModels: {},
      messages: [],
      sessionId: null,
      isStreaming: false,
    });
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;

    try {
      await act(async () => {
        root.render(
          <TooltipProvider>
            <ChatComposer />
          </TooltipProvider>,
        );
        await Promise.resolve();
      });
      await act(async () => {
        useClaudeChatStore.getState().setActiveTab("tab-a");
        await Promise.resolve();
      });

      expect(
        document.querySelector('[aria-label^="Approval policy"]'),
      ).toBeTruthy();
      expect(
        document.querySelector('[aria-label^="Select custom agent"]'),
      ).toBeTruthy();

      const trigger = document.querySelector('button[title="opus"]');
      expect(trigger?.getAttribute("aria-label")).toBe(
        "Switch model opus, High",
      );
      if (!(trigger instanceof HTMLButtonElement)) {
        throw new Error("Composer runtime trigger not found");
      }
      expect(trigger.textContent).toContain("Opus");
      expect(trigger.textContent).toContain("High");
      const triggerClasses = trigger.className.split(/\s+/);
      expect(triggerClasses).toContain("w-fit");
      expect(triggerClasses).toContain("self-start");
      expect(triggerClasses).not.toContain("w-full");
      expect(triggerClasses).not.toContain("flex-1");
      expect(triggerClasses).not.toContain("justify-between");
      expect(
        trigger.querySelector("span")?.className.split(/\s+/),
      ).not.toContain("flex-1");
      expect(
        document.querySelector('[data-testid="reasoning-strength-control"]'),
      ).toBeNull();
      await act(async () => trigger.click());
      expect(
        buttonByLabel(document.body, "Select model Opus").getAttribute(
          "aria-pressed",
        ),
      ).toBe("true");
    } finally {
      await act(async () => root.unmount());
      container.remove();
      resetProviderStoreForTests();
      useClaudeChatStore.setState(chatSnapshot, true);
      useClaudeSetupStore.setState(setupSnapshot, true);
      useDocumentStore.setState(documentSnapshot, true);
      useRuntimeStore.setState(runtimeSnapshot, true);
    }
  });

  it("keeps archived Codex conversations read-only", async () => {
    const chatSnapshot = useClaudeChatStore.getState();
    const setupSnapshot = useClaudeSetupStore.getState();
    const documentSnapshot = useDocumentStore.getState();
    const runtimeSnapshot = useRuntimeStore.getState();
    const baseTab = chatSnapshot.tabs[0];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    vi.mocked(invoke).mockResolvedValue(undefined as never);
    seedClaudeProvider();

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
        claude: runtimeAccount("claude", true),
        codex: runtimeAccount("codex", true),
      },
      models: { claude: [], codex: [codexModel] },
      loading: {},
      login: {},
    });
    useClaudeChatStore.setState({
      tabs: [
        {
          ...baseTab,
          id: "tab-codex",
          projectPath: "C:/project",
          runtime: "codex",
          chatPeer: "codex",
          runtimeModel: "gpt-5.4",
          reasoningEffort: "high",
          messages: [],
        },
      ],
      activeTabId: "tab-codex",
      activeProjectPath: "C:/project",
      messages: [],
      sessionId: null,
      isStreaming: false,
    });
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;

    try {
      await act(async () => {
        root.render(
          <TooltipProvider>
            <ChatComposer />
          </TooltipProvider>,
        );
        await Promise.resolve();
      });
      expect(container.textContent).toContain("read-only");
      expect(container.textContent).toContain("Start a new chat");
      expect(container.textContent).not.toContain("Codex (archived)");
      expect(
        vi
          .mocked(invoke)
          .mock.calls.some(([command]) => command === "runtime_start_turn"),
      ).toBe(false);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.mocked(invoke).mockReset();
      resetProviderStoreForTests();
      useClaudeChatStore.setState(chatSnapshot, true);
      useClaudeSetupStore.setState(setupSnapshot, true);
      useDocumentStore.setState(documentSnapshot, true);
      useRuntimeStore.setState(runtimeSnapshot, true);
    }
  });

  it("sends Claude turns without a providerCredentialId", async () => {
    const chatSnapshot = useClaudeChatStore.getState();
    const setupSnapshot = useClaudeSetupStore.getState();
    const documentSnapshot = useDocumentStore.getState();
    const runtimeSnapshot = useRuntimeStore.getState();
    const baseTab = chatSnapshot.tabs[0];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    vi.mocked(invoke).mockResolvedValue(undefined as never);
    seedClaudeProvider();

    useDocumentStore.setState({ projectRoot: "C:/project" });
    useClaudeSetupStore.setState({
      status: "ready",
      providerKind: "openai-compatible",
      claudeProviderConfigured: true,
      openAiCredentials: [
        {
          id: "provider-a",
          label: "OpenAI",
          base_url: "https://api.openai.com/v1",
          model: "gpt-5",
        },
      ],
      activeOpenAiCredentialId: "provider-a",
    });
    useRuntimeStore.setState({
      accounts: {
        claude: runtimeAccount("claude", true),
        codex: runtimeAccount("codex", true),
      },
      models: { claude: [], codex: [] },
      loading: {},
      login: {},
    });
    useClaudeChatStore.setState({
      tabs: [
        {
          ...baseTab,
          id: "tab-claude",
          projectPath: "C:/project",
          runtime: "claude",
          chatPeer: "claude",
          runtimeModel: "opus",
          reasoningEffort: "medium",
          providerKey: null,
          messages: [],
        },
      ],
      activeTabId: "tab-claude",
      activeProjectPath: "C:/project",
      selectedProviderCredentialId: "provider-a",
      selectedProviderModels: {},
      messages: [],
      sessionId: null,
      isStreaming: false,
    });
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;

    try {
      await act(async () => {
        root.render(
          <TooltipProvider>
            <ChatComposer />
          </TooltipProvider>,
        );
        await Promise.resolve();
      });
      const textarea = container.querySelector("textarea");
      if (!(textarea instanceof HTMLTextAreaElement)) {
        throw new Error("Composer textarea not found");
      }
      const setTextareaValue = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setTextareaValue?.call(textarea, "Use Claude peer");
      await act(async () => {
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        await Promise.resolve();
      });
      const sendButton = Array.from(container.querySelectorAll("button")).find(
        (button) =>
          button.getAttribute("title") === "Send" ||
          button.textContent?.trim() === "Send",
      );
      if (!(sendButton instanceof HTMLButtonElement)) {
        throw new Error("Composer send button not found");
      }
      expect(sendButton.disabled).toBe(false);
      await act(async () => {
        sendButton.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      const runtimeStartCalls = vi
        .mocked(invoke)
        .mock.calls.filter(([command]) => command === "runtime_start_turn");
      expect(runtimeStartCalls).toHaveLength(1);
      expect(runtimeStartCalls[0]?.[1]).toEqual({
        request: expect.objectContaining({
          runtime: "claude",
          providerCredentialId: null,
          providerModelOverride: null,
        }),
      });
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.mocked(invoke).mockReset();
      resetProviderStoreForTests();
      useClaudeChatStore.setState(chatSnapshot, true);
      useClaudeSetupStore.setState(setupSnapshot, true);
      useDocumentStore.setState(documentSnapshot, true);
      useRuntimeStore.setState(runtimeSnapshot, true);
    }
  });

  it("updates only the active tab model from the provider catalog", async () => {
    const chatSnapshot = useClaudeChatStore.getState();
    const setupSnapshot = useClaudeSetupStore.getState();
    const documentSnapshot = useDocumentStore.getState();
    const runtimeSnapshot = useRuntimeStore.getState();
    const baseTab = chatSnapshot.tabs[0];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    seedClaudeProvider();

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
        claude: runtimeAccount("claude", true),
        codex: runtimeAccount("codex", true),
      },
    });
    useClaudeChatStore.setState({
      tabs: [
        {
          ...baseTab,
          id: "tab-active",
          projectPath: "C:/project",
          runtime: "claude",
          chatPeer: "claude",
          runtimeModel: "opus",
          reasoningEffort: "high",
          providerKey: null,
        },
        {
          ...baseTab,
          id: "tab-other",
          projectPath: "C:/project",
          runtime: "claude",
          chatPeer: "claude",
          runtimeModel: "haiku",
          reasoningEffort: "low",
          providerKey: null,
        },
      ],
      activeTabId: "tab-active",
      activeProjectPath: "C:/project",
      selectedModel: "sonnet",
      effortLevel: "medium",
      selectedProviderCredentialId: CLAUDE_CODE_PROVIDER_ID,
      selectedProviderModels: {},
      messages: [],
      sessionId: null,
      isStreaming: false,
    });
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;

    try {
      await act(async () => {
        root.render(
          <TooltipProvider>
            <ChatComposer />
          </TooltipProvider>,
        );
        await Promise.resolve();
      });
      const trigger = document.querySelector('button[title="opus"]');
      expect(trigger?.getAttribute("aria-label")).toBe(
        "Switch model opus, High",
      );
      if (!(trigger instanceof HTMLButtonElement)) {
        throw new Error("Composer runtime trigger not found");
      }
      await act(async () => trigger.click());
      await act(async () =>
        buttonByLabel(document.body, "Select model Haiku").click(),
      );
      const activeTab = useClaudeChatStore
        .getState()
        .tabs.find((tab) => tab.id === "tab-active");
      expect(activeTab?.runtimeModel).toBe("haiku");
      expect(
        useClaudeChatStore.getState().tabs.find((tab) => tab.id === "tab-other")
          ?.reasoningEffort,
      ).toBe("low");
    } finally {
      await act(async () => root.unmount());
      container.remove();
      resetProviderStoreForTests();
      useClaudeChatStore.setState(chatSnapshot, true);
      useClaudeSetupStore.setState(setupSnapshot, true);
      useDocumentStore.setState(documentSnapshot, true);
      useRuntimeStore.setState(runtimeSnapshot, true);
    }
  });
});
