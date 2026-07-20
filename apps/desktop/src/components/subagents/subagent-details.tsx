import type { AgentRun } from "@/runtime/types";

interface SubagentDetailsProps {
  run: AgentRun | null;
}

export function SubagentDetails({ run }: SubagentDetailsProps) {
  if (!run) {
    return (
      <div className="px-3 py-2 text-muted-foreground text-xs">
        Select a subagent to inspect activity.
      </div>
    );
  }

  const elapsedMs = Math.max(
    0,
    (run.completedAt ?? Date.now()) - run.startedAt,
  );
  const elapsedLabel =
    elapsedMs < 1000 ? `${elapsedMs}ms` : `${Math.round(elapsedMs / 1000)}s`;

  return (
    <div className="space-y-1 border-border border-t px-3 py-2 text-xs">
      <div className="font-medium text-foreground">{run.agentName}</div>
      <div className="text-muted-foreground">
        Status: {run.status} · Elapsed: {elapsedLabel}
      </div>
      {run.activity && <div>Activity: {run.activity}</div>}
      {run.summary && <div>Summary: {run.summary}</div>}
      {run.error && <div className="text-destructive">Error: {run.error}</div>}
      {!run.transcriptAvailable && (
        <div className="text-muted-foreground">Transcript unavailable</div>
      )}
    </div>
  );
}
