import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import type {
  AgentRun,
  AgentRunNode,
  AgentRunStatus,
  ConversationRef,
  RuntimeEvent,
} from "@/runtime/types";

function rootKey(root: ConversationRef): string {
  return `${root.runtime}:${root.sessionId}`;
}

function isTerminal(status: AgentRunStatus): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

function statusRank(status: AgentRunStatus): number {
  switch (status) {
    case "running":
      return 0;
    case "queued":
      return 1;
    default:
      return 2;
  }
}

export function mergeAgentRun(
  existing: AgentRun | undefined,
  incoming: AgentRun,
): AgentRun {
  if (!existing) return incoming;
  const merged: AgentRun = {
    ...existing,
    parentId: existing.parentId ?? incoming.parentId,
    agentName: incoming.agentName || existing.agentName,
    agentRole: incoming.agentRole ?? existing.agentRole,
    model: incoming.model ?? existing.model,
    activity: incoming.activity ?? existing.activity,
    summary: incoming.summary ?? existing.summary,
    error: incoming.error ?? existing.error,
    transcriptAvailable:
      existing.transcriptAvailable || incoming.transcriptAvailable,
    startedAt: Math.min(existing.startedAt, incoming.startedAt),
    status: existing.status,
    completedAt: existing.completedAt,
  };

  if (isTerminal(existing.status) && !isTerminal(incoming.status)) {
    return merged;
  }

  merged.status = incoming.status;
  merged.completedAt = isTerminal(incoming.status)
    ? (incoming.completedAt ?? existing.completedAt)
    : null;
  return merged;
}

export function buildAgentRunTree(runs: AgentRun[]): AgentRunNode[] {
  const nodes = new Map<string, AgentRunNode>();
  for (const run of runs) {
    nodes.set(run.id, { ...run, children: [] });
  }

  const roots: AgentRunNode[] = [];
  for (const node of nodes.values()) {
    if (
      node.parentId &&
      nodes.has(node.parentId) &&
      node.parentId !== node.id
    ) {
      nodes.get(node.parentId)?.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const sortNodes = (list: AgentRunNode[]) => {
    list.sort(
      (left, right) =>
        statusRank(left.status) - statusRank(right.status) ||
        left.startedAt - right.startedAt ||
        left.id.localeCompare(right.id),
    );
    for (const node of list) {
      sortNodes(node.children);
    }
  };
  sortNodes(roots);
  return roots;
}

interface AgentRunStoreState {
  runsByRoot: Record<string, Record<string, AgentRun>>;
  selectedRunId: string | null;
  applyEvent: (root: ConversationRef, event: RuntimeEvent) => void;
  restore: (root: ConversationRef) => Promise<void>;
  selectRun: (id: string | null) => void;
  tree: (root: ConversationRef) => AgentRunNode[];
  reset: () => void;
}

export const useAgentRunStore = create<AgentRunStoreState>((set, get) => ({
  runsByRoot: {},
  selectedRunId: null,

  applyEvent: (root, event) => {
    if (
      event.type !== "subagentDiscovered" &&
      event.type !== "subagentStatusChanged"
    ) {
      return;
    }
    const key = rootKey(root);
    set((state) => {
      const current = state.runsByRoot[key] ?? {};
      const merged = mergeAgentRun(current[event.run.id], {
        ...event.run,
        rootConversationId: event.run.rootConversationId || root.sessionId,
        runtime: event.run.runtime || root.runtime,
      });
      return {
        runsByRoot: {
          ...state.runsByRoot,
          [key]: {
            ...current,
            [merged.id]: merged,
          },
        },
      };
    });
  },

  restore: async (root) => {
    const runs = await invoke<AgentRun[]>("runtime_agent_runs", {
      runtime: root.runtime,
      rootConversationId: root.sessionId,
      projectPath: root.projectPath,
    });
    const key = rootKey(root);
    set((state) => {
      const current = state.runsByRoot[key] ?? {};
      const next = { ...current };
      for (const run of runs) {
        next[run.id] = mergeAgentRun(next[run.id], run);
      }
      return {
        runsByRoot: {
          ...state.runsByRoot,
          [key]: next,
        },
      };
    });
  },

  selectRun: (id) => set({ selectedRunId: id }),

  tree: (root) => {
    const runs = Object.values(get().runsByRoot[rootKey(root)] ?? {});
    return buildAgentRunTree(runs);
  },

  reset: () => set({ runsByRoot: {}, selectedRunId: null }),
}));
