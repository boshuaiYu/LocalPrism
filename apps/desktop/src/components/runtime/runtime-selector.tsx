import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import type {
  ChangeTabRuntimeResult,
  ConversationRef,
  RuntimeConversation,
  RuntimeKind,
  RuntimeModel,
} from "@/runtime/types";
import { cn } from "@/lib/utils";

export type ClaudeModelAlias = "sonnet" | "opus" | "haiku" | "opusplan";

export interface ClaudeModelOption {
  id: ClaudeModelAlias;
  displayName: string;
  description: string;
}

export const CLAUDE_MODEL_OPTIONS = [
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
] as const satisfies readonly ClaudeModelOption[];

export const CLAUDE_REASONING_EFFORT_OPTIONS = [
  "low",
  "medium",
  "high",
] as const;

export type ClaudeReasoningEffort =
  (typeof CLAUDE_REASONING_EFFORT_OPTIONS)[number];

/** Matches the existing Claude composer default when an effort is unsupported. */
export const CLAUDE_DEFAULT_REASONING_EFFORT: ClaudeReasoningEffort = "medium";

export function getCodexModelOptions(
  models: readonly RuntimeModel[],
): RuntimeModel[] {
  return models.filter((model) => model.runtime === "codex");
}

export function getReasoningEffortOptions(
  runtime: RuntimeKind,
  selectedModel: RuntimeModel | null,
): readonly string[] {
  if (runtime === "claude") {
    return CLAUDE_REASONING_EFFORT_OPTIONS;
  }

  return selectedModel?.runtime === "codex"
    ? selectedModel.reasoningEfforts
    : [];
}

export function normalizeReasoningEffort(
  runtime: RuntimeKind,
  currentEffort: string | null,
  selectedModel: RuntimeModel | null,
): string | null {
  const supportedEfforts = getReasoningEffortOptions(runtime, selectedModel);
  if (currentEffort !== null && supportedEfforts.includes(currentEffort)) {
    return currentEffort;
  }

  if (runtime === "claude") {
    return CLAUDE_DEFAULT_REASONING_EFFORT;
  }

  const defaultEffort =
    selectedModel?.runtime === "codex"
      ? selectedModel.defaultReasoningEffort
      : null;
  if (defaultEffort !== null && supportedEfforts.includes(defaultEffort)) {
    return defaultEffort;
  }

  return supportedEfforts[0] ?? null;
}

export function getDefaultCodexModel(
  models: readonly RuntimeModel[],
): RuntimeModel | null {
  const codexModels = getCodexModelOptions(models);
  return codexModels.find((model) => model.isDefault) ?? codexModels[0] ?? null;
}

export function getSelectedCodexModel(
  models: readonly RuntimeModel[],
  selectedModelId: string | null,
): RuntimeModel | null {
  if (selectedModelId === null) return null;
  return (
    getCodexModelOptions(models).find(
      (model) => model.id === selectedModelId,
    ) ?? null
  );
}

export function isRuntimeSelectionReady(
  runtime: RuntimeKind,
  claudeAvailable: boolean,
  codexAvailable: boolean,
  selectedCodexModel: RuntimeModel | null,
  reasoningEffort: string | null,
): boolean {
  if (runtime === "claude") return claudeAvailable;
  if (!codexAvailable || selectedCodexModel?.runtime !== "codex") return false;

  return selectedCodexModel.reasoningEfforts.length === 0
    ? reasoningEffort === null
    : reasoningEffort !== null &&
        selectedCodexModel.reasoningEfforts.includes(reasoningEffort);
}

export function isRuntimeSendDisabled(
  isStreaming: boolean,
  hasInput: boolean,
  runtimeReady: boolean,
): boolean {
  return isStreaming ? hasInput && !runtimeReady : !hasInput || !runtimeReady;
}

export function runtimeSelectionSupportsImages(
  runtime: RuntimeKind,
  selectedCodexModel: RuntimeModel | null,
  claudeSupportsImages: boolean,
): boolean {
  return runtime === "codex"
    ? selectedCodexModel?.inputModalities.includes("image") === true
    : claudeSupportsImages;
}

export interface RuntimeSelection {
  runtimeModel: string | null;
  reasoningEffort: string | null;
  agentId: string | null;
}

export interface RuntimeSelectorProps {
  runtime: RuntimeKind;
  claudeAvailable: boolean;
  codexAvailable: boolean;
  codexModels: RuntimeModel[];
  codexModelsLoading: boolean;
  selectedModelId: string | null;
  reasoningEffort: string | null;
  busy: boolean;
  claudeProviderControls: ReactNode;
  claudeModelControls?: ReactNode;
  claudeModelListRef?: Ref<HTMLDivElement>;
  selectedClaudeModel: ClaudeModelAlias;
  selectedClaudeEffort: ClaudeReasoningEffort;
  onRuntimeChange: (
    runtime: RuntimeKind,
    options?: { confirmSessionReset?: boolean },
  ) => ChangeTabRuntimeResult;
  onSelectionChange: (selection: RuntimeSelection) => unknown;
  onClaudeModelChange: (model: ClaudeModelAlias) => void;
  onClaudeEffortChange: (effort: ClaudeReasoningEffort) => void;
  onRefreshCodexModels: () => Promise<void>;
}

function optionButtonClass(active: boolean): string {
  return cn(
    "flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50",
    active
      ? "bg-accent text-accent-foreground"
      : "text-foreground hover:bg-muted",
  );
}

export function RuntimeSelector({
  runtime,
  claudeAvailable,
  codexAvailable,
  codexModels,
  codexModelsLoading,
  selectedModelId,
  reasoningEffort,
  busy,
  claudeProviderControls,
  claudeModelControls,
  claudeModelListRef,
  selectedClaudeModel,
  selectedClaudeEffort,
  onRuntimeChange,
  onSelectionChange,
  onClaudeModelChange,
  onClaudeEffortChange,
  onRefreshCodexModels,
}: RuntimeSelectorProps) {
  const [pendingRuntime, setPendingRuntime] = useState<RuntimeKind | null>(
    null,
  );
  const refreshRequestedRef = useRef(false);
  const runtimeChangeTriggerRef = useRef<HTMLButtonElement | null>(null);
  const cancelRuntimeChangeRef = useRef<HTMLButtonElement | null>(null);
  const codexOptions = useMemo(
    () => getCodexModelOptions(codexModels),
    [codexModels],
  );
  const selectedCodexModel = useMemo(
    () => getSelectedCodexModel(codexOptions, selectedModelId),
    [codexOptions, selectedModelId],
  );
  const runtimeReady = isRuntimeSelectionReady(
    runtime,
    claudeAvailable,
    codexAvailable,
    selectedCodexModel,
    reasoningEffort,
  );

  useEffect(() => {
    if (runtime !== "codex") {
      refreshRequestedRef.current = false;
      return;
    }
    if (codexOptions.length > 0) {
      refreshRequestedRef.current = false;
      return;
    }
    if (!codexAvailable || codexModelsLoading || refreshRequestedRef.current) {
      return;
    }

    refreshRequestedRef.current = true;
    void onRefreshCodexModels().catch(() => {
      refreshRequestedRef.current = false;
    });
  }, [
    codexAvailable,
    codexModelsLoading,
    codexOptions.length,
    onRefreshCodexModels,
    runtime,
  ]);

  useEffect(() => {
    if (
      runtime !== "codex" ||
      !codexAvailable ||
      busy ||
      codexModelsLoading ||
      codexOptions.length === 0
    ) {
      return;
    }
    const model = selectedCodexModel ?? getDefaultCodexModel(codexOptions);
    if (!model) return;
    const normalizedEffort = normalizeReasoningEffort(
      "codex",
      selectedCodexModel ? reasoningEffort : null,
      model,
    );
    if (selectedCodexModel && normalizedEffort === reasoningEffort) return;
    onSelectionChange({
      runtimeModel: model.id,
      reasoningEffort: normalizedEffort,
      agentId: null,
    });
  }, [
    busy,
    codexAvailable,
    codexModelsLoading,
    codexOptions,
    onSelectionChange,
    reasoningEffort,
    runtime,
    selectedCodexModel,
  ]);

  useEffect(() => {
    if (pendingRuntime) {
      cancelRuntimeChangeRef.current?.focus();
    }
  }, [pendingRuntime]);

  const writeRuntimeDefaults = (nextRuntime: RuntimeKind) => {
    if (nextRuntime === "claude") {
      onClaudeModelChange(selectedClaudeModel);
      onClaudeEffortChange(selectedClaudeEffort);
      onSelectionChange({
        runtimeModel: selectedClaudeModel,
        reasoningEffort: selectedClaudeEffort,
        agentId: null,
      });
      return;
    }

    const model = getDefaultCodexModel(codexOptions);
    onSelectionChange({
      runtimeModel: model?.id ?? null,
      reasoningEffort: model
        ? normalizeReasoningEffort("codex", null, model)
        : null,
      agentId: null,
    });
  };

  const requestRuntimeChange = (
    nextRuntime: RuntimeKind,
    trigger: HTMLButtonElement,
  ) => {
    if (busy || nextRuntime === runtime) return;
    const result = onRuntimeChange(nextRuntime, undefined);
    if (result === "confirmation-required") {
      runtimeChangeTriggerRef.current = trigger;
      setPendingRuntime(nextRuntime);
      return;
    }
    if (result === "changed") {
      writeRuntimeDefaults(nextRuntime);
    }
  };

  const closeRuntimeConfirmation = () => {
    setPendingRuntime(null);
    runtimeChangeTriggerRef.current?.focus();
  };

  const confirmRuntimeChange = () => {
    if (!pendingRuntime || busy) return;
    const nextRuntime = pendingRuntime;
    const result = onRuntimeChange(nextRuntime, { confirmSessionReset: true });
    closeRuntimeConfirmation();
    if (result === "changed") {
      writeRuntimeDefaults(nextRuntime);
    }
  };

  const selectClaudeModel = (model: ClaudeModelAlias) => {
    if (busy || !claudeAvailable) return;
    onClaudeModelChange(model);
    onSelectionChange({
      runtimeModel: model,
      reasoningEffort: selectedClaudeEffort,
      agentId: null,
    });
  };

  const selectClaudeEffort = (effort: ClaudeReasoningEffort) => {
    if (busy || !claudeAvailable) return;
    onClaudeEffortChange(effort);
    onSelectionChange({
      runtimeModel: selectedClaudeModel,
      reasoningEffort: effort,
      agentId: null,
    });
  };

  const selectCodexModel = (model: RuntimeModel) => {
    if (busy || !codexAvailable) return;
    onSelectionChange({
      runtimeModel: model.id,
      reasoningEffort: normalizeReasoningEffort(
        "codex",
        reasoningEffort,
        model,
      ),
      agentId: null,
    });
  };

  const selectCodexEffort = (effort: string) => {
    if (busy || !codexAvailable || !selectedCodexModel) return;
    onSelectionChange({
      runtimeModel: selectedCodexModel.id,
      reasoningEffort: effort,
      agentId: null,
    });
  };

  const effortOptions = getReasoningEffortOptions(runtime, selectedCodexModel);

  return (
    <section
      aria-label="Runtime controls"
      data-runtime-ready={runtimeReady ? "true" : "false"}
      className="grid grid-cols-[minmax(0,11.5rem)_minmax(0,1fr)]"
    >
      <div className="max-h-80 overflow-y-auto border-border border-r pr-1">
        <div className="px-2 py-1 font-medium text-muted-foreground text-xs">
          Runtime
        </div>
        <button
          type="button"
          aria-label="Claude runtime"
          aria-pressed={runtime === "claude"}
          className={optionButtonClass(runtime === "claude")}
          disabled={busy || !claudeAvailable}
          onClick={(event) =>
            requestRuntimeChange("claude", event.currentTarget)
          }
        >
          <span className="font-medium text-xs">Claude</span>
          <span className="text-muted-foreground text-xs">
            {claudeAvailable ? "Ready" : "Not authenticated"}
          </span>
        </button>
        <button
          type="button"
          aria-label="Codex runtime"
          aria-pressed={runtime === "codex"}
          className={optionButtonClass(runtime === "codex")}
          disabled={busy || !codexAvailable}
          onClick={(event) =>
            requestRuntimeChange("codex", event.currentTarget)
          }
        >
          <span className="font-medium text-xs">Codex</span>
          <span className="text-muted-foreground text-xs">
            {codexAvailable ? "Ready" : "Not authenticated"}
          </span>
        </button>

        {runtime === "claude" && (
          <div aria-disabled={busy ? "true" : undefined}>
            <div className="mt-1 border-border border-t px-2 pt-2 pb-1 font-medium text-muted-foreground text-xs">
              Provider
            </div>
            {claudeProviderControls}
          </div>
        )}
      </div>

      <div
        ref={claudeModelListRef}
        className="flex max-h-80 min-w-0 flex-col overflow-y-auto pl-1"
      >
        <div className="px-2 py-1 font-medium text-muted-foreground text-xs">
          Model
        </div>
        {runtime === "claude" && claudeModelControls ? (
          claudeModelControls
        ) : runtime === "claude" ? (
          CLAUDE_MODEL_OPTIONS.map((model) => (
            <button
              type="button"
              key={model.id}
              aria-label={`Select model ${model.displayName}`}
              aria-pressed={selectedClaudeModel === model.id}
              className={optionButtonClass(selectedClaudeModel === model.id)}
              disabled={busy || !claudeAvailable}
              onClick={() => selectClaudeModel(model.id)}
            >
              <span className="min-w-0">
                <span className="block font-medium text-xs">
                  {model.displayName}
                </span>
                <span className="block truncate text-muted-foreground text-xs">
                  {model.description}
                </span>
              </span>
              {selectedClaudeModel === model.id && <span aria-hidden>✓</span>}
            </button>
          ))
        ) : codexModelsLoading && codexOptions.length === 0 ? (
          <div className="px-3 py-2 text-muted-foreground text-xs">
            Fetching Codex models...
          </div>
        ) : codexOptions.length === 0 ? (
          <div className="px-3 py-2 text-muted-foreground text-xs">
            No Codex models available
          </div>
        ) : (
          codexOptions.map((model) => (
            <button
              type="button"
              key={model.id}
              aria-label={`Select model ${model.displayName}`}
              aria-pressed={selectedCodexModel?.id === model.id}
              className={optionButtonClass(selectedCodexModel?.id === model.id)}
              disabled={busy || !codexAvailable}
              onClick={() => selectCodexModel(model)}
            >
              <span className="min-w-0">
                <span className="block font-medium text-xs">
                  {model.displayName}
                </span>
                {model.description && (
                  <span className="block truncate text-muted-foreground text-xs">
                    {model.description}
                  </span>
                )}
              </span>
              {selectedCodexModel?.id === model.id && (
                <span aria-hidden>✓</span>
              )}
            </button>
          ))
        )}

        <div className="mt-1 border-border border-t px-2 pt-2 pb-1 font-medium text-muted-foreground text-xs">
          Reasoning effort
        </div>
        <div className="flex flex-wrap gap-1 px-2 pb-2">
          {runtime === "claude"
            ? CLAUDE_REASONING_EFFORT_OPTIONS.map((effort) => (
                <button
                  type="button"
                  key={effort}
                  aria-label={`Reasoning effort ${effort}`}
                  aria-pressed={selectedClaudeEffort === effort}
                  className={cn(
                    "rounded-md px-2 py-1 font-medium text-xs disabled:cursor-not-allowed disabled:opacity-50",
                    selectedClaudeEffort === effort
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground",
                  )}
                  disabled={busy || !claudeAvailable}
                  onClick={() => selectClaudeEffort(effort)}
                >
                  {effort}
                </button>
              ))
            : effortOptions.map((effort) => (
                <button
                  type="button"
                  key={effort}
                  aria-label={`Reasoning effort ${effort}`}
                  aria-pressed={reasoningEffort === effort}
                  className={cn(
                    "rounded-md px-2 py-1 font-medium text-xs disabled:cursor-not-allowed disabled:opacity-50",
                    reasoningEffort === effort
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground",
                  )}
                  disabled={busy || !codexAvailable || !selectedCodexModel}
                  onClick={() => selectCodexEffort(effort)}
                >
                  {effort}
                </button>
              ))}
        </div>

        <div className="border-border border-t px-2 pt-2 pb-1 font-medium text-muted-foreground text-xs">
          Agent
        </div>
        <button
          type="button"
          aria-label="Agent (coming in the custom-agent phase)"
          disabled
          className="mx-2 mb-2 flex cursor-not-allowed items-center justify-between rounded-lg bg-muted px-3 py-2 text-left text-muted-foreground opacity-60"
        >
          <span className="font-medium text-xs">Agent</span>
          <span className="text-xs">Coming in the custom-agent phase</span>
        </button>
      </div>

      {pendingRuntime && (
        <div
          role="alertdialog"
          aria-label="Confirm runtime switch"
          aria-modal="true"
          className="col-span-2 m-1 border-border border-t px-3 py-2"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            closeRuntimeConfirmation();
          }}
        >
          <p className="text-xs">
            Switching to {pendingRuntime === "codex" ? "Codex" : "Claude"}
            will clear this tab&apos;s current session and messages.
          </p>
          <div className="mt-2 flex justify-end gap-2">
            <button
              ref={cancelRuntimeChangeRef}
              type="button"
              aria-label="Cancel runtime switch"
              className="rounded-md px-2 py-1 text-xs hover:bg-muted"
              onClick={closeRuntimeConfirmation}
            >
              Cancel
            </button>
            <button
              type="button"
              aria-label={`Confirm switch to ${pendingRuntime === "codex" ? "Codex" : "Claude"}`}
              className="rounded-md bg-primary px-2 py-1 text-primary-foreground text-xs"
              disabled={busy}
              onClick={confirmRuntimeChange}
            >
              Switch and clear session
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

export function filterRuntimeConversations(
  conversations: readonly RuntimeConversation[],
  runtime: RuntimeKind,
  projectPath: string,
): RuntimeConversation[] {
  return conversations.filter(
    (conversation) =>
      conversation.reference.runtime === runtime &&
      conversation.reference.projectPath === projectPath,
  );
}

export function matchesConversationReference(
  conversation: RuntimeConversation,
  reference: ConversationRef | null,
): boolean {
  return (
    reference !== null &&
    conversation.reference.runtime === reference.runtime &&
    conversation.reference.projectPath === reference.projectPath &&
    conversation.reference.sessionId === reference.sessionId
  );
}
