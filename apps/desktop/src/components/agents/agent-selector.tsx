import { useEffect, useMemo } from "react";
import { useAgentStore } from "@/stores/agent-store";
import { cn } from "@/lib/utils";
import {
  wireRuntimeFromPeer,
  type AgentProfile,
  type ChatRuntimePeer,
  type RuntimeKind,
} from "@/runtime/types";

export interface AgentSelectorProps {
  peer: ChatRuntimePeer;
  projectPath?: string | null;
  agentId: string | null;
  busy?: boolean;
  /** Called with the selected agent profile, or null for Default. */
  onAgentChange: (agent: AgentProfile | null) => void;
}

export function AgentSelector({
  peer,
  projectPath,
  agentId,
  busy = false,
  onAgentChange,
}: AgentSelectorProps) {
  const runtime: RuntimeKind = wireRuntimeFromPeer(peer);
  const agents = useAgentStore((state) => state.agents);
  const loading = useAgentStore((state) => state.loading);
  const refresh = useAgentStore((state) => state.refresh);

  useEffect(() => {
    void refresh(runtime, projectPath ?? undefined);
  }, [runtime, projectPath, refresh]);

  const options = useMemo(
    () => (agents ?? []).filter((agent) => agent.runtime === runtime),
    [agents, runtime],
  );

  const selected = options.find((agent) => agent.id === agentId) ?? null;

  return (
    <div className="px-2 pb-2">
      <label
        htmlFor="composer-agent-select"
        className="mb-1 block font-medium text-muted-foreground text-xs"
      >
        Agent
      </label>
      <select
        id="composer-agent-select"
        aria-label="Select custom agent"
        className={cn(
          "w-full rounded-lg border border-border bg-background px-3 py-2 text-xs",
          "disabled:cursor-not-allowed disabled:opacity-50",
        )}
        disabled={busy || loading}
        value={selected?.id ?? ""}
        onChange={(event) => {
          const next = event.target.value.trim();
          if (!next) {
            onAgentChange(null);
            return;
          }
          onAgentChange(options.find((agent) => agent.id === next) ?? null);
        }}
      >
        <option value="">Default</option>
        {options.map((agent) => (
          <option key={`${agent.scope}:${agent.id}`} value={agent.id}>
            {agent.name}
            {agent.scope === "project" ? " (project)" : ""}
          </option>
        ))}
      </select>
    </div>
  );
}
