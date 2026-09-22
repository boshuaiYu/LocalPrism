import { useMemo, type ReactNode, type Ref } from "react";
import type {
  ChangeTabRuntimeResult,
  ChatRuntimePeer,
  ConversationRef,
  RuntimeConversation,
  RuntimeKind,
  RuntimeModel,
} from "@/runtime/types";
import { ReasoningStrengthControl } from "@/components/claude-chat/reasoning-strength-control";
import { resolveFastModelPair } from "@/lib/fast-model";
import {
  normalizeReasoningEffortOptions,
  resolveReasoningEffort,
} from "@/lib/reasoning-effort";
import {
  deriveReasoningStrength,
  reasoningStrengthWireValue,
} from "@/lib/reasoning-strength";
import { cn } from "@/lib/utils";
import { useProviderStore } from "@/stores/provider-store";

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

/**
 * Catalog may still list these, but current Responses API (e.g. gpt-5.6-sol)
 * rejects them on the wire and triggers long reconnect storms.
 */
const CODEX_UNSUPPORTED_WIRE_EFFORTS = new Set(["minimal"]);

const CODEX_API_STABLE_EFFORTS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

/** "claude" and "api" are both Claude-backed peers and share the same effort set. */
export function getReasoningEffortOptions(
  peer: ChatRuntimePeer,
  selectedModel: RuntimeModel | null,
): readonly string[] {
  if (peer !== "codex") {
    if (!selectedModel) return [];
    return normalizeReasoningEffortOptions(selectedModel.reasoningEfforts);
  }

  if (selectedModel?.runtime !== "codex") return [];
  // Catalog may list max/ultra; expose the API-stable xhigh instead.
  // Hide unsupported wire efforts (e.g. minimal) from the picker.
  const seen = new Set<string>();
  const options: string[] = [];
  for (const effort of selectedModel.reasoningEfforts) {
    const normalized = CODEX_EFFORT_ALIASES[effort] ?? effort;
    if (CODEX_UNSUPPORTED_WIRE_EFFORTS.has(normalized)) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    options.push(normalized);
  }
  return options;
}

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
    const aliased = CODEX_EFFORT_ALIASES[raw] ?? raw;
    if (CODEX_UNSUPPORTED_WIRE_EFFORTS.has(aliased)) return null;
    return aliased;
  };

  const apiStableSupported = supported
    .map((entry) => CODEX_EFFORT_ALIASES[entry] ?? entry)
    .filter(
      (entry) =>
        (CODEX_API_STABLE_EFFORTS as readonly string[]).includes(entry) ||
        entry === "xhigh",
    );

  const candidates = [
    resolve(effort),
    resolve(selectedModel.defaultReasoningEffort),
    ...CODEX_API_STABLE_EFFORTS,
    apiStableSupported[0],
    supported.find((entry) => !CODEX_UNSUPPORTED_WIRE_EFFORTS.has(entry)) ??
      null,
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    // Accept API-stable catalog efforts, or xhigh after max/ultra coercion even
    // if the catalog omitted the stable name.
    if (
      apiStableSupported.includes(candidate) ||
      ((CODEX_API_STABLE_EFFORTS as readonly string[]).includes(candidate) &&
        supported.includes(candidate)) ||
      (candidate === "xhigh" &&
        (supported.includes("max") || supported.includes("ultra")))
    ) {
      return candidate;
    }
  }
  return apiStableSupported[0] ?? null;
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
  if (supportedEfforts.length === 0) return null;
  return resolveReasoningEffort(
    currentEffort,
    supportedEfforts,
    CLAUDE_DEFAULT_REASONING_EFFORT,
  );
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
  selectedClaudeModel: string;
  selectedClaudeEffort: string;
  onPeerChange: (
    peer: ChatRuntimePeer,
    options?: { confirmSessionReset?: boolean },
  ) => ChangeTabRuntimeResult;
  onSelectionChange: (selection: RuntimeSelection) => unknown;
  onClaudeModelChange: (model: string) => void;
  onClaudeEffortChange: (effort: string) => void;
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
  selectedModelId,
  reasoningEffort,
  agentId = null,
  busy,
  selectedClaudeModel,
  selectedClaudeEffort,
  onSelectionChange,
  onClaudeModelChange,
  onClaudeEffortChange,
}: RuntimeSelectorProps) {
  const providerModels = useProviderStore((state) => state.models);
  const providerReady = useProviderStore((state) => state.ready);
  const activeProviderName =
    useProviderStore(
      (state) => state.cards.find((card) => card.isActive)?.name,
    ) ?? "No provider";
  const selectedModel = useMemo(
    () =>
      providerModels.find((model) => model.id === selectedModelId) ??
      providerModels.find((model) => model.isDefault) ??
      providerModels[0] ??
      null,
    [providerModels, selectedModelId],
  );
  const strengthControl = deriveReasoningStrength(
    selectedModel,
    reasoningEffort ?? selectedClaudeEffort,
  );
  const selectedEffort = reasoningStrengthWireValue(strengthControl);
  const fastPair = useMemo(
    () => resolveFastModelPair(selectedModel?.id, providerModels),
    [providerModels, selectedModel?.id],
  );

  const applySelection = (
    modelId: string,
    effort: string | null,
    nextAgentId: string | null,
  ) => {
    onClaudeModelChange(modelId);
    if (effort) {
      onClaudeEffortChange(effort);
    }
    onSelectionChange({
      runtimeModel: modelId,
      reasoningEffort: effort,
      agentId: nextAgentId,
    });
  };

  return (
    <section
      aria-label="Runtime controls"
      data-runtime-ready={providerReady ? "true" : "false"}
      className="flex min-w-64 flex-col"
    >
      <div className="flex items-center justify-between gap-2 border-border border-b px-2 pb-2">
        <p className="text-muted-foreground text-xs">
          {activeProviderName} · switch providers in Settings
        </p>
      </div>

      <div className="flex max-h-80 min-w-0 flex-col overflow-y-auto">
        <div className="flex items-center justify-between px-2 py-1">
          <span className="font-medium text-muted-foreground text-xs">
            Model
          </span>
        </div>
        {providerModels.length === 0 ? (
          <div className="px-3 py-2 text-muted-foreground text-xs">
            Choose a provider in Settings → Providers
          </div>
        ) : (
          providerModels.map((model) => (
            <button
              type="button"
              key={model.id}
              aria-label={`Select model ${model.displayName}`}
              aria-pressed={selectedModel?.id === model.id}
              className={optionButtonClass(selectedModel?.id === model.id)}
              disabled={busy || !providerReady}
              onClick={() =>
                applySelection(
                  model.id,
                  resolveReasoningEffort(
                    selectedEffort,
                    normalizeReasoningEffortOptions(model.reasoningEfforts),
                  ),
                  agentId,
                )
              }
            >
              <span className="min-w-0">
                <span className="block font-medium text-xs">
                  {model.displayName}
                </span>
              </span>
              {selectedModel?.id === model.id && <span aria-hidden>✓</span>}
            </button>
          ))
        )}

        <div className="mt-1 flex flex-col gap-2 border-border border-t px-2 pt-2 pb-2">
          {fastPair ? (
            <button
              type="button"
              data-testid="reasoning-effort-fast-toggle"
              aria-label={
                selectedModel?.id === fastPair.fastId
                  ? "Disable fast model"
                  : "Enable fast model"
              }
              aria-pressed={selectedModel?.id === fastPair.fastId}
              disabled={busy || !providerReady}
              className={cn(
                "flex h-7 items-center gap-1.5 self-start rounded-full px-2 text-xs",
                selectedModel?.id === fastPair.fastId
                  ? "bg-[#C17A5C]/15 text-[#C17A5C]"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
                "disabled:cursor-not-allowed disabled:opacity-40",
              )}
              onClick={() => {
                const enabled = selectedModel?.id === fastPair.fastId;
                const nextId = enabled ? fastPair.baseId : fastPair.fastId;
                const nextModel = providerModels.find(
                  (model) => model.id === nextId,
                );
                applySelection(
                  nextId,
                  resolveReasoningEffort(
                    selectedEffort,
                    normalizeReasoningEffortOptions(
                      nextModel?.reasoningEfforts,
                    ),
                  ),
                  agentId,
                );
              }}
            >
              Fast
            </button>
          ) : null}
          <ReasoningStrengthControl
            control={strengthControl}
            layout="narrow"
            disabled={busy || !providerReady || !selectedModel}
            onChange={(effort) =>
              applySelection(
                selectedModel?.id ?? selectedClaudeModel,
                effort,
                agentId,
              )
            }
          />
        </div>
      </div>
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
