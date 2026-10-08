import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { BookOpenIcon, PlusIcon, XIcon } from "lucide-react";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { chatTabStripPlan } from "@/lib/chat-tab-strip";
import { cn } from "@/lib/utils";
import {
  pendingApprovalTabKey,
  useApprovalStore,
} from "@/stores/approval-store";
import {
  displayedChatTabTitle,
  useClaudeChatStore,
} from "@/stores/claude-chat-store";
import { LATEX_LEARN_PURPOSE } from "@/lib/latex-learn-tab";
import { tabsForProject } from "@/stores/chat-persistence";
import { tabOpenedUnderOtherAccount } from "@/lib/provider-account";
import { useI18n } from "@/lib/use-i18n";
import { SessionSelector } from "./session-selector";
import { WorkspaceAccountButton } from "./workspace-account-button";

export type AccountHeaderChrome = {
  utilities: boolean;
  hideLabel: boolean;
  density: "full" | "provider";
  accountMin: string;
};

/**
 * Wide bars keep new-tab, history, and the account chip as a tight group on
 * the right. Tabs take the leftover width and scroll. The chip stays as wide
 * as its label and ellipsizes only when the bar cannot fit that label.
 * Mid bars drop those icons so the label can show `SiliconFlow · Qw…`.
 * Very narrow bars keep the provider name only.
 */
export function accountHeaderChrome(widthPx: number): AccountHeaderChrome {
  if (!Number.isFinite(widthPx) || widthPx <= 0 || widthPx >= 420) {
    return {
      utilities: true,
      hideLabel: false,
      density: "full",
      accountMin: "min-w-[4.5rem]",
    };
  }
  if (widthPx >= 200) {
    return {
      utilities: false,
      hideLabel: false,
      density: "full",
      accountMin: "min-w-[10rem]",
    };
  }
  return {
    utilities: false,
    hideLabel: true,
    density: "provider",
    accountMin: "min-w-0",
  };
}

type TabBarItem = {
  id: string;
  title: string;
  purpose: "latex-learn" | null;
  isStreaming: boolean;
  isLoadingHistory: boolean;
  isStopping: boolean;
  closableWhileBusy: boolean;
};

function sameTabBarItems(left: TabBarItem[], right: TabBarItem[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (item, index) =>
        item.id === right[index].id &&
        item.title === right[index].title &&
        item.purpose === right[index].purpose &&
        item.isStreaming === right[index].isStreaming &&
        item.isLoadingHistory === right[index].isLoadingHistory &&
        item.isStopping === right[index].isStopping &&
        item.closableWhileBusy === right[index].closableWhileBusy,
    )
  );
}

export function ChatTabBar({ leading }: { leading?: ReactNode }) {
  const { t } = useI18n();
  const tabs = useStoreWithEqualityFn(
    useClaudeChatStore,
    (s) =>
      tabsForProject(s.tabs, s.activeProjectPath).map((tab) => ({
        id: tab.id,
        title: displayedChatTabTitle(tab.title, tab.messages),
        purpose:
          tab.purpose === LATEX_LEARN_PURPOSE ? LATEX_LEARN_PURPOSE : null,
        isStreaming: tab.isStreaming,
        isLoadingHistory: Boolean(tab.resumeRequestId),
        isStopping: (tab.cancelledAttempts?.length ?? 0) > 0,
        closableWhileBusy: tabOpenedUnderOtherAccount(tab, s),
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
  const barRef = useRef<HTMLDivElement>(null);
  const [barWidth, setBarWidth] = useState(0);
  const chrome = accountHeaderChrome(barWidth);
  const learnTabs = tabs.filter((tab) => tab.purpose === LATEX_LEARN_PURPOSE);
  const writingTabs = tabs.filter((tab) => tab.purpose !== LATEX_LEARN_PURPOSE);
  const strip = chatTabStripPlan({
    barWidthPx: barWidth,
    writingTabCount: writingTabs.length,
    hasLearnTab: learnTabs.length > 0,
    chrome,
  });

  useLayoutEffect(() => {
    const node = barRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const update = () => setBarWidth(node.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

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
      const currentTabs = tabsForProject(state.tabs, state.activeProjectPath);
      const currentActive = state.activeTabId;
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
    <div
      ref={barRef}
      data-testid="chat-tab-bar"
      className="flex min-w-0 flex-col overflow-hidden border-border/70 border-b bg-background"
    >
      {/* Caption buttons occupy this band. The row below spans the panel. */}
      <div
        data-testid="chat-titlebar-band"
        aria-hidden="true"
        className="h-[var(--titlebar-height)] shrink-0"
      />
      <div
        data-testid="chat-tab-toolbar"
        className="flex h-11 min-w-0 items-center overflow-hidden"
      >
        <div
          className={cn(
            "shrink-0",
            (chrome.hideLabel || strip.hideLeadingLabel) && "[&_span]:sr-only",
          )}
        >
          {leading}
        </div>
        {/* Horizontal tab scroll only. overflow-x:auto would otherwise
            compute overflow-y to auto and paint a second scrollbar in the bar.
            The learning tab sits outside this scroller so activating it cannot
            scroll the writing chat out of sight. */}
        <div
          ref={scrollRef}
          data-testid="chat-tab-scroller"
          className="scrollbar-none flex min-w-[4.5rem] flex-1 items-center self-stretch overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          style={{ minWidth: strip.writingScrollerMinPx }}
        >
          {writingTabs.map((tab) => (
            <TabButton
              key={tab.id}
              tabId={tab.id}
              title={tab.title || t("chat.newChat")}
              isActive={tab.id === activeTabId}
              isStreaming={tab.isStreaming}
              isLoadingHistory={tab.isLoadingHistory}
              isStopping={tab.isStopping}
              closableWhileBusy={tab.closableWhileBusy}
              hasPendingApproval={pendingTabIds.has(tab.id)}
              minWidth={strip.writingTabMinPx}
              maxWidth={strip.writingTabMaxPx}
              onClick={() => setActiveTab(tab.id)}
              onClose={(e) => handleClose(e, tab.id)}
            />
          ))}
        </div>
        {learnTabs.length > 0 ? (
          <div
            data-testid="chat-tab-learn-slot"
            className="flex shrink-0 items-center self-stretch"
          >
            {learnTabs.map((tab) => (
              <TabButton
                key={tab.id}
                tabId={tab.id}
                title={t("teach.sessionTitle")}
                learn
                isActive={tab.id === activeTabId}
                isStreaming={tab.isStreaming}
                isLoadingHistory={tab.isLoadingHistory}
                isStopping={tab.isStopping}
                closableWhileBusy={tab.closableWhileBusy}
                hasPendingApproval={pendingTabIds.has(tab.id)}
                minWidth={strip.learnSlotPx}
                onClick={() => setActiveTab(tab.id)}
                onClose={(e) => handleClose(e, tab.id)}
              />
            ))}
          </div>
        ) : null}
        <div
          data-testid="chat-account-cluster"
          className={cn(
            "flex w-max min-w-0 max-w-full shrink grow-0 items-center gap-1 overflow-hidden pr-2.5",
            chrome.accountMin,
          )}
          style={{ minWidth: strip.accountMinPx }}
        >
          {chrome.utilities ? (
            <button
              type="button"
              onClick={handleCreate}
              className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              aria-label={t("chat.newTab")}
            >
              <PlusIcon className="size-3.5" />
            </button>
          ) : null}
          {chrome.utilities ? <SessionSelector /> : null}
          <div
            data-testid="chat-account-chip"
            className="min-w-0 max-w-full shrink overflow-hidden"
          >
            <WorkspaceAccountButton density={strip.accountDensity} />
          </div>
        </div>
      </div>
    </div>
  );
}

function TabButton({
  tabId,
  title,
  learn = false,
  isActive,
  isStreaming,
  isLoadingHistory,
  isStopping,
  closableWhileBusy,
  hasPendingApproval,
  minWidth = 0,
  maxWidth,
  onClick,
  onClose,
}: {
  tabId: string;
  title: string;
  learn?: boolean;
  isActive: boolean;
  isStreaming: boolean;
  isLoadingHistory: boolean;
  isStopping: boolean;
  closableWhileBusy: boolean;
  hasPendingApproval: boolean;
  minWidth?: number;
  maxWidth?: number;
  onClick: () => void;
  onClose: (e: React.MouseEvent) => void;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      data-tab-id={tabId}
      data-learn-tab={learn ? "true" : undefined}
      title={title}
      aria-label={
        hasPendingApproval ? t("chat.needsApproval", { title }) : title
      }
      aria-busy={isLoadingHistory || undefined}
      onClick={onClick}
      style={{
        ...(minWidth > 0 ? { minWidth } : {}),
        ...(maxWidth ? { maxWidth } : {}),
      }}
      className={cn(
        "group relative flex h-full shrink-0 items-center gap-1.5 overflow-hidden border-b-2 px-3.5 text-xs transition-colors",
        learn ? "whitespace-nowrap" : "max-w-full",
        isActive
          ? "border-primary/80 bg-muted/40 text-foreground"
          : "border-transparent text-muted-foreground hover:bg-muted/25 hover:text-foreground",
      )}
    >
      {learn ? (
        <BookOpenIcon
          data-testid="chat-tab-learn-icon"
          className="size-3.5 shrink-0 text-muted-foreground"
        />
      ) : null}
      {(isStreaming || hasPendingApproval || isLoadingHistory) && (
        <span
          className="relative flex size-2 shrink-0"
          data-testid={
            hasPendingApproval
              ? "tab-approval-indicator"
              : isStreaming
                ? "tab-streaming-indicator"
                : "tab-history-indicator"
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
      <span
        data-testid="chat-tab-title"
        className={learn ? "shrink-0" : "min-w-0 truncate"}
      >
        {title}
      </span>
      {/* Close stays available for a session opened under another account.
          It overlays the label so a short title is not ellipsized to make
          room for a control that is hidden until hover. */}
      {(closableWhileBusy || (!isStreaming && !isStopping)) && (
        <span
          role="button"
          tabIndex={-1}
          aria-label={t("chat.closeTab")}
          onClick={onClose}
          className="absolute top-1/2 right-1 shrink-0 -translate-y-1/2 rounded-sm bg-background/80 p-0.5 opacity-0 transition-opacity hover:bg-muted-foreground/20 group-hover:opacity-100"
        >
          <XIcon className="size-3" />
        </span>
      )}
    </button>
  );
}
