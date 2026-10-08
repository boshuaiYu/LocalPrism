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
import {
  CHAT_STRIP_FONT_STACK,
  chatTabStripPlan,
  measureChatStripCanvasPx,
  type ChatTabStripTextPx,
} from "@/lib/chat-tab-strip";
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
import { useProviderStore } from "@/stores/provider-store";
import { SessionSelector } from "./session-selector";
import {
  WorkspaceAccountButton,
  workspaceAccountChipText,
} from "./workspace-account-button";

export {
  accountHeaderChrome,
  type AccountHeaderChrome,
} from "@/lib/chat-tab-strip";

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
  const measureRef = useRef<HTMLDivElement>(null);
  const [barWidth, setBarWidth] = useState(0);
  const [textPx, setTextPx] = useState<ChatTabStripTextPx>({});
  const cards = useProviderStore((state) => state.cards);
  const activeAccount =
    cards.find((card) => card.isActive) ??
    cards.find((card) => card.authenticated);
  const signedIn = Boolean(activeAccount?.authenticated);
  const providerName = activeAccount?.name?.trim() ?? "";
  const accountLabel = activeAccount?.accountLabel?.trim() ?? "";
  const accountFull = signedIn
    ? workspaceAccountChipText(providerName, accountLabel, t("chat.signedIn"))
    : t("chat.signIn");
  const accountProvider = signedIn ? providerName || accountFull : accountFull;
  const learnLabel = t("teach.sessionTitle");
  const leadingLabel = t("chrome.hide");
  const learnTabs = tabs.filter((tab) => tab.purpose === LATEX_LEARN_PURPOSE);
  const writingTabs = tabs.filter((tab) => tab.purpose !== LATEX_LEARN_PURPOSE);
  const strip = chatTabStripPlan({
    barWidthPx: barWidth,
    writingTabCount: writingTabs.length,
    hasLearnTab: learnTabs.length > 0,
    labels: {
      learn: learnLabel,
      leading: leadingLabel,
      accountFull,
      accountProvider,
    },
    textPx,
  });

  useLayoutEffect(() => {
    const node = barRef.current;
    if (!node) return;
    const readBar = () => {
      const next = Math.round(
        node.clientWidth || node.getBoundingClientRect().width || 0,
      );
      setBarWidth((prev) => (prev === next ? prev : next));
    };
    const readText = () => {
      const root = measureRef.current;
      const next: ChatTabStripTextPx = {};
      const assign = (
        key: keyof ChatTabStripTextPx,
        label: string,
        rendered?: number,
      ) => {
        const canvas = measureChatStripCanvasPx(label);
        const width = Math.max(rendered ?? 0, canvas);
        if (width > 0) next[key] = width;
      };
      if (root) {
        for (const el of root.querySelectorAll<HTMLElement>(
          "[data-strip-measure]",
        )) {
          const key = el.dataset.stripMeasure;
          if (
            key === "learn" ||
            key === "leading" ||
            key === "accountFull" ||
            key === "accountProvider"
          ) {
            assign(key, el.textContent ?? "", el.scrollWidth);
          }
        }
      } else {
        assign("learn", learnLabel);
        assign("leading", leadingLabel);
        assign("accountFull", accountFull);
        assign("accountProvider", accountProvider);
      }
      setTextPx((prev) =>
        prev.learn === next.learn &&
        prev.leading === next.leading &&
        prev.accountFull === next.accountFull &&
        prev.accountProvider === next.accountProvider
          ? prev
          : next,
      );
    };
    readBar();
    readText();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      readBar();
      readText();
    });
    observer.observe(node);
    if (measureRef.current) observer.observe(measureRef.current);
    return () => observer.disconnect();
  }, [accountFull, accountProvider, learnLabel, leadingLabel]);

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
      className="relative flex min-w-0 flex-col overflow-hidden border-border/70 border-b bg-background"
    >
      <div
        ref={measureRef}
        data-testid="chat-tab-measure"
        aria-hidden="true"
        className="pointer-events-none absolute h-0 w-0 overflow-hidden whitespace-nowrap text-xs"
        style={{ fontFamily: CHAT_STRIP_FONT_STACK }}
      >
        <span data-strip-measure="learn">{learnLabel}</span>
        <span data-strip-measure="leading">{leadingLabel}</span>
        <span data-strip-measure="accountFull">{accountFull}</span>
        <span data-strip-measure="accountProvider">{accountProvider}</span>
      </div>
      {/* Caption buttons occupy this band. The row below spans the panel. */}
      <div
        data-testid="chat-titlebar-band"
        aria-hidden="true"
        className="h-[var(--titlebar-height)] shrink-0"
      />
      <div
        data-testid="chat-tab-toolbar"
        data-account-density={strip.accountDensity}
        className="flex h-11 min-w-0 items-center overflow-hidden text-xs"
        style={{ fontFamily: CHAT_STRIP_FONT_STACK }}
      >
        <div
          data-leading-label={strip.hideLeadingLabel ? "hidden" : "visible"}
          className="shrink-0"
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
          className="flex w-max shrink-0 grow-0 items-center gap-1 pr-2.5"
          style={{ minWidth: strip.accountMinPx }}
        >
          {strip.showUtilities ? (
            <button
              type="button"
              onClick={handleCreate}
              className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              aria-label={t("chat.newTab")}
            >
              <PlusIcon className="size-3.5" />
            </button>
          ) : null}
          {strip.showUtilities ? <SessionSelector /> : null}
          <div data-testid="chat-account-chip" className="shrink-0">
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
        learn ? "whitespace-nowrap" : "w-max max-w-full",
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
