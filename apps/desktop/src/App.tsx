import { ThemeProvider, useTheme } from "next-themes";
import { ErrorBoundary } from "react-error-boundary";
import { Toaster } from "@/components/ui/sonner";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { useClaudeRuntimeSync } from "@/hooks/use-claude-runtime-sync";
import { useClaudeEvents } from "@/hooks/use-claude-events";
import { useRuntimeWarningEvents } from "@/hooks/use-runtime-warning-events";

import { useDocumentStore } from "@/stores/document-store";
import { useClaudeChatStore } from "@/stores/claude-chat-store";
import { ProjectPicker } from "@/components/project-picker";
import { WorkspaceLayout } from "@/components/workspace/workspace-layout";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useClaudeSetupStore } from "@/stores/claude-setup-store";
import { useAgentStore } from "@/stores/agent-store";
import { useSkillStore } from "@/stores/skill-store";
import { useUvSetupStore } from "@/stores/uv-setup-store";
import { ErrorFallback } from "@/components/error-fallback";
import { createLogger } from "@/lib/debug/logger";
import { EnvironmentOnboarding } from "@/components/environment-onboarding";
import { WelcomeWizard } from "@/components/welcome-wizard";
import { UpdatePrompt } from "@/components/update-prompt";
import { ProductTour } from "@/components/product-tour";
import {
  isWelcomeCompleted,
  markWelcomeCompleted,
  REOPEN_WELCOME_EVENT,
} from "@/lib/welcome";
import { runtimeListConversations } from "@/runtime/commands";

const log = createLogger("app");

const LazyDebugPage = lazy(() =>
  import("@/components/debug/debug-page").then((m) => ({
    default: m.DebugPage,
  })),
);

function NativeWindowThemeBridge() {
  const { resolvedTheme, theme } = useTheme();

  useEffect(() => {
    const syncNativeTheme = () => {
      const isDark =
        document.documentElement.classList.contains("dark") ||
        resolvedTheme === "dark";
      const nativeTheme = isDark ? "dark" : "light";

      document.documentElement.style.colorScheme = nativeTheme;
      invoke("set_native_window_theme", { theme: nativeTheme })
        .catch((err) => {
          log.warn("Failed to sync native window theme via Rust command", {
            error: String(err),
          });
          return getCurrentWindow().setTheme(nativeTheme);
        })
        .catch((err) => {
          log.warn("Failed to sync native window theme via JS API", {
            error: String(err),
          });
        });
    };

    syncNativeTheme();

    const observer = new MutationObserver(syncNativeTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    const systemThemeQuery = window.matchMedia("(prefers-color-scheme: dark)");
    systemThemeQuery.addEventListener("change", syncNativeTheme);

    return () => {
      observer.disconnect();
      systemThemeQuery.removeEventListener("change", syncNativeTheme);
    };
  }, [resolvedTheme, theme]);

  return null;
}

function WorkspaceWithClaude() {
  const projectRoot = useDocumentStore((s) => s.projectRoot);
  const initialized = useDocumentStore((s) => s.initialized);
  const chatScopeBlockerCount = useClaudeChatStore((s) =>
    s.tabs.reduce(
      (count, tab) =>
        count +
        (tab.isStreaming ? 1 : 0) +
        (tab.cancelledAttempts?.length ?? 0),
      0,
    ),
  );
  const autoResumedProjectRef = useRef<string | null>(null);
  const chatProjectRef = useRef<string | null>(null);
  const [chatScopeReadyProject, setChatScopeReadyProject] = useState<
    string | null
  >(null);

  // Update window title
  useEffect(() => {
    if (projectRoot) {
      const name = projectRoot.split(/[/\\]/).pop() || "LocalPrism";
      getCurrentWindow().setTitle(`${name} - LocalPrism`);
    }
  }, [projectRoot]);

  useEffect(() => {
    if (chatProjectRef.current === projectRoot) return;
    const result = useClaudeChatStore
      .getState()
      .resetForProject(projectRoot ?? null);
    if (result !== "blocked-stopping") {
      chatProjectRef.current = projectRoot;
      setChatScopeReadyProject(projectRoot);
    }
  }, [chatScopeBlockerCount, projectRoot]);

  // Auto-setup Python venv when project opens
  useEffect(() => {
    if (!initialized || !projectRoot) return;
    const uvStore = useUvSetupStore.getState();
    uvStore
      .checkStatus()
      .then(() => {
        const { status } = useUvSetupStore.getState();
        if (status === "ready") {
          return uvStore.setupVenv(projectRoot);
        }
      })
      .catch((err) => {
        log.error("Failed to setup Python venv", { error: String(err) });
      });
  }, [initialized, projectRoot]);

  // Open the most recent chat when entering a project.
  useEffect(() => {
    if (!projectRoot) {
      autoResumedProjectRef.current = null;
      return;
    }
    if (!initialized) return;
    if (chatScopeReadyProject !== projectRoot) return;
    if (autoResumedProjectRef.current === projectRoot) return;

    const capturedState = useClaudeChatStore.getState();
    const capturedTab = capturedState.tabs.find(
      (tab) => tab.id === capturedState.activeTabId,
    );
    const tabIsBusy = (tab: typeof capturedTab) =>
      !!tab && (tab.isStreaming || (tab.cancelledAttempts?.length ?? 0) > 0);
    if (
      capturedState.pendingInitialPrompt ||
      !capturedTab ||
      capturedTab.projectPath !== projectRoot ||
      tabIsBusy(capturedTab)
    ) {
      return;
    }

    const capturedTabId = capturedTab.id;
    const capturedRuntime = capturedTab.runtime;
    const capturedProjectPath = projectRoot;
    const capturedAttemptEpoch = capturedTab.attemptEpoch ?? 0;

    if (capturedRuntime === "codex") {
      autoResumedProjectRef.current = projectRoot;
      return;
    }

    autoResumedProjectRef.current = projectRoot;
    let cancelled = false;

    const capturedContextIsCurrent = () => {
      if (
        cancelled ||
        useDocumentStore.getState().projectRoot !== capturedProjectPath
      ) {
        return false;
      }

      const current = useClaudeChatStore.getState();
      const currentTab = current.tabs.find((tab) => tab.id === capturedTabId);
      return (
        !current.pendingInitialPrompt &&
        current.activeTabId === capturedTabId &&
        currentTab?.runtime === capturedRuntime &&
        currentTab.projectPath === capturedProjectPath &&
        (currentTab.attemptEpoch ?? 0) === capturedAttemptEpoch &&
        !tabIsBusy(currentTab)
      );
    };

    runtimeListConversations(capturedRuntime, capturedProjectPath)
      .then((conversations) => {
        if (!capturedContextIsCurrent()) return;
        const latest = conversations
          .filter(
            (conversation) =>
              conversation.reference.runtime === capturedRuntime &&
              conversation.reference.projectPath === capturedProjectPath,
          )
          .sort((a, b) => b.updatedAt - a.updatedAt)[0];
        const current = useClaudeChatStore.getState();

        const active = current.tabs.find((tab) => tab.id === capturedTabId);
        const hasLocalActivity =
          (active?.messages.length ?? 0) > 0 ||
          !!active?.isStreaming ||
          (active?.cancelledAttempts?.length ?? 0) > 0;

        if (!latest?.reference.sessionId) {
          // Empty remote history must not wipe an in-progress or local draft.
          // Only clear a stale idle session binding so the next send starts fresh.
          if (
            !hasLocalActivity &&
            (active?.sessionRef != null || active?.sessionId != null)
          ) {
            current.newSession();
          }
          return;
        }

        // Local drafts already on screen must not be replaced by auto-resume.
        // resumeConversation clears messages before history returns; an empty
        // or slow Codex history read would make the chat "disappear".
        if (hasLocalActivity) {
          return;
        }

        current
          .resumeConversation(latest.reference, latest.title)
          .catch((err) => {
            log.warn("Failed to auto-resume latest chat session", {
              sessionId: latest.reference.sessionId,
              error: String(err),
            });
          });
      })
      .catch((err) => {
        log.warn("Failed to auto-resume latest chat session", {
          error: String(err),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [chatScopeReadyProject, initialized, projectRoot]);

  // Consume pending initial prompt from project wizard
  useEffect(() => {
    if (!initialized) return;
    // Delay to let ClaudeChatDrawer mount and register event listeners
    const timer = setTimeout(() => {
      const prompt = useClaudeChatStore
        .getState()
        .consumePendingInitialPrompt();
      if (prompt) {
        useClaudeChatStore.getState().sendPrompt(prompt);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [initialized]);

  return <WorkspaceLayout />;
}

export function App({ onReady }: { onReady?: () => void }) {
  const projectRoot = useDocumentStore((s) => s.projectRoot);
  const [showDebug, setShowDebug] = useState(false);
  const [welcomeCompleted, setWelcomeCompleted] = useState(isWelcomeCompleted);
  const firstRunSessionRef = useRef(!welcomeCompleted);
  const showWelcome = !projectRoot && !welcomeCompleted;

  // Register global keyboard shortcuts (Cmd+S, Cmd+N) at the app level
  useKeyboardShortcuts();
  useClaudeEvents();
  useClaudeRuntimeSync();
  useRuntimeWarningEvents();

  useEffect(() => {
    const preventNativeContextMenu = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      event.preventDefault();
    };

    document.addEventListener("contextmenu", preventNativeContextMenu);
    return () => {
      document.removeEventListener("contextmenu", preventNativeContextMenu);
    };
  }, []);

  useEffect(() => {
    onReady?.();
  }, [onReady]);

  useEffect(() => {
    void useClaudeSetupStore.getState().ensureEngine();
    void useSkillStore.getState().ensureDefaultSkillPacks();
    void useAgentStore.getState().ensureBuiltinPresets();
  }, []);

  useEffect(() => {
    if (!projectRoot) {
      getCurrentWindow().setTitle("LocalPrism");
      return;
    }
    if (!isWelcomeCompleted()) {
      markWelcomeCompleted();
      setWelcomeCompleted(true);
    }
  }, [projectRoot]);

  // Listen for debug panel toggle (Ctrl+Shift+D)
  useEffect(() => {
    const handler = () => setShowDebug((prev) => !prev);
    window.addEventListener("toggle-debug-panel", handler);
    return () => window.removeEventListener("toggle-debug-panel", handler);
  }, []);

  useEffect(() => {
    const reopenWelcome = () => setWelcomeCompleted(false);
    window.addEventListener(REOPEN_WELCOME_EVENT, reopenWelcome);
    return () =>
      window.removeEventListener(REOPEN_WELCOME_EVENT, reopenWelcome);
  }, []);

  return (
    <ErrorBoundary FallbackComponent={ErrorFallback}>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
        <TooltipProvider>
          <NativeWindowThemeBridge />
          {/* Global macOS titlebar drag region — sits above all content */}
          <div
            data-tauri-drag-region
            className="fixed inset-x-0 top-0 z-[9999] h-[var(--titlebar-height)]"
          />
          {projectRoot ? (
            <WorkspaceWithClaude />
          ) : showWelcome ? (
            <WelcomeWizard onComplete={() => setWelcomeCompleted(true)} />
          ) : (
            <ProjectPicker />
          )}
          {!firstRunSessionRef.current && <EnvironmentOnboarding />}
          {!showWelcome && <ProductTour />}
          <UpdatePrompt />
          {showDebug && (
            <div className="fixed inset-0 z-[9998] flex items-end justify-center">
              <div
                className="absolute inset-0 bg-black/20"
                onClick={() => setShowDebug(false)}
              />
              <div className="relative h-[60vh] w-full border-border border-t bg-background shadow-lg">
                <div className="flex h-8 items-center justify-between border-border border-b bg-muted/50 px-3">
                  <span className="font-medium text-xs">Debug Panel</span>
                  <button
                    className="text-muted-foreground text-xs hover:text-foreground"
                    onClick={() => setShowDebug(false)}
                  >
                    Close (Ctrl+Shift+D)
                  </button>
                </div>
                <div className="h-[calc(60vh-2rem)] overflow-auto">
                  <Suspense
                    fallback={
                      <div className="p-4 text-muted-foreground text-sm">
                        Loading...
                      </div>
                    }
                  >
                    <LazyDebugPage />
                  </Suspense>
                </div>
              </div>
            </div>
          )}
          <Toaster />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
