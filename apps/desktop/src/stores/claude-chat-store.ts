import { create } from "zustand";
import { useDocumentStore } from "./document-store";
import { useHistoryStore } from "./history-store";
import { useClaudeSetupStore } from "./claude-setup-store";
import { createLogger } from "@/lib/debug/logger";
import { cleanupTemporaryChatFiles } from "@/lib/chat-temporary-files";
import {
  interruptRuntimeTurn,
  runtimeReadConversation,
  startRuntimeTurn,
} from "@/runtime/commands";
import { coerceCodexReasoningEffort } from "@/components/runtime/runtime-selector";
import type {
  ChangeTabRuntimeResult,
  ChatRuntimePeer,
  ConversationRef,
  RuntimeKind,
  RuntimeStopMode,
} from "@/runtime/types";
import { peerFromTab, wireRuntimeFromPeer } from "@/runtime/types";
import { useRuntimeStore } from "./runtime-store";
import {
  projectPersistedChat,
  readPersistedChatForProject,
  writePersistedChatForProject,
} from "./chat-persistence";

const log = createLogger("claude");
export const CLAUDE_CODE_PROVIDER_ID = "__claude-code__";
export const SELECTED_PROVIDER_CREDENTIAL_STORAGE_KEY =
  "claude-prism:selected-provider-credential-id";

function providerSelectionStorage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

export function loadSelectedProviderCredentialId(): string | null {
  const value = providerSelectionStorage()?.getItem(
    SELECTED_PROVIDER_CREDENTIAL_STORAGE_KEY,
  );
  const trimmed = value?.trim();
  return trimmed || null;
}

function persistSelectedProviderCredentialId(credentialId: string | null) {
  const storage = providerSelectionStorage();
  if (!storage) return;
  if (credentialId?.trim()) {
    storage.setItem(
      SELECTED_PROVIDER_CREDENTIAL_STORAGE_KEY,
      credentialId.trim(),
    );
  } else {
    storage.removeItem(SELECTED_PROVIDER_CREDENTIAL_STORAGE_KEY);
  }
}

/** Convert a character offset to 1-based line:col */
export function offsetToLineCol(
  content: string,
  offset: number,
): { line: number; col: number } {
  const before = content.slice(0, offset);
  const lines = before.split("\n");
  return { line: lines.length, col: lines[lines.length - 1].length + 1 };
}

// ─── Types ───

export interface ContentBlock {
  type: "text" | "tool_use" | "tool_result" | "thinking";
  // text block
  text?: string;
  // tool_use block
  id?: string;
  name?: string;
  input?: any;
  // tool_result block
  tool_use_id?: string;
  content?: any;
  is_error?: boolean;
  // thinking block
  thinking?: string;
  signature?: string;
}

export interface ClaudeStreamMessage {
  type: "system" | "assistant" | "user" | "result";
  subtype?: string;
  session_id?: string;
  model?: string;
  cwd?: string;
  tools?: string[];
  message?: {
    content?: ContentBlock[];
    usage?: { input_tokens: number; output_tokens: number };
  };
  usage?: { input_tokens: number; output_tokens: number };
  cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  result?: string;
  is_error?: boolean;
  num_turns?: number;
}

// ─── Tab Types ───

export interface TabDraft {
  input: string;
  pinnedContexts: {
    label: string;
    filePath: string;
    selectedText: string;
    imageDataUrl?: string;
    isTemporary?: boolean;
  }[];
}

export interface PromptContextOverride {
  label: string;
  filePath: string;
  selectedText: string;
  temporaryFilePaths?: string[];
}

export interface QueuedGuidance {
  id: string;
  prompt: string;
  contextOverride?: PromptContextOverride;
  createdAt: number;
  displayedInChat?: boolean;
}

export interface AttemptCancellation {
  attemptId: string;
  attemptEpoch: number;
  runtime: RuntimeKind;
  mode: RuntimeStopMode;
  temporaryFilePaths?: string[];
}

export type RuntimeStopOutcome = "stopped" | "not-found" | "uncertain";
export type ProjectChatResetResult = "reset" | "unchanged" | "blocked-stopping";

const rendererAttemptNonce = `${Date.now().toString(36)}-${Math.random()
  .toString(36)
  .slice(2)}`;
let runtimeAttemptSequence = 0;
let resumeRequestSequence = 0;

function nextRuntimeAttemptId(tabId: string): string {
  runtimeAttemptSequence += 1;
  return `${rendererAttemptNonce}:${tabId}:${runtimeAttemptSequence}`;
}

function nextResumeRequestId(tabId: string): string {
  resumeRequestSequence += 1;
  return `${rendererAttemptNonce}:resume:${tabId}:${resumeRequestSequence}`;
}

const pendingRuntimeStarts = new Map<string, Promise<void>>();

export interface TabState {
  id: string;
  title: string;
  projectPath: string | null;
  runtime: RuntimeKind;
  /**
   * UI-level peer selection ("claude" | "api" | "codex"). Optional so that
   * legacy/persisted tabs and test doubles built before this field existed
   * keep working — read access should always go through `chatPeerForTab`.
   */
  chatPeer?: ChatRuntimePeer;
  sessionRef: ConversationRef | null;
  sessionId: string | null;
  runtimeModel: string | null;
  reasoningEffort: string | null;
  agentId: string | null;
  /** Provider currently selected in the tab UI. */
  providerKey: string | null;
  /** Provider that last executed this session, used for safe resume/switching. */
  sessionProviderKey: string | null;
  messages: ClaudeStreamMessage[];
  isStreaming: boolean;
  streamingStartedAt: number | null;
  /** Ephemeral Codex reconnect / progress text shown while streaming. */
  streamingStatus?: string | null;
  error: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  draft: TabDraft;
  queuedGuidance?: QueuedGuidance[];
  forceQueuedGuidanceOnComplete?: boolean;
  forcedQueuedGuidanceId?: string | null;
  pendingTemporaryFilePaths?: string[];
  /** Monotonic token used to invalidate deferred work for this tab. */
  attemptEpoch?: number;
  /** Opaque, renderer-lifetime-unique identity used on the runtime wire. */
  activeAttemptId?: string | null;
  /** Attempt that is still saving/snapshotting before its runtime starts. */
  preflightAttemptEpoch?: number | null;
  /** Latest history request allowed to populate this tab. Never persisted. */
  resumeRequestId?: string | null;
  /** Stop intents awaiting their corresponding legacy completion event. */
  cancelledAttempts?: AttemptCancellation[];
}

export type TabRuntimeSelection = Pick<
  TabState,
  "runtimeModel" | "reasoningEffort" | "agentId"
>;

export type UpdateTabRuntimeSelectionResult =
  | "changed"
  | "unchanged"
  | "not-found"
  | "blocked-streaming"
  | "blocked-stopping";

/** Fields that are projected from the active tab to top-level state */
const TAB_FIELDS = [
  "sessionId",
  "messages",
  "isStreaming",
  "streamingStartedAt",
  "streamingStatus",
  "error",
  "totalInputTokens",
  "totalOutputTokens",
] as const;

/**
 * Reads the effective peer for a tab, deriving it when unset. The wire
 * `runtime` always wins for Codex (a tab can never present as Codex while
 * running the Claude wire runtime, or vice versa) — this guards against
 * code paths that update `runtime` without also updating `chatPeer`.
 */
export function chatPeerForTab(
  tab: Pick<TabState, "runtime" | "providerKey" | "chatPeer">,
): ChatRuntimePeer {
  if (tab.runtime === "codex") return "codex";
  if (tab.chatPeer === "claude" || tab.chatPeer === "api") return tab.chatPeer;
  return peerFromTab(tab);
}

function makeDefaultTab(
  id: string,
  projectPath: string | null = null,
): TabState {
  const selectedCredentialId =
    loadSelectedProviderCredentialId() ?? CLAUDE_CODE_PROVIDER_ID;
  const providerKey = providerKeyForSelectedCredential(selectedCredentialId);
  return {
    id,
    title: "New Chat",
    projectPath,
    runtime: "claude",
    chatPeer: peerFromTab({ runtime: "claude", providerKey }),
    sessionRef: null,
    sessionId: null,
    runtimeModel: null,
    reasoningEffort: null,
    agentId: null,
    providerKey,
    sessionProviderKey: null,
    messages: [],
    isStreaming: false,
    streamingStartedAt: null,
    streamingStatus: null,
    error: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    draft: { input: "", pinnedContexts: [] },
    queuedGuidance: [],
    forceQueuedGuidanceOnComplete: false,
    forcedQueuedGuidanceId: null,
    pendingTemporaryFilePaths: [],
    attemptEpoch: 0,
    activeAttemptId: null,
    preflightAttemptEpoch: null,
    resumeRequestId: null,
    cancelledAttempts: [],
  };
}

function providerSessionKey(providerCredentialId: string | null): string {
  return providerCredentialId
    ? `openai-compatible:${providerCredentialId}`
    : CLAUDE_CODE_PROVIDER_ID;
}

function providerKeyForSelectedCredential(credentialId: string | null): string {
  return credentialId && credentialId !== CLAUDE_CODE_PROVIDER_ID
    ? providerSessionKey(credentialId)
    : CLAUDE_CODE_PROVIDER_ID;
}

function providerCredentialIdFromSessionKey(
  providerKey: string | null,
): string | null | undefined {
  if (!providerKey) return undefined;
  if (providerKey === CLAUDE_CODE_PROVIDER_ID) return CLAUDE_CODE_PROVIDER_ID;
  const prefix = "openai-compatible:";
  return providerKey.startsWith(prefix)
    ? providerKey.slice(prefix.length)
    : undefined;
}

function selectedCredentialForProviderKey(providerKey: string | null) {
  const credentialId = providerCredentialIdFromSessionKey(providerKey);
  return credentialId === undefined ? null : credentialId;
}

function sameAttemptCancellation(
  left: AttemptCancellation,
  right: AttemptCancellation,
) {
  return (
    left.attemptId === right.attemptId &&
    left.runtime === right.runtime &&
    left.mode === right.mode
  );
}

function sameAttemptIdentity(
  left: AttemptCancellation,
  right: AttemptCancellation,
) {
  return left.attemptId === right.attemptId && left.runtime === right.runtime;
}

function addAttemptCancellation(
  tab: TabState | undefined,
  cancellation: AttemptCancellation,
) {
  return [
    ...(tab?.cancelledAttempts ?? []).filter(
      (candidate) => !sameAttemptIdentity(candidate, cancellation),
    ),
    cancellation,
  ];
}

function removeAttemptCancellation(
  tab: TabState | undefined,
  cancellation: AttemptCancellation,
) {
  return (tab?.cancelledAttempts ?? []).filter(
    (candidate) => !sameAttemptCancellation(candidate, cancellation),
  );
}

function inferProviderKeyFromHistory(history: any[]): string | null {
  const init = history.find(
    (entry) => entry?.type === "system" && entry?.subtype === "init",
  );
  if (!init) return null;

  if (
    init.provider === "openai-compatible" &&
    typeof init.provider_credential_id === "string" &&
    init.provider_credential_id.trim()
  ) {
    return providerSessionKey(init.provider_credential_id.trim());
  }

  const model = typeof init.model === "string" ? init.model : "";
  if (model.toLowerCase().startsWith("claude")) {
    return CLAUDE_CODE_PROVIDER_ID;
  }

  const matchingCredential = useClaudeSetupStore
    .getState()
    .openAiCredentials.find((credential) => credential.model === model);
  return matchingCredential ? providerSessionKey(matchingCredential.id) : null;
}

function usageFromMessage(msg: ClaudeStreamMessage): {
  input_tokens: number;
  output_tokens: number;
} {
  const usage = msg.usage || msg.message?.usage;
  return {
    input_tokens: usage?.input_tokens || 0,
    output_tokens: usage?.output_tokens || 0,
  };
}

function usageTotalsForMessages(messages: ClaudeStreamMessage[]): {
  inputTokens: number;
  outputTokens: number;
} {
  return messages.reduce(
    (totals, msg) => {
      const usage = usageFromMessage(msg);
      totals.inputTokens += usage.input_tokens;
      totals.outputTokens += usage.output_tokens;
      return totals;
    },
    { inputTokens: 0, outputTokens: 0 },
  );
}

function stringifyBlockContent(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function messageContentText(message: ClaudeStreamMessage): string {
  const rawContent = (message.message as any)?.content;
  if (typeof rawContent === "string") return rawContent.trim();

  const blocks = rawContent ?? [];
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text" && block.text?.trim()) {
      parts.push(block.text.trim());
    } else if (block.type === "tool_use") {
      const input = block.input ? stringifyBlockContent(block.input) : "";
      parts.push(
        `[tool_use: ${block.name ?? "unknown"}${input ? ` ${input}` : ""}]`,
      );
    } else if (block.type === "tool_result") {
      const content = stringifyBlockContent(block.content ?? "");
      parts.push(`[tool_result${block.is_error ? " error" : ""}: ${content}]`);
    }
  }
  return parts.join("\n").trim();
}

function displayTextForStoredUserPrompt(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!/^\[(?:Currently open file|File): [^\]\n]*\]/.test(normalized)) {
    return text;
  }

  const contextEnd = normalized.lastIndexOf("]\n\n");
  if (contextEnd < 0) return text;

  const contextText = normalized.slice(0, contextEnd + 1);
  const body = normalized.slice(contextEnd + 3);
  const selectionMatch = contextText.match(/(?:^|\n)\[Selection: ([^\]\n]+)\]/);
  const contextLabel = selectionMatch?.[1]?.trim();

  if (!contextLabel) return body;
  return body.trim() ? `${contextLabel}\n${body}` : contextLabel;
}

function sanitizeStoredUserMessageForDisplay(
  message: ClaudeStreamMessage,
): ClaudeStreamMessage {
  if (message.type !== "user") return message;

  const rawContent = (message.message as any)?.content;
  if (typeof rawContent === "string") {
    const displayText = displayTextForStoredUserPrompt(rawContent);
    return displayText === rawContent
      ? message
      : {
          ...message,
          message: { ...message.message, content: displayText as any },
        };
  }

  if (!Array.isArray(rawContent)) return message;

  let changed = false;
  const content = rawContent.map((block) => {
    if (block.type !== "text" || typeof block.text !== "string") {
      return block;
    }

    const displayText = displayTextForStoredUserPrompt(block.text);
    if (displayText === block.text) return block;

    changed = true;
    return { ...block, text: displayText };
  });

  return changed
    ? { ...message, message: { ...message.message, content } }
    : message;
}

function sameConversationReference(
  left: ConversationRef | null | undefined,
  right: ConversationRef | null | undefined,
): boolean {
  if (!left || !right) return false;
  return (
    left.runtime === right.runtime &&
    left.sessionId === right.sessionId &&
    left.projectPath === right.projectPath
  );
}

function codexTextFragments(value: unknown): string[] {
  if (typeof value === "string") {
    const text = value.trim();
    return text ? [text] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap(codexTextFragments);
  }
  if (!value || typeof value !== "object") return [];

  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") {
    return codexTextFragments(record.text);
  }
  return [record.summary, record.content].flatMap(codexTextFragments);
}

function codexHistoryMessages(items: unknown[]): ClaudeStreamMessage[] {
  const messages: ClaudeStreamMessage[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "";
    if (type === "userMessage") {
      const text = codexTextFragments(record.text ?? record.content).join("\n");
      if (text) {
        messages.push({
          type: "user",
          message: { content: [{ type: "text", text }] },
        });
      }
    } else if (type === "agentMessage") {
      const text = codexTextFragments(record.text ?? record.content).join("\n");
      if (text) {
        messages.push({
          type: "assistant",
          message: { content: [{ type: "text", text }] },
        });
      }
    } else if (type === "reasoning" || type === "reasoningSummary") {
      const thinking = codexTextFragments(
        record.summary ?? record.content ?? record.text,
      ).join("\n");
      if (thinking) {
        messages.push({
          type: "assistant",
          subtype: "reasoning",
          message: { content: [{ type: "thinking", thinking }] },
        });
      }
    }
  }
  return messages;
}

function claudeHistoryMessages(items: unknown[]): ClaudeStreamMessage[] {
  const messages: ClaudeStreamMessage[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const type = (item as { type?: unknown }).type;
    if (type === "user" || type === "assistant" || type === "result") {
      messages.push(item as unknown as ClaudeStreamMessage);
    }
  }
  return messages;
}

function conversationHistoryMessages(
  runtime: RuntimeKind,
  items: unknown[],
): ClaudeStreamMessage[] {
  if (runtime === "codex") return codexHistoryMessages(items);
  return claudeHistoryMessages(items).map(sanitizeStoredUserMessageForDisplay);
}

function buildProviderSwitchContext(
  messages: ClaudeStreamMessage[],
  maxChars = 18000,
): string | null {
  const entries = messages
    .filter((msg) => msg.type === "user" || msg.type === "assistant")
    .map((msg) => {
      const text = messageContentText(msg);
      if (!text) return null;
      return `${msg.type === "user" ? "User" : "Assistant"}:\n${text}`;
    })
    .filter((entry): entry is string => !!entry);

  if (entries.length === 0) return null;

  const selected: string[] = [];
  let total = 0;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const next = entries[i];
    if (selected.length > 0 && total + next.length > maxChars) break;
    selected.unshift(next);
    total += next.length;
  }

  return [
    "[Provider switch context]",
    "The conversation below happened earlier in this same LocalPrism chat before switching model providers.",
    "Use it as prior context. Do not repeat it; answer only the user's latest request after this block.",
    "",
    selected.join("\n\n"),
    "[End provider switch context]",
  ].join("\n");
}

let tabCounter = 0n;
function nextTabId(): string {
  return `tab-${++tabCounter}`;
}

function reseedTabCounter(tabs: Pick<TabState, "id">[]) {
  for (const tab of tabs) {
    const match = /^tab-(\d+)$/.exec(tab.id);
    if (!match) continue;
    try {
      const value = BigInt(match[1]);
      if (value > tabCounter) tabCounter = value;
    } catch {
      // Ignore malformed persisted suffixes and continue from the safe counter.
    }
  }
}

function nextGuidanceId(): string {
  return `guidance-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function truncateChatTitle(text: string, maxChars = 80): string {
  return text.length > maxChars
    ? `${text.slice(0, Math.max(0, maxChars - 3))}...`
    : text;
}

function normalizeChatTitleWhitespace(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function isNoiseChatTitleLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  const lower = trimmed.toLowerCase();
  return (
    lower.startsWith("template:") ||
    lower.startsWith("file:") ||
    lower.startsWith("reference files") ||
    lower === "what i want to create" ||
    lower.startsWith("(extracted text") ||
    lower.startsWith("attachments/") ||
    lower.startsWith("the file currently contains") ||
    (lower.startsWith("new ") && lower.includes(" project"))
  );
}

function extractMarkedRequestBody(text: string): string | null {
  const lines = text.split(/\r?\n/);
  const markerIndex = lines.findIndex(
    (line) => line.trim().toLowerCase() === "what i want to create",
  );
  if (markerIndex < 0) return null;

  const selected: string[] = [];
  for (const line of lines.slice(markerIndex + 1)) {
    const trimmed = line.trim();
    if (trimmed.toLowerCase() === "reference files") break;
    if (isNoiseChatTitleLine(trimmed)) continue;
    selected.push(trimmed);
    if (selected.join(" ").length >= 120) break;
  }

  const body = normalizeChatTitleWhitespace(selected.join(" "));
  return body || null;
}

function firstMeaningfulTitleLine(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    if (!isNoiseChatTitleLine(line)) {
      const normalized = normalizeChatTitleWhitespace(line);
      if (normalized) return normalized;
    }
  }
  return null;
}

function summarizeChatTitle(prompt: string): string | undefined {
  const clean = prompt.includes("]\n\n")
    ? prompt.slice(prompt.lastIndexOf("]\n\n") + 3)
    : prompt;
  if (
    clean.startsWith("<ide_") ||
    clean.startsWith("<system-reminder>") ||
    clean.startsWith("<command-name>") ||
    clean.startsWith("<local-command-stdout>")
  ) {
    return undefined;
  }

  const source =
    extractMarkedRequestBody(clean) ?? firstMeaningfulTitleLine(clean);
  if (!source) return undefined;

  const normalized = normalizeChatTitleWhitespace(source);
  const lower = normalized.toLowerCase();
  const researchPrefix = [
    "a research paper for ",
    "research paper for ",
    "a research paper on ",
    "research paper on ",
    "a research paper about ",
    "research paper about ",
  ].find((prefix) => lower.startsWith(prefix));

  if (researchPrefix) {
    const topic = normalized.slice(researchPrefix.length).trim();
    return topic
      ? `Research Paper: ${truncateChatTitle(topic, 56)}`
      : "Research Paper";
  }

  return truncateChatTitle(normalized);
}

function titleForMessages(messages: ClaudeStreamMessage[]): string | undefined {
  const firstUser = messages.find((message) => message.type === "user");
  if (!firstUser) return undefined;
  return summarizeChatTitle(messageContentText(firstUser));
}

/**
 * Update a specific tab in `tabs[]` and, if that tab is the active tab,
 * also project the changed fields to top-level state for consumer compatibility.
 */
function applyTabUpdate(
  state: ClaudeChatState,
  tabId: string,
  updates: Partial<TabState>,
): Partial<ClaudeChatState> {
  const currentTab = state.tabs.find((tab) => tab.id === tabId);
  if (!currentTab) return {};
  const normalizedUpdates = normalizeTabSessionProjection(currentTab, updates);
  const newTabs = state.tabs.map((t) =>
    t.id === tabId ? { ...t, ...normalizedUpdates } : t,
  );
  const result: Partial<ClaudeChatState> = { tabs: newTabs };
  if (tabId === state.activeTabId) {
    for (const key of TAB_FIELDS) {
      if (key in normalizedUpdates) {
        (result as any)[key] = (normalizedUpdates as any)[key];
      }
    }
  }
  return result;
}

export function normalizeTabSessionProjection(
  tab: TabState,
  updates: Partial<TabState>,
): Partial<TabState> {
  const affectsSession =
    "sessionId" in updates ||
    "sessionRef" in updates ||
    "runtime" in updates ||
    "projectPath" in updates;
  if (!affectsSession) return updates;

  const runtime = updates.runtime ?? tab.runtime;
  const projectPath =
    "projectPath" in updates ? (updates.projectPath ?? null) : tab.projectPath;
  if ("sessionRef" in updates) {
    const ref = updates.sessionRef;
    const sessionRef =
      ref && ref.runtime === runtime && ref.projectPath === projectPath
        ? ref
        : null;
    return {
      ...updates,
      sessionId: sessionRef?.sessionId ?? null,
      sessionRef,
    };
  }

  if ("sessionId" in updates) {
    const sessionId = updates.sessionId ?? null;
    const sessionRef =
      sessionId && projectPath ? { runtime, sessionId, projectPath } : null;
    return { ...updates, sessionId, sessionRef };
  }

  const sessionRef =
    tab.sessionRef?.runtime === runtime &&
    tab.sessionRef.projectPath === projectPath
      ? tab.sessionRef
      : null;
  return {
    ...updates,
    sessionId: sessionRef?.sessionId ?? null,
    sessionRef,
  };
}

// ─── State Interface ───

function mergeStreamingContent(
  existing: ContentBlock[],
  incoming: ContentBlock[],
): ContentBlock[] {
  let merged = [...existing];
  for (const block of incoming) {
    if (block.type === "text" && block.text) {
      const idx = merged.findIndex((item) => item.type === "text");
      if (idx >= 0) {
        merged = merged.map((item, itemIdx) =>
          itemIdx === idx
            ? { ...item, text: `${item.text ?? ""}${block.text}` }
            : item,
        );
      } else {
        merged.push(block);
      }
    } else if (block.type === "thinking" && block.thinking) {
      const idx = merged.findIndex((item) => item.type === "thinking");
      if (idx >= 0) {
        merged = merged.map((item, itemIdx) =>
          itemIdx === idx
            ? { ...item, thinking: `${item.thinking ?? ""}${block.thinking}` }
            : item,
        );
      } else {
        merged.unshift(block);
      }
    } else {
      merged.push(block);
    }
  }
  return merged;
}

function finalizeStreamingContent(
  existing: ContentBlock[],
  finalContent: ContentBlock[],
): ContentBlock[] {
  const nonTextStreamingContent = existing.filter(
    (block) => block.type !== "text",
  );
  return mergeStreamingContent(nonTextStreamingContent, finalContent);
}

function temporaryFilesOwnedByTab(tab: TabState | undefined): string[] {
  if (!tab) return [];
  return Array.from(
    new Set([
      ...(tab.pendingTemporaryFilePaths ?? []),
      ...(tab.queuedGuidance ?? []).flatMap(
        (guidance) => guidance.contextOverride?.temporaryFilePaths ?? [],
      ),
      ...(tab.cancelledAttempts ?? []).flatMap(
        (cancellation) => cancellation.temporaryFilePaths ?? [],
      ),
    ]),
  );
}

function cleanupDiscardedTemporaryFiles(paths: string[]) {
  const candidates = Array.from(new Set(paths));
  if (candidates.length === 0) return;

  void Promise.resolve().then(() => {
    const currentlyOwned = new Set(
      useClaudeChatStore
        .getState()
        .tabs.flatMap((tab) => temporaryFilesOwnedByTab(tab)),
    );
    return cleanupTemporaryChatFiles(
      candidates.filter((path) => !currentlyOwned.has(path)),
    );
  });
}

const DEFAULT_TAB_ID = nextTabId();

interface ClaudeChatState {
  // ── Projected fields (from active tab — read by consumers) ──
  messages: ClaudeStreamMessage[];
  sessionId: string | null;
  isStreaming: boolean;
  streamingStartedAt: number | null;
  streamingStatus?: string | null;
  error: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;

  // ── Tab state ──
  tabs: TabState[];
  activeTabId: string;
  activeProjectPath: string | null;

  /** Deferred prompt to send once the workspace is ready (set by project wizard) */
  pendingInitialPrompt: string | null;
  setPendingInitialPrompt: (prompt: string | null) => void;
  consumePendingInitialPrompt: () => string | null;

  /** Pending attachments from external sources (e.g. PDF capture) */
  pendingAttachments: {
    label: string;
    filePath: string;
    selectedText: string;
    imageDataUrl?: string;
  }[];
  addPendingAttachment: (attachment: {
    label: string;
    filePath: string;
    selectedText: string;
    imageDataUrl?: string;
  }) => void;
  consumePendingAttachments: () => {
    label: string;
    filePath: string;
    selectedText: string;
    imageDataUrl?: string;
  }[];
  pendingPinnedContextRemovalLabels: string[];
  requestPinnedContextRemoval: (labels: string[]) => void;
  consumePendingPinnedContextRemovals: () => string[];

  /** Currently selected model (passed per-prompt to Claude CLI) */
  selectedModel: "sonnet" | "opus" | "haiku" | "opusplan";
  setSelectedModel: (model: "sonnet" | "opus" | "haiku" | "opusplan") => void;
  selectedProviderCredentialId: string | null;
  setSelectedProviderCredentialId: (credentialId: string | null) => void;
  selectedProviderModels: Record<string, string>;
  setSelectedProviderModel: (credentialId: string, model: string) => void;

  /** Effort level for Opus 4.6 adaptive reasoning */
  effortLevel: "low" | "medium" | "high";
  setEffortLevel: (level: "low" | "medium" | "high") => void;

  // Actions
  sendPrompt: (
    userPrompt: string,
    contextOverride?: PromptContextOverride,
    options?: { tabId?: string; preserveTabProvider?: boolean },
  ) => Promise<void>;
  queueGuidance: (
    tabId: string,
    prompt: string,
    contextOverride?: PromptContextOverride,
  ) => void;
  consumeQueuedGuidance: (
    tabId: string,
    guidanceId?: string | null,
  ) => QueuedGuidance | null;
  displayQueuedGuidanceInChat: (
    tabId: string,
    guidanceId?: string | null,
  ) => string | null;
  removeQueuedGuidance: (tabId: string, guidanceId: string) => void;
  clearQueuedGuidance: (tabId: string) => void;
  consumeTemporaryFilePaths: (tabId: string) => string[];
  forceQueuedGuidanceNow: (tabId: string, guidanceId?: string) => Promise<void>;
  cancelExecution: (tabId?: string) => Promise<RuntimeStopOutcome>;
  clearMessages: () => void;
  newSession: () => void;
  resetForProject: (projectPath: string | null) => ProjectChatResetResult;
  resumeConversation: (
    reference: ConversationRef,
    title?: string,
  ) => Promise<void>;
  resumeSession: (sessionId: string, title?: string) => Promise<void>;
  changeTabRuntime: (
    tabId: string,
    nextPeer: ChatRuntimePeer,
    options?: { confirmSessionReset?: boolean },
  ) => ChangeTabRuntimeResult;
  updateTabRuntimeSelection: (
    tabId: string,
    selection: TabRuntimeSelection,
  ) => UpdateTabRuntimeSelectionResult;

  // Tab actions
  createTab: () => string;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  saveDraft: (tabId: string, draft: TabDraft) => void;

  /** True when any tab is streaming */
  anyStreaming: () => boolean;

  // Internal actions (called by event hook, routed by tabId)
  _appendMessage: (tabId: string, msg: ClaudeStreamMessage) => void;
  _setSessionId: (tabId: string, id: string) => void;
  _setSessionTitle: (sessionId: string, title: string) => void;
  _setConversationTitle: (reference: ConversationRef, title: string) => void;
  _setStreaming: (tabId: string, streaming: boolean) => void;
  _setStreamingStatus: (tabId: string, status: string | null) => void;
  _setError: (tabId: string, error: string | null) => void;
  _addUsage: (tabId: string, inputTokens: number, outputTokens: number) => void;
  _consumeAttemptCancellation: (
    tabId: string,
    attemptId: string,
  ) => AttemptCancellation | null;
  _cleanupTemporaryFilePaths: (paths: string[]) => void;
}

// ─── Store ───

export const useClaudeChatStore = create<ClaudeChatState>()((set, get) => ({
  // Projected fields (initialized from default tab)
  messages: [],
  sessionId: null,
  isStreaming: false,
  streamingStartedAt: null,
  streamingStatus: null,
  error: null,
  totalInputTokens: 0,
  totalOutputTokens: 0,

  // Tab state
  tabs: [makeDefaultTab(DEFAULT_TAB_ID)],
  activeTabId: DEFAULT_TAB_ID,
  activeProjectPath: null,

  selectedModel: "opus",
  setSelectedModel: (model) => set({ selectedModel: model }),
  selectedProviderCredentialId:
    loadSelectedProviderCredentialId() ?? CLAUDE_CODE_PROVIDER_ID,
  setSelectedProviderCredentialId: (credentialId) => {
    persistSelectedProviderCredentialId(credentialId);
    const providerKey = providerKeyForSelectedCredential(
      credentialId ?? CLAUDE_CODE_PROVIDER_ID,
    );
    set((state) => ({
      selectedProviderCredentialId: credentialId,
      tabs: state.tabs.map((tab) =>
        tab.id === state.activeTabId ? { ...tab, providerKey } : tab,
      ),
    }));
  },
  selectedProviderModels: {},
  setSelectedProviderModel: (credentialId, model) =>
    set((state) => ({
      selectedProviderModels: {
        ...state.selectedProviderModels,
        [credentialId]: model,
      },
    })),

  effortLevel: "medium",
  setEffortLevel: (level) => set({ effortLevel: level }),

  pendingInitialPrompt: null,
  setPendingInitialPrompt: (prompt) => set({ pendingInitialPrompt: prompt }),
  consumePendingInitialPrompt: () => {
    const { pendingInitialPrompt } = get();
    if (pendingInitialPrompt) {
      set({ pendingInitialPrompt: null });
    }
    return pendingInitialPrompt;
  },

  pendingAttachments: [],
  addPendingAttachment: (attachment) => {
    set((state) => ({
      pendingAttachments: [...state.pendingAttachments, attachment],
    }));
  },
  consumePendingAttachments: () => {
    const { pendingAttachments } = get();
    if (pendingAttachments.length > 0) {
      set({ pendingAttachments: [] });
    }
    return pendingAttachments;
  },
  pendingPinnedContextRemovalLabels: [],
  requestPinnedContextRemoval: (labels) => {
    if (labels.length === 0) return;
    set((state) => ({
      pendingPinnedContextRemovalLabels: [
        ...state.pendingPinnedContextRemovalLabels,
        ...labels,
      ],
    }));
  },
  consumePendingPinnedContextRemovals: () => {
    const { pendingPinnedContextRemovalLabels } = get();
    if (pendingPinnedContextRemovalLabels.length > 0) {
      set({ pendingPinnedContextRemovalLabels: [] });
    }
    return pendingPinnedContextRemovalLabels;
  },

  anyStreaming: () =>
    get().tabs.some(
      (tab) => tab.isStreaming || (tab.cancelledAttempts?.length ?? 0) > 0,
    ),

  sendPrompt: async (
    userPrompt: string,
    contextOverride?: PromptContextOverride,
    options?: { tabId?: string; preserveTabProvider?: boolean },
  ) => {
    let state = get();
    let activeTabId = options?.tabId ?? state.activeTabId;
    let activeTab = state.tabs.find((t) => t.id === activeTabId);
    const directTemporaryFilePaths = [
      ...(contextOverride?.temporaryFilePaths ?? []),
    ];
    const discardRejectedPrompt = (tabId: string) => {
      const discarded = [...directTemporaryFilePaths];
      set((current) => {
        const tab = current.tabs.find((candidate) => candidate.id === tabId);
        if (
          !tab ||
          tab.isStreaming ||
          (tab.cancelledAttempts?.length ?? 0) > 0
        ) {
          return {};
        }
        discarded.push(...(tab.pendingTemporaryFilePaths ?? []));
        return applyTabUpdate(current, tabId, {
          pendingTemporaryFilePaths: [],
        });
      });
      cleanupDiscardedTemporaryFiles(discarded);
    };
    if (!activeTab || activeTab.isStreaming) {
      discardRejectedPrompt(activeTabId);
      return;
    }
    if ((activeTab.cancelledAttempts?.length ?? 0) > 0) {
      set((s) =>
        applyTabUpdate(s, activeTabId, {
          error: "Waiting for the previous runtime turn to stop.",
        }),
      );
      discardRejectedPrompt(activeTabId);
      return;
    }

    const docState = useDocumentStore.getState();
    const projectPath = docState.projectRoot;
    const projectGeneration = docState.projectGeneration;
    const projectContentGeneration = docState.contentGeneration;
    if (!projectPath) {
      set((s) => applyTabUpdate(s, activeTabId, { error: "No project open" }));
      discardRejectedPrompt(activeTabId);
      return;
    }
    if (docState.isProjectMutating) {
      set((s) =>
        applyTabUpdate(s, activeTabId, {
          error: "The project is being changed. Wait for it to finish.",
        }),
      );
      discardRejectedPrompt(activeTabId);
      return;
    }

    if (
      state.activeProjectPath !== projectPath ||
      activeTab.projectPath !== projectPath
    ) {
      const resetResult = get().resetForProject(projectPath);
      if (resetResult === "blocked-stopping") {
        discardRejectedPrompt(activeTabId);
        return;
      }
      state = get();
      activeTabId = state.activeTabId;
      activeTab = state.tabs.find((t) => t.id === activeTabId);
      if (
        !activeTab ||
        activeTab.isStreaming ||
        activeTab.projectPath !== projectPath
      ) {
        discardRejectedPrompt(activeTabId);
        return;
      }
    }

    const runtime = activeTab.runtime;
    const runtimeModel = activeTab.runtimeModel?.trim() || null;
    let tabReasoningEffort = activeTab.reasoningEffort?.trim() || null;
    const codexAgentId = activeTab.agentId?.trim() || null;
    if (runtime === "codex" && !runtimeModel) {
      set((s) =>
        applyTabUpdate(s, activeTabId, {
          error: "Select a Codex model before sending a message.",
        }),
      );
      discardRejectedPrompt(activeTabId);
      return;
    }
    if (runtime === "codex" && runtimeModel) {
      const selectedCodexModel =
        useRuntimeStore
          .getState()
          .models.codex.find((model) => model.id === runtimeModel) ?? null;
      if (selectedCodexModel) {
        const coercedEffort = coerceCodexReasoningEffort(
          tabReasoningEffort,
          selectedCodexModel,
        );
        if (!coercedEffort) {
          set((s) =>
            applyTabUpdate(s, activeTabId, {
              error:
                "Select a supported reasoning effort for this Codex model before sending.",
            }),
          );
          discardRejectedPrompt(activeTabId);
          return;
        }
        if (tabReasoningEffort !== coercedEffort) {
          set((s) =>
            applyTabUpdate(s, activeTabId, {
              reasoningEffort: coercedEffort,
            }),
          );
        }
        tabReasoningEffort = coercedEffort;
      } else if (
        tabReasoningEffort === "max" ||
        tabReasoningEffort === "ultra"
      ) {
        tabReasoningEffort = "xhigh";
        set((s) =>
          applyTabUpdate(s, activeTabId, {
            reasoningEffort: "xhigh",
          }),
        );
      }
    }
    const requestModel = runtimeModel ?? state.selectedModel;
    const attemptEpoch = (activeTab.attemptEpoch ?? 0) + 1;
    const attemptId = nextRuntimeAttemptId(activeTabId);
    const isCurrentAttempt = () => {
      const currentTab = get().tabs.find((tab) => tab.id === activeTabId);
      return (
        currentTab?.attemptEpoch === attemptEpoch &&
        currentTab.activeAttemptId === attemptId
      );
    };
    const isCurrentPreflight = () => {
      const currentTab = get().tabs.find((tab) => tab.id === activeTabId);
      return (
        currentTab?.attemptEpoch === attemptEpoch &&
        currentTab.preflightAttemptEpoch === attemptEpoch &&
        currentTab.activeAttemptId === attemptId
      );
    };
    const projectIsStable = () => {
      const currentDocument = useDocumentStore.getState();
      return (
        currentDocument.projectRoot === projectPath &&
        currentDocument.projectGeneration === projectGeneration &&
        currentDocument.contentGeneration === projectContentGeneration &&
        !currentDocument.files.some((file) => file.isDirty) &&
        !currentDocument.isProjectMutating
      );
    };
    const temporaryFilePathsForAttempt = Array.from(
      new Set([
        ...(activeTab.pendingTemporaryFilePaths ?? []),
        ...(contextOverride?.temporaryFilePaths ?? []),
      ]),
    );
    const abortUnstablePreflight = (message?: string) => {
      if (!isCurrentPreflight()) return;
      set((current) =>
        applyTabUpdate(current, activeTabId, {
          attemptEpoch: attemptEpoch + 1,
          activeAttemptId: null,
          preflightAttemptEpoch: null,
          isStreaming: false,
          streamingStartedAt: null,
          pendingTemporaryFilePaths: [],
          error:
            message ??
            "The project changed before the runtime turn could start.",
        }),
      );
      cleanupDiscardedTemporaryFiles(temporaryFilePathsForAttempt);
    };

    const sessionRef =
      activeTab.sessionRef?.runtime === runtime &&
      activeTab.sessionRef.projectPath === projectPath
        ? activeTab.sessionRef
        : null;
    const sessionId = sessionRef?.sessionId ?? null;
    const { effortLevel, selectedProviderModels } = state;
    const chatPeer = chatPeerForTab(activeTab);
    let providerCredentialId: string | null = null;
    if (runtime === "claude" && chatPeer === "api") {
      const tabSelectedProviderCredentialId =
        selectedCredentialForProviderKey(activeTab.providerKey) ??
        state.selectedProviderCredentialId;
      providerCredentialId =
        tabSelectedProviderCredentialId &&
        tabSelectedProviderCredentialId !== CLAUDE_CODE_PROVIDER_ID
          ? tabSelectedProviderCredentialId
          : null;

      if (options?.preserveTabProvider && activeTab.providerKey) {
        const tabProviderCredentialId = providerCredentialIdFromSessionKey(
          activeTab.providerKey,
        );
        if (tabProviderCredentialId === CLAUDE_CODE_PROVIDER_ID) {
          providerCredentialId = null;
        } else if (tabProviderCredentialId !== undefined) {
          providerCredentialId = tabProviderCredentialId;
        }
      }
    }

    const providerModelOverride =
      runtime === "claude" && providerCredentialId
        ? selectedProviderModels[providerCredentialId] || null
        : null;
    const requestProviderKey =
      runtime === "claude" ? providerSessionKey(providerCredentialId) : null;
    const previousProviderKey = activeTab.sessionProviderKey ?? null;
    const providerChanged =
      runtime === "claude" &&
      !!sessionId &&
      !!previousProviderKey &&
      previousProviderKey !== requestProviderKey;
    const switchingDirectProviderToClaudeCode =
      providerChanged &&
      requestProviderKey === CLAUDE_CODE_PROVIDER_ID &&
      previousProviderKey !== CLAUDE_CODE_PROVIDER_ID;
    const resumeSessionId = switchingDirectProviderToClaudeCode
      ? null
      : sessionId;

    const sendStart = performance.now();
    const streamingStartedAt = Date.now();
    log.info("sendPrompt start", {
      sessionId: !!sessionId,
      providerChanged,
      hasContext: !!contextOverride,
      tab: activeTabId,
    });

    // Compute context label for display in chat history
    const activeFile = docState.files.find(
      (f) => f.id === docState.activeFileId,
    );
    let contextLabel: string | null = null;

    if (contextOverride) {
      contextLabel = contextOverride.label;
    } else if (activeFile) {
      const selRange = docState.selectionRange;
      if (selRange && activeFile.content) {
        const content = activeFile.content;
        const startLC = offsetToLineCol(content, selRange.start);
        const endLC = offsetToLineCol(content, selRange.end);
        contextLabel = `@${activeFile.relativePath}:${startLC.line}:${startLC.col}-${endLC.line}:${endLC.col}`;
      }
    }

    // Add user message to the list for display (with context label visible)
    const displayText = contextLabel
      ? `${contextLabel}\n${userPrompt}`
      : userPrompt;
    const userMessage: ClaudeStreamMessage = {
      type: "user",
      message: {
        content: [{ type: "text", text: displayText }],
      },
    };

    // Auto-set tab title from first prompt
    const isFirstMessage = activeTab && activeTab.messages.length === 0;
    const tabTitle = isFirstMessage
      ? summarizeChatTitle(userPrompt)
      : undefined;

    set((s) => {
      const currentTab = s.tabs.find((t) => t.id === activeTabId);
      const tabUpdates: Partial<TabState> = {
        messages: [...(currentTab?.messages ?? []), userMessage],
        projectPath,
        sessionId: resumeSessionId,
        isStreaming: true,
        streamingStartedAt,
        streamingStatus: runtime === "codex" ? "Waiting for Codex…" : null,
        error: null,
        pendingTemporaryFilePaths: temporaryFilePathsForAttempt,
        attemptEpoch,
        activeAttemptId: attemptId,
        preflightAttemptEpoch: attemptEpoch,
        resumeRequestId: null,
      };
      if (runtime === "claude") {
        tabUpdates.providerKey = requestProviderKey;
        tabUpdates.sessionProviderKey = requestProviderKey;
      }
      if (tabTitle) tabUpdates.title = tabTitle;
      return {
        ...applyTabUpdate(s, activeTabId, tabUpdates),
        activeProjectPath: projectPath,
      };
    });

    try {
      // Flush unsaved edits to disk so the runtime reads the latest content.
      if (docState.files.some((f) => f.isDirty)) {
        log.debug("saving dirty files...");
        await docState.saveAllFiles();
        if (!isCurrentPreflight()) return;
        if (!projectIsStable()) {
          const currentDocument = useDocumentStore.getState();
          abortUnstablePreflight(
            currentDocument.files.some((file) => file.isDirty)
              ? "Files changed while saving. Send the message again after the latest edits are saved."
              : undefined,
          );
          return;
        }
        log.debug("saveAllFiles done");
      }

      // Snapshot before the runtime edits files.
      if (projectPath) {
        try {
          log.debug("creating snapshot...");
          await useHistoryStore
            .getState()
            .createSnapshot(
              projectPath,
              runtime === "claude"
                ? "[claude] Before Claude edit"
                : "[codex] Before Codex edit",
            );
          log.debug("snapshot done");
        } catch {
          /* snapshot failure should not block the runtime */
        }
        if (!isCurrentPreflight()) return;
        if (!projectIsStable()) {
          abortUnstablePreflight();
          return;
        }
      }

      // Build prompt with full context for the selected runtime.
      let prompt = userPrompt;
      if (activeFile) {
        const selRange = docState.selectionRange;
        const selectedText =
          selRange && activeFile.content
            ? activeFile.content.slice(selRange.start, selRange.end)
            : null;
        let ctx = `[Currently open file: ${activeFile.relativePath}]`;
        if (contextOverride) {
          ctx += `\n[Selection: ${contextOverride.label}]`;
          ctx += `\n[Selected text:\n${contextOverride.selectedText}\n]`;
        } else if (selectedText && selRange) {
          const content = activeFile.content ?? "";
          const startLC = offsetToLineCol(content, selRange.start);
          const endLC = offsetToLineCol(content, selRange.end);
          ctx += `\n[Selection: @${activeFile.relativePath}:${startLC.line}:${startLC.col}-${endLC.line}:${endLC.col}]`;
          ctx += `\n[Selected text:\n${selectedText}\n]`;
        }
        prompt = `${ctx}\n\n${userPrompt}`;
      }
      if (switchingDirectProviderToClaudeCode) {
        const priorContext = buildProviderSwitchContext(
          activeTab?.messages ?? [],
        );
        if (priorContext) {
          prompt = `${priorContext}\n\n${prompt}`;
        }
      }
      log.info("invoking CLI", {
        promptLength: prompt.length,
        mode: resumeSessionId ? "resume" : "new",
      });

      if (!isCurrentPreflight()) return;
      if (!projectIsStable()) {
        abortUnstablePreflight();
        return;
      }
      const startPromise = startRuntimeTurn({
        runtime,
        projectPath,
        tabId: activeTabId,
        attemptId,
        sessionId: resumeSessionId,
        prompt,
        model: requestModel,
        reasoningEffort:
          runtime === "claude"
            ? (tabReasoningEffort ?? effortLevel)
            : tabReasoningEffort,
        agentId: runtime === "codex" ? codexAgentId : null,
        providerCredentialId:
          runtime === "claude" ? providerCredentialId : null,
        providerModelOverride:
          runtime === "claude" ? providerModelOverride : null,
      });
      pendingRuntimeStarts.set(attemptId, startPromise);
      try {
        await startPromise;
      } finally {
        if (pendingRuntimeStarts.get(attemptId) === startPromise) {
          pendingRuntimeStarts.delete(attemptId);
        }
      }
      if (!isCurrentPreflight()) return;
      if (!projectIsStable()) {
        await get().cancelExecution(activeTabId);
        return;
      }
      set((current) =>
        applyTabUpdate(current, activeTabId, {
          preflightAttemptEpoch: null,
        }),
      );
      log.info(
        `sendPrompt complete in ${(performance.now() - sendStart).toFixed(0)}ms`,
      );
    } catch (err: any) {
      const cancelledAttempt = get()
        .tabs.find((tab) => tab.id === activeTabId)
        ?.cancelledAttempts?.find(
          (cancellation) =>
            cancellation.attemptId === attemptId &&
            cancellation.runtime === runtime,
        );
      if (cancelledAttempt) {
        set((current) => {
          const currentTab = current.tabs.find((tab) => tab.id === activeTabId);
          if (
            !(currentTab?.cancelledAttempts ?? []).some(
              (cancellation) => cancellation.attemptId === attemptId,
            )
          ) {
            return {};
          }
          return applyTabUpdate(current, activeTabId, {
            isStreaming: true,
            streamingStartedAt:
              currentTab?.streamingStartedAt ?? streamingStartedAt,
            error:
              "Unable to confirm that the runtime stopped. Retry Stop before starting another turn.",
          });
        });
        return;
      }
      if (!isCurrentAttempt() || !isCurrentPreflight()) return;
      log.error(
        `sendPrompt failed after ${(performance.now() - sendStart).toFixed(0)}ms`,
        { error: String(err) },
      );
      set((s) =>
        applyTabUpdate(s, activeTabId, {
          isStreaming: false,
          streamingStartedAt: null,
          preflightAttemptEpoch: null,
          activeAttemptId: null,
          pendingTemporaryFilePaths: [],
          error: err?.message || String(err),
        }),
      );
      cleanupDiscardedTemporaryFiles(temporaryFilePathsForAttempt);
    }
  },

  queueGuidance: (tabId, prompt, contextOverride) => {
    const trimmed = prompt.trim();
    const temporaryFilePaths = contextOverride?.temporaryFilePaths ?? [];
    if (!trimmed) {
      cleanupDiscardedTemporaryFiles(temporaryFilePaths);
      return;
    }
    let accepted = false;
    set((state) => {
      const tab = state.tabs.find((t) => t.id === tabId);
      if (!tab) return {};
      if ((tab.cancelledAttempts?.length ?? 0) > 0) return {};
      accepted = true;
      const queuedGuidance = [
        ...(tab.queuedGuidance ?? []),
        {
          id: nextGuidanceId(),
          prompt: trimmed,
          contextOverride,
          createdAt: Date.now(),
        },
      ];
      return applyTabUpdate(state, tabId, { queuedGuidance });
    });
    if (!accepted) cleanupDiscardedTemporaryFiles(temporaryFilePaths);
  },

  consumeQueuedGuidance: (tabId, guidanceId) => {
    const state = get();
    const tab = state.tabs.find((t) => t.id === tabId);
    const queue = tab?.queuedGuidance ?? [];
    const displayedIndex = queue.findIndex(
      (guidance) => guidance.displayedInChat,
    );
    const targetIndex = guidanceId
      ? queue.findIndex((guidance) => guidance.id === guidanceId)
      : displayedIndex >= 0
        ? displayedIndex
        : 0;
    const next = targetIndex >= 0 ? queue[targetIndex] : null;
    if (!next) {
      if (tab?.forceQueuedGuidanceOnComplete) {
        set((s) =>
          applyTabUpdate(s, tabId, {
            forceQueuedGuidanceOnComplete: false,
            forcedQueuedGuidanceId: null,
          }),
        );
      }
      return null;
    }
    const rest = queue.filter((_, index) => index !== targetIndex);
    set((s) =>
      applyTabUpdate(s, tabId, {
        queuedGuidance: rest,
        forceQueuedGuidanceOnComplete: false,
        forcedQueuedGuidanceId: null,
      }),
    );
    return next;
  },

  displayQueuedGuidanceInChat: (tabId, guidanceId) => {
    let displayedId: string | null = null;
    set((state) => {
      const tab = state.tabs.find((t) => t.id === tabId);
      const queue = tab?.queuedGuidance ?? [];
      const targetId = guidanceId ?? queue[0]?.id;
      if (!tab || !targetId || queue.length === 0) return {};
      displayedId = targetId;
      return applyTabUpdate(state, tabId, {
        queuedGuidance: queue.map((guidance) => ({
          ...guidance,
          displayedInChat: guidance.displayedInChat || guidance.id === targetId,
        })),
      });
    });
    return displayedId;
  },

  removeQueuedGuidance: (tabId, guidanceId) => {
    let discardedTemporaryFilePaths: string[] = [];
    set((state) => {
      const tab = state.tabs.find((t) => t.id === tabId);
      if (!tab) return {};
      const removedGuidance = (tab.queuedGuidance ?? []).find(
        (guidance) => guidance.id === guidanceId,
      );
      discardedTemporaryFilePaths = [
        ...(removedGuidance?.contextOverride?.temporaryFilePaths ?? []),
      ];
      const queuedGuidance = (tab.queuedGuidance ?? []).filter(
        (guidance) => guidance.id !== guidanceId,
      );
      const nextForcedGuidanceId =
        tab.forcedQueuedGuidanceId === guidanceId
          ? (queuedGuidance.find((guidance) => guidance.displayedInChat)?.id ??
            null)
          : tab.forcedQueuedGuidanceId;
      return applyTabUpdate(state, tabId, {
        queuedGuidance,
        ...(tab.forcedQueuedGuidanceId === guidanceId
          ? {
              forceQueuedGuidanceOnComplete: nextForcedGuidanceId !== null,
              forcedQueuedGuidanceId: nextForcedGuidanceId,
            }
          : {}),
      });
    });
    cleanupDiscardedTemporaryFiles(discardedTemporaryFilePaths);
  },

  clearQueuedGuidance: (tabId) => {
    const discardedTemporaryFilePaths =
      get()
        .tabs.find((tab) => tab.id === tabId)
        ?.queuedGuidance?.flatMap(
          (guidance) => guidance.contextOverride?.temporaryFilePaths ?? [],
        ) ?? [];
    set((state) =>
      applyTabUpdate(state, tabId, {
        queuedGuidance: [],
        forceQueuedGuidanceOnComplete: false,
        forcedQueuedGuidanceId: null,
      }),
    );
    cleanupDiscardedTemporaryFiles(discardedTemporaryFilePaths);
  },

  consumeTemporaryFilePaths: (tabId) => {
    const paths =
      get().tabs.find((tab) => tab.id === tabId)?.pendingTemporaryFilePaths ??
      [];
    if (paths.length > 0) {
      set((state) =>
        applyTabUpdate(state, tabId, { pendingTemporaryFilePaths: [] }),
      );
    }
    return paths;
  },

  forceQueuedGuidanceNow: async (tabId, guidanceId) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab?.isStreaming || !(tab.queuedGuidance?.length ?? 0)) return;
    const cancellation: AttemptCancellation = {
      attemptId: tab.activeAttemptId ?? "",
      attemptEpoch: tab.attemptEpoch ?? 0,
      runtime: tab.runtime,
      mode: "interrupt",
    };
    if (!cancellation.attemptId) return;
    if ((tab.cancelledAttempts?.length ?? 0) > 0) return;
    const targetId = get().displayQueuedGuidanceInChat(tabId, guidanceId);
    if (!targetId) return;

    const rollbackForcedStop = (error?: string) => {
      set((state) => {
        const currentTab = state.tabs.find(
          (candidate) => candidate.id === tabId,
        );
        if (currentTab?.attemptEpoch !== cancellation.attemptEpoch) return {};
        const existingForcedId = currentTab?.forcedQueuedGuidanceId ?? null;
        const nextForcedId =
          existingForcedId && existingForcedId !== targetId
            ? existingForcedId
            : null;
        return applyTabUpdate(state, tabId, {
          queuedGuidance: (currentTab?.queuedGuidance ?? []).map((guidance) =>
            guidance.id === targetId
              ? { ...guidance, displayedInChat: false }
              : guidance,
          ),
          forceQueuedGuidanceOnComplete: nextForcedId !== null,
          forcedQueuedGuidanceId: nextForcedId,
          cancelledAttempts: removeAttemptCancellation(
            currentTab,
            cancellation,
          ),
          ...(error ? { error } : {}),
        });
      });
    };

    set((state) => {
      const currentTab = state.tabs.find((t) => t.id === tabId);
      const existingForcedId = currentTab?.forcedQueuedGuidanceId ?? null;
      const existingForcedStillQueued = (currentTab?.queuedGuidance ?? []).some(
        (guidance) => guidance.id === existingForcedId,
      );
      return applyTabUpdate(state, tabId, {
        forceQueuedGuidanceOnComplete: true,
        forcedQueuedGuidanceId: existingForcedStillQueued
          ? existingForcedId
          : targetId,
        cancelledAttempts: addAttemptCancellation(currentTab, cancellation),
      });
    });

    try {
      let stopped = await interruptRuntimeTurn(
        tab.runtime,
        tabId,
        cancellation.attemptId,
        "interrupt",
      );
      if (!stopped) {
        const pendingStart = pendingRuntimeStarts.get(cancellation.attemptId);
        if (pendingStart) {
          try {
            await pendingStart;
          } catch {
            // The start failed, so there is no runtime turn left to interrupt.
          }
          const markerStillExists = (
            get().tabs.find((candidate) => candidate.id === tabId)
              ?.cancelledAttempts ?? []
          ).some((candidate) =>
            sameAttemptCancellation(candidate, cancellation),
          );
          if (!markerStillExists) return;
          stopped = await interruptRuntimeTurn(
            tab.runtime,
            tabId,
            cancellation.attemptId,
            "interrupt",
          );
        }
      }
      if (!stopped) rollbackForcedStop();
    } catch (err: any) {
      set((state) => {
        const currentTab = state.tabs.find(
          (candidate) => candidate.id === tabId,
        );
        if (
          !(currentTab?.cancelledAttempts ?? []).some((candidate) =>
            sameAttemptCancellation(candidate, cancellation),
          )
        ) {
          return {};
        }
        return applyTabUpdate(state, tabId, {
          error:
            err?.message ||
            "Unable to confirm that the runtime was interrupted.",
        });
      });
    }
  },

  cancelExecution: async (tabId) => {
    const activeTabId = tabId ?? get().activeTabId;
    const tab = get().tabs.find((t) => t.id === activeTabId);
    if (!tab) return "not-found";
    const existingTerminate = (tab.cancelledAttempts ?? []).find(
      (candidate) =>
        candidate.runtime === tab.runtime && candidate.mode === "terminate",
    );
    if (!tab.isStreaming) {
      return (tab.cancelledAttempts?.length ?? 0) > 0 ? "stopped" : "not-found";
    }
    const currentEpoch = tab.attemptEpoch ?? 0;
    const currentAttemptId =
      tab.activeAttemptId ?? nextRuntimeAttemptId(activeTabId);

    // Saving and snapshotting are entirely local. Invalidate that preflight
    // without creating a backend tombstone for a start that was never sent.
    if (
      !existingTerminate &&
      (tab.cancelledAttempts?.length ?? 0) === 0 &&
      tab.preflightAttemptEpoch === currentEpoch &&
      !pendingRuntimeStarts.has(currentAttemptId)
    ) {
      const temporaryFilePaths = temporaryFilesOwnedByTab(tab);
      set((state) =>
        applyTabUpdate(state, activeTabId, {
          attemptEpoch: currentEpoch + 1,
          activeAttemptId: null,
          preflightAttemptEpoch: null,
          isStreaming: false,
          streamingStartedAt: null,
          queuedGuidance: [],
          forceQueuedGuidanceOnComplete: false,
          forcedQueuedGuidanceId: null,
          pendingTemporaryFilePaths: [],
        }),
      );
      cleanupDiscardedTemporaryFiles(temporaryFilePaths);
      return "not-found";
    }

    const cancellation: AttemptCancellation = existingTerminate ?? {
      attemptId: currentAttemptId,
      attemptEpoch: currentEpoch,
      runtime: tab.runtime,
      mode: "terminate",
      temporaryFilePaths: [...(tab.pendingTemporaryFilePaths ?? [])],
    };
    const isRetry = existingTerminate != null;
    if (!isRetry) {
      const discardedTemporaryFilePaths = temporaryFilesOwnedByTab(tab);
      set((state) => {
        const currentTab = state.tabs.find(
          (candidate) => candidate.id === activeTabId,
        );
        return applyTabUpdate(state, activeTabId, {
          attemptEpoch: cancellation.attemptEpoch + 1,
          activeAttemptId: cancellation.attemptId,
          preflightAttemptEpoch: null,
          isStreaming: false,
          streamingStartedAt: null,
          queuedGuidance: [],
          forceQueuedGuidanceOnComplete: false,
          forcedQueuedGuidanceId: null,
          pendingTemporaryFilePaths: [],
          cancelledAttempts: addAttemptCancellation(currentTab, cancellation),
        });
      });
      cleanupDiscardedTemporaryFiles(discardedTemporaryFilePaths);
    }

    const rollbackCancellation = () => {
      set((state) => {
        const currentTab = state.tabs.find(
          (candidate) => candidate.id === activeTabId,
        );
        if (
          currentTab?.attemptEpoch !== cancellation.attemptEpoch + 1 ||
          !(currentTab.cancelledAttempts ?? []).some((candidate) =>
            sameAttemptCancellation(candidate, cancellation),
          )
        ) {
          return {};
        }
        return applyTabUpdate(state, activeTabId, {
          cancelledAttempts: removeAttemptCancellation(
            currentTab,
            cancellation,
          ),
          isStreaming: false,
          streamingStartedAt: null,
        });
      });
    };
    try {
      let stopped = await interruptRuntimeTurn(
        tab.runtime,
        activeTabId,
        cancellation.attemptId,
        "terminate",
      );
      if (!stopped) {
        const pendingStart = pendingRuntimeStarts.get(cancellation.attemptId);
        if (pendingStart) {
          try {
            await pendingStart;
          } catch {
            // The failed start leaves nothing for the retry to terminate.
          }
          const markerStillExists = (
            get().tabs.find((candidate) => candidate.id === activeTabId)
              ?.cancelledAttempts ?? []
          ).some((candidate) =>
            sameAttemptCancellation(candidate, cancellation),
          );
          if (!markerStillExists) return "stopped";
          stopped = await interruptRuntimeTurn(
            tab.runtime,
            activeTabId,
            cancellation.attemptId,
            "terminate",
          );
        }
      }
      if (!stopped) {
        // Give a terminal event already queued by Tauri one microtask to
        // consume its provisional marker before treating false as definitive.
        await Promise.resolve();
        const markerStillExists = (
          get().tabs.find((candidate) => candidate.id === activeTabId)
            ?.cancelledAttempts ?? []
        ).some((candidate) => sameAttemptCancellation(candidate, cancellation));
        if (!markerStillExists) return "stopped";
        rollbackCancellation();
        cleanupDiscardedTemporaryFiles(cancellation.temporaryFilePaths ?? []);
        return "not-found";
      }
      set((state) => {
        const currentTab = state.tabs.find(
          (candidate) => candidate.id === activeTabId,
        );
        if (
          !(currentTab?.cancelledAttempts ?? []).some((candidate) =>
            sameAttemptCancellation(candidate, cancellation),
          )
        ) {
          return {};
        }
        return applyTabUpdate(state, activeTabId, {
          isStreaming: false,
          streamingStartedAt: null,
        });
      });
      return "stopped";
    } catch {
      const message =
        "Unable to confirm that the runtime stopped. Waiting for terminal completion before allowing another turn.";
      set((state) => {
        const currentTab = state.tabs.find(
          (candidate) => candidate.id === activeTabId,
        );
        if (
          !(currentTab?.cancelledAttempts ?? []).some((candidate) =>
            sameAttemptCancellation(candidate, cancellation),
          )
        ) {
          return {};
        }
        return applyTabUpdate(state, activeTabId, {
          isStreaming: true,
          streamingStartedAt:
            currentTab?.streamingStartedAt ??
            tab.streamingStartedAt ??
            Date.now(),
          error: message,
        });
      });
      return "uncertain";
    }
  },

  clearMessages: () => {
    const { activeTabId, tabs } = get();
    const tab = tabs.find((candidate) => candidate.id === activeTabId);
    const isBusy =
      tab?.isStreaming || (tab?.cancelledAttempts?.length ?? 0) > 0;
    const discardedTemporaryFilePaths = [
      ...(tab?.queuedGuidance ?? []).flatMap(
        (guidance) => guidance.contextOverride?.temporaryFilePaths ?? [],
      ),
      ...(!isBusy ? (tab?.pendingTemporaryFilePaths ?? []) : []),
    ];
    set((s) =>
      applyTabUpdate(s, activeTabId, {
        messages: [],
        error: null,
        streamingStartedAt: null,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        queuedGuidance: [],
        forceQueuedGuidanceOnComplete: false,
        forcedQueuedGuidanceId: null,
        resumeRequestId: null,
        ...(!isBusy ? { pendingTemporaryFilePaths: [] } : {}),
      }),
    );
    cleanupDiscardedTemporaryFiles(discardedTemporaryFilePaths);
  },

  resetForProject: (projectPath) => {
    const state = get();
    if (
      state.tabs.some(
        (tab) => tab.isStreaming || (tab.cancelledAttempts?.length ?? 0) > 0,
      )
    ) {
      return "blocked-stopping";
    }
    const tabsAlreadyScoped =
      state.activeProjectPath === projectPath &&
      state.tabs.every((tab) => tab.projectPath === projectPath);
    if (tabsAlreadyScoped) return "unchanged";
    const discardedTemporaryFilePaths = state.tabs.flatMap((tab) =>
      temporaryFilesOwnedByTab(tab),
    );

    const persisted = projectPath
      ? readPersistedChatForProject(projectPath)
      : null;
    const restoredTabs = (persisted?.tabs ?? []).filter(
      (tab) => tab.projectPath === projectPath,
    ) as TabState[];
    const restoredActiveTabId = restoredTabs.find(
      (tab) => tab.id === persisted?.activeTabId,
    )?.id;
    const fallbackTab = makeDefaultTab(nextTabId(), projectPath);
    const tabs = (restoredTabs.length > 0 ? restoredTabs : [fallbackTab]).map(
      (restoredTab) => {
        const previousAttemptEpoch =
          state.tabs.find((candidate) => candidate.id === restoredTab.id)
            ?.attemptEpoch ?? 0;
        return {
          ...restoredTab,
          streamingStatus: null,
          attemptEpoch:
            Math.max(previousAttemptEpoch, restoredTab.attemptEpoch ?? 0) + 1,
          activeAttemptId: null,
          preflightAttemptEpoch: null,
          resumeRequestId: null,
          cancelledAttempts: [],
        };
      },
    );
    const tab =
      tabs.find((candidate) => candidate.id === restoredActiveTabId) ?? tabs[0];
    reseedTabCounter(tabs);
    const nextSelectedProviderCredentialId =
      selectedCredentialForProviderKey(tab.providerKey) ??
      CLAUDE_CODE_PROVIDER_ID;
    persistSelectedProviderCredentialId(nextSelectedProviderCredentialId);

    set({
      tabs,
      activeTabId: tab.id,
      activeProjectPath: projectPath,
      messages: tab.messages,
      sessionId: tab.sessionId,
      isStreaming: tab.isStreaming,
      streamingStartedAt: tab.streamingStartedAt,
      error: tab.error,
      totalInputTokens: tab.totalInputTokens,
      totalOutputTokens: tab.totalOutputTokens,
      pendingAttachments: [],
      pendingPinnedContextRemovalLabels: [],
      selectedProviderCredentialId: nextSelectedProviderCredentialId,
    });
    cleanupDiscardedTemporaryFiles(discardedTemporaryFilePaths);
    return "reset";
  },

  newSession: () => {
    log.info("Starting new session");
    const { activeTabId, tabs } = get();
    const activeTab = tabs.find((t) => t.id === activeTabId);
    const projectPath =
      get().activeProjectPath ??
      useDocumentStore.getState().projectRoot ??
      null;
    if (
      activeTab &&
      (activeTab.isStreaming || (activeTab.cancelledAttempts?.length ?? 0) > 0)
    ) {
      const id = nextTabId();
      const newTab = {
        ...makeDefaultTab(id, projectPath),
        runtime: activeTab.runtime,
        chatPeer: chatPeerForTab(activeTab),
        runtimeModel: activeTab.runtimeModel,
        reasoningEffort: activeTab.reasoningEffort,
        agentId: activeTab.agentId,
        providerKey: activeTab.providerKey,
      };
      set({
        tabs: [...tabs, newTab],
        activeTabId: id,
        activeProjectPath: projectPath,
        messages: newTab.messages,
        sessionId: newTab.sessionId,
        isStreaming: newTab.isStreaming,
        streamingStartedAt: newTab.streamingStartedAt,
        error: newTab.error,
        totalInputTokens: newTab.totalInputTokens,
        totalOutputTokens: newTab.totalOutputTokens,
        selectedProviderCredentialId: selectedCredentialForProviderKey(
          newTab.providerKey,
        ),
      });
      return;
    }

    const discardedTemporaryFilePaths = temporaryFilesOwnedByTab(activeTab);
    set((s) => ({
      ...applyTabUpdate(s, activeTabId, {
        messages: [],
        sessionId: null,
        projectPath,
        providerKey:
          activeTab?.providerKey ??
          providerKeyForSelectedCredential(s.selectedProviderCredentialId),
        sessionProviderKey: null,
        error: null,
        isStreaming: false,
        streamingStartedAt: null,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        title: "New Chat",
        queuedGuidance: [],
        forceQueuedGuidanceOnComplete: false,
        forcedQueuedGuidanceId: null,
        pendingTemporaryFilePaths: [],
        attemptEpoch: (activeTab?.attemptEpoch ?? 0) + 1,
        activeAttemptId: null,
        preflightAttemptEpoch: null,
        resumeRequestId: null,
      }),
      activeProjectPath: projectPath,
    }));
    cleanupDiscardedTemporaryFiles(discardedTemporaryFilePaths);
  },

  changeTabRuntime: (tabId, nextPeer, options) => {
    const state = get();
    const tab = state.tabs.find((candidate) => candidate.id === tabId);
    if (!tab) return "not-found";
    if (chatPeerForTab(tab) === nextPeer) return "unchanged";
    if (tab.isStreaming) return "blocked-streaming";
    if ((tab.cancelledAttempts?.length ?? 0) > 0) return "blocked-stopping";
    const hasConversationState =
      tab.sessionRef !== null ||
      tab.sessionId !== null ||
      tab.messages.length > 0;
    if (hasConversationState && !options?.confirmSessionReset) {
      return "confirmation-required";
    }
    const nextRuntime = wireRuntimeFromPeer(nextPeer);
    const discardedTemporaryFilePaths = temporaryFilesOwnedByTab(tab);
    // Keep an API connection selected when entering the API peer so users can
    // switch Claude ↔ API without re-picking a credential every time.
    const nextProviderKey =
      nextPeer === "api" &&
      tab.providerKey &&
      tab.providerKey !== CLAUDE_CODE_PROVIDER_ID
        ? tab.providerKey
        : null;

    set((current) => ({
      ...applyTabUpdate(current, tabId, {
        chatPeer: nextPeer,
        runtime: nextRuntime,
        providerKey: nextProviderKey,
        sessionRef: null,
        sessionId: null,
        runtimeModel: null,
        reasoningEffort: null,
        agentId: null,
        sessionProviderKey: null,
        messages: [],
        isStreaming: false,
        streamingStartedAt: null,
        error: null,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        title: "New Chat",
        queuedGuidance: [],
        forceQueuedGuidanceOnComplete: false,
        forcedQueuedGuidanceId: null,
        pendingTemporaryFilePaths: [],
        attemptEpoch: (tab.attemptEpoch ?? 0) + 1,
        activeAttemptId: null,
        preflightAttemptEpoch: null,
        resumeRequestId: null,
      }),
    }));
    cleanupDiscardedTemporaryFiles(discardedTemporaryFilePaths);
    return "changed";
  },

  updateTabRuntimeSelection: (tabId, selection) => {
    let result: UpdateTabRuntimeSelectionResult = "not-found";
    set((state) => {
      const tab = state.tabs.find((candidate) => candidate.id === tabId);
      if (!tab) return state;
      if (tab.isStreaming) {
        result = "blocked-streaming";
        return state;
      }
      if ((tab.cancelledAttempts?.length ?? 0) > 0) {
        result = "blocked-stopping";
        return state;
      }
      if (
        tab.runtimeModel === selection.runtimeModel &&
        tab.reasoningEffort === selection.reasoningEffort &&
        tab.agentId === selection.agentId
      ) {
        result = "unchanged";
        return state;
      }

      result = "changed";
      return applyTabUpdate(state, tabId, selection);
    });
    return result;
  },

  resumeConversation: async (reference, title) => {
    log.info(`Resuming ${reference.runtime} session`, {
      session: reference.sessionId.slice(0, 8),
    });
    const sessionTitle = title?.trim() || undefined;
    const projectPath = useDocumentStore.getState().projectRoot;
    if (
      !projectPath ||
      projectPath !== reference.projectPath ||
      !reference.sessionId.trim()
    ) {
      return;
    }
    const state = get();
    let { activeTabId } = state;
    let { tabs } = state;
    const isBusy = (tab: TabState) =>
      tab.isStreaming || (tab.cancelledAttempts?.length ?? 0) > 0;
    const existingTab = tabs.find(
      (tab) =>
        tab.runtime === reference.runtime &&
        tab.projectPath === reference.projectPath &&
        tab.sessionId === reference.sessionId &&
        sameConversationReference(tab.sessionRef, reference),
    );

    if (existingTab) {
      activeTabId = existingTab.id;
      const nextSelectedProviderCredentialId =
        reference.runtime === "claude"
          ? (selectedCredentialForProviderKey(existingTab.providerKey) ??
            CLAUDE_CODE_PROVIDER_ID)
          : state.selectedProviderCredentialId;
      if (reference.runtime === "claude") {
        persistSelectedProviderCredentialId(nextSelectedProviderCredentialId);
      }
      set({
        activeTabId: existingTab.id,
        activeProjectPath: reference.projectPath,
        messages: existingTab.messages,
        sessionId: existingTab.sessionRef?.sessionId ?? null,
        isStreaming: existingTab.isStreaming,
        streamingStartedAt: existingTab.streamingStartedAt,
        error: existingTab.error,
        totalInputTokens: existingTab.totalInputTokens,
        totalOutputTokens: existingTab.totalOutputTokens,
        selectedProviderCredentialId: nextSelectedProviderCredentialId,
      });
      if (isBusy(existingTab)) return;
    } else {
      const activeTab = tabs.find((tab) => tab.id === activeTabId);
      if (activeTab && isBusy(activeTab)) {
        const id = nextTabId();
        const newTab = {
          ...makeDefaultTab(id, reference.projectPath),
          ...(activeTab.runtime === reference.runtime
            ? {
                runtime: activeTab.runtime,
                chatPeer: chatPeerForTab(activeTab),
                runtimeModel: activeTab.runtimeModel,
                reasoningEffort: activeTab.reasoningEffort,
                agentId: activeTab.agentId,
              }
            : {}),
          providerKey:
            activeTab.providerKey ??
            providerKeyForSelectedCredential(
              get().selectedProviderCredentialId,
            ),
        };
        tabs = [...tabs, newTab];
        activeTabId = id;
        set({
          tabs,
          activeTabId,
          activeProjectPath: reference.projectPath,
          messages: newTab.messages,
          sessionId: newTab.sessionId,
          isStreaming: newTab.isStreaming,
          streamingStartedAt: newTab.streamingStartedAt,
          error: newTab.error,
          totalInputTokens: newTab.totalInputTokens,
          totalOutputTokens: newTab.totalOutputTokens,
          selectedProviderCredentialId: selectedCredentialForProviderKey(
            newTab.providerKey,
          ),
        });
      }
    }

    const targetTab = get().tabs.find((tab) => tab.id === activeTabId);
    if (!targetTab || isBusy(targetTab)) return;
    const resumeRequestId = nextResumeRequestId(activeTabId);
    const discardedTemporaryFilePaths = temporaryFilesOwnedByTab(targetTab);
    const runtimeChanged = targetTab.runtime !== reference.runtime;

    set((s) => ({
      ...applyTabUpdate(s, activeTabId, {
        messages: [],
        projectPath: reference.projectPath,
        runtime: reference.runtime,
        chatPeer: peerFromTab({
          runtime: reference.runtime,
          providerKey: null,
        }),
        sessionRef: { ...reference },
        sessionId: reference.sessionId,
        ...(runtimeChanged
          ? {
              runtimeModel: null,
              reasoningEffort: null,
              agentId: null,
            }
          : {}),
        providerKey: null,
        sessionProviderKey: null,
        error: null,
        isStreaming: false,
        streamingStartedAt: null,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        title: sessionTitle ?? "New Chat",
        queuedGuidance: [],
        forceQueuedGuidanceOnComplete: false,
        forcedQueuedGuidanceId: null,
        pendingTemporaryFilePaths: [],
        attemptEpoch: (targetTab.attemptEpoch ?? 0) + 1,
        activeAttemptId: null,
        preflightAttemptEpoch: null,
        resumeRequestId,
      }),
      activeProjectPath: reference.projectPath,
    }));
    cleanupDiscardedTemporaryFiles(discardedTemporaryFilePaths);

    const ownsHistoryRequest = (current: ClaudeChatState) => {
      const tab = current.tabs.find(
        (candidate) => candidate.id === activeTabId,
      );
      return (
        useDocumentStore.getState().projectRoot === reference.projectPath &&
        current.activeProjectPath === reference.projectPath &&
        tab?.projectPath === reference.projectPath &&
        tab.runtime === reference.runtime &&
        tab.sessionId === reference.sessionId &&
        sameConversationReference(tab.sessionRef, reference) &&
        tab.resumeRequestId === resumeRequestId &&
        !tab.isStreaming &&
        (tab.cancelledAttempts?.length ?? 0) === 0 &&
        tab.activeAttemptId == null
      );
    };

    try {
      const history = await runtimeReadConversation(reference);
      if (!ownsHistoryRequest(get())) return;
      if (!sameConversationReference(history.reference, reference)) {
        set((s) =>
          ownsHistoryRequest(s)
            ? applyTabUpdate(s, activeTabId, { resumeRequestId: null })
            : {},
        );
        return;
      }

      const messages = conversationHistoryMessages(
        reference.runtime,
        history.items,
      );
      const titleMessages =
        reference.runtime === "claude"
          ? claudeHistoryMessages(history.items)
          : messages;
      const totals = usageTotalsForMessages(messages);
      const providerKey =
        reference.runtime === "claude"
          ? inferProviderKeyFromHistory(history.items)
          : null;
      let nextSelectedProviderCredentialId: string | null =
        CLAUDE_CODE_PROVIDER_ID;
      if (reference.runtime === "claude") {
        const selectedProviderCredentialId =
          providerCredentialIdFromSessionKey(providerKey);
        nextSelectedProviderCredentialId =
          selectedProviderCredentialId === undefined
            ? CLAUDE_CODE_PROVIDER_ID
            : selectedProviderCredentialId;
        if (get().activeTabId === activeTabId) {
          persistSelectedProviderCredentialId(nextSelectedProviderCredentialId);
        }
      }
      set((s) => {
        if (!ownsHistoryRequest(s)) return {};
        const runtimeUpdates: Partial<TabState> = (() => {
          if (reference.runtime !== "claude") return {};
          const resolvedProviderKey =
            providerKey ??
            providerKeyForSelectedCredential(nextSelectedProviderCredentialId);
          return {
            providerKey: resolvedProviderKey,
            sessionProviderKey: resolvedProviderKey,
            chatPeer: peerFromTab({
              runtime: "claude",
              providerKey: resolvedProviderKey,
            }),
          };
        })();
        const nextState = applyTabUpdate(s, activeTabId, {
          messages,
          ...runtimeUpdates,
          title: sessionTitle ?? titleForMessages(titleMessages) ?? "New Chat",
          totalInputTokens: totals.inputTokens,
          totalOutputTokens: totals.outputTokens,
          resumeRequestId: null,
        });
        return reference.runtime === "claude" && s.activeTabId === activeTabId
          ? {
              ...nextState,
              selectedProviderCredentialId: nextSelectedProviderCredentialId,
            }
          : nextState;
      });
    } catch (err) {
      log.error("Failed to load session history", { error: String(err) });
      set((s) =>
        ownsHistoryRequest(s)
          ? applyTabUpdate(s, activeTabId, { resumeRequestId: null })
          : {},
      );
    }
  },

  resumeSession: async (sessionId, title) => {
    const projectPath = useDocumentStore.getState().projectRoot;
    if (!projectPath) return;
    await get().resumeConversation(
      { runtime: "claude", sessionId, projectPath },
      title,
    );
  },

  // ─── Tab Actions ───

  createTab: () => {
    log.debug("Creating new tab");
    const id = nextTabId();
    const state = get();
    const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
    const projectPath =
      state.activeProjectPath ??
      useDocumentStore.getState().projectRoot ??
      null;
    const inheritedProviderKey = activeTab
      ? (activeTab.providerKey ??
        providerKeyForSelectedCredential(state.selectedProviderCredentialId))
      : providerKeyForSelectedCredential(state.selectedProviderCredentialId);
    const newTab = {
      ...makeDefaultTab(id, projectPath),
      ...(activeTab
        ? {
            runtime: activeTab.runtime,
            chatPeer: peerFromTab({
              runtime: activeTab.runtime,
              providerKey: inheritedProviderKey,
            }),
            runtimeModel: activeTab.runtimeModel,
            reasoningEffort: activeTab.reasoningEffort,
            agentId: activeTab.agentId,
            providerKey: inheritedProviderKey,
          }
        : {
            providerKey: inheritedProviderKey,
          }),
    };
    set((s) => ({
      tabs: [...s.tabs, newTab],
      activeTabId: id,
      activeProjectPath: projectPath,
      // Project new tab fields to top-level
      messages: newTab.messages,
      sessionId: newTab.sessionId,
      isStreaming: newTab.isStreaming,
      streamingStartedAt: newTab.streamingStartedAt,
      error: newTab.error,
      totalInputTokens: newTab.totalInputTokens,
      totalOutputTokens: newTab.totalOutputTokens,
      selectedProviderCredentialId: selectedCredentialForProviderKey(
        newTab.providerKey,
      ),
    }));
    return id;
  },

  closeTab: (tabId: string) => {
    const state = get();
    const tab = state.tabs.find((t) => t.id === tabId);
    // Prevent closing a streaming or stopping tab.
    if (tab?.isStreaming || (tab?.cancelledAttempts?.length ?? 0) > 0) return;
    // Prevent closing the last tab
    if (state.tabs.length <= 1) return;

    const idx = state.tabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return;
    const discardedTemporaryFilePaths = temporaryFilesOwnedByTab(tab);

    const newTabs = state.tabs.filter((t) => t.id !== tabId);

    if (tabId === state.activeTabId) {
      // Switch to adjacent tab
      const newIdx = Math.min(idx, newTabs.length - 1);
      const newActive = newTabs[newIdx];
      const nextSelectedProviderCredentialId =
        selectedCredentialForProviderKey(newActive.providerKey) ??
        CLAUDE_CODE_PROVIDER_ID;
      persistSelectedProviderCredentialId(nextSelectedProviderCredentialId);
      set({
        tabs: newTabs,
        activeTabId: newActive.id,
        activeProjectPath: newActive.projectPath,
        // Project new active tab
        messages: newActive.messages,
        sessionId: newActive.sessionId,
        isStreaming: newActive.isStreaming,
        streamingStartedAt: newActive.streamingStartedAt,
        error: newActive.error,
        totalInputTokens: newActive.totalInputTokens,
        totalOutputTokens: newActive.totalOutputTokens,
        selectedProviderCredentialId: nextSelectedProviderCredentialId,
      });
    } else {
      set({ tabs: newTabs });
    }
    cleanupDiscardedTemporaryFiles(discardedTemporaryFilePaths);
  },

  setActiveTab: (tabId: string) => {
    const state = get();
    if (tabId === state.activeTabId) return;
    const targetTab = state.tabs.find((t) => t.id === tabId);
    if (!targetTab) return;
    const nextSelectedProviderCredentialId =
      selectedCredentialForProviderKey(targetTab.providerKey) ??
      CLAUDE_CODE_PROVIDER_ID;
    persistSelectedProviderCredentialId(nextSelectedProviderCredentialId);

    // Project the target tab's fields to top-level
    set({
      activeTabId: tabId,
      activeProjectPath: targetTab.projectPath,
      messages: targetTab.messages,
      sessionId: targetTab.sessionId,
      isStreaming: targetTab.isStreaming,
      streamingStartedAt: targetTab.streamingStartedAt,
      error: targetTab.error,
      totalInputTokens: targetTab.totalInputTokens,
      totalOutputTokens: targetTab.totalOutputTokens,
      selectedProviderCredentialId: nextSelectedProviderCredentialId,
    });
  },

  saveDraft: (tabId: string, draft: TabDraft) => {
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, draft } : t)),
    }));
  },

  // ─── Internal Actions (routed by explicit tabId) ───

  _appendMessage: (tabId: string, msg: ClaudeStreamMessage) => {
    set((state) => {
      const { input_tokens: inputDelta, output_tokens: outputDelta } =
        usageFromMessage(msg);

      const tab = state.tabs.find((t) => t.id === tabId);
      if (!tab) return {};

      if (msg.type === "assistant" && msg.subtype === "streaming_delta") {
        const last = tab.messages[tab.messages.length - 1];
        if (last?.type === "assistant" && last.subtype === "streaming_delta") {
          const existing = last.message?.content ?? [];
          const incoming = msg.message?.content ?? [];
          if (incoming.length > 0) {
            const merged: ClaudeStreamMessage = {
              ...last,
              message: {
                ...last.message,
                content: mergeStreamingContent(existing, incoming),
              },
            };
            return applyTabUpdate(state, tabId, {
              messages: [...tab.messages.slice(0, -1), merged],
              totalInputTokens: tab.totalInputTokens + inputDelta,
              totalOutputTokens: tab.totalOutputTokens + outputDelta,
            });
          }
        }
      }

      if (msg.type === "assistant" && msg.subtype === "streaming_final") {
        const last = tab.messages[tab.messages.length - 1];
        if (last?.type === "assistant" && last.subtype === "streaming_delta") {
          const finalized: ClaudeStreamMessage = {
            ...msg,
            message: {
              ...msg.message,
              content: finalizeStreamingContent(
                last.message?.content ?? [],
                msg.message?.content ?? [],
              ),
            },
          };
          return applyTabUpdate(state, tabId, {
            messages: [...tab.messages.slice(0, -1), finalized],
            totalInputTokens: tab.totalInputTokens + inputDelta,
            totalOutputTokens: tab.totalOutputTokens + outputDelta,
          });
        }
      }

      return applyTabUpdate(state, tabId, {
        messages: [...tab.messages, msg],
        totalInputTokens: tab.totalInputTokens + inputDelta,
        totalOutputTokens: tab.totalOutputTokens + outputDelta,
      });
    });
  },

  _setSessionId: (tabId: string, id: string) => {
    set((state) => {
      const tab = state.tabs.find((candidate) => candidate.id === tabId);
      if (!tab?.projectPath) return {};
      return applyTabUpdate(state, tabId, {
        sessionId: id,
        sessionRef: {
          runtime: tab.runtime,
          sessionId: id,
          projectPath: tab.projectPath,
        },
      });
    });
  },

  _setSessionTitle: (sessionId: string, title: string) => {
    const cleanTitle = title.trim();
    if (!cleanTitle) return;
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.sessionId === sessionId &&
        tab.projectPath === state.activeProjectPath
          ? { ...tab, title: cleanTitle }
          : tab,
      ),
    }));
  },

  _setConversationTitle: (reference: ConversationRef, title: string) => {
    const cleanTitle = title.trim();
    if (!cleanTitle) return;
    set((state) => ({
      tabs: state.tabs.map((tab) => {
        const tabReference =
          tab.sessionRef ??
          (tab.sessionId && tab.projectPath
            ? {
                runtime: tab.runtime,
                sessionId: tab.sessionId,
                projectPath: tab.projectPath,
              }
            : null);
        return sameConversationReference(tabReference, reference)
          ? { ...tab, title: cleanTitle }
          : tab;
      }),
    }));
  },

  _setStreaming: (tabId: string, streaming: boolean) => {
    set((state) => {
      const tab = state.tabs.find((t) => t.id === tabId);
      return applyTabUpdate(state, tabId, {
        isStreaming: streaming,
        streamingStartedAt: streaming
          ? (tab?.streamingStartedAt ?? Date.now())
          : null,
        streamingStatus: streaming ? (tab?.streamingStatus ?? null) : null,
      });
    });
  },

  _setStreamingStatus: (tabId: string, status: string | null) => {
    set((state) => applyTabUpdate(state, tabId, { streamingStatus: status }));
  },

  _setError: (tabId: string, error: string | null) => {
    set((state) => applyTabUpdate(state, tabId, { error }));
  },

  _addUsage: (tabId: string, inputTokens: number, outputTokens: number) => {
    set((state) => {
      const tab = state.tabs.find((candidate) => candidate.id === tabId);
      if (!tab) return {};
      return applyTabUpdate(state, tabId, {
        totalInputTokens: tab.totalInputTokens + inputTokens,
        totalOutputTokens: tab.totalOutputTokens + outputTokens,
      });
    });
  },

  _consumeAttemptCancellation: (tabId: string, attemptId: string) => {
    let consumed: AttemptCancellation | null = null;
    set((state) => {
      const tab = state.tabs.find((candidate) => candidate.id === tabId);
      const cancellations = tab?.cancelledAttempts ?? [];
      const next = cancellations.find(
        (candidate) => candidate.attemptId === attemptId,
      );
      if (!next) return {};
      consumed = next;
      return applyTabUpdate(state, tabId, {
        cancelledAttempts: cancellations.filter(
          (candidate) => candidate.attemptId !== attemptId,
        ),
      });
    });
    pendingRuntimeStarts.delete(attemptId);
    return consumed;
  },

  _cleanupTemporaryFilePaths: (paths: string[]) => {
    cleanupDiscardedTemporaryFiles(paths);
  },
}));

useClaudeChatStore.subscribe((state, previousState) => {
  const projectPath = state.activeProjectPath;
  if (projectPath === null) return;
  const tabs = state.tabs.filter((tab) => tab.projectPath === projectPath);
  if (tabs.length === 0) return;
  const projected = projectPersistedChat({
    activeTabId: state.activeTabId,
    tabs,
  });
  const previousTabs = previousState.tabs.filter(
    (tab) => tab.projectPath === projectPath,
  );
  if (previousTabs.length > 0) {
    const previousProjected = projectPersistedChat({
      activeTabId: previousState.activeTabId,
      tabs: previousTabs,
    });
    if (JSON.stringify(projected) === JSON.stringify(previousProjected)) return;
  }
  writePersistedChatForProject(projectPath, projected);
});
