import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckIcon,
  HistoryIcon,
  Loader2Icon,
  PlusIcon,
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
import type {
  ConversationRef,
  RuntimeConversation,
  RuntimeKind,
} from "@/runtime/types";
import { type TabState, useClaudeChatStore } from "@/stores/claude-chat-store";

const log = createLogger("session-selector");

function formatRelativeTime(unixSeconds: number): string {
  const now = Date.now() / 1000;
  const delta = now - unixSeconds;

  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  if (delta < 604800) return `${Math.floor(delta / 86400)}d ago`;

  const date = new Date(unixSeconds * 1000);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
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
  return tab?.projectPath
    ? { runtime: tab.runtime, projectPath: tab.projectPath }
    : null;
}

function contextMatches(runtime: RuntimeKind, projectPath: string): boolean {
  const current = activeContext();
  return current?.runtime === runtime && current.projectPath === projectPath;
}

export function SessionSelector() {
  const [conversations, setConversations] = useState<RuntimeConversation[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [deletingReference, setDeletingReference] =
    useState<ConversationRef | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RuntimeConversation | null>(
    null,
  );
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const activeTabId = useClaudeChatStore((state) => state.activeTabId);
  const tabs = useClaudeChatStore((state) => state.tabs);
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const runtime = activeTab?.runtime ?? null;
  const projectPath = activeTab?.projectPath ?? null;
  const currentReference = tabConversationReference(activeTab);
  const newSession = useClaudeChatStore((state) => state.newSession);
  const resumeConversation = useClaudeChatStore(
    (state) => state.resumeConversation,
  );
  const setConversationTitle = useClaudeChatStore(
    (state) => state._setConversationTitle,
  );

  const contextRef = useRef<{
    runtime: RuntimeKind;
    projectPath: string;
  } | null>(runtime && projectPath ? { runtime, projectPath } : null);
  const listRequestRef = useRef(0);
  const deleteRequestRef = useRef(0);
  const archivedReferencesRef = useRef(new Set<string>());
  contextRef.current = runtime && projectPath ? { runtime, projectPath } : null;

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
  }, [runtime, projectPath]);

  const loadConversations = useCallback(async () => {
    if (!runtime || !projectPath) return;
    const requestRuntime = runtime;
    const requestProjectPath = projectPath;
    const requestId = ++listRequestRef.current;
    const stillOwnsRequest = () => {
      const context = contextRef.current;
      return (
        listRequestRef.current === requestId &&
        context?.runtime === requestRuntime &&
        context.projectPath === requestProjectPath &&
        contextMatches(requestRuntime, requestProjectPath)
      );
    };

    setIsLoading(true);
    try {
      const result = await runtimeListConversations(
        requestRuntime,
        requestProjectPath,
      );
      if (!stillOwnsRequest()) return;
      const filtered = result.filter(
        (conversation) =>
          conversation.reference.runtime === requestRuntime &&
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
  }, [projectPath, runtime, setConversationTitle]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open) void loadConversations();
    },
    [loadConversations],
  );

  const handleSelectConversation = useCallback(
    (conversation: RuntimeConversation) => {
      const reference = conversation.reference;
      const key = conversationKey(reference);
      if (deletingKey === key) return;
      if (!contextMatches(reference.runtime, reference.projectPath)) return;
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
        !contextMatches(reference.runtime, reference.projectPath)
      ) {
        return;
      }

      const requestId = ++deleteRequestRef.current;
      const stillOwnsRequest = () => {
        const context = contextRef.current;
        return (
          deleteRequestRef.current === requestId &&
          context?.runtime === reference.runtime &&
          context.projectPath === reference.projectPath &&
          contextMatches(reference.runtime, reference.projectPath)
        );
      };
      setDeleteError(null);
      setDeletingReference(reference);
      try {
        await runtimeArchiveConversation(reference);
        archivedReferencesRef.current.add(key);
        if (contextMatches(reference.runtime, reference.projectPath)) {
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
          contextMatches(reference.runtime, reference.projectPath) &&
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

  return (
    <>
      <DropdownMenu onOpenChange={handleOpenChange}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
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
          className="max-h-80 w-72 overflow-y-auto"
        >
          <DropdownMenuLabel>Sessions</DropdownMenuLabel>
          <DropdownMenuItem onSelect={newSession}>
            <PlusIcon className="size-4" />
            <span>New Chat</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />

          {isLoading ? (
            <div className="flex items-center justify-center py-4">
              <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : conversations.length === 0 ? (
            <div className="px-2 py-4 text-center text-muted-foreground text-sm">
              No previous sessions
            </div>
          ) : (
            conversations.map((conversation) => {
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
                  className="group flex items-start gap-2"
                >
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm">
                      {conversation.title}
                    </span>
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
                      className="flex size-6 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
                      aria-label={
                        isBusy
                          ? `Cannot ${actionLower} ${conversation.title} while it is running or stopping`
                          : `${action} ${conversation.title}`
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
                        if (
                          !contextMatches(
                            reference.runtime,
                            reference.projectPath,
                          )
                        ) {
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
            })
          )}
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
                  Archive &quot;{deleteTarget?.title || "this session"}&quot;?
                  The thread will be archived. Codex rollout files are not
                  deleted.
                </>
              ) : (
                <>
                  Permanently delete &quot;
                  {deleteTarget?.title || "this session"}&quot; from this
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
