import { useEffect, useRef } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import {
  CLAUDE_CODE_PROVIDER_ID,
  useClaudeChatStore,
  type ClaudeStreamMessage,
  type TabState,
} from "@/stores/claude-chat-store";
import { useDocumentStore } from "@/stores/document-store";
import { useHistoryStore } from "@/stores/history-store";
import { useProposedChangesStore } from "@/stores/proposed-changes-store";
import { readTexFileContent } from "@/lib/tauri/fs";
import {
  resolveCompileTarget,
  activeCompileUsesTexlive,
} from "@/lib/latex-compiler";
import { runOwnedProjectCompile } from "@/lib/project-compile";
import { createLogger } from "@/lib/debug/logger";
import { isDebugLoggingEnabled } from "@/lib/debug/log-store";
import { interruptRuntimeTurn } from "@/runtime/commands";
import type { RuntimeEventEnvelope } from "@/runtime/types";
import { useApprovalStore } from "@/stores/approval-store";
import { useSettingsStore } from "@/stores/settings-store";
import { translate } from "@/lib/i18n";
import { localizeChatNotice } from "@/lib/chat-empty-reply";
import {
  classifyClaudeProcessStderr,
  formatUnexpectedClaudeExit,
} from "@/lib/claude-exit-error";
import { createStreamDeltaBatcher } from "@/hooks/stream-delta-batch";
import { shouldRefreshSkillsAfterTool } from "@/lib/skills-refresh";
import { scheduleSkillsRefresh } from "@/stores/skill-store";

function streamingAttemptSignature(tabs: readonly TabState[]): string {
  return tabs
    .map((tab) => {
      if (!tab.isStreaming) return `${tab.id}:idle`;
      const providerKey = tab.sessionProviderKey ?? tab.providerKey ?? "";
      return `${tab.id}:${tab.activeAttemptId ?? ""}:${tab.runtime}:${providerKey}`;
    })
    .join("|");
}

const log = createLogger("claude-event");

/** Fail a turn that receives no assistant/tool/reasoning progress. */
// Codex WebSocket reconnect storms commonly take ~75–120s before HTTP
// fallback succeeds; keep the local abort above that budget.
const CODEX_NO_PROGRESS_MS = 180_000;
const CLAUDE_NO_PROGRESS_MS = 180_000;

const INTERRUPTED_CODEX_REPLY_ERROR =
  "Codex turn was interrupted before a reply arrived.";

function emptyCodexReplyError(): string {
  return localizeChatNotice(
    "localprism:empty-reply",
    useSettingsStore.getState().uiLanguage,
  );
}

function messageHasVisibleCodexContent(message: ClaudeStreamMessage): boolean {
  if (message.type === "assistant") {
    const content = message.message?.content;
    if (!Array.isArray(content)) return false;
    return content.some(
      (block) =>
        (block.type === "text" && !!block.text?.trim()) ||
        (block.type === "thinking" && !!block.thinking?.trim()) ||
        (block.type === "tool_use" && !!block.id),
    );
  }
  if (message.type === "user") {
    const content = message.message?.content;
    if (!Array.isArray(content)) return false;
    // Tool results count as visible turn activity for empty-reply detection.
    return content.some(
      (block) => block.type === "tool_result" && !!block.tool_use_id,
    );
  }
  return false;
}

/** Visible assistant/tool activity after the latest user text bubble. */
function hasVisibleCodexReplyAfterLastUser(
  messages: ClaudeStreamMessage[],
): boolean {
  let lastUserTextIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.type !== "user") continue;
    const content = message.message?.content;
    const hasUserText = Array.isArray(content)
      ? content.some((block) => block.type === "text" && !!block.text?.trim())
      : false;
    if (hasUserText) {
      lastUserTextIndex = index;
      break;
    }
  }
  if (lastUserTextIndex < 0) return false;
  return messages
    .slice(lastUserTextIndex + 1)
    .some(messageHasVisibleCodexContent);
}

/** Backend event payload shapes (include tab_id for routing) */
interface ClaudeOutputPayload {
  tab_id: string;
  attempt_id: string;
  data: string;
}

interface ClaudeCompletePayload {
  tab_id: string;
  attempt_id: string;
  success: boolean;
  exit_code?: number | null;
  stderr_tail?: string | null;
}

interface ClaudeErrorPayload {
  tab_id: string;
  attempt_id: string;
  data: string;
}

/**
 * Hook that manages Tauri event listeners for Claude CLI streaming output.
 *
 * Listeners are kept alive at all times (no race condition with invoke).
 * Per-tab mutable state (pendingToolUses, hasTexChanges) is stored in Maps
 * keyed by tab_id so multiple tabs can stream concurrently.
 */
export function useClaudeEvents() {
  // Per-tab mutable state stored in refs so the long-lived listeners
  // always read the latest values without needing to be re-created.
  const pendingToolUsesRef = useRef(
    new Map<string, Map<string, { name: string; input: any }>>(),
  );
  const codexToolInputsRef = useRef(
    new Map<string, { name: string; input: unknown }>(),
  );
  const hasTexChangesRef = useRef(new Map<string, boolean>());
  const cancelledForAskRef = useRef(new Map<string, boolean>());
  const lastErrorRef = useRef(new Map<string, string>());
  const directProviderTabRef = useRef(new Map<string, boolean>());
  const listenersRef = useRef<UnlistenFn[]>([]);
  const activeAttemptRef = useRef(new Map<string, string>());
  const msgCountRef = useRef(new Map<string, number>());
  const streamStartTimeRef = useRef(new Map<string, number>());
  const lastMsgTimeRef = useRef(new Map<string, number>());
  const lastCodexEventAtRef = useRef(new Map<string, number>());
  const lastCodexProgressAtRef = useRef(new Map<string, number>());
  const lastClaudeProgressAtRef = useRef(new Map<string, number>());
  const codexHadReplyRef = useRef(new Set<string>());
  const codexStallReportedRef = useRef(new Set<string>());
  const claudeStallReportedRef = useRef(new Set<string>());

  // Reset per-tab state when a tab starts/stops streaming — not on every token.
  const streamingSignature = useClaudeChatStore((s) =>
    streamingAttemptSignature(s.tabs),
  );
  useEffect(() => {
    const tabs = useClaudeChatStore.getState().tabs;
    for (const tab of tabs) {
      const attemptId = tab.activeAttemptId;
      if (
        tab.isStreaming &&
        attemptId != null &&
        activeAttemptRef.current.get(tab.id) !== attemptId
      ) {
        activeAttemptRef.current.set(tab.id, attemptId);
        // New stream detected for this tab — initialize state
        pendingToolUsesRef.current.set(tab.id, new Map());
        hasTexChangesRef.current.set(tab.id, false);
        cancelledForAskRef.current.set(tab.id, false);
        lastErrorRef.current.delete(tab.id);
        const providerKey = tab.sessionProviderKey ?? tab.providerKey;
        directProviderTabRef.current.set(
          tab.id,
          !!providerKey && providerKey !== CLAUDE_CODE_PROVIDER_ID,
        );
        msgCountRef.current.set(tab.id, 0);
        streamStartTimeRef.current.delete(tab.id);
        lastMsgTimeRef.current.delete(tab.id);
        const now = Date.now();
        lastCodexEventAtRef.current.set(tab.id, now);
        lastCodexProgressAtRef.current.set(tab.id, now);
        lastClaudeProgressAtRef.current.set(tab.id, now);
        codexHadReplyRef.current.delete(`${tab.id}:${attemptId}`);
        claudeStallReportedRef.current.delete(`${tab.id}:${attemptId}`);
        codexStallReportedRef.current.delete(`${tab.id}:${attemptId}`);
      } else if (!tab.isStreaming) {
        // Clean up finished tab state
        activeAttemptRef.current.delete(tab.id);
        pendingToolUsesRef.current.delete(tab.id);
        hasTexChangesRef.current.delete(tab.id);
        cancelledForAskRef.current.delete(tab.id);
        lastErrorRef.current.delete(tab.id);
        directProviderTabRef.current.delete(tab.id);
        msgCountRef.current.delete(tab.id);
        streamStartTimeRef.current.delete(tab.id);
        lastMsgTimeRef.current.delete(tab.id);
        lastCodexEventAtRef.current.delete(tab.id);
        lastCodexProgressAtRef.current.delete(tab.id);
        lastClaudeProgressAtRef.current.delete(tab.id);
        for (const key of [...codexHadReplyRef.current]) {
          if (key.startsWith(`${tab.id}:`)) {
            codexHadReplyRef.current.delete(key);
          }
        }
        for (const key of [...claudeStallReportedRef.current]) {
          if (key.startsWith(`${tab.id}:`)) {
            claudeStallReportedRef.current.delete(key);
          }
        }
      }
    }
  }, [streamingSignature]);

  // Stall only when assistant/tool/reasoning progress stops — reconnect
  // warnings and other soft events must not reset this clock.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      const chatStore = useClaudeChatStore.getState();
      for (const tab of chatStore.tabs) {
        if (!tab.isStreaming || !tab.activeAttemptId) {
          continue;
        }
        const attemptKey = `${tab.id}:${tab.activeAttemptId}`;
        if (tab.runtime === "codex") {
          if (codexStallReportedRef.current.has(attemptKey)) continue;
          const lastProgressAt =
            lastCodexProgressAtRef.current.get(tab.id) ??
            tab.streamingStartedAt ??
            now;
          if (now - lastProgressAt < CODEX_NO_PROGRESS_MS) continue;
          codexStallReportedRef.current.add(attemptKey);
          chatStore._setError(
            tab.id,
            "Codex made no reply progress for 180 seconds (reconnects alone do not count). Check network/VPN/proxy, then Stop and retry.",
          );
          chatStore._setStreamingStatus(tab.id, null);
          void chatStore.cancelExecution(tab.id);
          void interruptRuntimeTurn(
            "codex",
            tab.id,
            tab.activeAttemptId,
            "terminate",
          ).catch(() => undefined);
          continue;
        }
        if (tab.runtime !== "claude") continue;
        if (claudeStallReportedRef.current.has(attemptKey)) continue;
        const lastProgressAt =
          lastClaudeProgressAtRef.current.get(tab.id) ??
          tab.streamingStartedAt ??
          now;
        if (now - lastProgressAt < CLAUDE_NO_PROGRESS_MS) continue;
        claudeStallReportedRef.current.add(attemptKey);
        chatStore._setError(
          tab.id,
          "The model made no reply for 180 seconds. Check the provider API key, network, or Stop and retry.",
        );
        chatStore._setStreamingStatus(tab.id, null);
        void chatStore.cancelExecution(tab.id);
      }
    }, 5_000);
    return () => window.clearInterval(timer);
  }, []);

  // ── One-time listener setup (mount only) ──
  useEffect(() => {
    const deltaBatcher = createStreamDeltaBatcher((tabId, message) => {
      useClaudeChatStore.getState()._appendMessage(tabId, message);
    });

    type ProjectOwner = {
      projectRoot: string;
      projectGeneration: number | undefined;
    };

    function captureProjectOwner(): ProjectOwner | null {
      const state = useDocumentStore.getState();
      return state.projectRoot
        ? {
            projectRoot: state.projectRoot,
            projectGeneration: state.projectGeneration,
          }
        : null;
    }

    function stillOwnsProject(owner: ProjectOwner | null): boolean {
      const state = useDocumentStore.getState();
      return owner
        ? state.projectRoot === owner.projectRoot &&
            state.projectGeneration === owner.projectGeneration
        : state.projectRoot == null;
    }

    function setUserVisibleError(tabId: string, message: string) {
      lastErrorRef.current.set(tabId, message);
      useClaudeChatStore.getState()._setError(tabId, message);
    }

    function providerErrorMessage(payload: string): string | null {
      const trimmed = payload.trim();
      if (!trimmed) return null;
      const lower = trimmed.toLowerCase();
      const detail =
        trimmed.length > 800 ? `${trimmed.slice(0, 800)}...` : trimmed;
      if (/\b400\b/.test(lower) || lower.includes("bad request")) {
        return translate(
          useSettingsStore.getState().uiLanguage,
          "errors.http400",
          {
            detail,
          },
        );
      }
      const looksProviderRelated =
        lower.includes("provider") ||
        lower.includes("openai") ||
        lower.includes("api key") ||
        lower.includes("unauthorized") ||
        lower.includes("401") ||
        lower.includes("403") ||
        lower.includes("404") ||
        lower.includes("429") ||
        lower.includes("too many requests") ||
        lower.includes("rate limit") ||
        lower.includes("invalid model") ||
        lower.includes("model access") ||
        lower.includes("tool_calls") ||
        lower.includes("unsupported parameter") ||
        lower.includes("does not support") ||
        lower.includes("base url");
      if (!looksProviderRelated) return null;
      return detail;
    }

    async function registerProposedChange(
      tabId: string,
      attemptId: string,
      filePath: string,
      toolUseId: string,
      toolName: string,
    ) {
      const docState = useDocumentStore.getState();
      const projectRoot = docState.projectRoot;
      let relativePath = filePath;
      if (projectRoot && filePath.startsWith(projectRoot)) {
        relativePath = filePath.slice(projectRoot.length).replace(/^\//, "");
      }
      const file = docState.files.find(
        (f) => f.relativePath === relativePath || f.absolutePath === filePath,
      );
      if (!file) return;

      const oldContent = file.content ?? "";
      try {
        const newContent = await readTexFileContent(file.absolutePath);
        const currentTab = useClaudeChatStore
          .getState()
          .tabs.find((candidate) => candidate.id === tabId);
        if (
          currentTab?.runtime !== "claude" ||
          currentTab.activeAttemptId !== attemptId
        ) {
          return;
        }
        if (oldContent !== newContent) {
          useProposedChangesStore.getState().addChange({
            id: toolUseId,
            filePath: file.relativePath,
            absolutePath: file.absolutePath,
            oldContent,
            newContent,
            toolName,
          });
        }
      } catch {
        // readTexFileContent failed — not critical
      }
    }

    function elapsed(tabId: string) {
      const start = streamStartTimeRef.current.get(tabId);
      if (!start) return "";
      return `+${((performance.now() - start) / 1000).toFixed(1)}s`;
    }

    function handleStreamMessage(payload: ClaudeOutputPayload) {
      const { tab_id: tabId, attempt_id: attemptId, data } = payload;

      let msg: ClaudeStreamMessage;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }

      const chatStore = useClaudeChatStore.getState();

      // Only process messages if this tab is still streaming
      const tab = chatStore.tabs.find((t) => t.id === tabId);
      if (
        !tab?.isStreaming ||
        tab.runtime !== "claude" ||
        tab.activeAttemptId !== attemptId
      ) {
        return;
      }

      const count = (msgCountRef.current.get(tabId) ?? 0) + 1;
      msgCountRef.current.set(tabId, count);
      const now = performance.now();
      if (count === 1) streamStartTimeRef.current.set(tabId, now);
      const lastTime = lastMsgTimeRef.current.get(tabId);
      const gap = lastTime ? ((now - lastTime) / 1000).toFixed(1) : "0";
      lastMsgTimeRef.current.set(tabId, now);

      if (msg.type === "assistant" && messageHasVisibleCodexContent(msg)) {
        lastClaudeProgressAtRef.current.set(tabId, Date.now());
      }
      if (msg.type === "user" && messageHasVisibleCodexContent(msg)) {
        lastClaudeProgressAtRef.current.set(tabId, Date.now());
      }

      if (isDebugLoggingEnabled()) {
        const contentTypes =
          msg.message?.content?.map((b: any) => b.type).join(",") ?? "";
        const gapWarning = Number(gap) > 10 ? ` GAP ${gap}s` : "";
        log.debug(
          `[${tabId}] ${elapsed(tabId)} #${count} type=${msg.type} sub=${msg.subtype ?? ""} content=[${contentTypes}] gap=${gap}s${gapWarning}`,
        );

        if (msg.type === "assistant") {
          const thinkingBlock = msg.message?.content?.find(
            (b: any) => b.type === "thinking",
          );
          if (thinkingBlock) {
            log.debug(
              `[${tabId}] ${elapsed(tabId)} thinking: ${(thinkingBlock.thinking || "").slice(0, 100)}`,
            );
          }
          const textBlock = msg.message?.content?.find(
            (b: any) => b.type === "text",
          );
          if (textBlock?.text) {
            log.debug(
              `[${tabId}] ${elapsed(tabId)} text: ${textBlock.text.slice(0, 100)}`,
            );
          }
          const toolBlock = msg.message?.content?.find(
            (b: any) => b.type === "tool_use",
          );
          if (toolBlock) {
            log.debug(
              `[${tabId}] ${elapsed(tabId)} tool_use: ${toolBlock.name} ${toolBlock.input?.file_path ?? ""}`,
            );
          }
        }
        if (msg.type === "user" && msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === "tool_result") {
              const preview =
                typeof block.content === "string"
                  ? block.content.slice(0, 80)
                  : JSON.stringify(block.content)?.slice(0, 80);
              log.debug(
                `[${tabId}] ${elapsed(tabId)} tool_result: id=${block.tool_use_id} err=${block.is_error ?? false} len=${preview?.length ?? 0}`,
              );
            }
          }
        }
      }
      if (msg.type === "result") {
        log.info(
          `[${tabId}] ${elapsed(tabId)} result cost=$${msg.cost_usd} api=${msg.duration_api_ms}ms total=${msg.duration_ms}ms`,
        );
        if (
          msg.is_error &&
          msg.subtype !== "cancelled" &&
          typeof msg.result === "string" &&
          msg.result.trim()
        ) {
          setUserVisibleError(tabId, msg.result.trim());
        }
      }

      // Extract session_id from system:init
      if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
        chatStore._setSessionId(tabId, msg.session_id);
      }

      // Detect rate limit events and surface to user — never append to messages
      if ((msg as any).type === "rate_limit_event") {
        const info = (msg as any).rate_limit_info;
        if (info) {
          const resetsAt = info.resetsAt
            ? new Date(info.resetsAt * 1000).toLocaleTimeString()
            : "unknown";
          log.warn(
            `[${tabId}] rate_limit: status=${info.status} type=${info.rateLimitType} resets=${resetsAt} overage=${info.overageStatus}`,
          );
          if (info.status !== "allowed") {
            chatStore._setError(
              tabId,
              `Rate limited (${info.rateLimitType}). Resets at ${resetsAt}`,
            );
          }
        }
        return; // rate_limit_event is informational — do not append to messages
      }

      // Track tool_use blocks for file change detection
      const tabToolUses = pendingToolUsesRef.current.get(tabId) ?? new Map();
      if (msg.type === "assistant" && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === "tool_use" && block.id && block.name) {
            tabToolUses.set(block.id, {
              name: block.name,
              input: block.input,
            });
          }
        }
        pendingToolUsesRef.current.set(tabId, tabToolUses);
      }

      // Detect file modifications from tool_results → register as proposed changes
      if (msg.type === "user" && msg.message?.content) {
        for (const block of msg.message.content) {
          if (block.type === "tool_result" && block.tool_use_id) {
            const toolUse = tabToolUses.get(block.tool_use_id);
            if (
              toolUse &&
              !block.is_error &&
              shouldRefreshSkillsAfterTool(toolUse.name, toolUse.input)
            ) {
              scheduleSkillsRefresh();
            }
            if (
              toolUse &&
              !block.is_error &&
              /^(Write|write|Edit|edit|MultiEdit|multiedit)$/.test(toolUse.name)
            ) {
              const fp = toolUse.input?.file_path || toolUse.input?.path;
              if (fp) {
                registerProposedChange(
                  tabId,
                  attemptId,
                  fp,
                  block.tool_use_id!,
                  toolUse.name,
                );
                if (/\.(tex|bib|sty|cls|dtx)$/i.test(fp)) {
                  hasTexChangesRef.current.set(tabId, true);
                }
              }
            }
          }
        }
      }

      // Skip duplicate user messages we already added locally
      if (
        msg.type === "user" &&
        msg.message?.content?.length === 1 &&
        msg.message.content[0].type === "text"
      ) {
        return;
      }

      chatStore._appendMessage(tabId, msg);

      // When a UI-pause tool is detected, cancel the process so the user
      // can interact with the widget before Claude continues.
      if (msg.type === "assistant" && msg.message?.content) {
        const hasUiPauseTool = msg.message.content.some(
          (b: any) =>
            b.type === "tool_use" &&
            (b.name === "AskUserQuestion" || b.name === "ExitPlanMode"),
        );
        if (hasUiPauseTool) {
          log.info(
            `[${tabId}] ${elapsed(tabId)} UI-pause tool detected - cancelling process for user input`,
          );
          cancelledForAskRef.current.set(tabId, true);
          invoke("cancel_claude_execution", { tabId, attemptId }).catch(
            () => {},
          );
        }
      }
    }

    async function handleComplete(payload: ClaudeCompletePayload) {
      const { tab_id: tabId, attempt_id: attemptId, success } = payload;
      const count = msgCountRef.current.get(tabId) ?? 0;

      log.info(
        `[${tabId}] complete success=${success} (${count} messages) cancelledForAsk=${cancelledForAskRef.current.get(tabId) ?? false}`,
      );
      const initialTab = useClaudeChatStore
        .getState()
        .tabs.find((candidate) => candidate.id === tabId);
      if (initialTab?.runtime !== "claude") return;
      const hasMatchingCancellation = (initialTab.cancelledAttempts ?? []).some(
        (candidate) => candidate.attemptId === attemptId,
      );
      if (
        !hasMatchingCancellation &&
        initialTab.activeAttemptId !== attemptId
      ) {
        return;
      }

      const chatStore = useClaudeChatStore.getState();
      const cancellation = chatStore._consumeAttemptCancellation(
        tabId,
        attemptId,
      );

      // Guard against duplicate complete events
      const tab = useClaudeChatStore
        .getState()
        .tabs.find((candidate) => candidate.id === tabId);
      if (cancellation?.mode === "terminate") {
        if (
          tab?.runtime === "claude" &&
          (tab.attemptEpoch ?? 0) <= cancellation.attemptEpoch + 1
        ) {
          chatStore._setStreaming(tabId, false);
        }
        chatStore._cleanupTemporaryFilePaths(
          cancellation.temporaryFilePaths ?? [],
        );
        return;
      }
      const isCurrentCompletionAttempt = () => {
        const currentTab = useClaudeChatStore
          .getState()
          .tabs.find((candidate) => candidate.id === tabId);
        return (
          currentTab?.runtime === "claude" &&
          currentTab.activeAttemptId === attemptId
        );
      };
      if (!isCurrentCompletionAttempt()) return;
      if (!tab?.isStreaming) {
        log.warn(
          `[${tabId}] ignoring duplicate complete event (not streaming)`,
        );
        return;
      }
      const completionProjectOwner = captureProjectOwner();

      if (
        !success &&
        !tab.error &&
        !lastErrorRef.current.get(tabId) &&
        !cancelledForAskRef.current.get(tabId) &&
        cancellation?.mode !== "interrupt"
      ) {
        const isDirectProvider = directProviderTabRef.current.get(tabId);
        const isWindows = navigator.userAgent.includes("Windows");
        chatStore._setError(
          tabId,
          formatUnexpectedClaudeExit({
            started: count > 0,
            isDirectProvider: !!isDirectProvider,
            isWindows,
            exitCode: payload.exit_code,
            stderrTail: payload.stderr_tail,
            language: useSettingsStore.getState().uiLanguage,
          }),
        );
      }

      // Clean up per-tab state
      if (activeAttemptRef.current.get(tabId) === attemptId) {
        activeAttemptRef.current.delete(tabId);
        pendingToolUsesRef.current.delete(tabId);
        hasTexChangesRef.current.delete(tabId);
        cancelledForAskRef.current.delete(tabId);
        lastErrorRef.current.delete(tabId);
        directProviderTabRef.current.delete(tabId);
      }

      const completedSessionId = tab.sessionId;
      useApprovalStore.getState().dismissForTab(tabId);
      chatStore._setStreaming(tabId, false);
      chatStore._cleanupTemporaryFilePaths(
        chatStore.consumeTemporaryFilePaths(tabId),
      );

      const forceQueuedGuidance = tab.forceQueuedGuidanceOnComplete === true;
      if (forceQueuedGuidance) {
        if (!isCurrentCompletionAttempt()) return;
        const queuedGuidance = useClaudeChatStore
          .getState()
          .consumeQueuedGuidance(tabId, tab.forcedQueuedGuidanceId);
        if (queuedGuidance) {
          log.info(`[${tabId}] interrupting current run with queued guidance`);
          void useClaudeChatStore
            .getState()
            .sendPrompt(queuedGuidance.prompt, queuedGuidance.contextOverride, {
              tabId,
              preserveTabProvider: true,
              displayPrompt: queuedGuidance.displayPrompt,
            });
          return;
        }
      }

      // Snapshot after Claude edit
      const projectPath = completionProjectOwner?.projectRoot ?? null;
      if (projectPath && completedSessionId) {
        void (async () => {
          try {
            const title = await invoke<string | null>(
              "generate_claude_session_title",
              {
                projectPath,
                sessionId: completedSessionId,
              },
            );
            if (
              title &&
              stillOwnsProject(completionProjectOwner) &&
              isCurrentCompletionAttempt()
            ) {
              useClaudeChatStore
                .getState()
                ._setSessionTitle(completedSessionId, title);
            }
          } catch (err) {
            log.warn("failed to refresh completed session title", {
              error: String(err),
            });
          }
        })();
      }

      if (projectPath) {
        try {
          await useHistoryStore
            .getState()
            .createSnapshot(projectPath, "[claude] After Claude edit");
        } catch {
          // snapshot failure should not break the flow
        }
      }
      if (
        !stillOwnsProject(completionProjectOwner) ||
        !isCurrentCompletionAttempt()
      ) {
        return;
      }

      const docStore = useDocumentStore.getState();
      await docStore.refreshFiles();
      if (
        !stillOwnsProject(completionProjectOwner) ||
        !isCurrentCompletionAttempt()
      ) {
        return;
      }

      const queuedGuidance = success
        ? useClaudeChatStore.getState().consumeQueuedGuidance(tabId)
        : null;
      if (queuedGuidance) {
        log.info(`[${tabId}] continuing with queued guidance`);
        void useClaudeChatStore
          .getState()
          .sendPrompt(queuedGuidance.prompt, queuedGuidance.contextOverride, {
            tabId,
            preserveTabProvider: true,
            displayPrompt: queuedGuidance.displayPrompt,
          });
        return;
      }

      // Auto-recompile after Claude finishes
      if (
        !stillOwnsProject(completionProjectOwner) ||
        !isCurrentCompletionAttempt()
      ) {
        return;
      }
      const { projectRoot, projectGeneration, files, activeFileId } =
        useDocumentStore.getState();
      if (projectRoot) {
        const resolved = resolveCompileTarget(activeFileId, files);
        if (resolved) {
          const { rootId, targetPath } = resolved;
          await runOwnedProjectCompile({
            owner: { projectRoot, projectGeneration },
            rootFileId: rootId,
            targetPath,
            useTexlive: activeCompileUsesTexlive(),
            minimumBusyMs: 0,
            isStillValid: () =>
              stillOwnsProject(completionProjectOwner) &&
              isCurrentCompletionAttempt(),
          });
        }
      }
    }

    async function handleRuntimeEvent(payload: RuntimeEventEnvelope) {
      if (payload.runtime !== "codex" || !payload.attemptId) return;
      const { tabId, attemptId, event } = payload;
      const initialTab = useClaudeChatStore
        .getState()
        .tabs.find((candidate) => candidate.id === tabId);
      if (initialTab?.runtime !== "codex") return;

      const isCurrentAttempt = () => {
        const currentTab = useClaudeChatStore
          .getState()
          .tabs.find((candidate) => candidate.id === tabId);
        return (
          currentTab?.runtime === "codex" &&
          currentTab.activeAttemptId === attemptId
        );
      };
      const terminal =
        event.type === "turnCompleted" ||
        event.type === "turnInterrupted" ||
        event.type === "turnFailed";

      if (terminal) {
        deltaBatcher.flush(tabId);
        const hasMatchingCancellation = (
          initialTab.cancelledAttempts ?? []
        ).some((candidate) => candidate.attemptId === attemptId);
        const currentForGate = useClaudeChatStore
          .getState()
          .tabs.find((candidate) => candidate.id === tabId);
        // A newer live attempt owns the tab — ignore stale terminals.
        const newerAttemptOwnsTab =
          !!currentForGate?.activeAttemptId &&
          currentForGate.activeAttemptId !== attemptId &&
          !hasMatchingCancellation;
        if (newerAttemptOwnsTab) {
          return;
        }
        // Previously required isStreaming && current attempt. That dropped
        // late turnCompleted after a premature streaming clear, leaving only
        // the user bubble with no error banner.

        const chatStore = useClaudeChatStore.getState();
        const cancellation = chatStore._consumeAttemptCancellation(
          tabId,
          attemptId,
        );
        if (cancellation?.mode === "terminate") {
          deltaBatcher.discard(tabId);
          const currentTab = useClaudeChatStore
            .getState()
            .tabs.find((candidate) => candidate.id === tabId);
          if (
            currentTab?.runtime === "codex" &&
            (currentTab.attemptEpoch ?? 0) <= cancellation.attemptEpoch + 1
          ) {
            chatStore._setStreaming(tabId, false);
            chatStore._clearActiveAttempt(tabId, attemptId);
          }
          chatStore._cleanupTemporaryFilePaths(
            cancellation.temporaryFilePaths ?? [],
          );
          return;
        }
        const completionProjectOwner = captureProjectOwner();
        const attemptKey = `${tabId}:${attemptId}`;
        const tabSnapshot =
          useClaudeChatStore
            .getState()
            .tabs.find((candidate) => candidate.id === tabId) ?? initialTab;
        const hadReply =
          codexHadReplyRef.current.has(attemptKey) ||
          hasVisibleCodexReplyAfterLastUser(tabSnapshot.messages ?? []);
        // Terminal events must always leave the UI, even after reconnect warnings.
        chatStore._setStreamingStatus(tabId, null);
        chatStore._setStreaming(tabId, false);
        let emptyReplyError: string | null = null;
        if (event.type === "turnFailed") {
          chatStore._setError(tabId, event.message);
        } else if (event.type === "turnInterrupted") {
          emptyReplyError = hadReply ? null : INTERRUPTED_CODEX_REPLY_ERROR;
          chatStore._setError(tabId, emptyReplyError);
        } else if (event.type === "turnCompleted") {
          // Empty successful completions previously left only the user bubble
          // (streaming off, no error, empty assistant filtered from UI).
          emptyReplyError = hadReply ? null : emptyCodexReplyError();
          chatStore._setError(tabId, emptyReplyError);
        }
        if (emptyReplyError) {
          // Banner alone is easy to miss; keep a visible bubble in-thread.
          chatStore._appendMessage(tabId, {
            type: "assistant",
            subtype: "streaming_final",
            message: {
              content: [{ type: "text", text: emptyReplyError }],
            },
          });
        }
        chatStore._cleanupTemporaryFilePaths(
          chatStore.consumeTemporaryFilePaths(tabId),
        );
        codexHadReplyRef.current.delete(attemptKey);

        const completedTab = useClaudeChatStore
          .getState()
          .tabs.find((candidate) => candidate.id === tabId);
        const queuedGuidance =
          cancellation?.mode === "interrupt" &&
          completedTab?.forceQueuedGuidanceOnComplete
            ? useClaudeChatStore
                .getState()
                .consumeQueuedGuidance(
                  tabId,
                  completedTab.forcedQueuedGuidanceId,
                )
            : event.type === "turnCompleted"
              ? useClaudeChatStore.getState().consumeQueuedGuidance(tabId)
              : null;
        if (queuedGuidance) {
          chatStore._clearActiveAttempt(tabId, attemptId);
          void useClaudeChatStore
            .getState()
            .sendPrompt(queuedGuidance.prompt, queuedGuidance.contextOverride, {
              tabId,
              preserveTabProvider: true,
              displayPrompt: queuedGuidance.displayPrompt,
            });
          return;
        }

        const projectPath = completionProjectOwner?.projectRoot ?? null;
        if (projectPath) {
          try {
            await useHistoryStore
              .getState()
              .createSnapshot(projectPath, "[codex] After Codex edit");
          } catch {
            // Snapshot failure should not block terminal cleanup.
          }
          if (
            !stillOwnsProject(completionProjectOwner) ||
            !isCurrentAttempt()
          ) {
            chatStore._clearActiveAttempt(tabId, attemptId);
            return;
          }
          await useDocumentStore.getState().refreshFiles();
        }
        chatStore._clearActiveAttempt(tabId, attemptId);
        return;
      }

      if (!initialTab.isStreaming || !isCurrentAttempt()) return;
      const chatStore = useClaudeChatStore.getState();
      lastCodexEventAtRef.current.set(tabId, Date.now());
      const isProgressEvent =
        event.type === "assistantDelta" ||
        event.type === "assistantCompleted" ||
        event.type === "reasoningSummaryDelta" ||
        event.type === "toolStarted" ||
        event.type === "toolCompleted";
      if (isProgressEvent) {
        lastCodexProgressAtRef.current.set(tabId, Date.now());
        const hasVisibleReply =
          (event.type === "assistantDelta" && !!event.delta?.trim()) ||
          (event.type === "assistantCompleted" && !!event.content?.trim()) ||
          event.type === "reasoningSummaryDelta" ||
          event.type === "toolStarted" ||
          event.type === "toolCompleted";
        if (hasVisibleReply) {
          codexHadReplyRef.current.add(`${tabId}:${attemptId}`);
        }
      }
      switch (event.type) {
        case "sessionStarted":
          deltaBatcher.flush(tabId);
          chatStore._setSessionId(tabId, event.sessionId);
          break;
        case "turnStarted":
          if (event.turnId) chatStore._tagCodexTurn(tabId, event.turnId);
          break;
        case "assistantDelta":
          chatStore._setStreamingStatus(tabId, null);
          deltaBatcher.enqueue(tabId, "text", event.delta);
          break;
        case "assistantCompleted":
          deltaBatcher.flush(tabId);
          chatStore._setStreamingStatus(tabId, null);
          chatStore._appendMessage(tabId, {
            type: "assistant",
            subtype: "streaming_final",
            message: { content: [{ type: "text", text: event.content }] },
          });
          break;
        case "reasoningSummaryDelta":
          chatStore._setStreamingStatus(tabId, null);
          deltaBatcher.enqueue(tabId, "thinking", event.delta);
          break;
        case "toolStarted":
          deltaBatcher.flush(tabId);
          codexToolInputsRef.current.set(event.itemId, {
            name: event.name,
            input: event.input,
          });
          chatStore._appendMessage(tabId, {
            type: "assistant",
            message: {
              content: [
                {
                  type: "tool_use",
                  id: event.itemId,
                  name: event.name,
                  input: event.input,
                },
              ],
            },
          });
          break;
        case "toolCompleted":
          deltaBatcher.flush(tabId);
          {
            const started = codexToolInputsRef.current.get(event.itemId);
            if (
              event.success &&
              started &&
              shouldRefreshSkillsAfterTool(started.name, started.input)
            ) {
              scheduleSkillsRefresh();
            }
          }
          chatStore._appendMessage(tabId, {
            type: "user",
            message: {
              content: [
                {
                  type: "tool_result",
                  tool_use_id: event.itemId,
                  content: event.output ?? "",
                  is_error: !event.success,
                },
              ],
            },
          });
          break;
        case "fileChange":
          if (
            shouldRefreshSkillsAfterTool("Write", { file_path: event.path })
          ) {
            scheduleSkillsRefresh();
          }
          break;
        case "usage":
          deltaBatcher.flush(tabId);
          chatStore._addUsage(tabId, event.inputTokens, event.outputTokens, {
            cacheReadTokens: event.cacheReadTokens,
            contextWindow: event.contextWindow,
          });
          break;
        case "warning": {
          // Soft / reconnect / retry warnings must not end streaming or
          // sticky-fail the tab. Only turnFailed / turnCompleted /
          // turnInterrupted should clear isStreaming.
          deltaBatcher.flush(tabId);
          const message = event.message.trim();
          if (!message) break;
          const reconnectMatch = message.match(
            /Reconnecting(?:\.\.\.|…)\s*(\d+)\s*\/\s*(\d+)/i,
          );
          if (reconnectMatch) {
            chatStore._setStreamingStatus(
              tabId,
              `Codex reconnecting ${reconnectMatch[1]}/${reconnectMatch[2]} (request timed out; still waiting for a reply)…`,
            );
          } else {
            // Retry notices and other soft warnings only update status.
            chatStore._setStreamingStatus(tabId, message);
          }
          break;
        }
      }
    }

    // Set up listeners once and keep them alive for the component lifetime.
    // Each listener is added to listenersRef immediately after registration
    // to avoid a race condition where unmount happens mid-setup.
    let cancelled = false;
    (async () => {
      const unlistenOutput = await listen<ClaudeOutputPayload>(
        "claude-output",
        (event) => {
          if (!cancelled) handleStreamMessage(event.payload);
        },
      );
      if (cancelled) {
        unlistenOutput();
        return;
      }
      listenersRef.current.push(unlistenOutput);

      const unlistenComplete = await listen<ClaudeCompletePayload>(
        "claude-complete",
        (event) => {
          if (!cancelled) handleComplete(event.payload);
        },
      );
      if (cancelled) {
        unlistenComplete();
        return;
      }
      listenersRef.current.push(unlistenComplete);

      const unlistenError = await listen<ClaudeErrorPayload>(
        "claude-error",
        (event) => {
          if (!cancelled) {
            const {
              tab_id: tabId,
              attempt_id: attemptId,
              data: payload,
            } = event.payload;
            const tab = useClaudeChatStore
              .getState()
              .tabs.find((candidate) => candidate.id === tabId);
            if (
              !tab?.isStreaming ||
              tab.runtime !== "claude" ||
              tab.activeAttemptId !== attemptId
            ) {
              return;
            }
            log.warn(`[${tabId}] stderr: ${payload}`);
            if (
              payload.includes("Error") ||
              payload.includes("error") ||
              payload.includes("ECONNREFUSED") ||
              payload.includes("timeout")
            ) {
              log.error(`[${tabId}] CRITICAL: ${payload}`);
            }
            const isDirectProvider = directProviderTabRef.current.get(tabId);
            const classified = classifyClaudeProcessStderr(
              payload,
              useSettingsStore.getState().uiLanguage,
            );
            const providerMessage =
              isDirectProvider || providerErrorMessage(payload)
                ? providerErrorMessage(payload) || payload.trim()
                : classified;
            if (providerMessage) {
              setUserVisibleError(tabId, providerMessage);
            } else if (classified) {
              setUserVisibleError(tabId, classified);
            }
            // Surface critical stderr messages to the user UI (only if no error is already set)
            if (
              (payload.includes("git-bash") ||
                payload.includes("git bash") ||
                payload.includes("bash.exe")) &&
              !useClaudeChatStore.getState().tabs.find((t) => t.id === tabId)
                ?.error
            ) {
              useClaudeChatStore
                .getState()
                ._setError(
                  tabId,
                  "Claude Code requires git-bash on Windows. Please install Git for Windows or set the CLAUDE_CODE_GIT_BASH_PATH environment variable.",
                );
            }
          }
        },
      );
      if (cancelled) {
        unlistenError();
        return;
      }
      listenersRef.current.push(unlistenError);

      const unlistenRuntime = await listen<RuntimeEventEnvelope>(
        "runtime-event",
        (event) => {
          if (!cancelled) void handleRuntimeEvent(event.payload);
        },
      );
      if (cancelled) {
        unlistenRuntime();
        return;
      }
      listenersRef.current.push(unlistenRuntime);
    })();

    return () => {
      cancelled = true;
      deltaBatcher.dispose();
      for (const unlisten of listenersRef.current) {
        unlisten();
      }
      listenersRef.current = [];
    };
  }, []); // mount-only
}
