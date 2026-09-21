import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckIcon,
  HistoryIcon,
  Loader2Icon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { createLogger } from "@/lib/debug/logger";
import {
  runtimeArchiveConversation,
  runtimeListConversations,
} from "@/runtime/commands";
import type { ConversationRef, RuntimeConversation } from "@/runtime/types";
import { type TabState, useClaudeChatStore } from "@/stores/claude-chat-store";

const log = createLogger("session-selector");
const IDLE_TABS: TabState[] = [];

const GENERIC_TITLES = new Set([
  "",
  "new chat",
  "untitled",
  "untitled session",
  "untitled chat",
]);

type RecencyGroup = "today" | "yesterday" | "week" | "older";

const RECENCY_LABELS: Record<RecencyGroup, string> = {
  today: "Today",
  yesterday: "Yesterday",
  week: "Previous 7 days",
  older: "Older",
};

function startOfLocalDay(ms: number): number {
  const date = new Date(ms);
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
}

export function formatRelativeTime(
  unixSeconds: number,
  nowMs = Date.now(),
): string {
  const delta = Math.max(0, nowMs / 1000 - unixSeconds);

  if (delta < 60) return "Just now";
  if (delta < 3600) {
    const minutes = Math.floor(delta / 60);
    return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  }
  if (delta < 86400) {
    const hours = Math.floor(delta / 3600);
    return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  }

  const dayDiff = Math.round(
    (startOfLocalDay(nowMs) - startOfLocalDay(unixSeconds * 1000)) / 86_400_000,
  );
  if (dayDiff === 1) return "Yesterday";
  if (dayDiff < 7) return `${dayDiff} days ago`;

  const date = new Date(unixSeconds * 1000);
  const sameYear = date.getFullYear() === new Date(nowMs).getFullYear();
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

export function recencyGroup(
  unixSeconds: number,
  nowMs = Date.now(),
): RecencyGroup {
  const dayDiff = Math.round(
    (startOfLocalDay(nowMs) - startOfLocalDay(unixSeconds * 1000)) / 86_400_000,
  );
  if (dayDiff <= 0) return "today";
  if (dayDiff === 1) return "yesterday";
  if (dayDiff < 7) return "week";
  return "older";
}

function isGenericConversationTitle(title: string | null | undefined): boolean {
  const trimmed = title?.trim() ?? "";
  if (GENERIC_TITLES.has(trimmed.toLowerCase())) return true;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    trimmed,
  );
}

function firstUserLineFromMessages(
  messages: TabState["messages"] | undefined,
): string | null {
  if (!messages?.length) return null;
  for (const message of messages) {
    if (message.type !== "user") continue;
    const raw = message.message?.content;
    const text = Array.isArray(raw)
      ? raw
          .filter((block) => block.type === "text" && block.text)
          .map((block) => block.text)
          .join("\n")
      : "";
    const line = text
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .find(
        (entry) =>
          entry &&
          !entry.startsWith("@") &&
          !entry.startsWith("~@") &&
          !entry.startsWith("[Currently open file"),
      );
    if (!line) continue;
    return line.length > 80 ? `${line.slice(0, 77).trimEnd()}...` : line;
  }
  return null;
}

export function displayConversationTitle(
  conversation: Pick<RuntimeConversation, "title" | "reference">,
  tabs: readonly TabState[],
): string {
  if (!isGenericConversationTitle(conversation.title)) {
    return conversation.title.trim();
  }
  const matchingTab = tabs.find((tab) =>
    sameConversation(tabConversationReference(tab), conversation.reference),
  );
  return firstUserLineFromMessages(matchingTab?.messages) ?? "Untitled chat";
}

function conversationKey(reference: ConversationRef): string {
  return JSON.stringify([
    reference.runtime,
    reference.projectPath,
    reference.sessionId,
  ]);
}

function sameConversation(
  left: ConversationRef | null | undefined,
  right: ConversationRef | null | undefined,
): boolean {
  return !!left && !!right && conversationKey(left) === conversationKey(right);
}

function tabConversationReference(tab: TabState | undefined) {
  if (!tab) return null;
  if (tab.sessionRef) return tab.sessionRef;
  if (!tab.sessionId || !tab.projectPath) return null;
  return {
    runtime: tab.runtime,
    projectPath: tab.projectPath,
    sessionId: tab.sessionId,
  } satisfies ConversationRef;
}

function activeContext() {
  const state = useClaudeChatStore.getState();
  const tab = state.tabs.find(
    (candidate) => candidate.id === state.activeTabId,
  );
  return tab?.projectPath ? { projectPath: tab.projectPath } : null;
}

function contextMatches(projectPath: string): boolean {
  return activeContext()?.projectPath === projectPath;
}

function localProjectConversations(projectPath: string): RuntimeConversation[] {
  return useClaudeChatStore.getState().tabs.flatMap((tab) => {
    const reference = tabConversationReference(tab);
    if (!reference || reference.projectPath !== projectPath) return [];
    return [
      {
        reference,
        title: tab.title || "Untitled chat",
        status: "active" as const,
        updatedAt: Math.floor(Date.now() / 1000),
      },
    ];
  });
}

function mergeConversations(
  lists: readonly RuntimeConversation[][],
): RuntimeConversation[] {
  const seen = new Set<string>();
  const merged: RuntimeConversation[] = [];
  for (const list of lists) {
    for (const conversation of list) {
      const key = conversationKey(conversation.reference);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(conversation);
    }
  }
  return merged;
}

export function SessionSelector() {
  const [conversations, setConversations] = useState<RuntimeConversation[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [deletingReference, setDeletingReference] =
    useState<ConversationRef | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RuntimeConversation | null>(
    null,
  );
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const needsLiveTabs = menuOpen || deleteTarget != null;
  const projectPath = useClaudeChatStore(
    (state) =>
      state.tabs.find((tab) => tab.id === state.activeTabId)?.projectPath ??
      null,
  );
  const tabs = useClaudeChatStore((state) =>
    needsLiveTabs ? state.tabs : IDLE_TABS,
  );
  const activeTab = useClaudeChatStore((state) =>
    needsLiveTabs
      ? state.tabs.find((tab) => tab.id === state.activeTabId)
      : undefined,
  );
  const currentReference = tabConversationReference(activeTab);
  const newSession = useClaudeChatStore((state) => state.newSession);
  const resumeConversation = useClaudeChatStore(
    (state) => state.resumeConversation,
  );
  const setConversationTitle = useClaudeChatStore(
    (state) => state._setConversationTitle,
  );

  const contextRef = useRef<{ projectPath: string } | null>(
    projectPath ? { projectPath } : null,
  );
  const listRequestRef = useRef(0);
  const deleteRequestRef = useRef(0);
  const archivedReferencesRef = useRef(new Set<string>());
  contextRef.current = projectPath ? { projectPath } : null;

  const deletingKey = deletingReference
    ? conversationKey(deletingReference)
    : null;
  const busyConversationKeys = useMemo(() => {
    const result = new Set<string>();
    for (const tab of tabs) {
      if (!tab.isStreaming && (tab.cancelledAttempts?.length ?? 0) === 0) {
        continue;
      }
      const reference = tabConversationReference(tab);
      if (reference) result.add(conversationKey(reference));
    }
    return result;
  }, [tabs]);

  useEffect(() => {
    listRequestRef.current += 1;
    deleteRequestRef.current += 1;
    setConversations([]);
    setIsLoading(false);
    setDeletingReference(null);
    setDeleteTarget(null);
    setDeleteError(null);
    setSearchQuery("");
  }, [projectPath]);

  const loadConversations = useCallback(async () => {
    if (!projectPath) return;
    const requestProjectPath = projectPath;
    const requestId = ++listRequestRef.current;
    const stillOwnsRequest = () => {
      const context = contextRef.current;
      return (
        listRequestRef.current === requestId &&
        context?.projectPath === requestProjectPath &&
        contextMatches(requestProjectPath)
      );
    };

    setIsLoading(true);
    try {
      const [claudeList, codexList] = await Promise.all([
        runtimeListConversations("claude", requestProjectPath).catch(() => []),
        runtimeListConversations("codex", requestProjectPath).catch(() => []),
      ]);
      if (!stillOwnsRequest()) return;
      const filtered = mergeConversations([
        claudeList,
        codexList,
        localProjectConversations(requestProjectPath),
      ]).filter(
        (conversation) =>
          conversation.reference.projectPath === requestProjectPath &&
          !archivedReferencesRef.current.has(
            conversationKey(conversation.reference),
          ),
      );
      setConversations(filtered);
      for (const conversation of filtered) {
        setConversationTitle(conversation.reference, conversation.title);
      }
    } catch (error) {
      if (!stillOwnsRequest()) return;
      log.error("Failed to load conversations", { error: String(error) });
      setConversations([]);
    } finally {
      if (stillOwnsRequest()) setIsLoading(false);
    }
  }, [projectPath, setConversationTitle]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      setMenuOpen(open);
      setSearchQuery("");
      if (open) void loadConversations();
    },
    [loadConversations],
  );

  useEffect(() => {
    if (!menuOpen) return;
    const frame = window.requestAnimationFrame(() => {
      searchRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [menuOpen]);

  const visibleConversations = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const decorated = conversations.map((conversation) => ({
      conversation,
      title: displayConversationTitle(conversation, tabs),
    }));
    if (!query) return decorated;
    return decorated.filter(
      ({ conversation, title }) =>
        title.toLowerCase().includes(query) ||
        conversation.title.toLowerCase().includes(query),
    );
  }, [conversations, searchQuery, tabs]);

  const handleSelectConversation = useCallback(
    (conversation: RuntimeConversation) => {
      const reference = conversation.reference;
      const key = conversationKey(reference);
      if (deletingKey === key) return;
      if (!contextMatches(reference.projectPath)) return;
      const state = useClaudeChatStore.getState();
      const currentTab = state.tabs.find((tab) => tab.id === state.activeTabId);
      if (sameConversation(tabConversationReference(currentTab), reference)) {
        return;
      }
      void resumeConversation(reference, conversation.title);
    },
    [deletingKey, resumeConversation],
  );

  const handleArchiveConversation = useCallback(
    async (conversation: RuntimeConversation) => {
      const reference = conversation.reference;
      const key = conversationKey(reference);
      if (
        deletingReference ||
        busyConversationKeys.has(key) ||
        !contextMatches(reference.projectPath)
      ) {
        return;
      }

      const requestId = ++deleteRequestRef.current;
      const stillOwnsRequest = () => {
        const context = contextRef.current;
        return (
          deleteRequestRef.current === requestId &&
          context?.projectPath === reference.projectPath &&
          contextMatches(reference.projectPath)
        );
      };
      setDeleteError(null);
      setDeletingReference(reference);
      try {
        await runtimeArchiveConversation(reference);
        archivedReferencesRef.current.add(key);
        if (contextMatches(reference.projectPath)) {
          setConversations((current) =>
            current.filter(
              (candidate) => !sameConversation(candidate.reference, reference),
            ),
          );
        }
        if (!stillOwnsRequest()) return;
        listRequestRef.current += 1;
        setIsLoading(false);

        const state = useClaudeChatStore.getState();
        const currentTab = state.tabs.find(
          (tab) => tab.id === state.activeTabId,
        );
        if (
          contextMatches(reference.projectPath) &&
          sameConversation(tabConversationReference(currentTab), reference)
        ) {
          state.newSession();
        }
        setDeleteTarget((current) =>
          sameConversation(current?.reference, reference) ? null : current,
        );
      } catch (error) {
        if (!stillOwnsRequest()) return;
        log.error("Failed to archive conversation", {
          reference,
          error: String(error),
        });
        setDeleteError(error instanceof Error ? error.message : String(error));
      } finally {
        if (stillOwnsRequest()) {
          setDeletingReference((current) =>
            sameConversation(current, reference) ? null : current,
          );
        }
      }
    },
    [busyConversationKeys, deletingReference],
  );

  const targetIsCodex = deleteTarget?.reference.runtime === "codex";
  const targetKey = deleteTarget
    ? conversationKey(deleteTarget.reference)
    : null;
  const deleteDisplayTitle = deleteTarget
    ? displayConversationTitle(deleteTarget, tabs)
    : "this session";

  const renderConversation = (
    conversation: RuntimeConversation,
    title: string,
  ) => {
    const reference = conversation.reference;
    const key = conversationKey(reference);
    const isBusy = busyConversationKeys.has(key);
    const isDeleting = deletingKey === key;
    const isCurrent = sameConversation(currentReference, reference);
    const isCodex = reference.runtime === "codex";
    const action = isCodex ? "Archive" : "Delete";
    const actionLower = action.toLowerCase();
    return (
      <DropdownMenuItem
        key={key}
        onSelect={() => handleSelectConversation(conversation)}
        disabled={isDeleting}
        className="group flex min-h-12 items-start gap-2 px-2.5 py-2.5"
      >
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm leading-snug">{title}</span>
          {isCodex ? (
            <span className="text-muted-foreground text-xs">Read-only</span>
          ) : null}
          <span className="text-muted-foreground text-xs">
            {formatRelativeTime(conversation.updatedAt)}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {isBusy ? (
            <Loader2Icon className="size-4 animate-spin text-primary" />
          ) : (
            isCurrent && <CheckIcon className="size-4 text-primary" />
          )}
          <button
            type="button"
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
            aria-label={
              isBusy
                ? `Cannot ${actionLower} ${title} while it is running or stopping`
                : `${action} ${title}`
            }
            title={
              isBusy
                ? `Cannot ${actionLower} a session while it is running or stopping`
                : `${action} chat`
            }
            disabled={isBusy || isDeleting}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (!contextMatches(reference.projectPath)) {
                return;
              }
              setDeleteError(null);
              setDeleteTarget(conversation);
            }}
          >
            {isDeleting ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <Trash2Icon className="size-3.5" />
            )}
          </button>
        </div>
      </DropdownMenuItem>
    );
  };

  const renderGrouped = (
    items: { conversation: RuntimeConversation; title: string }[],
  ) => {
    const groups: { id: RecencyGroup; items: typeof items }[] = [
      { id: "today", items: [] },
      { id: "yesterday", items: [] },
      { id: "week", items: [] },
      { id: "older", items: [] },
    ];
    const sorted = [...items].sort(
      (left, right) =>
        right.conversation.updatedAt - left.conversation.updatedAt,
    );
    for (const item of sorted) {
      groups
        .find((group) => group.id === recencyGroup(item.conversation.updatedAt))
        ?.items.push(item);
    }
    return groups
      .filter((group) => group.items.length > 0)
      .map((group) => (
        <div key={group.id}>
          <DropdownMenuLabel className="px-2.5 py-1.5 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
            {RECENCY_LABELS[group.id]}
          </DropdownMenuLabel>
          {group.items.map(({ conversation, title }) =>
            renderConversation(conversation, title),
          )}
        </div>
      ));
  };

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={handleOpenChange}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Session history"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <HistoryIcon className="size-4" />
          </button>
        </DropdownMenuTrigger>

        <DropdownMenuContent
          align="end"
          side="bottom"
          className="flex w-96 flex-col overflow-hidden p-0"
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <div className="border-border/70 border-b p-2">
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                ref={searchRef}
                type="search"
                aria-label="Search chats"
                placeholder="Search chats"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                onPointerDown={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key !== "ArrowDown") return;
                  event.preventDefault();
                  const root = event.currentTarget.closest(
                    "[data-slot='dropdown-menu-content']",
                  );
                  const first = root?.querySelector<HTMLElement>(
                    '[role="menuitem"]:not([aria-disabled="true"])',
                  );
                  first?.focus();
                }}
                className="h-9 w-full rounded-md border border-border/70 bg-background pr-3 pl-8 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              />
            </div>
          </div>

          <div className="max-h-80 overflow-y-auto p-1">
            <DropdownMenuItem
              onSelect={newSession}
              className="min-h-10 gap-2 px-2.5"
            >
              <PlusIcon className="size-4" />
              <span>New Chat</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />

            {isLoading ? (
              <div className="flex items-center justify-center py-6">
                <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
              </div>
            ) : conversations.length === 0 ? (
              <div className="px-2 py-6 text-center text-muted-foreground text-sm">
                No previous sessions
              </div>
            ) : visibleConversations.length === 0 ? (
              <div className="px-2 py-6 text-center text-muted-foreground text-sm">
                No matching chats
              </div>
            ) : (
              (() => {
                const writable = visibleConversations.filter(
                  ({ conversation }) =>
                    conversation.reference.runtime !== "codex",
                );
                const readOnly = visibleConversations.filter(
                  ({ conversation }) =>
                    conversation.reference.runtime === "codex",
                );
                return (
                  <>
                    {renderGrouped(writable)}
                    {readOnly.length > 0 ? (
                      <>
                        {writable.length > 0 ? <DropdownMenuSeparator /> : null}
                        <DropdownMenuLabel className="px-2.5 py-1.5">
                          Read-only
                        </DropdownMenuLabel>
                        {renderGrouped(readOnly)}
                      </>
                    ) : null}
                  </>
                );
              })()
            )}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open && !deletingReference) {
            setDeleteTarget(null);
            setDeleteError(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {targetIsCodex ? "Archive Chat" : "Delete Chat"}
            </DialogTitle>
            <DialogDescription>
              {targetIsCodex ? (
                <>
                  Archive &quot;{deleteDisplayTitle}&quot;? The thread will be
                  archived. Codex rollout files are not deleted.
                </>
              ) : (
                <>
                  Permanently delete &quot;{deleteDisplayTitle}&quot; from this
                  project? This cannot be undone.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          {deleteError && (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-xs">
              {deleteError}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                if (deletingReference) return;
                setDeleteTarget(null);
                setDeleteError(null);
              }}
              disabled={!!deletingReference}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (deleteTarget) {
                  void handleArchiveConversation(deleteTarget);
                }
              }}
              disabled={
                !deleteTarget ||
                !!deletingReference ||
                (targetKey ? busyConversationKeys.has(targetKey) : false)
              }
            >
              {deletingReference ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : (
                <Trash2Icon className="size-3.5" />
              )}
              {targetIsCodex ? "Archive" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
