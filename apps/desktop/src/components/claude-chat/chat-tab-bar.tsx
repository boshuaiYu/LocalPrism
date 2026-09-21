import { useCallback, useMemo, useRef, useEffect, type ReactNode } from "react";
import { PlusIcon, XIcon } from "lucide-react";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { cn } from "@/lib/utils";
import {
  pendingApprovalTabKey,
  useApprovalStore,
} from "@/stores/approval-store";
import { useClaudeChatStore } from "@/stores/claude-chat-store";
import { SessionSelector } from "./session-selector";
import { WorkspaceAccountButton } from "./workspace-account-button";

type TabBarItem = {
  id: string;
  title: string;
  isStreaming: boolean;
  isStopping: boolean;
};

function sameTabBarItems(left: TabBarItem[], right: TabBarItem[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (item, index) =>
        item.id === right[index].id &&
        item.title === right[index].title &&
        item.isStreaming === right[index].isStreaming &&
        item.isStopping === right[index].isStopping,
    )
  );
}

export function ChatTabBar({ leading }: { leading?: ReactNode }) {
  const tabs = useStoreWithEqualityFn(
    useClaudeChatStore,
    (s) =>
      s.tabs.map((tab) => ({
        id: tab.id,
        title: tab.title,
        isStreaming: tab.isStreaming,
        isStopping: (tab.cancelledAttempts?.length ?? 0) > 0,
      })),
    sameTabBarItems,
  );
  const activeTabId = useClaudeChatStore((s) => s.activeTabId);
  const setActiveTab = useClaudeChatStore((s) => s.setActiveTab);
  const createTab = useClaudeChatStore((s) => s.createTab);
  const closeTab = useClaudeChatStore((s) => s.closeTab);
  const pendingTabKey = useApprovalStore((s) =>
    pendingApprovalTabKey(s.pending),
  );
  const pendingTabIds = useMemo(
    () => new Set(pendingTabKey.split("\0").filter(Boolean)),
    [pendingTabKey],
  );
  const scrollRef = useRef<HTMLDivElement>(null);

  // Scroll active tab into view when it changes
  useEffect(() => {
    const el = scrollRef.current?.querySelector(
      `[data-tab-id="${activeTabId}"]`,
    );
    el?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
      inline: "nearest",
    });
  }, [activeTabId]);

  // Keyboard shortcuts: Ctrl+Tab / Ctrl+Shift+Tab to switch tabs, Ctrl+T new, Ctrl+W close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isMac = navigator.platform.startsWith("Mac");
      const state = useClaudeChatStore.getState();
      const { tabs: currentTabs, activeTabId: currentActive } = state;
      if (currentTabs.length === 0) return;

      // Ctrl+Tab / Ctrl+Shift+Tab — tab switching (all platforms)
      if (e.ctrlKey && e.key === "Tab") {
        e.preventDefault();
        const idx = currentTabs.findIndex((t) => t.id === currentActive);
        if (e.shiftKey) {
          const prev = (idx - 1 + currentTabs.length) % currentTabs.length;
          state.setActiveTab(currentTabs[prev].id);
        } else {
          const next = (idx + 1) % currentTabs.length;
          state.setActiveTab(currentTabs[next].id);
        }
        return;
      }

      // Cmd+T / Ctrl+T — new tab
      const modKey = isMac ? e.metaKey : e.ctrlKey;
      if (modKey && e.key === "t" && !e.shiftKey) {
        e.preventDefault();
        state.createTab();
        return;
      }

      // Cmd+W / Ctrl+W — close tab
      if (modKey && e.key === "w" && !e.shiftKey) {
        e.preventDefault();
        state.closeTab(currentActive);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleCreate = useCallback(() => {
    createTab();
  }, [createTab]);

  const handleClose = useCallback(
    (e: React.MouseEvent, tabId: string) => {
      e.stopPropagation();
      closeTab(tabId);
    },
    [closeTab],
  );

  return (
    <div className="flex h-11 items-center border-border/70 border-b bg-background">
      {leading}
      <div
        ref={scrollRef}
        className="scrollbar-none flex min-w-0 flex-1 items-center self-stretch overflow-x-auto"
      >
        {tabs.map((tab) => (
          <TabButton
            key={tab.id}
            tabId={tab.id}
            title={tab.title}
            isActive={tab.id === activeTabId}
            isStreaming={tab.isStreaming}
            isStopping={tab.isStopping}
            hasPendingApproval={pendingTabIds.has(tab.id)}
            onClick={() => setActiveTab(tab.id)}
            onClose={(e) => handleClose(e, tab.id)}
          />
        ))}
      </div>
      <div className="flex shrink-0 items-center gap-1 pr-2.5">
        <button
          type="button"
          onClick={handleCreate}
          className="flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label="New tab"
        >
          <PlusIcon className="size-3.5" />
        </button>
        <SessionSelector />
        <WorkspaceAccountButton />
      </div>
    </div>
  );
}

function TabButton({
  tabId,
  title,
  isActive,
  isStreaming,
  isStopping,
  hasPendingApproval,
  onClick,
  onClose,
}: {
  tabId: string;
  title: string;
  isActive: boolean;
  isStreaming: boolean;
  isStopping: boolean;
  hasPendingApproval: boolean;
  onClick: () => void;
  onClose: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      data-tab-id={tabId}
      aria-label={hasPendingApproval ? `${title} (needs approval)` : title}
      onClick={onClick}
      className={cn(
        "group relative flex h-full min-w-0 max-w-[11rem] items-center gap-1.5 border-b-2 px-3.5 text-xs transition-colors",
        isActive
          ? "border-primary/80 bg-muted/40 text-foreground"
          : "border-transparent text-muted-foreground hover:bg-muted/25 hover:text-foreground",
      )}
    >
      {(isStreaming || hasPendingApproval) && (
        <span
          className="relative flex size-2 shrink-0"
          data-testid={
            hasPendingApproval
              ? "tab-approval-indicator"
              : "tab-streaming-indicator"
          }
        >
          <span
            className={cn(
              "absolute inline-flex size-full animate-ping rounded-full",
              hasPendingApproval ? "bg-amber-500/70" : "bg-primary/60",
            )}
          />
          <span
            className={cn(
              "relative inline-flex size-2 rounded-full",
              hasPendingApproval ? "bg-amber-500" : "bg-primary",
            )}
          />
        </span>
      )}
      <span className="truncate">{title}</span>
      {/* Close button — hidden while this tab is streaming or stopping */}
      {!isStreaming && !isStopping && (
        <span
          role="button"
          tabIndex={-1}
          aria-label="Close tab"
          onClick={onClose}
          className="ml-auto shrink-0 rounded-sm p-0.5 opacity-0 transition-opacity hover:bg-muted-foreground/20 group-hover:opacity-100"
        >
          <XIcon className="size-3" />
        </span>
      )}
    </button>
  );
}
