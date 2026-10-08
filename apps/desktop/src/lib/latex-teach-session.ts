import { builtInDefaultAgentId } from "@/lib/default-agent";
import {
  isLatexLearnTab,
  LATEX_LEARN_PURPOSE,
  latexLearnSessionId,
  latexLearnSessionTitle,
  planLatexTeachAsk,
} from "@/lib/latex-learn-tab";
import type { ConversationRef } from "@/runtime/types";
import { useAgentStore } from "@/stores/agent-store";
import { useChatLayoutStore } from "@/stores/chat-layout-store";
import { useClaudeChatStore, type TabState } from "@/stores/claude-chat-store";
import { sameProjectPath } from "@/stores/chat-persistence";
import { useDocumentStore } from "@/stores/document-store";
import { useSettingsStore } from "@/stores/settings-store";

type TeachAskWaiter = {
  prompt: string;
  projectPath: string;
  resolve: () => void;
};

const teachAskWaiters: TeachAskWaiter[] = [];
let teachAskRunning = false;
let teachAskGeneration = 0;

/** Drops queued teaching asks so one test cannot block the next. */
export function resetLatexTeachAskQueue(): void {
  teachAskGeneration += 1;
  const waiting = teachAskWaiters.splice(0);
  for (const waiter of waiting) waiter.resolve();
  teachAskRunning = false;
}

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
  const sessionId = latexLearnSessionId(tab);
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

function ownedLearnTab(projectPath: string, tabId: string): TabState | null {
  if (useDocumentStore.getState().projectRoot !== projectPath) return null;
  const state = useClaudeChatStore.getState();
  if (state.activeProjectPath !== projectPath) return null;
  const tab = state.tabs.find((item) => item.id === tabId);
  if (
    !tab ||
    !isLatexLearnTab(tab) ||
    !sameProjectPath(tab.projectPath, projectPath)
  ) {
    return null;
  }
  return tab;
}

function waitUntilLearnResumeIdle(
  projectPath: string,
  tabId: string,
): Promise<TabState | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (tab: TabState | null) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      resolve(tab);
    };
    const publish = () => {
      const tab = ownedLearnTab(projectPath, tabId);
      if (!tab || !tab.resumeRequestId) finish(tab);
    };
    const unsubscribe = useClaudeChatStore.subscribe(publish);
    publish();
  });
}

function takeTeachAsks(projectPath: string): TeachAskWaiter[] {
  const taken: TeachAskWaiter[] = [];
  for (let index = teachAskWaiters.length - 1; index >= 0; index -= 1) {
    const waiter = teachAskWaiters[index];
    if (waiter.projectPath !== projectPath) continue;
    taken.unshift(waiter);
    teachAskWaiters.splice(index, 1);
  }
  return taken;
}

function settleTeachAsks(waiters: readonly TeachAskWaiter[]): void {
  for (const waiter of waiters) waiter.resolve();
}

/**
 * One in-flight delivery per process. Overlapping clicks share that delivery's
 * history read, then leave in order: the first prompt starts the turn and the
 * rest wait on the learning tab.
 */
async function drainTeachAsks(generation: number): Promise<void> {
  if (teachAskRunning || generation !== teachAskGeneration) return;
  teachAskRunning = true;
  try {
    while (generation === teachAskGeneration && teachAskWaiters.length > 0) {
      const projectPath = teachAskWaiters[0]?.projectPath;
      if (!projectPath) {
        settleTeachAsks(teachAskWaiters.splice(0));
        continue;
      }
      const group = takeTeachAsks(projectPath);
      try {
        await deliverLatexTeachAsks(
          projectPath,
          group.map((waiter) => waiter.prompt),
          () => {
            if (generation !== teachAskGeneration) return [];
            const late = takeTeachAsks(projectPath);
            group.push(...late);
            return late.map((waiter) => waiter.prompt);
          },
        );
      } finally {
        settleTeachAsks(group);
      }
    }
  } finally {
    if (generation === teachAskGeneration) {
      teachAskRunning = false;
      if (teachAskWaiters.length > 0) void drainTeachAsks(generation);
    }
  }
}

/**
 * Send a teaching prompt into the project's single learning session and show
 * that session. The prompt already carries the lesson and any selected text.
 * The main chat's draft, chips, and transcript are left alone.
 */
export function sendLatexTeachAsk(prompt: string): Promise<void> {
  const trimmed = prompt.trim();
  if (!trimmed) return Promise.resolve();
  const projectPath = useDocumentStore.getState().projectRoot;
  if (!projectPath) return Promise.resolve();
  const generation = teachAskGeneration;
  return new Promise((resolve) => {
    if (generation !== teachAskGeneration) {
      resolve();
      return;
    }
    teachAskWaiters.push({ prompt: trimmed, projectPath, resolve });
    void drainTeachAsks(generation);
  });
}

async function deliverLatexTeachAsks(
  projectPath: string,
  prompts: string[],
  scoop: () => string[],
): Promise<void> {
  const collect = () => {
    const extra = scoop();
    if (extra.length > 0) prompts.push(...extra);
  };
  if (prompts.length === 0) return;
  if (useDocumentStore.getState().projectRoot !== projectPath) return;

  const before = useClaudeChatStore.getState();
  if (before.activeProjectPath !== projectPath) {
    if (before.resetForProject(projectPath) === "blocked-stopping") return;
  }
  if (
    useDocumentStore.getState().projectRoot !== projectPath ||
    useClaudeChatStore.getState().activeProjectPath !== projectPath
  ) {
    return;
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

  let tab = ownedLearnTab(projectPath, tabId);
  if (!tab) return;

  const shouldLoadHistory = plan.kind === "reuse" && plan.loadHistory;
  if (tab.resumeRequestId || shouldLoadHistory) {
    const expectedSession = latexLearnSessionId(tab);
    if (shouldLoadHistory && !tab.resumeRequestId) {
      const reference = referenceForLearnTab(tab);
      if (!reference) return;
      await useClaudeChatStore.getState().resumeConversation(reference, title);
      tab = ownedLearnTab(projectPath, tabId);
    }
    if (tab?.resumeRequestId) {
      tab = await waitUntilLearnResumeIdle(projectPath, tabId);
    }
    collect();
    if (!tab || tab.resumeRequestId) return;
    if (latexLearnSessionId(tab) !== expectedSession) return;
    if (tab.error) return;
  } else {
    collect();
  }

  tab = ownedLearnTab(projectPath, tabId);
  if (!tab || tab.resumeRequestId) return;
  collect();
  if (prompts.length === 0) return;

  const queue = (prompt: string) => {
    useClaudeChatStore
      .getState()
      .queueGuidance(tabId, prompt, undefined, undefined, {
        skipAmbientContext: true,
      });
  };
  if ((tab.cancelledAttempts?.length ?? 0) > 0) {
    for (const prompt of prompts) queue(prompt);
    return;
  }

  let cursor = 0;
  if (!tab.isStreaming) {
    const first = prompts[0];
    if (!first || !ownedLearnTab(projectPath, tabId)) return;
    await useClaudeChatStore.getState().sendPrompt(first, undefined, {
      tabId,
      skipAmbientContext: true,
    });
    cursor = 1;
    tab = ownedLearnTab(projectPath, tabId);
    if (!tab?.isStreaming) return;
  }
  collect();
  for (const prompt of prompts.slice(cursor)) queue(prompt);
}
