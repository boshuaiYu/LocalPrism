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
  ChatRuntimePeer,
  ConversationRef,
  RuntimeConversation,
  RuntimeKind,
  RuntimeModel,
} from "@/runtime/types";
import { AgentSelector } from "@/components/agents/agent-selector";
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

/** Codex catalog may advertise max/ultra while the Responses API only accepts xhigh. */
const CODEX_EFFORT_ALIASES: Record<string, string> = {
  max: "xhigh",
  ultra: "xhigh",
};

/** "claude" and "api" are both Claude-backed peers and share the same effort set. */
export function getReasoningEffortOptions(
  peer: ChatRuntimePeer,
  selectedModel: RuntimeModel | null,
): readonly string[] {
  if (peer !== "codex") {
    return CLAUDE_REASONING_EFFORT_OPTIONS;
  }

  if (selectedModel?.runtime !== "codex") return [];
  // Catalog may list max/ultra; expose the API-stable xhigh instead.
  const seen = new Set<string>();
  const options: string[] = [];
  for (const effort of selectedModel.reasoningEfforts) {
    const normalized = CODEX_EFFORT_ALIASES[effort] ?? effort;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    options.push(normalized);
  }
  return options;
}

const CODEX_API_STABLE_EFFORTS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export function coerceCodexReasoningEffort(
  effort: string | null | undefined,
  selectedModel: RuntimeModel | null,
): string | null {
  if (selectedModel?.runtime !== "codex") return effort?.trim() || null;
  const supported = selectedModel.reasoningEfforts;
  if (supported.length === 0) return null;

  const resolve = (value: string | null | undefined): string | null => {
    const raw = value?.trim() || null;
    if (!raw) return null;
    return CODEX_EFFORT_ALIASES[raw] ?? raw;
  };

  const candidates = [
    resolve(effort),
    resolve(selectedModel.defaultReasoningEffort),
    ...CODEX_API_STABLE_EFFORTS,
    supported[0],
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    // Accept catalog-listed efforts, or xhigh after max/ultra coercion even if
    // the catalog omitted the stable name.
    if (
      supported.includes(candidate) ||
      (candidate === "xhigh" &&
        (supported.includes("max") || supported.includes("ultra")))
    ) {
      return candidate;
    }
  }
  return supported.find((entry) => !(entry in CODEX_EFFORT_ALIASES)) ?? null;
}

export function normalizeReasoningEffort(
  peer: ChatRuntimePeer,
  currentEffort: string | null,
  selectedModel: RuntimeModel | null,
): string | null {
  if (peer === "codex") {
    return coerceCodexReasoningEffort(currentEffort, selectedModel);
  }

  const supportedEfforts = getReasoningEffortOptions(peer, selectedModel);
  if (currentEffort !== null && supportedEfforts.includes(currentEffort)) {
    return currentEffort;
  }

  return CLAUDE_DEFAULT_REASONING_EFFORT;
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
  peer: ChatRuntimePeer,
  claudeAvailable: boolean,
  apiAvailable: boolean,
  codexAvailable: boolean,
  selectedCodexModel: RuntimeModel | null,
  reasoningEffort: string | null,
): boolean {
  if (peer === "claude") return claudeAvailable;
  if (peer === "api") return apiAvailable;
  if (!codexAvailable || selectedCodexModel?.runtime !== "codex") return false;

  const supportedEfforts = getReasoningEffortOptions(
    "codex",
    selectedCodexModel,
  );
  return supportedEfforts.length === 0
    ? reasoningEffort === null
    : reasoningEffort !== null && supportedEfforts.includes(reasoningEffort);
}

export function isRuntimeSendDisabled(
  isStreaming: boolean,
  hasInput: boolean,
  runtimeReady: boolean,
): boolean {
  return isStreaming ? hasInput && !runtimeReady : !hasInput || !runtimeReady;
}

export function runtimeSelectionSupportsImages(
  peer: ChatRuntimePeer,
  selectedCodexModel: RuntimeModel | null,
  claudeSupportsImages: boolean,
): boolean {
  return peer === "codex"
    ? selectedCodexModel?.inputModalities.includes("image") === true
    : claudeSupportsImages;
}

export interface RuntimeSelection {
  runtimeModel: string | null;
  reasoningEffort: string | null;
  agentId: string | null;
}

export interface RuntimeSelectorProps {
  peer: ChatRuntimePeer;
  claudeAvailable: boolean;
  apiAvailable: boolean;
  codexAvailable: boolean;
  codexModels: RuntimeModel[];
  codexModelsLoading: boolean;
  selectedModelId: string | null;
  reasoningEffort: string | null;
  agentId?: string | null;
  projectPath?: string | null;
  busy: boolean;
  apiProviderControls: ReactNode;
  apiModelControls?: ReactNode;
  apiModelListRef?: Ref<HTMLDivElement>;
  selectedClaudeModel: ClaudeModelAlias;
  selectedClaudeEffort: ClaudeReasoningEffort;
  onPeerChange: (
    peer: ChatRuntimePeer,
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

function peerLabel(peer: ChatRuntimePeer): string {
  if (peer === "api") return "API";
  if (peer === "codex") return "Codex";
  return "Claude";
}

export function RuntimeSelector({
  peer,
  claudeAvailable,
  apiAvailable,
  codexAvailable,
  codexModels,
  codexModelsLoading,
  selectedModelId,
  reasoningEffort,
  agentId = null,
  projectPath = null,
  busy,
  apiProviderControls,
  apiModelControls,
  apiModelListRef,
  selectedClaudeModel,
  selectedClaudeEffort,
  onPeerChange,
  onSelectionChange,
  onClaudeModelChange,
  onClaudeEffortChange,
  onRefreshCodexModels,
}: RuntimeSelectorProps) {
  const [pendingPeer, setPendingPeer] = useState<ChatRuntimePeer | null>(null);
  const refreshRequestedRef = useRef(false);
  const peerChangeTriggerRef = useRef<HTMLButtonElement | null>(null);
  const cancelPeerChangeRef = useRef<HTMLButtonElement | null>(null);
  const codexOptions = useMemo(
    () => getCodexModelOptions(codexModels),
    [codexModels],
  );
  const selectedCodexModel = useMemo(
    () => getSelectedCodexModel(codexOptions, selectedModelId),
    [codexOptions, selectedModelId],
  );
  const runtimeReady = isRuntimeSelectionReady(
    peer,
    claudeAvailable,
    apiAvailable,
    codexAvailable,
    selectedCodexModel,
    reasoningEffort,
  );

  useEffect(() => {
    if (peer !== "codex") {
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
    peer,
  ]);

  useEffect(() => {
    if (
      peer !== "codex" ||
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
      agentId,
    });
  }, [
    agentId,
    busy,
    codexAvailable,
    codexModelsLoading,
    codexOptions,
    onSelectionChange,
    reasoningEffort,
    peer,
    selectedCodexModel,
  ]);

  useEffect(() => {
    if (pendingPeer) {
      cancelPeerChangeRef.current?.focus();
    }
  }, [pendingPeer]);

  const writePeerDefaults = (nextPeer: ChatRuntimePeer) => {
    if (nextPeer !== "codex") {
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

  const requestPeerChange = (
    nextPeer: ChatRuntimePeer,
    trigger: HTMLButtonElement,
  ) => {
    if (busy || nextPeer === peer) return;
    const result = onPeerChange(nextPeer, undefined);
    if (result === "confirmation-required") {
      peerChangeTriggerRef.current = trigger;
      setPendingPeer(nextPeer);
      return;
    }
    if (result === "changed") {
      writePeerDefaults(nextPeer);
    }
  };

  const closePeerConfirmation = () => {
    setPendingPeer(null);
    peerChangeTriggerRef.current?.focus();
  };

  const confirmPeerChange = () => {
    if (!pendingPeer || busy) return;
    const nextPeer = pendingPeer;
    const result = onPeerChange(nextPeer, { confirmSessionReset: true });
    closePeerConfirmation();
    if (result === "changed") {
      writePeerDefaults(nextPeer);
    }
  };

  const selectClaudeModel = (model: ClaudeModelAlias) => {
    if (busy || (peer === "claude" ? !claudeAvailable : !apiAvailable)) return;
    onClaudeModelChange(model);
    onSelectionChange({
      runtimeModel: model,
      reasoningEffort: selectedClaudeEffort,
      agentId,
    });
  };

  const selectClaudeEffort = (effort: ClaudeReasoningEffort) => {
    if (busy || (peer === "claude" ? !claudeAvailable : !apiAvailable)) return;
    onClaudeEffortChange(effort);
    onSelectionChange({
      runtimeModel: selectedClaudeModel,
      reasoningEffort: effort,
      agentId,
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
      agentId,
    });
  };

  const selectCodexEffort = (effort: string) => {
    if (busy || !codexAvailable || !selectedCodexModel) return;
    onSelectionChange({
      runtimeModel: selectedCodexModel.id,
      reasoningEffort: effort,
      agentId,
    });
  };

  const effortOptions = getReasoningEffortOptions(peer, selectedCodexModel);

  return (
    <section
      aria-label="Runtime controls"
      data-runtime-ready={runtimeReady ? "true" : "false"}
      className="grid grid-cols-[minmax(0,11.5rem)_minmax(0,1fr)]"
    >
      <div className="col-span-2 flex items-center gap-1 border-border border-b px-2 pb-2">
        <button
          type="button"
          aria-label="Claude peer"
          aria-pressed={peer === "claude"}
          className={cn(
            "flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 font-medium text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50",
            peer === "claude"
              ? "bg-accent text-accent-foreground"
              : "text-foreground hover:bg-muted",
          )}
          disabled={busy || !claudeAvailable}
          onClick={(event) => requestPeerChange("claude", event.currentTarget)}
        >
          Claude
        </button>
        <button
          type="button"
          aria-label="API peer"
          aria-pressed={peer === "api"}
          className={cn(
            "flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 font-medium text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50",
            peer === "api"
              ? "bg-accent text-accent-foreground"
              : "text-foreground hover:bg-muted",
          )}
          disabled={busy}
          onClick={(event) => requestPeerChange("api", event.currentTarget)}
        >
          API
        </button>
        <button
          type="button"
          aria-label="Codex peer"
          aria-pressed={peer === "codex"}
          className={cn(
            "flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 font-medium text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50",
            peer === "codex"
              ? "bg-accent text-accent-foreground"
              : "text-foreground hover:bg-muted",
          )}
          disabled={busy || !codexAvailable}
          onClick={(event) => requestPeerChange("codex", event.currentTarget)}
        >
          Codex
          <span className="text-[10px] text-muted-foreground">
            {codexAvailable ? "" : "Not authenticated"}
          </span>
        </button>
      </div>

      <div className="max-h-80 overflow-y-auto border-border border-r pr-1">
        {peer === "api" && (
          <>
            <div className="px-2 py-1 font-medium text-muted-foreground text-xs">
              API connections
            </div>
            {apiProviderControls}
          </>
        )}
      </div>

      <div
        ref={peer === "api" ? apiModelListRef : undefined}
        className="flex max-h-80 min-w-0 flex-col overflow-y-auto pl-1"
      >
        <div className="flex items-center justify-between px-2 py-1">
          <span className="font-medium text-muted-foreground text-xs">
            Model
          </span>
          {peer === "codex" && (
            <button
              type="button"
              aria-label="Refresh Codex models"
              className="rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              disabled={busy || !codexAvailable || codexModelsLoading}
              onClick={() => void onRefreshCodexModels()}
            >
              Refresh models
            </button>
          )}
        </div>
        {peer !== "codex" ? (
          peer === "api" && apiModelControls ? (
            apiModelControls
          ) : peer === "api" ? (
            <div className="px-3 py-2 text-muted-foreground text-xs">
              Select an API connection to see its models
            </div>
          ) : (
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
          )
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
          {peer !== "codex"
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
                  disabled={
                    busy ||
                    (peer === "claude" ? !claudeAvailable : !apiAvailable)
                  }
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
        <AgentSelector
          peer={peer}
          projectPath={projectPath}
          agentId={agentId}
          busy={busy}
          onAgentChange={(nextAgentId) =>
            onSelectionChange({
              runtimeModel: selectedModelId,
              reasoningEffort,
              agentId: nextAgentId,
            })
          }
        />
      </div>

      {pendingPeer && (
        <div
          role="alertdialog"
          aria-label="Confirm peer switch"
          aria-modal="true"
          className="col-span-2 m-1 border-border border-t px-3 py-2"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            closePeerConfirmation();
          }}
        >
          <p className="text-xs">
            Switching to {peerLabel(pendingPeer)} will clear this tab&apos;s
            current session and messages.
          </p>
          <div className="mt-2 flex justify-end gap-2">
            <button
              ref={cancelPeerChangeRef}
              type="button"
              aria-label="Cancel peer switch"
              className="rounded-md px-2 py-1 text-xs hover:bg-muted"
              onClick={closePeerConfirmation}
            >
              Cancel
            </button>
            <button
              type="button"
              aria-label={`Confirm switch to ${peerLabel(pendingPeer)}`}
              className="rounded-md bg-primary px-2 py-1 text-primary-foreground text-xs"
              disabled={busy}
              onClick={confirmPeerChange}
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
