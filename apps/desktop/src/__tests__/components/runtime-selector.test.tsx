import { act, type ComponentType, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { describe, expect, it, vi } from "vitest";
import { ChatComposer } from "@/components/claude-chat/chat-composer";
import * as runtimeSelectorModule from "@/components/runtime/runtime-selector";
import {
  CLAUDE_MODEL_OPTIONS,
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

  it("keeps Claude and API effort controls compatible with low, medium, and high", () => {
    expect(getReasoningEffortOptions("claude", null)).toEqual([
      "low",
      "medium",
      "high",
    ]);
    expect(getReasoningEffortOptions("api", null)).toEqual([
      "low",
      "medium",
      "high",
    ]);
  });

  it("uses only the selected Codex model's arbitrary backend efforts", () => {
    expect(getReasoningEffortOptions("codex", codexModel)).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(getReasoningEffortOptions("codex", null)).toEqual([]);
    expect(getReasoningEffortOptions("codex", backendClaudeModel)).toEqual([]);
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
    expect(normalizeReasoningEffort("codex", null, codexModel)).toBe("minimal");
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

  it("normalizes unsupported Claude/API efforts to the documented medium default", () => {
    expect(normalizeReasoningEffort("claude", "low", null)).toBe("low");
    expect(normalizeReasoningEffort("claude", "minimal", null)).toBe("medium");
    expect(normalizeReasoningEffort("claude", null, null)).toBe("medium");
    expect(normalizeReasoningEffort("api", null, null)).toBe("medium");
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
  selectedClaudeModel: "sonnet" | "opus" | "haiku" | "opusplan";
  selectedClaudeEffort: "low" | "medium" | "high";
  onPeerChange: (
    peer: ChatRuntimePeer,
    options?: { confirmSessionReset?: boolean },
  ) => ChangeTabRuntimeResult;
  onSelectionChange: (selection: RuntimeSelection) => string;
  onClaudeModelChange: (
    model: "sonnet" | "opus" | "haiku" | "opusplan",
  ) => void;
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
  reasoningEffort: "minimal",
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
  it("shows three independent peers: Claude, API, and Codex", async () => {
    const view = await mountSelector();
    try {
      expect(
        buttonByLabel(view.container, "Claude peer").getAttribute(
          "aria-pressed",
        ),
      ).toBe("false");
      expect(
        buttonByLabel(view.container, "API peer").getAttribute("aria-pressed"),
      ).toBe("false");
      expect(
        buttonByLabel(view.container, "Codex peer").getAttribute(
          "aria-pressed",
        ),
      ).toBe("true");
    } finally {
      await view.unmount();
    }
  });

  it("exposes the selected model and effort with pressed semantics", async () => {
    const view = await mountSelector();
    try {
      expect(
        buttonByLabel(view.container, "Select model GPT-5.4").getAttribute(
          "aria-pressed",
        ),
      ).toBe("true");
      expect(
        buttonByLabel(view.container, "Select model GPT-5.4 Mini").getAttribute(
          "aria-pressed",
        ),
      ).toBe("false");
      expect(
        buttonByLabel(view.container, "Reasoning effort minimal").getAttribute(
          "aria-pressed",
        ),
      ).toBe("true");
      expect(
        buttonByLabel(view.container, "Reasoning effort high").getAttribute(
          "aria-pressed",
        ),
      ).toBe("false");
    } finally {
      await view.unmount();
    }
  });

  it("renders only dynamic backend Codex models without a fallback", async () => {
    const view = await mountSelector();
    try {
      expect(view.container.textContent).toContain("GPT-5.4");
      expect(view.container.textContent).toContain("GPT-5.4 Mini");
      expect(view.container.textContent).not.toContain("Sonnet");
      expect(view.container.textContent).not.toContain("API provider");
    } finally {
      await view.unmount();
    }
  });

  it("shows only Claude aliases and efforts for the Claude peer, with no provider list", async () => {
    const view = await mountSelector({
      peer: "claude",
      selectedClaudeModel: "opus",
      selectedClaudeEffort: "high",
    });
    try {
      expect(view.container.textContent).toContain("Sonnet");
      expect(view.container.textContent).toContain("Opus");
      expect(
        buttonByLabel(view.container, "Select model Opus").getAttribute(
          "aria-pressed",
        ),
      ).toBe("true");
      expect(view.container.textContent).not.toContain("API provider");
      expect(view.container.textContent).not.toContain("GPT-5.4");
    } finally {
      await view.unmount();
    }
  });

  it("keeps compatible provider and model controls inside the API branch", async () => {
    const view = await mountSelector({
      peer: "api",
      selectedModelId: "provider-model",
      reasoningEffort: "medium",
      apiProviderControls: (
        <button type="button">OpenAI-compatible provider</button>
      ),
      apiModelControls: <button type="button">OpenAI-compatible model</button>,
    });
    try {
      expect(view.container.textContent).toContain(
        "OpenAI-compatible provider",
      );
      expect(view.container.textContent).toContain("OpenAI-compatible model");
      expect(view.container.textContent).not.toContain(
        "Fast, efficient for most tasks",
      );
    } finally {
      await view.unmount();
    }
  });

  it("prompts to add a connection when the API peer has no model controls yet", async () => {
    const view = await mountSelector({
      peer: "api",
      apiModelControls: undefined,
    });
    try {
      expect(view.container.textContent).toContain(
        "Select an API connection to see its models",
      );
    } finally {
      await view.unmount();
    }
  });

  it("shows a clear empty state and marks Codex selection as not ready", async () => {
    const view = await mountSelector({
      codexModels: [],
      selectedModelId: null,
      reasoningEffort: null,
    });
    try {
      expect(view.container.textContent).toContain("No Codex models available");
      expect(
        view.container
          .querySelector('[aria-label="Runtime controls"]')
          ?.getAttribute("data-runtime-ready"),
      ).toBe("false");
      expect(view.container.textContent).not.toContain("Sonnet");
    } finally {
      await view.unmount();
    }
  });

  it("marks cached Codex models as not ready after authentication is lost", async () => {
    const view = await mountSelector({
      peer: "codex",
      codexAvailable: false,
      codexModels: [codexModel],
      selectedModelId: codexModel.id,
      reasoningEffort: "minimal",
    });
    try {
      expect(
        view.container
          .querySelector('[aria-label="Runtime controls"]')
          ?.getAttribute("data-runtime-ready"),
      ).toBe("false");
      expect(
        buttonByLabel(view.container, "Select model GPT-5.4").disabled,
      ).toBe(true);
    } finally {
      await view.unmount();
    }
  });

  it("marks the API peer as not ready without a connection, ready once available", async () => {
    const view = await mountSelector({ peer: "api", apiAvailable: false });
    try {
      expect(
        view.container
          .querySelector('[aria-label="Runtime controls"]')
          ?.getAttribute("data-runtime-ready"),
      ).toBe("false");
      await view.rerender({ apiAvailable: true });
      expect(
        view.container
          .querySelector('[aria-label="Runtime controls"]')
          ?.getAttribute("data-runtime-ready"),
      ).toBe("true");
    } finally {
      await view.unmount();
    }
  });

  it("normalizes model changes and exposes arbitrary backend efforts", async () => {
    const onSelectionChange = vi
      .fn<RuntimeSelectorTestProps["onSelectionChange"]>()
      .mockReturnValue("changed");
    const view = await mountSelector({
      selectedModelId: "gpt-5.4-mini",
      reasoningEffort: "ultra",
      onSelectionChange,
    });
    try {
      await act(async () =>
        buttonByLabel(view.container, "Select model GPT-5.4").click(),
      );
      // Catalog "ultra" coerces to API-stable "xhigh".
      expect(onSelectionChange).toHaveBeenLastCalledWith({
        runtimeModel: "gpt-5.4",
        reasoningEffort: "xhigh",
        agentId: null,
      });

      await view.rerender({
        selectedModelId: "gpt-5.4",
        reasoningEffort: "xhigh",
      });
      expect(
        buttonByLabel(view.container, "Reasoning effort minimal"),
      ).not.toBeNull();
      expect(
        buttonByLabel(view.container, "Reasoning effort xhigh"),
      ).not.toBeNull();
      await act(async () =>
        buttonByLabel(view.container, "Reasoning effort minimal").click(),
      );
      expect(onSelectionChange).toHaveBeenLastCalledWith({
        runtimeModel: "gpt-5.4",
        reasoningEffort: "minimal",
        agentId: null,
      });
    } finally {
      await view.unmount();
    }
  });

  it("normalizes an existing Codex model effort when catalog metadata changes", async () => {
    const initialModel: RuntimeModel = {
      ...codexModel,
      id: "gpt-X",
      displayName: "GPT-X",
      reasoningEfforts: ["medium", "high"],
      defaultReasoningEffort: "medium",
    };
    const highOnlyModel: RuntimeModel = {
      ...initialModel,
      reasoningEfforts: ["high"],
      defaultReasoningEffort: "high",
    };
    const firstFallbackModel: RuntimeModel = {
      ...initialModel,
      reasoningEfforts: ["none", "xhigh"],
      defaultReasoningEffort: "medium",
    };
    const noEffortModel: RuntimeModel = {
      ...initialModel,
      reasoningEfforts: [],
      defaultReasoningEffort: "high",
    };
    const onSelectionChange = vi
      .fn<RuntimeSelectorTestProps["onSelectionChange"]>()
      .mockReturnValue("changed");
    const view = await mountSelector({
      codexModels: [initialModel],
      selectedModelId: initialModel.id,
      reasoningEffort: "medium",
      onSelectionChange,
    });
    const runtimeReady = () =>
      view.container
        .querySelector('[aria-label="Runtime controls"]')
        ?.getAttribute("data-runtime-ready");

    try {
      expect(runtimeReady()).toBe("true");
      expect(onSelectionChange).not.toHaveBeenCalled();

      await view.rerender({ codexModels: [highOnlyModel], busy: true });
      expect(runtimeReady()).toBe("false");
      expect(onSelectionChange).not.toHaveBeenCalled();

      await view.rerender({ busy: false });
      expect(onSelectionChange).toHaveBeenLastCalledWith({
        runtimeModel: "gpt-X",
        reasoningEffort: "high",
        agentId: null,
      });
      expect(onSelectionChange).toHaveBeenCalledTimes(1);

      await view.rerender({ reasoningEffort: "high" });
      expect(runtimeReady()).toBe("true");
      expect(onSelectionChange).toHaveBeenCalledTimes(1);

      await view.rerender({
        codexModels: [firstFallbackModel],
        reasoningEffort: "high",
      });
      expect(runtimeReady()).toBe("false");
      expect(onSelectionChange).toHaveBeenLastCalledWith({
        runtimeModel: "gpt-X",
        reasoningEffort: "none",
        agentId: null,
      });
      expect(onSelectionChange).toHaveBeenCalledTimes(2);

      await view.rerender({ reasoningEffort: "none" });
      expect(runtimeReady()).toBe("true");
      expect(onSelectionChange).toHaveBeenCalledTimes(2);

      await view.rerender({
        codexModels: [noEffortModel],
        reasoningEffort: "none",
      });
      expect(runtimeReady()).toBe("false");
      expect(onSelectionChange).toHaveBeenLastCalledWith({
        runtimeModel: "gpt-X",
        reasoningEffort: null,
        agentId: null,
      });
      expect(onSelectionChange).toHaveBeenCalledTimes(3);

      await view.rerender({ reasoningEffort: null });
      expect(runtimeReady()).toBe("true");
      expect(onSelectionChange).toHaveBeenCalledTimes(3);
    } finally {
      await view.unmount();
    }
  });

  it("keeps session state untouched on cancel and applies defaults after confirm", async () => {
    const onPeerChange = vi
      .fn<RuntimeSelectorTestProps["onPeerChange"]>()
      .mockImplementation((_peer, options) =>
        options?.confirmSessionReset ? "changed" : "confirmation-required",
      );
    const onSelectionChange = vi
      .fn<RuntimeSelectorTestProps["onSelectionChange"]>()
      .mockReturnValue("changed");
    const view = await mountSelector({
      peer: "claude",
      codexModels: [secondCodexModel, codexModel],
      selectedModelId: "sonnet",
      reasoningEffort: "medium",
      onPeerChange,
      onSelectionChange,
    });
    try {
      await act(async () =>
        buttonByLabel(view.container, "Codex peer").click(),
      );
      expect(
        view.container.querySelector('[role="alertdialog"]'),
      ).not.toBeNull();
      await act(async () =>
        buttonByLabel(view.container, "Cancel peer switch").click(),
      );
      expect(onPeerChange).toHaveBeenCalledTimes(1);
      expect(onSelectionChange).not.toHaveBeenCalled();

      await act(async () =>
        buttonByLabel(view.container, "Codex peer").click(),
      );
      await act(async () =>
        buttonByLabel(view.container, "Confirm switch to Codex").click(),
      );
      expect(onPeerChange).toHaveBeenLastCalledWith("codex", {
        confirmSessionReset: true,
      });
      expect(onSelectionChange).toHaveBeenLastCalledWith({
        runtimeModel: "gpt-5.4",
        reasoningEffort: "minimal",
        agentId: null,
      });
    } finally {
      await view.unmount();
    }
  });

  it("mentions API in the confirmation dialog when switching to/from the API peer", async () => {
    const onPeerChange = vi
      .fn<RuntimeSelectorTestProps["onPeerChange"]>()
      .mockReturnValue("confirmation-required");
    const view = await mountSelector({
      peer: "claude",
      onPeerChange,
    });
    try {
      await act(async () => buttonByLabel(view.container, "API peer").click());
      expect(view.container.textContent).toContain(
        "Switching to API will clear this tab's current session and messages.",
      );
      expect(
        buttonByLabel(view.container, "Confirm switch to API"),
      ).not.toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it("focuses the safe confirmation action and restores its trigger on Escape", async () => {
    const onPeerChange = vi
      .fn<RuntimeSelectorTestProps["onPeerChange"]>()
      .mockReturnValue("confirmation-required");
    const view = await mountSelector({
      peer: "claude",
      selectedModelId: "sonnet",
      reasoningEffort: "medium",
      onPeerChange,
    });
    try {
      const trigger = buttonByLabel(view.container, "Codex peer");
      trigger.focus();
      await act(async () => trigger.click());

      const dialog = view.container.querySelector('[role="alertdialog"]');
      const cancel = buttonByLabel(view.container, "Cancel peer switch");
      expect(dialog?.getAttribute("aria-modal")).toBe("true");
      expect(document.activeElement).toBe(cancel);

      await act(async () => {
        cancel.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
      });
      expect(view.container.querySelector('[role="alertdialog"]')).toBeNull();
      expect(document.activeElement).toBe(trigger);
      expect(onPeerChange).toHaveBeenCalledTimes(1);
    } finally {
      await view.unmount();
    }
  });

  it("changes a sessionless peer immediately and writes Claude defaults", async () => {
    const onPeerChange = vi
      .fn<RuntimeSelectorTestProps["onPeerChange"]>()
      .mockReturnValue("changed");
    const onSelectionChange = vi
      .fn<RuntimeSelectorTestProps["onSelectionChange"]>()
      .mockReturnValue("changed");
    const onClaudeModelChange = vi.fn();
    const onClaudeEffortChange = vi.fn();
    const view = await mountSelector({
      selectedClaudeModel: "opus",
      selectedClaudeEffort: "high",
      onPeerChange,
      onSelectionChange,
      onClaudeModelChange,
      onClaudeEffortChange,
    });
    try {
      await act(async () =>
        buttonByLabel(view.container, "Claude peer").click(),
      );
      expect(onPeerChange).toHaveBeenCalledWith("claude", undefined);
      expect(onClaudeModelChange).toHaveBeenCalledWith("opus");
      expect(onClaudeEffortChange).toHaveBeenCalledWith("high");
      expect(onSelectionChange).toHaveBeenCalledWith({
        runtimeModel: "opus",
        reasoningEffort: "high",
        agentId: null,
      });
    } finally {
      await view.unmount();
    }
  });

  it("disables peer, model, and effort changes while streaming or stopping", async () => {
    const onPeerChange = vi.fn();
    const onSelectionChange = vi.fn();
    const view = await mountSelector({
      busy: true,
      onPeerChange,
      onSelectionChange,
    });
    try {
      expect(buttonByLabel(view.container, "Claude peer").disabled).toBe(true);
      expect(
        buttonByLabel(view.container, "Select model GPT-5.4 Mini").disabled,
      ).toBe(true);
      expect(
        buttonByLabel(view.container, "Reasoning effort xhigh").disabled,
      ).toBe(true);
      await act(async () =>
        buttonByLabel(view.container, "Select model GPT-5.4 Mini").click(),
      );
      expect(onPeerChange).not.toHaveBeenCalled();
      expect(onSelectionChange).not.toHaveBeenCalled();
    } finally {
      await view.unmount();
    }
  });

  it("refreshes an authenticated empty Codex list once without a render loop", async () => {
    const onRefreshCodexModels = vi.fn().mockResolvedValue(undefined);
    const view = await mountSelector({
      codexModels: [],
      selectedModelId: null,
      onRefreshCodexModels,
    });
    try {
      expect(onRefreshCodexModels).toHaveBeenCalledTimes(1);
      await view.rerender({ codexModels: [], codexModelsLoading: false });
      await view.rerender({ codexModels: [], codexModelsLoading: false });
      expect(onRefreshCodexModels).toHaveBeenCalledTimes(1);
    } finally {
      await view.unmount();
    }
  });

  it("retries Codex model refresh after a failed one-shot fetch", async () => {
    const onRefreshCodexModels = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce(undefined);
    const view = await mountSelector({
      codexModels: [],
      selectedModelId: null,
      onRefreshCodexModels,
    });
    try {
      expect(onRefreshCodexModels).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => {
        expect(onRefreshCodexModels).toHaveBeenCalledTimes(1);
      });
      await view.rerender({
        codexModels: [],
        codexModelsLoading: true,
      });
      await view.rerender({
        codexModels: [],
        codexModelsLoading: false,
      });
      await vi.waitFor(() => {
        expect(onRefreshCodexModels).toHaveBeenCalledTimes(2);
      });
    } finally {
      await view.unmount();
    }
  });

  it("offers a manual Refresh models button for the Codex peer", async () => {
    const onRefreshCodexModels = vi.fn().mockResolvedValue(undefined);
    const view = await mountSelector({ onRefreshCodexModels });
    try {
      await act(async () =>
        buttonByLabel(view.container, "Refresh Codex models").click(),
      );
      expect(onRefreshCodexModels).toHaveBeenCalled();
    } finally {
      await view.unmount();
    }
  });

  it("shows unavailable runtime status and a disabled future Agent control", async () => {
    const view = await mountSelector({ codexAvailable: false });
    try {
      const codex = buttonByLabel(view.container, "Codex peer");
      expect(codex.disabled).toBe(true);
      expect(codex.textContent).toContain("Not authenticated");
      const agent = buttonByLabel(
        view.container,
        "Agent (coming in the custom-agent phase)",
      );
      expect(agent.disabled).toBe(true);
      expect(agent.textContent).toContain("Coming in the custom-agent phase");
    } finally {
      await view.unmount();
    }
  });
});

function runtimeAccount(
  runtime: RuntimeKind,
  authenticated: boolean,
): RuntimeAccount {
  return {
    runtime,
    installed: true,
    authenticated,
    version: "test",
    accountLabel: null,
    authMode: null,
    capabilities: {
      models: true,
      skills: true,
      customAgents: false,
      subagents: false,
      approvals: true,
    },
    error: null,
  };
}

describe("ChatComposer runtime peer wiring", () => {
  it("shows the active tab's Claude model consistently after switching tabs", async () => {
    const chatSnapshot = useClaudeChatStore.getState();
    const setupSnapshot = useClaudeSetupStore.getState();
    const documentSnapshot = useDocumentStore.getState();
    const runtimeSnapshot = useRuntimeStore.getState();
    const baseTab = chatSnapshot.tabs[0];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

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

      const trigger = document.querySelector(
        'button[title="Switch provider or model"]',
      );
      if (!(trigger instanceof HTMLButtonElement)) {
        throw new Error("Composer runtime trigger not found");
      }
      expect(trigger.textContent).toContain("Opus");
      await act(async () => trigger.click());

      const selectedModelButton = buttonByLabel(
        document.body,
        "Select model Opus",
      );
      const activeTab = useClaudeChatStore
        .getState()
        .tabs.find((tab) => tab.id === "tab-a");

      expect({
        trigger: trigger.textContent,
        rightModelPressed: selectedModelButton.getAttribute("aria-pressed"),
        sendModel: activeTab?.runtimeModel,
        staleGlobalModel: useClaudeChatStore.getState().selectedModel,
      }).toEqual({
        trigger: expect.stringContaining("Opus"),
        rightModelPressed: "true",
        sendModel: "opus",
        staleGlobalModel: "haiku",
      });
    } finally {
      await act(async () => root.unmount());
      container.remove();
      useClaudeChatStore.setState(chatSnapshot, true);
      useClaudeSetupStore.setState(setupSnapshot, true);
      useDocumentStore.setState(documentSnapshot, true);
      useRuntimeStore.setState(runtimeSnapshot, true);
    }
  });

  it("blocks a stale Codex effort and sends only after catalog normalization", async () => {
    const chatSnapshot = useClaudeChatStore.getState();
    const setupSnapshot = useClaudeSetupStore.getState();
    const documentSnapshot = useDocumentStore.getState();
    const runtimeSnapshot = useRuntimeStore.getState();
    const baseTab = chatSnapshot.tabs[0];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const highOnlyModel: RuntimeModel = {
      ...codexModel,
      id: "gpt-X",
      displayName: "GPT-X",
      reasoningEfforts: ["high"],
      defaultReasoningEffort: "high",
    };
    vi.mocked(invoke).mockResolvedValue(undefined as never);

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
      models: { claude: [], codex: [highOnlyModel] },
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
          runtimeModel: "gpt-X",
          reasoningEffort: "medium",
          agentId: null,
          messages: [],
        },
      ],
      activeTabId: "tab-codex",
      activeProjectPath: "C:/project",
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
      const textarea = container.querySelector("textarea");
      if (!(textarea instanceof HTMLTextAreaElement)) {
        throw new Error("Composer textarea not found");
      }
      const setTextareaValue = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      if (!setTextareaValue) {
        throw new Error("Native textarea setter not found");
      }
      await act(async () => {
        setTextareaValue.call(textarea, "Use the normalized effort");
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        await Promise.resolve();
      });
      const sendButton = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Send",
      );
      if (!(sendButton instanceof HTMLButtonElement)) {
        throw new Error("Composer send button not found");
      }
      expect(sendButton.disabled).toBe(true);

      const trigger = document.querySelector(
        'button[title="Switch provider or model"]',
      );
      if (!(trigger instanceof HTMLButtonElement)) {
        throw new Error("Composer runtime trigger not found");
      }
      await act(async () => {
        trigger.click();
        await Promise.resolve();
      });
      expect(
        useClaudeChatStore.getState().tabs.find((tab) => tab.id === "tab-codex")
          ?.reasoningEffort,
      ).toBe("high");
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
          runtime: "codex",
          model: "gpt-X",
          reasoningEffort: "high",
          providerCredentialId: null,
        }),
      });
      expect(
        runtimeStartCalls.some(
          ([, args]) =>
            (
              args as {
                request?: { reasoningEffort?: string | null };
              }
            )?.request?.reasoningEffort === "medium",
        ),
      ).toBe(false);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.mocked(invoke).mockReset();
      useClaudeChatStore.setState(chatSnapshot, true);
      useClaudeSetupStore.setState(setupSnapshot, true);
      useDocumentStore.setState(documentSnapshot, true);
      useRuntimeStore.setState(runtimeSnapshot, true);
    }
  });

  it("sends the Claude peer without a providerCredentialId even with saved API credentials", async () => {
    const chatSnapshot = useClaudeChatStore.getState();
    const setupSnapshot = useClaudeSetupStore.getState();
    const documentSnapshot = useDocumentStore.getState();
    const runtimeSnapshot = useRuntimeStore.getState();
    const baseTab = chatSnapshot.tabs[0];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    vi.mocked(invoke).mockResolvedValue(undefined as never);

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
        (button) => button.textContent?.trim() === "Send",
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
      useClaudeChatStore.setState(chatSnapshot, true);
      useClaudeSetupStore.setState(setupSnapshot, true);
      useDocumentStore.setState(documentSnapshot, true);
      useRuntimeStore.setState(runtimeSnapshot, true);
    }
  });

  it("uses saved Claude defaults when switching from a colliding Codex selection", async () => {
    const chatSnapshot = useClaudeChatStore.getState();
    const setupSnapshot = useClaudeSetupStore.getState();
    const documentSnapshot = useDocumentStore.getState();
    const runtimeSnapshot = useRuntimeStore.getState();
    const baseTab = chatSnapshot.tabs[0];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const collidingCodexModel: RuntimeModel = {
      ...codexModel,
      id: "opus",
      displayName: "Codex Opus Alias",
      reasoningEfforts: ["high"],
      defaultReasoningEffort: "high",
    };

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
      models: { claude: [], codex: [collidingCodexModel] },
      loading: {},
      login: {},
    });
    useClaudeChatStore.setState({
      tabs: [
        {
          ...baseTab,
          id: "tab-codex-alias",
          projectPath: "C:/project",
          runtime: "codex",
          chatPeer: "codex",
          runtimeModel: "opus",
          reasoningEffort: "high",
          agentId: null,
          sessionRef: null,
          sessionId: null,
          messages: [],
        },
      ],
      activeTabId: "tab-codex-alias",
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
      const trigger = document.querySelector(
        'button[title="Switch provider or model"]',
      );
      if (!(trigger instanceof HTMLButtonElement)) {
        throw new Error("Composer runtime trigger not found");
      }
      await act(async () => trigger.click());
      await act(async () =>
        buttonByLabel(document.body, "Claude peer").click(),
      );

      const state = useClaudeChatStore.getState();
      const activeTab = state.tabs.find((tab) => tab.id === "tab-codex-alias");
      expect({
        runtime: activeTab?.runtime,
        runtimeModel: activeTab?.runtimeModel,
        reasoningEffort: activeTab?.reasoningEffort,
        selectedModel: state.selectedModel,
        effortLevel: state.effortLevel,
      }).toEqual({
        runtime: "claude",
        runtimeModel: "haiku",
        reasoningEffort: "low",
        selectedModel: "haiku",
        effortLevel: "low",
      });
    } finally {
      await act(async () => root.unmount());
      container.remove();
      useClaudeChatStore.setState(chatSnapshot, true);
      useClaudeSetupStore.setState(setupSnapshot, true);
      useDocumentStore.setState(documentSnapshot, true);
      useRuntimeStore.setState(runtimeSnapshot, true);
    }
  });

  it("discards a peer confirmation when its owning tab is no longer active", async () => {
    const chatSnapshot = useClaudeChatStore.getState();
    const setupSnapshot = useClaudeSetupStore.getState();
    const documentSnapshot = useDocumentStore.getState();
    const runtimeSnapshot = useRuntimeStore.getState();
    const baseTab = chatSnapshot.tabs[0];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const tabAMessages = [
      {
        type: "user" as const,
        message: {
          content: [{ type: "text" as const, text: "Tab A message" }],
        },
      },
    ];
    const tabBMessages = [
      {
        type: "user" as const,
        message: {
          content: [{ type: "text" as const, text: "Tab B message" }],
        },
      },
    ];

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
          sessionRef: {
            runtime: "claude",
            projectPath: "C:/project",
            sessionId: "session-a",
          },
          sessionId: "session-a",
          runtimeModel: "sonnet",
          reasoningEffort: "medium",
          providerKey: null,
          sessionProviderKey: null,
          messages: tabAMessages,
        },
        {
          ...baseTab,
          id: "tab-b",
          projectPath: "C:/project",
          runtime: "claude",
          chatPeer: "claude",
          sessionRef: {
            runtime: "claude",
            projectPath: "C:/project",
            sessionId: "session-b",
          },
          sessionId: "session-b",
          runtimeModel: "opus",
          reasoningEffort: "high",
          providerKey: null,
          sessionProviderKey: null,
          messages: tabBMessages,
        },
      ],
      activeTabId: "tab-a",
      activeProjectPath: "C:/project",
      selectedModel: "sonnet",
      effortLevel: "medium",
      selectedProviderCredentialId: CLAUDE_CODE_PROVIDER_ID,
      selectedProviderModels: {},
      messages: tabAMessages,
      sessionId: "session-a",
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
      const trigger = document.querySelector(
        'button[title="Switch provider or model"]',
      );
      if (!(trigger instanceof HTMLButtonElement)) {
        throw new Error("Composer runtime trigger not found");
      }
      await act(async () => trigger.click());
      await act(async () => buttonByLabel(document.body, "Codex peer").click());
      expect(
        document.body.querySelector('[role="alertdialog"]'),
      ).not.toBeNull();

      await act(async () => {
        useClaudeChatStore.getState().setActiveTab("tab-b");
        await Promise.resolve();
      });
      const staleConfirm = document.body.querySelector(
        'button[aria-label="Confirm switch to Codex"]',
      );
      if (staleConfirm instanceof HTMLButtonElement) {
        await act(async () => staleConfirm.click());
      }
      const stateAfterStaleConfirm = useClaudeChatStore.getState();
      const tabB = stateAfterStaleConfirm.tabs.find(
        (tab) => tab.id === "tab-b",
      );

      expect({
        staleConfirmationPresent: staleConfirm !== null,
        activeTabId: stateAfterStaleConfirm.activeTabId,
        runtime: tabB?.runtime,
        sessionRef: tabB?.sessionRef,
        sessionId: tabB?.sessionId,
        messages: tabB?.messages,
      }).toEqual({
        staleConfirmationPresent: false,
        activeTabId: "tab-b",
        runtime: "claude",
        sessionRef: {
          runtime: "claude",
          projectPath: "C:/project",
          sessionId: "session-b",
        },
        sessionId: "session-b",
        messages: tabBMessages,
      });
    } finally {
      await act(async () => root.unmount());
      container.remove();
      useClaudeChatStore.setState(chatSnapshot, true);
      useClaudeSetupStore.setState(setupSnapshot, true);
      useDocumentStore.setState(documentSnapshot, true);
      useRuntimeStore.setState(runtimeSnapshot, true);
    }
  });

  it("preserves the active tab's Claude effort and model across separate edits", async () => {
    const chatSnapshot = useClaudeChatStore.getState();
    const setupSnapshot = useClaudeSetupStore.getState();
    const documentSnapshot = useDocumentStore.getState();
    const runtimeSnapshot = useRuntimeStore.getState();
    const baseTab = chatSnapshot.tabs[0];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

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
      const trigger = document.querySelector(
        'button[title="Switch provider or model"]',
      );
      if (!(trigger instanceof HTMLButtonElement)) {
        throw new Error("Composer runtime trigger not found");
      }
      await act(async () => trigger.click());
      await act(async () =>
        buttonByLabel(document.body, "Select model Haiku").click(),
      );

      let activeTab = useClaudeChatStore
        .getState()
        .tabs.find((tab) => tab.id === "tab-active");
      expect(activeTab?.runtimeModel).toBe("haiku");
      expect(activeTab?.reasoningEffort).toBe("high");
      expect(
        useClaudeChatStore.getState().tabs.find((tab) => tab.id === "tab-other")
          ?.reasoningEffort,
      ).toBe("low");

      await act(async () => {
        useClaudeChatStore.setState({ selectedModel: "sonnet" });
      });
      await act(async () =>
        buttonByLabel(document.body, "Reasoning effort low").click(),
      );
      activeTab = useClaudeChatStore
        .getState()
        .tabs.find((tab) => tab.id === "tab-active");
      expect(activeTab?.runtimeModel).toBe("haiku");
      expect(activeTab?.reasoningEffort).toBe("low");
    } finally {
      await act(async () => root.unmount());
      container.remove();
      useClaudeChatStore.setState(chatSnapshot, true);
      useClaudeSetupStore.setState(setupSnapshot, true);
      useDocumentStore.setState(documentSnapshot, true);
      useRuntimeStore.setState(runtimeSnapshot, true);
    }
  });

  it("scrolls the selected compatible-provider model into view when opened", async () => {
    const chatSnapshot = useClaudeChatStore.getState();
    const setupSnapshot = useClaudeSetupStore.getState();
    const documentSnapshot = useDocumentStore.getState();
    const runtimeSnapshot = useRuntimeStore.getState();
    const baseTab = chatSnapshot.tabs[0];
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "list_openai_compatible_credential_models") {
        return ["first-model", "selected-model", "last-model"];
      }
      return [];
    });

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
          model: "first-model",
        },
      ],
      activeOpenAiCredentialId: "provider-a",
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
          id: "tab-provider",
          projectPath: "C:/project",
          runtime: "claude",
          chatPeer: "api",
          runtimeModel: "sonnet",
          reasoningEffort: "medium",
        },
      ],
      activeTabId: "tab-provider",
      activeProjectPath: "C:/project",
      selectedProviderCredentialId: "provider-a",
      selectedProviderModels: { "provider-a": "selected-model" },
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
      const trigger = document.querySelector(
        'button[title="Switch provider or model"]',
      );
      if (!(trigger instanceof HTMLButtonElement)) {
        throw new Error("Composer runtime trigger not found");
      }
      await act(async () => {
        trigger.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const selectedModelButton = Array.from(
        document.body.querySelectorAll("button"),
      ).find((button) => button.textContent?.trim() === "selected-model");
      const firstModelButton = Array.from(
        document.body.querySelectorAll("button"),
      ).find((button) => button.textContent?.trim() === "first-model");
      expect(invoke).toHaveBeenCalledWith(
        "list_openai_compatible_credential_models",
        { credentialId: "provider-a" },
      );
      expect(selectedModelButton).toBeInstanceOf(HTMLButtonElement);
      expect(selectedModelButton?.getAttribute("aria-pressed")).toBe("true");
      expect(firstModelButton?.getAttribute("aria-pressed")).toBe("false");
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.mocked(invoke).mockReset();
      if (originalScrollIntoView) {
        Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
          configurable: true,
          value: originalScrollIntoView,
        });
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
      }
      useClaudeChatStore.setState(chatSnapshot, true);
      useClaudeSetupStore.setState(setupSnapshot, true);
      useDocumentStore.setState(documentSnapshot, true);
      useRuntimeStore.setState(runtimeSnapshot, true);
    }
  });
});
