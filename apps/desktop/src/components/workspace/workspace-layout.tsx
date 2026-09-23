import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { SettingsIcon } from "lucide-react";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelHandle,
} from "react-resizable-panels";
import { Sidebar } from "./sidebar";
import { LatexEditor } from "./editor/latex-editor";
import { PdfPreview } from "./preview/pdf-preview";
import { ChatRestoreButton } from "@/components/claude-chat/chat-restore-button";
import { ClaudeChatDrawer } from "@/components/claude-chat/claude-chat-drawer";
import { ProductTour } from "@/components/product-tour";
import {
  AppStatusCluster,
  useAppVersion,
} from "@/components/app-status-cluster";
import { UpdatePrompt } from "@/components/update-prompt";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/use-i18n";
import { useRuntimeEvents } from "@/hooks/use-runtime-events";
import { useApprovalStore } from "@/stores/approval-store";
import { useDocumentStore } from "@/stores/document-store";
import { usePreviewStore } from "@/stores/preview-store";
import { useChatLayoutStore } from "@/stores/chat-layout-store";
import { useClaudeChatStore } from "@/stores/claude-chat-store";
import {
  paneIds,
  paneSizeMap,
  writePaneLayout,
  type PaneVisibility,
} from "@/lib/workspace-pane-layout";

const SIDEBAR_DEFAULT_SIZE = 15;
const SIDEBAR_MIN_SIZE = 10;
const SIDEBAR_COLLAPSED_WIDTH_PX = 48;
const SIDEBAR_COLLAPSED_SIZE_FALLBACK = 8;
const SIDEBAR_ANIMATION_MS = 280;

function easeInOutSmooth(progress: number) {
  return progress * progress * (3 - 2 * progress);
}

function WorkspaceResizeHandle({ testId }: { testId?: string }) {
  return (
    <PanelResizeHandle
      data-testid={testId}
      className="group relative w-2 shrink-0 bg-transparent outline-none focus-visible:bg-ring/20 data-resize-handle-active:bg-ring/15"
    >
      <span className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors group-hover:bg-ring group-focus-visible:bg-ring group-data-resize-handle-active:bg-ring" />
    </PanelResizeHandle>
  );
}

export function WorkspaceLayout() {
  const { t } = useI18n();
  const appVersion = useAppVersion();
  useRuntimeEvents();
  const initialized = useDocumentStore((s) => s.initialized);
  const previewVisible = usePreviewStore((s) => s.visible);
  const setPreviewVisible = usePreviewStore((s) => s.setVisible);
  const chatVisible = useChatLayoutStore((s) => s.visible);
  const setChatVisible = useChatLayoutStore((s) => s.setVisible);
  const revealChat = useChatLayoutStore((s) => s.reveal);
  const suppressAutoOpen = useChatLayoutStore((s) => s.suppressAutoOpen);
  const chatNeedsAttention = useClaudeChatStore(
    (s) =>
      s.tabs.some((tab) => tab.isStreaming) || s.pendingAttachments.length > 0,
  );
  const hasPendingApproval = useApprovalStore(
    (s) => Object.keys(s.pending).length > 0,
  );
  const workspaceRef = useRef<HTMLDivElement>(null);
  const sidebarPanelRef = useRef<ImperativePanelHandle>(null);
  const sidebarAnimationFrameRef = useRef<number | null>(null);
  const sidebarAnimatingRef = useRef(false);
  const expandedSidebarSizeRef = useRef(SIDEBAR_DEFAULT_SIZE);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarCollapsedSize, setSidebarCollapsedSize] = useState(
    SIDEBAR_COLLAPSED_SIZE_FALLBACK,
  );
  const [codeVisible, setCodeVisible] = useState(true);
  const paneVisibility: PaneVisibility = {
    code: codeVisible,
    chat: chatVisible,
    pdf: previewVisible,
  };
  const paneSizes = paneSizeMap(paneVisibility, localStorage);
  const persistLayout = useCallback(
    (sizes: number[]) => {
      const visibility = {
        code: codeVisible,
        chat: chatVisible,
        pdf: previewVisible,
      };
      if (sidebarAnimatingRef.current || sidebarCollapsed) return;
      if (sizes.length !== paneIds(visibility).length) return;
      writePaneLayout(visibility, sizes, localStorage);
    },
    [chatVisible, codeVisible, previewVisible, sidebarCollapsed],
  );

  const getCollapsedSidebarSize = useCallback(() => {
    const workspaceWidth =
      workspaceRef.current?.clientWidth ?? window.innerWidth;
    if (!workspaceWidth) return SIDEBAR_COLLAPSED_SIZE_FALLBACK;
    return Math.min(
      18,
      Math.max(2.5, (SIDEBAR_COLLAPSED_WIDTH_PX / workspaceWidth) * 100),
    );
  }, []);

  const animateSidebarToSize = useCallback((targetSize: number) => {
    const sidebarPanel = sidebarPanelRef.current;
    if (!sidebarPanel) return;

    if (sidebarAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(sidebarAnimationFrameRef.current);
    }

    const startSize = sidebarPanel.getSize();
    const sizeDelta = targetSize - startSize;
    const startedAt = performance.now();
    sidebarAnimatingRef.current = true;

    const step = (now: number) => {
      const progress = Math.min((now - startedAt) / SIDEBAR_ANIMATION_MS, 1);
      const nextSize = startSize + sizeDelta * easeInOutSmooth(progress);

      sidebarPanel.resize(nextSize);

      if (progress < 1) {
        sidebarAnimationFrameRef.current = window.requestAnimationFrame(step);
        return;
      }

      sidebarPanel.resize(targetSize);
      sidebarAnimationFrameRef.current = null;
      sidebarAnimatingRef.current = false;
    };

    sidebarAnimationFrameRef.current = window.requestAnimationFrame(step);
  }, []);

  const setSidebarPaneCollapsed = useCallback(
    (nextCollapsed: boolean) => {
      const sidebarPanel = sidebarPanelRef.current;
      if (!sidebarPanel) return;

      if (!nextCollapsed) {
        setSidebarCollapsed(false);
        animateSidebarToSize(expandedSidebarSizeRef.current);
      } else {
        const collapsedSize = getCollapsedSidebarSize();
        const currentSize = sidebarPanel.getSize();
        if (currentSize >= SIDEBAR_MIN_SIZE) {
          expandedSidebarSizeRef.current = currentSize;
        }
        setSidebarCollapsedSize(collapsedSize);
        setSidebarCollapsed(true);
        animateSidebarToSize(collapsedSize);
      }
    },
    [animateSidebarToSize, getCollapsedSidebarSize],
  );

  const toggleSidebarCollapsed = useCallback(() => {
    setSidebarPaneCollapsed(!sidebarCollapsed);
  }, [setSidebarPaneCollapsed, sidebarCollapsed]);

  const setCodePaneVisible = useCallback(
    (visible: boolean) => {
      if (!visible && !previewVisible) {
        setPreviewVisible(true);
      }
      setCodeVisible(visible);
    },
    [previewVisible, setPreviewVisible],
  );

  const setPdfPaneVisible = useCallback(
    (visible: boolean) => {
      if (!visible && !codeVisible) {
        setCodeVisible(true);
      }
      setPreviewVisible(visible);
    },
    [codeVisible, setPreviewVisible],
  );

  const setChatPaneVisible = useCallback(
    (visible: boolean) => {
      setChatVisible(visible);
    },
    [setChatVisible],
  );

  useEffect(() => {
    if (
      (chatNeedsAttention || hasPendingApproval) &&
      !chatVisible &&
      !suppressAutoOpen
    ) {
      revealChat();
    }
  }, [
    chatNeedsAttention,
    chatVisible,
    hasPendingApproval,
    revealChat,
    suppressAutoOpen,
  ]);

  // Cmd+\ / Ctrl+\ toggles the PDF preview pane.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        setPdfPaneVisible(!previewVisible);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [previewVisible, setPdfPaneVisible]);

  // Cmd+Shift+A / Ctrl+Shift+A toggles the chat pane.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.repeat || e.altKey) return;
      const target = e.target;
      const typingInField =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable);
      if (typingInField) return;
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        (e.code === "KeyA" || e.key.toLowerCase() === "a")
      ) {
        e.preventDefault();
        setChatPaneVisible(!chatVisible);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [chatVisible, setChatPaneVisible]);

  useEffect(() => {
    return () => {
      if (sidebarAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(sidebarAnimationFrameRef.current);
      }
    };
  }, []);

  useLayoutEffect(() => {
    const updateCollapsedSize = () => {
      const nextSize = getCollapsedSidebarSize();
      setSidebarCollapsedSize(nextSize);

      if (sidebarCollapsed && !sidebarAnimatingRef.current) {
        sidebarPanelRef.current?.resize(nextSize);
      }
    };

    updateCollapsedSize();

    const workspaceElement = workspaceRef.current;
    if (!workspaceElement) return;

    const resizeObserver = new ResizeObserver(updateCollapsedSize);
    resizeObserver.observe(workspaceElement);

    return () => resizeObserver.disconnect();
  }, [getCollapsedSidebarSize, sidebarCollapsed]);

  const chatRestoreButton = !chatVisible ? (
    <ChatRestoreButton
      attention={chatNeedsAttention || hasPendingApproval}
      onOpen={() => setChatPaneVisible(true)}
      className="absolute right-4 bottom-6 z-20"
    />
  ) : null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header
        data-testid="app-chrome-header"
        className="flex shrink-0 items-center justify-between gap-2 border-b px-3 pt-[var(--titlebar-height)] pb-1"
      >
        <AppStatusCluster version={appVersion} />
        <Button
          type="button"
          variant="ghost"
          className="h-8 gap-2 rounded-lg px-2 text-muted-foreground hover:text-foreground"
          onClick={() =>
            window.dispatchEvent(new CustomEvent("localprism-open-settings"))
          }
        >
          <SettingsIcon className="size-4" />
          {t("chrome.settings")}
        </Button>
      </header>
      <UpdatePrompt />
      <div
        ref={workspaceRef}
        className="relative min-h-0 flex-1"
        style={{ ["--titlebar-height" as string]: "0px" }}
      >
        {!initialized ? (
          <div className="flex h-full items-center justify-center">
            <div className="text-muted-foreground">Loading project...</div>
          </div>
        ) : (
          <>
            <PanelGroup
              direction="horizontal"
              className="h-full"
              onLayout={persistLayout}
            >
              <Panel
                id="sidebar"
                order={1}
                ref={sidebarPanelRef}
                defaultSize={paneSizes.sidebar}
                minSize={SIDEBAR_MIN_SIZE}
                maxSize={25}
                collapsible
                collapsedSize={sidebarCollapsedSize}
                onCollapse={() => setSidebarCollapsed(true)}
                onExpand={() => setSidebarCollapsed(false)}
                onResize={(size) => {
                  if (
                    !sidebarAnimatingRef.current &&
                    size >= SIDEBAR_MIN_SIZE
                  ) {
                    expandedSidebarSizeRef.current = size;
                  }
                }}
                className="min-w-0 overflow-hidden"
              >
                <Sidebar
                  collapsed={sidebarCollapsed}
                  onToggleCollapsed={toggleSidebarCollapsed}
                  layoutControls={{
                    codeVisible,
                    chatVisible,
                    pdfVisible: previewVisible,
                    sidebarVisible: !sidebarCollapsed,
                    setCodeVisible: setCodePaneVisible,
                    setChatVisible: setChatPaneVisible,
                    setPdfVisible: setPdfPaneVisible,
                    setSidebarVisible: (visible) =>
                      setSidebarPaneCollapsed(!visible),
                  }}
                />
              </Panel>

              <WorkspaceResizeHandle />

              {codeVisible && (
                <Panel
                  id="code"
                  order={2}
                  defaultSize={paneSizes.code}
                  minSize={22}
                  className="min-w-0"
                >
                  {chatVisible ? (
                    <LatexEditor />
                  ) : (
                    <div className="relative h-full min-w-0">
                      <LatexEditor />
                      {chatRestoreButton}
                    </div>
                  )}
                </Panel>
              )}

              {codeVisible && chatVisible && (
                <WorkspaceResizeHandle testId="resize-code-chat" />
              )}

              {codeVisible && !chatVisible && previewVisible && (
                <WorkspaceResizeHandle testId="resize-code-pdf" />
              )}

              {chatVisible && (
                <Panel
                  id="chat"
                  order={3}
                  defaultSize={paneSizes.chat}
                  minSize={18}
                  collapsible
                  collapsedSize={0}
                  onCollapse={() => setChatPaneVisible(false)}
                  className="min-w-0 overflow-hidden"
                >
                  <ClaudeChatDrawer />
                </Panel>
              )}

              {chatVisible && previewVisible && (
                <WorkspaceResizeHandle testId="resize-chat-pdf" />
              )}

              {previewVisible && (
                <Panel
                  id="pdf"
                  order={4}
                  defaultSize={paneSizes.pdf}
                  minSize={22}
                  className="min-w-0"
                >
                  {!chatVisible && !codeVisible ? (
                    <div
                      className="relative h-full min-w-0"
                      data-tour="tour-pdf"
                    >
                      <PdfPreview />
                      {chatRestoreButton}
                    </div>
                  ) : (
                    <div className="h-full min-w-0" data-tour="tour-pdf">
                      <PdfPreview />
                    </div>
                  )}
                </Panel>
              )}
            </PanelGroup>
            {!codeVisible && !previewVisible && chatRestoreButton}
            <ProductTour />
          </>
        )}
      </div>
    </div>
  );
}
