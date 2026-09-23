import type {
  ChatRuntimePeer,
  ConversationRef,
  RuntimeKind,
} from "@/runtime/types";
import { peerFromTab } from "@/runtime/types";

export const CHAT_TABS_STORAGE_KEY = "claude-prism.chat-tabs.v2";

function canonicalProjectPath(projectPath: string): string {
  const withForwardSlashes = projectPath.trim().replace(/\\/g, "/");
  if (withForwardSlashes === "/") return "/";

  if (withForwardSlashes.startsWith("//")) {
    const uncPath = `//${withForwardSlashes
      .slice(2)
      .replace(/\/+/g, "/")
      .replace(/\/+$/, "")}`;
    return uncPath.toLowerCase();
  }

  const collapsed = withForwardSlashes.replace(/\/+/g, "/");
  if (/^[a-zA-Z]:\/$/.test(collapsed)) {
    return collapsed.toLowerCase();
  }
  const normalized = collapsed.replace(/\/+$/, "");
  return /^[a-zA-Z]:\//.test(normalized)
    ? normalized.toLowerCase()
    : normalized;
}

export function sameProjectPath(left: string | null, right: string): boolean {
  return (
    left != null && canonicalProjectPath(left) === canonicalProjectPath(right)
  );
}

export function tabsForProject<T extends { projectPath: string | null }>(
  tabs: readonly T[],
  projectPath: string | null,
): T[] {
  if (!projectPath) {
    return tabs.filter((tab) => tab.projectPath == null);
  }
  return tabs.filter((tab) => sameProjectPath(tab.projectPath, projectPath));
}

export function projectChatStorageKey(projectPath: string): string {
  return `${CHAT_TABS_STORAGE_KEY}:project:${encodeURIComponent(
    canonicalProjectPath(projectPath),
  )}`;
}

export interface PersistedChatTab {
  id: string;
  title: string;
  projectPath: string | null;
  runtime: RuntimeKind;
  chatPeer: ChatRuntimePeer;
  sessionRef: ConversationRef | null;
  providerKey: string | null;
  sessionProviderKey: string | null;
  runtimeModel: string | null;
  reasoningEffort: string | null;
  agentId: string | null;
}

export interface PersistedChatDocument {
  version: 2;
  activeTabId: string;
  tabs: PersistedChatTab[];
}

export interface HydratedChatTab extends PersistedChatTab {
  /** Compatibility projection. `sessionRef` remains authoritative for v2. */
  sessionId: string | null;
  messages: [];
  isStreaming: false;
  streamingStartedAt: null;
  error: null;
  totalInputTokens: 0;
  totalOutputTokens: 0;
  draft: { input: ""; pinnedContexts: [] };
  queuedGuidance: [];
  forceQueuedGuidanceOnComplete: false;
  forcedQueuedGuidanceId: null;
  pendingTemporaryFilePaths: [];
  activeAttemptId: null;
  resumeRequestId: null;
}

export interface HydratedChatDocument {
  version: 2;
  activeTabId: string;
  tabs: HydratedChatTab[];
}

type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "setItem">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function runtimeKind(value: unknown): RuntimeKind {
  return value === "codex" ? "codex" : "claude";
}

function chatPeerKind(
  value: unknown,
  runtime: RuntimeKind,
  providerKey: string | null,
): ChatRuntimePeer {
  if (value === "claude" || value === "api" || value === "codex") {
    return value;
  }
  return peerFromTab({ runtime, providerKey });
}

function idleTab(tab: PersistedChatTab, legacySessionId?: string | null) {
  return {
    ...tab,
    sessionId: tab.sessionRef?.sessionId ?? legacySessionId ?? null,
    messages: [] as [],
    isStreaming: false as const,
    streamingStartedAt: null,
    error: null,
    totalInputTokens: 0 as const,
    totalOutputTokens: 0 as const,
    draft: { input: "" as const, pinnedContexts: [] as [] },
    queuedGuidance: [] as [],
    forceQueuedGuidanceOnComplete: false as const,
    forcedQueuedGuidanceId: null,
    pendingTemporaryFilePaths: [] as [],
    activeAttemptId: null,
    resumeRequestId: null,
  } satisfies HydratedChatTab;
}

function defaultDocument(): HydratedChatDocument {
  const tab = idleTab({
    id: "tab-1",
    title: "New Chat",
    projectPath: null,
    runtime: "claude",
    chatPeer: "claude",
    sessionRef: null,
    providerKey: null,
    sessionProviderKey: null,
    runtimeModel: null,
    reasoningEffort: null,
    agentId: null,
  });
  return { version: 2, activeTabId: tab.id, tabs: [tab] };
}

function validatedSessionRef(
  value: unknown,
  runtime: RuntimeKind,
  projectPath: string | null,
): ConversationRef | null {
  if (!isRecord(value) || !projectPath) return null;
  const sessionId = nullableString(value.sessionId);
  const refProjectPath = nullableString(value.projectPath);
  if (
    value.runtime !== runtime ||
    !sessionId ||
    refProjectPath !== projectPath
  ) {
    return null;
  }
  return { runtime, sessionId, projectPath };
}

function uniqueTabId(value: unknown, usedIds: Set<string>): string {
  const candidate = nullableString(value);
  if (candidate && !usedIds.has(candidate)) {
    usedIds.add(candidate);
    return candidate;
  }

  let index = 1;
  let generated = `tab-${index}`;
  while (usedIds.has(generated)) {
    generated = `tab-${++index}`;
  }
  usedIds.add(generated);
  return generated;
}

function migrateV2Tab(
  value: unknown,
  usedIds: Set<string>,
): HydratedChatTab | null {
  if (!isRecord(value)) return null;
  const runtime = runtimeKind(value.runtime);
  const projectPath = nullableString(value.projectPath);
  const sessionRef = validatedSessionRef(
    value.sessionRef,
    runtime,
    projectPath,
  );
  const providerKey = nullableString(value.providerKey);
  return idleTab({
    id: uniqueTabId(value.id, usedIds),
    title: nullableString(value.title) ?? "New Chat",
    projectPath,
    runtime,
    chatPeer: chatPeerKind(value.chatPeer, runtime, providerKey),
    sessionRef,
    providerKey,
    sessionProviderKey: nullableString(value.sessionProviderKey),
    runtimeModel: nullableString(value.runtimeModel),
    reasoningEffort: nullableString(value.reasoningEffort),
    agentId: nullableString(value.agentId),
  });
}

function migrateV1Tab(
  value: unknown,
  usedIds: Set<string>,
): HydratedChatTab | null {
  if (!isRecord(value)) return null;
  const projectPath = nullableString(value.projectPath);
  const sessionId = nullableString(value.sessionId);
  const sessionRef =
    projectPath && sessionId
      ? { runtime: "claude" as const, sessionId, projectPath }
      : null;
  const providerKey = nullableString(value.providerKey);
  return idleTab(
    {
      id: uniqueTabId(value.id, usedIds),
      title: nullableString(value.title) ?? "New Chat",
      projectPath,
      runtime: "claude",
      chatPeer: peerFromTab({ runtime: "claude", providerKey }),
      sessionRef,
      providerKey,
      sessionProviderKey: nullableString(value.sessionProviderKey),
      runtimeModel: null,
      reasoningEffort: null,
      agentId: null,
    },
    sessionId,
  );
}

/** Safely normalizes persisted v1/v2 data into idle, hydration-ready tabs. */
export function migratePersistedChat(input: unknown): HydratedChatDocument {
  if (!isRecord(input) || (input.version !== 1 && input.version !== 2)) {
    return defaultDocument();
  }
  if (!Array.isArray(input.tabs)) return defaultDocument();

  const usedIds = new Set<string>();
  const tabs = input.tabs.flatMap((value) => {
    const tab =
      input.version === 1
        ? migrateV1Tab(value, usedIds)
        : migrateV2Tab(value, usedIds);
    return tab ? [tab] : [];
  });
  if (tabs.length === 0) return defaultDocument();

  const requestedActiveTabId = nullableString(input.activeTabId);
  const activeTabId = tabs.some((tab) => tab.id === requestedActiveTabId)
    ? (requestedActiveTabId as string)
    : tabs[0].id;
  return { version: 2, activeTabId, tabs };
}

export interface PersistableSessionRefLike {
  runtime?: unknown;
  sessionId?: unknown;
  projectPath?: unknown;
}

export interface PersistableTabLike {
  id: string;
  title: string;
  projectPath: string | null;
  runtime?: unknown;
  chatPeer?: unknown;
  sessionRef?: PersistableSessionRefLike | null;
  providerKey?: string | null;
  sessionProviderKey?: string | null;
  runtimeModel?: string | null;
  reasoningEffort?: string | null;
  agentId?: string | null;
}

function sameSessionRef(
  left: PersistableSessionRefLike | null | undefined,
  right: PersistableSessionRefLike | null | undefined,
): boolean {
  if (left == null || right == null) return left == null && right == null;
  return (
    left.runtime === right.runtime &&
    left.sessionId === right.sessionId &&
    left.projectPath === right.projectPath
  );
}

/** Field-level persist equality — avoids JSON.stringify on every chat tick. */
export function samePersistableTab(
  left: PersistableTabLike,
  right: PersistableTabLike,
): boolean {
  const leftRuntime = runtimeKind(left.runtime);
  const rightRuntime = runtimeKind(right.runtime);
  const leftProvider = nullableString(left.providerKey);
  const rightProvider = nullableString(right.providerKey);
  return (
    left.id === right.id &&
    left.title === right.title &&
    nullableString(left.projectPath) === nullableString(right.projectPath) &&
    leftRuntime === rightRuntime &&
    chatPeerKind(left.chatPeer, leftRuntime, leftProvider) ===
      chatPeerKind(right.chatPeer, rightRuntime, rightProvider) &&
    leftProvider === rightProvider &&
    nullableString(left.sessionProviderKey) ===
      nullableString(right.sessionProviderKey) &&
    nullableString(left.runtimeModel) === nullableString(right.runtimeModel) &&
    nullableString(left.reasoningEffort) ===
      nullableString(right.reasoningEffort) &&
    nullableString(left.agentId) === nullableString(right.agentId) &&
    sameSessionRef(left.sessionRef, right.sessionRef)
  );
}

export function samePersistableTabs(
  left: readonly PersistableTabLike[],
  right: readonly PersistableTabLike[],
): boolean {
  return (
    left.length === right.length &&
    left.every((tab, index) => samePersistableTab(tab, right[index]))
  );
}

/** Projects live chat state through an explicit persistence whitelist. */
export function projectPersistedChat(input: unknown): PersistedChatDocument {
  const state = isRecord(input) ? input : {};
  const normalized = migratePersistedChat({
    version: 2,
    activeTabId: state.activeTabId,
    tabs: state.tabs,
  });
  return {
    version: 2,
    activeTabId: normalized.activeTabId,
    tabs: normalized.tabs.map((tab) => ({
      id: tab.id,
      title: tab.title,
      projectPath: tab.projectPath,
      runtime: tab.runtime,
      chatPeer: tab.chatPeer,
      sessionRef: tab.sessionRef,
      providerKey: tab.providerKey,
      sessionProviderKey: tab.sessionProviderKey,
      runtimeModel: tab.runtimeModel,
      reasoningEffort: tab.reasoningEffort,
      agentId: tab.agentId,
    })),
  };
}

function browserStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readPersistedChat(
  storage: StorageReader | null = browserStorage(),
): HydratedChatDocument {
  try {
    const raw = storage?.getItem(CHAT_TABS_STORAGE_KEY);
    return migratePersistedChat(raw ? JSON.parse(raw) : null);
  } catch {
    return defaultDocument();
  }
}

function hydratedDocumentForProject(
  document: HydratedChatDocument,
  projectPath: string,
): HydratedChatDocument {
  const tabs = document.tabs
    .filter((tab) => sameProjectPath(tab.projectPath, projectPath))
    .map((tab) => {
      const sessionRef = tab.sessionRef
        ? { ...tab.sessionRef, projectPath }
        : null;
      return {
        ...tab,
        projectPath,
        sessionRef,
        sessionId: sessionRef?.sessionId ?? null,
      };
    });
  if (tabs.length === 0) return defaultDocument();
  const activeTabId = tabs.some((tab) => tab.id === document.activeTabId)
    ? document.activeTabId
    : tabs[0].id;
  return { version: 2, activeTabId, tabs };
}

/** Reads one project's isolated document, falling back to the legacy global key. */
export function readPersistedChatForProject(
  projectPath: string,
  storage: StorageReader | null = browserStorage(),
): HydratedChatDocument {
  try {
    const projectRaw = storage?.getItem(projectChatStorageKey(projectPath));
    if (projectRaw) {
      return hydratedDocumentForProject(
        migratePersistedChat(JSON.parse(projectRaw)),
        projectPath,
      );
    }
  } catch {
    return defaultDocument();
  }
  return hydratedDocumentForProject(readPersistedChat(storage), projectPath);
}

export function writePersistedChat(
  input: unknown,
  storage: StorageWriter | null = browserStorage(),
): void {
  try {
    storage?.setItem(
      CHAT_TABS_STORAGE_KEY,
      JSON.stringify(projectPersistedChat(input)),
    );
  } catch {
    // Persistence must never disrupt the live chat UI.
  }
}

/** Writes only the named project's strict-whitelist document. */
export function writePersistedChatForProject(
  projectPath: string,
  input: unknown,
  storage: StorageWriter | null = browserStorage(),
): void {
  try {
    const projected = projectPersistedChat(input);
    const tabs = projected.tabs.filter((tab) =>
      sameProjectPath(tab.projectPath, projectPath),
    );
    if (tabs.length === 0) return;
    const activeTabId = tabs.some((tab) => tab.id === projected.activeTabId)
      ? projected.activeTabId
      : tabs[0].id;
    storage?.setItem(
      projectChatStorageKey(projectPath),
      JSON.stringify({ version: 2, activeTabId, tabs }),
    );
  } catch {
    // Persistence must never disrupt the live chat UI.
  }
}
