import { useEffect, useState } from "react";
import { AgentEditor } from "@/components/agents/agent-editor";
import { Button } from "@/components/ui/button";
import { useAgentStore } from "@/stores/agent-store";
import type { AgentProfile } from "@/runtime/types";

export interface AgentLibraryProps {
  projectPath?: string | null;
}

export function AgentLibrary({ projectPath = null }: AgentLibraryProps) {
  const agents = useAgentStore((state) => state.agents);
  const loading = useAgentStore((state) => state.loading);
  const error = useAgentStore((state) => state.error);
  const refresh = useAgentStore((state) => state.refresh);
  const remove = useAgentStore((state) => state.remove);
  const [editing, setEditing] = useState<AgentProfile | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    void refresh("claude", projectPath ?? undefined);
  }, [projectPath, refresh]);

  return (
    <div className="space-y-4" data-testid="agent-library">
      <p className="text-muted-foreground text-xs">
        Custom subagents are stored in claude-home/agents next to the LocalPrism
        install folder, not ~/.claude.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          className="ml-auto"
          onClick={() => {
            setCreating(true);
            setEditing(null);
          }}
        >
          New agent
        </Button>
      </div>

      {error && <p className="text-destructive text-sm">{error}</p>}
      {loading && (
        <p className="text-muted-foreground text-sm">Loading agents…</p>
      )}

      {(creating || editing) && (
        <AgentEditor
          runtime="claude"
          projectPath={projectPath}
          initial={editing}
          onCancel={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
          }}
        />
      )}

      <ul className="space-y-2">
        {agents.map((agent) => (
          <li
            key={`${agent.scope}:${agent.id}:${agent.sourcePath}`}
            className="rounded-lg border border-border px-3 py-2"
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-medium text-sm">{agent.name}</p>
                <p className="text-muted-foreground text-xs">
                  {agent.scope} · {agent.id}
                </p>
                {agent.description && (
                  <p className="mt-1 text-xs">{agent.description}</p>
                )}
              </div>
              <div className="flex gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setEditing(agent);
                    setCreating(false);
                  }}
                >
                  Edit
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => void remove(agent, projectPath ?? undefined)}
                >
                  Delete
                </Button>
              </div>
            </div>
          </li>
        ))}
        {!loading && agents.length === 0 && !creating && !editing && (
          <li className="text-muted-foreground text-sm">
            No custom agents yet.
          </li>
        )}
      </ul>
    </div>
  );
}
