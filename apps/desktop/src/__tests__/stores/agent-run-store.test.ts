import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { buildAgentRunTree, useAgentRunStore } from "@/stores/agent-run-store";
import type { AgentRun, ConversationRef } from "@/runtime/types";

const root: ConversationRef = {
  runtime: "codex",
  sessionId: "root",
  projectPath: "/tmp/paper",
};

function run(
  id: string,
  status: AgentRun["status"],
  parentId: string | null = "root",
): AgentRun {
  return {
    id,
    parentId,
    rootConversationId: "root",
    runtime: "codex",
    agentName: id,
    agentRole: null,
    model: "gpt-5.4",
    status,
    startedAt: 100,
    completedAt: status === "completed" ? 200 : null,
    activity: status,
    summary: null,
    error: null,
    transcriptAvailable: true,
  };
}

describe("agent-run-store", () => {
  beforeEach(() => {
    useAgentRunStore.getState().reset();
    vi.mocked(invoke).mockReset();
  });

  it("accepts child before parent and keeps terminal monotonic", () => {
    const store = useAgentRunStore.getState();
    store.applyEvent(root, {
      type: "subagentDiscovered",
      run: run("child", "running", null),
    });
    store.applyEvent(root, {
      type: "subagentStatusChanged",
      run: run("child", "running", "root"),
    });
    store.applyEvent(root, {
      type: "subagentStatusChanged",
      run: run("child", "completed", "root"),
    });
    store.applyEvent(root, {
      type: "subagentStatusChanged",
      run: run("child", "running", "root"),
    });

    const saved = useAgentRunStore.getState().runsByRoot["codex:root"]?.child;
    expect(saved?.parentId).toBe("root");
    expect(saved?.status).toBe("completed");
  });

  it("builds a tree with running-first ordering", () => {
    const tree = buildAgentRunTree([
      run("done", "completed"),
      run("active", "running"),
      run("nested", "queued", "active"),
    ]);
    expect(tree.map((node) => node.id)).toEqual(["active", "done"]);
    expect(tree[0]?.children.map((node) => node.id)).toEqual(["nested"]);
  });

  it("merges recovery without changing selection of another root", async () => {
    vi.mocked(invoke).mockResolvedValue([run("recovered", "completed")]);
    const store = useAgentRunStore.getState();
    store.applyEvent(
      { ...root, sessionId: "other" },
      {
        type: "subagentDiscovered",
        run: { ...run("x", "running"), rootConversationId: "other" },
      },
    );
    store.selectRun("x");
    await store.restore(root);
    expect(useAgentRunStore.getState().selectedRunId).toBe("x");
    expect(
      useAgentRunStore.getState().runsByRoot["codex:root"]?.recovered?.status,
    ).toBe("completed");
  });
});
