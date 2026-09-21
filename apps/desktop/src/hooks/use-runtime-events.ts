import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { normalizeRuntimeEnvelope } from "@/runtime/event-normalizer";
import type { RuntimeEventEnvelope } from "@/runtime/types";
import { useAgentRunStore } from "@/stores/agent-run-store";
import { useApprovalStore } from "@/stores/approval-store";
import { useClaudeChatStore } from "@/stores/claude-chat-store";

/**
 * Shared subscription for approval/subagent runtime events.
 * Chat streaming remains owned by `useClaudeEvents` to avoid double-handling
 * message deltas.
 */
export function useRuntimeEvents() {
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    void (async () => {
      try {
        await invoke("runtime_approvals_set_ready", { ready: true });
      } catch {
        // Headless/test environments may not expose the command.
      }

      unlisten = await listen<RuntimeEventEnvelope>(
        "runtime-event",
        (event) => {
          if (cancelled) return;
          const normalized = normalizeRuntimeEnvelope(event.payload);
          if (!normalized.ok) return;
          routeRuntimeSideEffects(normalized.value);
        },
      );
    })();

    return () => {
      cancelled = true;
      unlisten?.();
      void invoke("runtime_approvals_set_ready", { ready: false }).catch(
        () => undefined,
      );
    };
  }, []);
}

export function routeRuntimeSideEffects(envelope: RuntimeEventEnvelope): void {
  const { event, sessionId, tabId } = envelope;
  switch (event.type) {
    case "approvalResolved":
      useApprovalStore.getState().dismiss(event.requestId);
      break;
    case "approvalRequested":
    case "userInputRequested": {
      const request = {
        ...event.request,
        tabId: event.request.tabId || tabId,
        threadId: event.request.threadId ?? sessionId,
        turnId: event.request.turnId ?? envelope.turnId,
        runtime: event.request.runtime || envelope.runtime,
      };
      if (
        event.type === "approvalRequested" &&
        !isKnownApprovalMethod(request.method)
      ) {
        void useApprovalStore.getState().rejectUnknown(request);
        return;
      }
      useApprovalStore.getState().enqueue(request);
      break;
    }
    case "subagentDiscovered":
    case "subagentStatusChanged": {
      const tab = useClaudeChatStore
        .getState()
        .tabs.find((candidate) => candidate.id === tabId);
      const rootSessionId =
        event.run.rootConversationId ||
        sessionId ||
        tab?.sessionId ||
        event.run.id;
      useAgentRunStore.getState().applyEvent(
        {
          runtime: event.run.runtime || envelope.runtime,
          sessionId: rootSessionId,
          projectPath: "",
        },
        event,
      );
      break;
    }
    default:
      break;
  }
}

function isKnownApprovalMethod(method: string): boolean {
  return (
    method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval" ||
    method === "item/permissions/requestApproval" ||
    method === "item/tool/requestUserInput" ||
    method === "claude/can_use_tool"
  );
}
