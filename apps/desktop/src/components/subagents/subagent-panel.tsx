import { useEffect, useMemo, useState } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import type { AgentRunNode, ConversationRef } from "@/runtime/types";
import { useAgentRunStore } from "@/stores/agent-run-store";
import { useClaudeChatStore } from "@/stores/claude-chat-store";
import { SubagentDetails } from "./subagent-details";
import { SubagentTree } from "./subagent-tree";

function isActiveStatus(status: string): boolean {
  return status === "queued" || status === "running";
}

function filterTree(
  nodes: AgentRunNode[],
  predicate: (node: AgentRunNode) => boolean,
): AgentRunNode[] {
  return nodes
    .map((node) => ({
      ...node,
      children: filterTree(node.children, predicate),
    }))
    .filter((node) => predicate(node) || node.children.length > 0);
}

export function SubagentPanel() {
  const activeTab = useClaudeChatStore((state) =>
    state.tabs.find((tab) => tab.id === state.activeTabId),
  );
  const selectedRunId = useAgentRunStore((state) => state.selectedRunId);
  const selectRun = useAgentRunStore((state) => state.selectRun);
  const runsByRoot = useAgentRunStore((state) => state.runsByRoot);
  const projectPath = useClaudeChatStore(
    (state) => state.activeProjectPath ?? "",
  );

  const root: ConversationRef | null = activeTab?.sessionId
    ? {
        runtime: activeTab.runtime === "codex" ? "codex" : "claude",
        sessionId: activeTab.sessionId,
        projectPath,
      }
    : null;

  useEffect(() => {
    if (!root) return;
    void useAgentRunStore.getState().restore(root);
  }, [root?.runtime, root?.sessionId, root?.projectPath]);

  const runs = useMemo(() => {
    if (!root) return [];
    return Object.values(runsByRoot[`${root.runtime}:${root.sessionId}`] ?? {});
  }, [root, runsByRoot]);

  const tree = useMemo(() => {
    if (!root) return [];
    return useAgentRunStore.getState().tree(root);
  }, [root, runs]);

  const active = runs.filter((run) => isActiveStatus(run.status));
  const done = runs.filter((run) => !isActiveStatus(run.status));
  const [open, setOpen] = useState(true);
  const selected =
    runs.find((run) => run.id === selectedRunId) ??
    active[0] ??
    done[0] ??
    null;

  if (!root || runs.length === 0) {
    return null;
  }

  const expanded = active.length > 0 || open;

  return (
    <section
      className="border-border border-b"
      data-testid="subagent-panel"
      aria-label="Subagents"
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left font-medium text-xs"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDownIcon className="size-3.5" />
        ) : (
          <ChevronRightIcon className="size-3.5" />
        )}
        Subagents
        <span className="text-muted-foreground">
          {active.length} active · {done.length} done
        </span>
      </button>
      {expanded && (
        <div className="pb-2">
          {active.length > 0 && (
            <div className="px-3 pb-1">
              <div className="mb-1 text-[10px] text-muted-foreground uppercase tracking-wide">
                Active
              </div>
              <SubagentTree
                nodes={filterTree(tree, (node) => isActiveStatus(node.status))}
                selectedRunId={selected?.id ?? null}
                onSelect={selectRun}
              />
            </div>
          )}
          {done.length > 0 && (
            <div className="px-3 pb-1">
              <div className="mb-1 text-[10px] text-muted-foreground uppercase tracking-wide">
                Done
              </div>
              <SubagentTree
                nodes={filterTree(tree, (node) => !isActiveStatus(node.status))}
                selectedRunId={selected?.id ?? null}
                onSelect={selectRun}
              />
            </div>
          )}
          <SubagentDetails run={selected} />
        </div>
      )}
    </section>
  );
}
