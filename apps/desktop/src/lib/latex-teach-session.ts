import { builtInDefaultAgentId } from "@/lib/default-agent";
import {
  isLatexLearnTab,
  LATEX_LEARN_PURPOSE,
  latexLearnSessionTitle,
  planLatexTeachAsk,
} from "@/lib/latex-learn-tab";
import type { ConversationRef } from "@/runtime/types";
import { useAgentStore } from "@/stores/agent-store";
import { useChatLayoutStore } from "@/stores/chat-layout-store";
import { useClaudeChatStore, type TabState } from "@/stores/claude-chat-store";
import { useDocumentStore } from "@/stores/document-store";
import { useSettingsStore } from "@/stores/settings-store";

function agentIdForNewLearnTab(
  source: Pick<TabState, "runtime" | "agentId"> | undefined,
): string | null {
  if (source && source.runtime !== "codex") {
    const selected = source.agentId?.trim();
    if (selected) return selected;
  }
  return builtInDefaultAgentId(
    useAgentStore
      .getState()
      .agents.filter((agent) => agent.runtime === "claude"),
  );
}

function stampLearnTab(
  tabId: string,
  title: string,
  agent?: { id: string | null },
): void {
  useClaudeChatStore.setState((state) => ({
    tabs: state.tabs.map((tab) =>
      tab.id === tabId
        ? {
            ...tab,
            purpose: LATEX_LEARN_PURPOSE,
            title,
            ...(agent ? { agentId: agent.id } : {}),
          }
        : tab,
    ),
  }));
}

function referenceForLearnTab(
  tab: TabState | undefined,
): ConversationRef | null {
  if (!tab || tab.runtime === "codex" || !tab.projectPath) return null;
  const sessionId =
    tab.sessionRef?.sessionId?.trim() || tab.sessionId?.trim() || "";
  if (!sessionId) return null;
  const runtime = tab.sessionRef?.runtime ?? tab.runtime;
  if (runtime !== "claude") return null;
  return {
    runtime: "claude",
    sessionId,
    projectPath: tab.projectPath,
  };
}

function openLearnTab(
  source: Pick<TabState, "runtime" | "agentId"> | undefined,
  title: string,
): string {
  const tabId = useClaudeChatStore.getState().createTab();
  stampLearnTab(tabId, title, { id: agentIdForNewLearnTab(source) });
  return tabId;
}

/**
 * Send a teaching prompt into the project's single learning session and show
 * that session. The prompt already carries the lesson and any selected text.
 * The main chat's draft, chips, and transcript are left alone.
 */
export async function sendLatexTeachAsk(prompt: string): Promise<void> {
  const trimmed = prompt.trim();
  if (!trimmed) return;

  const projectPath = useDocumentStore.getState().projectRoot;
  if (!projectPath) return;

  const before = useClaudeChatStore.getState();
  if (before.activeProjectPath !== projectPath) {
    if (before.resetForProject(projectPath) === "blocked-stopping") return;
  }

  const title = latexLearnSessionTitle(useSettingsStore.getState().uiLanguage);
  const state = useClaudeChatStore.getState();
  const source = state.tabs.find((tab) => tab.id === state.activeTabId);
  const plan = planLatexTeachAsk(state.tabs, projectPath);
  if (plan.kind === "missing-project") return;

  const tabId =
    plan.kind === "reuse" ? plan.tabId : openLearnTab(source, title);

  if (plan.kind === "reuse") {
    stampLearnTab(tabId, title);
    if (useClaudeChatStore.getState().activeTabId !== tabId) {
      useClaudeChatStore.getState().setActiveTab(tabId, {
        resumeHistory: false,
      });
    }
  }

  useChatLayoutStore.getState().reveal();

  if (plan.kind === "reuse" && plan.loadHistory) {
    const reference = referenceForLearnTab(
      useClaudeChatStore.getState().tabs.find((tab) => tab.id === tabId),
    );
    if (reference) {
      await useClaudeChatStore.getState().resumeConversation(reference, title);
    }
  }

  const tab = useClaudeChatStore
    .getState()
    .tabs.find((item) => item.id === tabId);
  if (!tab || !isLatexLearnTab(tab)) return;

  if (tab.isStreaming) {
    useClaudeChatStore
      .getState()
      .queueGuidance(tabId, trimmed, undefined, undefined, {
        skipAmbientContext: true,
      });
    return;
  }

  await useClaudeChatStore.getState().sendPrompt(trimmed, undefined, {
    tabId,
    skipAmbientContext: true,
  });
}
