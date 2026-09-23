export type TokenUsageSnapshot = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
};

export type TokenMeterModel = {
  modelLabel: string;
  windowTokens: number;
  usedTokens: number;
  remainingTokens: number;
  percent: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  estimated: boolean;
};

type UsageFields = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  cached_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  prompt_tokens_details?: { cached_tokens?: number };
};

type UsageMessage = {
  type?: string;
  parent_tool_use_id?: string | null;
  parentToolUseId?: string | null;
  usage?: UsageFields;
  message?: { usage?: UsageFields };
};

type CatalogModel = {
  id: string;
  displayName?: string;
  contextWindow?: number | null;
};

function usageNumber(...values: Array<number | undefined | null>): number {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value;
    }
  }
  return 0;
}

function exclusiveInputTokens(input: number, cache: number): number {
  return cache > 0 && cache <= input ? input - cache : input;
}

export function parseUsageFields(
  usage: UsageFields | undefined | null,
): TokenUsageSnapshot {
  const anthropicCache = usageNumber(usage?.cache_read_input_tokens);
  const cacheReadTokens = usageNumber(
    usage?.cache_read_input_tokens,
    usage?.cache_read_tokens,
    usage?.cached_tokens,
    usage?.input_tokens_details?.cached_tokens,
    usage?.prompt_tokens_details?.cached_tokens,
  );
  const rawInput = usageNumber(
    usage?.input_tokens,
    usage?.prompt_tokens,
    usage?.inputTokens,
  );
  return {
    inputTokens:
      anthropicCache > 0
        ? rawInput
        : exclusiveInputTokens(rawInput, cacheReadTokens),
    outputTokens: usageNumber(
      usage?.output_tokens,
      usage?.completion_tokens,
      usage?.outputTokens,
    ),
    cacheReadTokens,
    cacheCreationTokens: usageNumber(
      usage?.cache_creation_input_tokens,
      usage?.cache_creation_tokens,
    ),
  };
}

export function conversationUsage(
  messages?: ReadonlyArray<UsageMessage> | null,
  lastUsage?: TokenUsageSnapshot | null,
): TokenUsageSnapshot | null {
  if (messages && messages.length === 0) return null;
  const fromMessages = lastTurnUsage(messages);
  const fromStore =
    lastUsage && snapshotHasTokens(lastUsage) ? lastUsage : null;
  if (!fromMessages) return fromStore;
  if (!fromStore) return fromMessages;
  if (!snapshotHasPromptTokens(fromStore)) {
    return mergeTokenUsageSnapshots(fromMessages, fromStore);
  }
  if (!snapshotHasPromptTokens(fromMessages)) {
    return mergeTokenUsageSnapshots(fromStore, fromMessages);
  }
  return mergeTokenUsageSnapshots(fromStore, fromMessages);
}

export function usageFromStreamMessage(
  message: UsageMessage | undefined | null,
): TokenUsageSnapshot {
  return parseUsageFields(message?.usage || message?.message?.usage);
}

export function snapshotHasTokens(snapshot: TokenUsageSnapshot): boolean {
  return (
    snapshot.inputTokens > 0 ||
    snapshot.outputTokens > 0 ||
    snapshot.cacheReadTokens > 0 ||
    snapshot.cacheCreationTokens > 0
  );
}

export function snapshotHasPromptTokens(snapshot: TokenUsageSnapshot): boolean {
  return (
    snapshot.inputTokens > 0 ||
    snapshot.cacheReadTokens > 0 ||
    snapshot.cacheCreationTokens > 0
  );
}

export function mergeTokenUsageSnapshots(
  current: TokenUsageSnapshot | null | undefined,
  incoming: TokenUsageSnapshot,
): TokenUsageSnapshot {
  if (!current || !snapshotHasTokens(current)) return incoming;
  if (!snapshotHasTokens(incoming)) return current;
  return {
    inputTokens: incoming.inputTokens || current.inputTokens,
    outputTokens:
      snapshotHasPromptTokens(incoming) && incoming.outputTokens > 0
        ? incoming.outputTokens
        : Math.max(incoming.outputTokens, current.outputTokens),
    cacheReadTokens: snapshotHasPromptTokens(incoming)
      ? incoming.cacheReadTokens
      : current.cacheReadTokens,
    cacheCreationTokens: snapshotHasPromptTokens(incoming)
      ? incoming.cacheCreationTokens
      : current.cacheCreationTokens,
  };
}

function isSubagentUsage(message: UsageMessage): boolean {
  const parent = message.parent_tool_use_id ?? message.parentToolUseId;
  return typeof parent === "string" && parent.trim().length > 0;
}

function collectLastTurnUsage(
  messages: ReadonlyArray<UsageMessage>,
  mode: "requests" | "results" | "any",
): TokenUsageSnapshot | null {
  let merged: TokenUsageSnapshot | null = null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isSubagentUsage(message)) continue;
    if (mode === "results" && message.type !== "result") continue;
    if (mode === "requests" && message.type === "result") continue;
    const snapshot = usageFromStreamMessage(message);
    if (!snapshotHasTokens(snapshot)) continue;
    merged = merged ? mergeTokenUsageSnapshots(snapshot, merged) : snapshot;
    if (snapshotHasPromptTokens(merged)) return merged;
  }
  return merged;
}

export function lastTurnUsage(
  messages: ReadonlyArray<UsageMessage> | undefined | null,
): TokenUsageSnapshot | null {
  if (!messages?.length) return null;
  // `result.usage` is cumulative across tool steps and, on a resumed Claude
  // session, earlier spend. Context occupancy is the latest root request.
  const requestUsage = collectLastTurnUsage(messages, "requests");
  if (requestUsage && snapshotHasPromptTokens(requestUsage))
    return requestUsage;
  return (
    collectLastTurnUsage(messages, "results") ??
    collectLastTurnUsage(messages, "any")
  );
}

function normalizeModelKey(value: string): string {
  return value.toLowerCase().replace(/[\s._/-]+/g, "");
}

export function catalogContextWindow(
  models: ReadonlyArray<CatalogModel> | null | undefined,
  modelLabel: string | null | undefined,
): number | null {
  const needle = normalizeModelKey(modelLabel ?? "");
  if (!needle || !models?.length) return null;
  const exact = models.find((model) => {
    const id = normalizeModelKey(model.id);
    const name = normalizeModelKey(model.displayName ?? "");
    return id === needle || (name.length > 0 && name === needle);
  });
  const match =
    exact ??
    models.find((model) => {
      const id = normalizeModelKey(model.id);
      const name = normalizeModelKey(model.displayName ?? "");
      if (needle.length < 4) return false;
      return (
        id.includes(needle) ||
        needle.includes(id) ||
        (name.length >= 4 && (name.includes(needle) || needle.includes(name)))
      );
    });
  const window = match?.contextWindow;
  return window && window > 0 ? window : null;
}

export function estimateContextWindow(
  model: string | null | undefined,
  catalogWindow?: number | null,
): number {
  if (catalogWindow && catalogWindow > 0) return catalogWindow;
  const id = (model ?? "").toLowerCase();
  if (!id) return 200_000;
  if (/gpt-4\.1/.test(id)) return 1_047_576;
  if (/gpt-/.test(id)) return 272_000;
  if (/1m/.test(id) && /claude|opus|sonnet/.test(id)) return 1_000_000;
  if (/opus|sonnet|haiku|claude/.test(id)) return 200_000;
  return 200_000;
}

export function formatTokenCount(value: number): string {
  return Math.max(0, Math.round(value)).toLocaleString("en-US");
}

export function buildTokenMeterModel(options: {
  modelLabel: string | null | undefined;
  messages?: ReadonlyArray<UsageMessage> | null;
  lastUsage?: TokenUsageSnapshot | null;
  windowTokens?: number | null;
}): TokenMeterModel {
  const last = conversationUsage(options.messages, options.lastUsage);
  const inputTokens = last ? last.inputTokens : 0;
  const outputTokens = last ? last.outputTokens : 0;
  const cacheReadTokens = last?.cacheReadTokens ?? 0;
  const cacheCreationTokens = last?.cacheCreationTokens ?? 0;
  // Prompt occupancy for the latest request. Anthropic input excludes cache.
  // OpenAI-shaped snapshots are split before they reach this sum. Do not add
  // session-cumulative result totals on top of this request.
  const usedTokens = last
    ? last.inputTokens + last.cacheReadTokens + last.cacheCreationTokens
    : 0;
  const windowTokens = estimateContextWindow(
    options.modelLabel,
    options.windowTokens,
  );
  const remainingTokens = Math.max(0, windowTokens - usedTokens);
  const percent =
    windowTokens <= 0 || !last
      ? 0
      : Math.min(100, Math.round((usedTokens / windowTokens) * 100));

  return {
    modelLabel: options.modelLabel?.trim() || "Model",
    windowTokens,
    usedTokens,
    remainingTokens,
    percent,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    estimated: !last,
  };
}
