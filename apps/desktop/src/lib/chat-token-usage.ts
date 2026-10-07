export type TokenUsageSnapshot = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** False when this snapshot did not include a cache-read field. */
  cacheReadKnown?: boolean;
  /** False when this snapshot did not include a cache-write field. */
  cacheCreationKnown?: boolean;
  /**
   * Upstream message id for this request. A different id is a different
   * request even when the inclusive token total happens to match.
   */
  requestKey?: string;
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
  /** The ring is showing the previous request while this turn has no usage yet. */
  previousTurn: boolean;
};

type UsageDetail = {
  cached_tokens?: number;
  cachedTokens?: number;
  cache_write_tokens?: number;
  cacheWriteTokens?: number;
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
  cachedTokens?: number;
  cached_input_tokens?: number;
  cachedInputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  cache_write_input_tokens?: number;
  cacheWriteInputTokens?: number;
  cache_write_tokens?: number;
  cacheWriteTokens?: number;
  prompt_cache_hit_tokens?: number;
  promptCacheHitTokens?: number;
  cached_content_token_count?: number;
  cachedContentTokenCount?: number;
  prompt_token_count?: number;
  promptTokenCount?: number;
  input_tokens_details?: UsageDetail;
  prompt_tokens_details?: UsageDetail;
  inputTokensDetails?: UsageDetail;
  promptTokensDetails?: UsageDetail;
};

type UsageMetadata = {
  agent_id?: string | null;
  agentId?: string | null;
  parent_tool_use_id?: string | null;
  parentToolUseId?: string | null;
  user_id?: string | null;
};

type UsageMessage = {
  type?: string;
  parent_tool_use_id?: string | null;
  parentToolUseId?: string | null;
  agent_id?: string | null;
  agentId?: string | null;
  user_id?: string | null;
  metadata?: UsageMetadata | null;
  usage?: UsageFields;
  message?: { id?: string; usage?: UsageFields };
};

type CatalogModel = {
  id: string;
  displayName?: string;
  contextWindow?: number | null;
};

function usageCount(...values: Array<number | undefined | null>): {
  value: number;
  present: boolean;
} {
  let sawZero = false;
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      continue;
    }
    if (value > 0) return { value, present: true };
    sawZero = true;
  }
  return { value: 0, present: sawZero };
}

function usageNumber(...values: Array<number | undefined | null>): number {
  return usageCount(...values).value;
}

function exclusiveInputTokens(input: number, cache: number): number {
  return cache > 0 && cache <= input ? input - cache : input;
}

export function parseUsageFields(
  usage: UsageFields | undefined | null,
): TokenUsageSnapshot {
  const anthropicCache = usageCount(
    usage?.cache_read_input_tokens,
    usage?.cacheReadInputTokens,
  );
  const anthropicWrite = usageCount(
    usage?.cache_creation_input_tokens,
    usage?.cacheCreationInputTokens,
  );
  const cacheRead = usageCount(
    usage?.cache_read_input_tokens,
    usage?.cached_input_tokens,
    usage?.cachedInputTokens,
    usage?.cache_read_tokens,
    usage?.cached_tokens,
    usage?.cachedTokens,
    usage?.prompt_cache_hit_tokens,
    usage?.promptCacheHitTokens,
    usage?.cached_content_token_count,
    usage?.cachedContentTokenCount,
    usage?.input_tokens_details?.cached_tokens,
    usage?.input_tokens_details?.cachedTokens,
    usage?.prompt_tokens_details?.cached_tokens,
    usage?.prompt_tokens_details?.cachedTokens,
    usage?.inputTokensDetails?.cached_tokens,
    usage?.inputTokensDetails?.cachedTokens,
    usage?.promptTokensDetails?.cachedTokens,
  );
  const cacheWrite = usageCount(
    usage?.cache_creation_input_tokens,
    usage?.cache_write_input_tokens,
    usage?.cacheWriteInputTokens,
    usage?.cache_creation_tokens,
    usage?.cache_write_tokens,
    usage?.cacheWriteTokens,
    usage?.input_tokens_details?.cache_write_tokens,
    usage?.input_tokens_details?.cacheWriteTokens,
    usage?.prompt_tokens_details?.cache_write_tokens,
    usage?.inputTokensDetails?.cacheWriteTokens,
    usage?.promptTokensDetails?.cacheWriteTokens,
  );
  const rawInput = usageNumber(
    usage?.input_tokens,
    usage?.prompt_tokens,
    usage?.inputTokens,
    usage?.prompt_token_count,
    usage?.promptTokenCount,
  );
  // Anthropic input already excludes cache. Other providers include it.
  const anthropicShape = anthropicCache.value > 0 || anthropicWrite.value > 0;
  let inputTokens = rawInput;
  if (!anthropicShape) {
    inputTokens = exclusiveInputTokens(inputTokens, cacheRead.value);
    inputTokens = exclusiveInputTokens(inputTokens, cacheWrite.value);
  }
  return {
    inputTokens,
    outputTokens: usageNumber(
      usage?.output_tokens,
      usage?.completion_tokens,
      usage?.outputTokens,
    ),
    cacheReadTokens: cacheRead.value,
    cacheCreationTokens: cacheWrite.value,
    ...(cacheRead.present ? {} : { cacheReadKnown: false }),
    ...(cacheWrite.present ? {} : { cacheCreationKnown: false }),
  };
}

export function conversationUsage(
  messages?: ReadonlyArray<UsageMessage> | null,
  lastUsage?: TokenUsageSnapshot | null,
  options?: { inFlight?: boolean; ignoreTranscript?: boolean },
): TokenUsageSnapshot | null {
  const fromStore =
    lastUsage && snapshotHasTokens(lastUsage) ? lastUsage : null;
  // A model switch clears the store, but the transcript still holds the
  // previous model's request. Until a new prompt usage arrives, ignore it.
  if (options?.ignoreTranscript) return fromStore;
  if (messages && messages.length === 0) return null;
  const scoped = options?.inFlight ? messagesAfterLastUser(messages) : messages;
  const fromMessages = lastTurnUsage(scoped);
  if (!fromMessages) {
    if (fromStore) return fromStore;
    // The new turn has not reported usage. Keep the last request already in
    // the transcript so the ring does not fall to zero.
    if (!options?.inFlight) return null;
    const carried = lastTurnUsage(messages);
    return carried && snapshotHasTokens(carried) ? carried : null;
  }
  if (!fromStore) return fromMessages;
  // While the turn is in flight the store is the live request. A new
  // message_start replaces the previous assistant, which sits outside `scoped`.
  if (options?.inFlight) {
    return mergeTokenUsageSnapshots(fromMessages, fromStore);
  }
  if (!snapshotHasPromptTokens(fromStore)) {
    return mergeTokenUsageSnapshots(fromMessages, fromStore);
  }
  if (!snapshotHasPromptTokens(fromMessages)) {
    return mergeTokenUsageSnapshots(fromStore, fromMessages);
  }
  return mergeTokenUsageSnapshots(fromStore, fromMessages);
}

function messagesAfterLastUser(
  messages: ReadonlyArray<UsageMessage> | null | undefined,
): ReadonlyArray<UsageMessage> | null | undefined {
  if (!messages?.length) return messages;
  let boundary = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.type === "user") {
      boundary = index;
      break;
    }
  }
  if (boundary < 0) return messages;
  return messages.slice(boundary + 1);
}

export function usageFromStreamMessage(
  message: UsageMessage | undefined | null,
): TokenUsageSnapshot {
  return parseUsageFields(message?.usage || message?.message?.usage);
}

type AnthropicStreamEvent = {
  type?: string;
  usage?: UsageFields;
  message?: { id?: string; usage?: UsageFields };
  delta?: { type?: string };
  content_block?: { type?: string };
};

export function usageFromAnthropicStreamEvent(
  event: unknown,
): TokenUsageSnapshot | null {
  if (!event || typeof event !== "object") return null;
  const record = event as AnthropicStreamEvent;
  const usage =
    record.type === "message_start"
      ? record.message?.usage
      : record.type === "message_delta"
        ? record.usage
        : undefined;
  if (!usage) return null;
  const snapshot = parseUsageFields(usage);
  if (!snapshotHasTokens(snapshot)) return null;
  const requestKey =
    record.type === "message_start" ? textMarker(record.message?.id) : null;
  return requestKey ? { ...snapshot, requestKey } : snapshot;
}

/** Thinking and token deltas count as a reply even before visible text lands. */
export function streamEventCountsAsReplyProgress(event: unknown): boolean {
  if (!event || typeof event !== "object") return false;
  const record = event as AnthropicStreamEvent;
  if (record.type === "content_block_delta") {
    const delta = record.delta?.type;
    return (
      delta === "thinking_delta" ||
      delta === "text_delta" ||
      delta === "input_json_delta" ||
      delta === "signature_delta"
    );
  }
  if (record.type === "content_block_start") {
    const kind = record.content_block?.type;
    return kind === "thinking" || kind === "text" || kind === "tool_use";
  }
  return false;
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

function inclusiveTokens(snapshot: TokenUsageSnapshot): number {
  return (
    snapshot.inputTokens +
    snapshot.cacheReadTokens +
    snapshot.cacheCreationTokens
  );
}

function cacheDetail(snapshot: TokenUsageSnapshot): number {
  return snapshot.cacheReadTokens + snapshot.cacheCreationTokens;
}

function publishedUsage(snapshot: TokenUsageSnapshot): TokenUsageSnapshot {
  const published: TokenUsageSnapshot = {
    inputTokens: snapshot.inputTokens,
    outputTokens: snapshot.outputTokens,
    cacheReadTokens: snapshot.cacheReadTokens,
    cacheCreationTokens: snapshot.cacheCreationTokens,
  };
  if (snapshot.cacheReadKnown === false) published.cacheReadKnown = false;
  if (snapshot.cacheCreationKnown === false) {
    published.cacheCreationKnown = false;
  }
  if (snapshot.requestKey) published.requestKey = snapshot.requestKey;
  return published;
}

function mergedCacheField(
  currentValue: number,
  incomingValue: number,
  currentKnown: boolean | undefined,
  incomingKnown: boolean | undefined,
  current: TokenUsageSnapshot,
  incoming: TokenUsageSnapshot,
): { value: number; known: boolean | undefined } {
  if (!snapshotHasPromptTokens(incoming)) {
    return { value: currentValue, known: currentKnown };
  }
  // Absent on this snapshot. Keep the value only when this is still the same
  // request (same exclusive input, or an output-only update above). A later
  // turn that omits the field must not inherit the previous turn's cache.
  if (incomingKnown === false) {
    if (incoming.inputTokens === current.inputTokens) {
      return { value: currentValue, known: currentKnown };
    }
    return { value: 0, known: false };
  }
  return { value: incomingValue, known: undefined };
}

function keptOutput(
  current: TokenUsageSnapshot,
  incoming: TokenUsageSnapshot,
): number {
  return incoming.outputTokens > 0
    ? incoming.outputTokens
    : Math.max(incoming.outputTokens, current.outputTokens);
}

function requestKeysDisagree(
  current: TokenUsageSnapshot,
  incoming: TokenUsageSnapshot,
): boolean {
  return Boolean(
    current.requestKey &&
      incoming.requestKey &&
      current.requestKey !== incoming.requestKey,
  );
}

/** One side reports the whole prompt as input and the other still names cache. */
function isCacheFold(
  named: TokenUsageSnapshot,
  folded: TokenUsageSnapshot,
): boolean {
  return (
    cacheDetail(folded) === 0 &&
    cacheDetail(named) > 0 &&
    folded.inputTokens > 0 &&
    inclusiveTokens(named) === folded.inputTokens
  );
}

function foldedSnapshot(
  current: TokenUsageSnapshot,
  incoming: TokenUsageSnapshot,
): TokenUsageSnapshot {
  const named =
    cacheDetail(incoming) > cacheDetail(current) ? incoming : current;
  return publishedUsage({
    inputTokens: named.inputTokens,
    outputTokens: Math.max(incoming.outputTokens, current.outputTokens),
    cacheReadTokens: named.cacheReadTokens,
    cacheCreationTokens: named.cacheCreationTokens,
    ...(named.cacheReadKnown === false ? { cacheReadKnown: false } : {}),
    ...(named.cacheCreationKnown === false
      ? { cacheCreationKnown: false }
      : {}),
    requestKey: incoming.requestKey ?? current.requestKey,
  });
}

export function mergeTokenUsageSnapshots(
  current: TokenUsageSnapshot | null | undefined,
  incoming: TokenUsageSnapshot,
): TokenUsageSnapshot {
  if (!current || !snapshotHasTokens(current)) return publishedUsage(incoming);
  if (!snapshotHasTokens(incoming)) return publishedUsage(current);
  if (!snapshotHasPromptTokens(incoming)) {
    if (requestKeysDisagree(current, incoming)) return publishedUsage(current);
    return publishedUsage({
      inputTokens: current.inputTokens,
      outputTokens: keptOutput(current, incoming),
      cacheReadTokens: current.cacheReadTokens,
      cacheCreationTokens: current.cacheCreationTokens,
      ...(current.cacheReadKnown === false ? { cacheReadKnown: false } : {}),
      ...(current.cacheCreationKnown === false
        ? { cacheCreationKnown: false }
        : {}),
      requestKey: incoming.requestKey ?? current.requestKey,
    });
  }
  if (requestKeysDisagree(current, incoming)) return publishedUsage(incoming);
  const sameRequest =
    Boolean(current.requestKey && incoming.requestKey) ||
    incoming.inputTokens === current.inputTokens;
  if (
    !sameRequest &&
    (isCacheFold(current, incoming) || isCacheFold(incoming, current))
  ) {
    return foldedSnapshot(current, incoming);
  }
  if (!sameRequest) return publishedUsage(incoming);
  const cacheRead = mergedCacheField(
    current.cacheReadTokens,
    incoming.cacheReadTokens,
    current.cacheReadKnown,
    incoming.cacheReadKnown,
    current,
    incoming,
  );
  const cacheWrite = mergedCacheField(
    current.cacheCreationTokens,
    incoming.cacheCreationTokens,
    current.cacheCreationKnown,
    incoming.cacheCreationKnown,
    current,
    incoming,
  );
  // Exclusive input 0 is real when the prompt tokens were all cached.
  // `||` would treat that 0 as missing and keep the previous turn.
  return publishedUsage({
    inputTokens: incoming.inputTokens,
    outputTokens: keptOutput(current, incoming),
    cacheReadTokens: cacheRead.value,
    cacheCreationTokens: cacheWrite.value,
    ...(cacheRead.known === false ? { cacheReadKnown: false } : {}),
    ...(cacheWrite.known === false ? { cacheCreationKnown: false } : {}),
    requestKey: incoming.requestKey ?? current.requestKey,
  });
}

function textMarker(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > 0 ? text : null;
}

function markerInRecord(
  record: object | null | undefined,
  keys: readonly string[],
): string | null {
  if (!record) return null;
  const fields = record as Record<string, unknown>;
  for (const key of keys) {
    const marker = textMarker(fields[key]);
    if (marker) return marker;
  }
  return null;
}

function markerInUserId(value: unknown): string | null {
  const text = textMarker(value);
  if (!text?.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(text) as object;
    return (
      markerInRecord(parsed, ["agent_id", "agentId"]) ??
      markerInRecord(parsed, ["parent_tool_use_id", "parentToolUseId"])
    );
  } catch {
    return null;
  }
}

/** Matches the proxy: agent id, parent tool id, or those fields inside user_id JSON. */
export function isSubagentUsageMessage(
  message: object | null | undefined,
): boolean {
  if (!message) return false;
  const record = message as UsageMessage;
  return (
    markerInRecord(record, ["parent_tool_use_id", "parentToolUseId"]) !==
      null ||
    markerInRecord(record, ["agent_id", "agentId"]) !== null ||
    markerInRecord(record.metadata, [
      "agent_id",
      "agentId",
      "parent_tool_use_id",
      "parentToolUseId",
    ]) !== null ||
    markerInUserId(record.user_id) !== null ||
    markerInUserId(record.metadata?.user_id) !== null
  );
}

function isSubagentUsage(message: UsageMessage): boolean {
  return isSubagentUsageMessage(message);
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
  if (requestUsage && snapshotHasPromptTokens(requestUsage)) {
    return publishedUsage(requestUsage);
  }
  const fallback =
    collectLastTurnUsage(messages, "results") ??
    collectLastTurnUsage(messages, "any");
  return fallback ? publishedUsage(fallback) : null;
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

/**
 * Moonshot / Kimi's 256k window. Same value as `MOONSHOT_CONTEXT_WINDOW` in
 * `apps/desktop/src-tauri/src/context_window.rs`, which is what Claude Code
 * compacts against when the catalog has no window.
 */
export const MOONSHOT_CONTEXT_WINDOW = 262_144;

/**
 * Window the context ring draws when the catalog has no positive value.
 * Family sizes match `known_context_window` in `context_window.rs`.
 */
export function estimateContextWindow(
  model: string | null | undefined,
  catalogWindow?: number | null,
): number {
  if (catalogWindow && catalogWindow > 0) return catalogWindow;
  const id = (model ?? "").toLowerCase();
  if (!id) return 200_000;
  if (/gpt-4\.1/.test(id)) return 1_047_576;
  if (/gpt-/.test(id)) return 272_000;
  if (/kimi|moonshot/.test(id)) return MOONSHOT_CONTEXT_WINDOW;
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
  inFlight?: boolean;
  previousTurn?: boolean;
  ignoreTranscript?: boolean;
}): TokenMeterModel {
  const last = conversationUsage(options.messages, options.lastUsage, {
    inFlight: options.inFlight,
    ignoreTranscript: options.ignoreTranscript,
  });
  const inputTokens = last ? last.inputTokens : 0;
  const outputTokens = last ? last.outputTokens : 0;
  const cacheReadTokens = last?.cacheReadTokens ?? 0;
  const cacheCreationTokens = last?.cacheCreationTokens ?? 0;
  // Occupancy is the latest request: uncached input + cache read + cache
  // write + that request's output. Cache is already split out of inclusive
  // provider input, so adding it back does not double-count. Do not add
  // earlier requests or a thread-lifetime total.
  const usedTokens = last
    ? last.inputTokens +
      last.cacheReadTokens +
      last.cacheCreationTokens +
      last.outputTokens
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
    previousTurn: Boolean(options.previousTurn && options.inFlight && last),
  };
}
