import type { AgentRunNode } from "@/runtime/types";

interface SubagentTreeProps {
  nodes: AgentRunNode[];
  selectedRunId: string | null;
  onSelect: (id: string) => void;
  depth?: number;
}

export function SubagentTree({
  nodes,
  selectedRunId,
  onSelect,
  depth = 0,
}: SubagentTreeProps) {
  return (
    <ul className="space-y-1">
      {nodes.map((node) => (
        <li key={node.id}>
          <button
            type="button"
            className={`flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
              selectedRunId === node.id
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:bg-muted/60"
            }`}
            style={{ paddingLeft: `${0.5 + depth * 0.75}rem` }}
            onClick={() => onSelect(node.id)}
          >
            <span className="min-w-0 flex-1 truncate font-medium text-foreground">
              {node.agentName}
            </span>
            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase">
              {node.runtime}
            </span>
            {node.model && (
              <span className="shrink-0 text-[10px]">{node.model}</span>
            )}
          </button>
          {node.children.length > 0 && (
            <SubagentTree
              nodes={node.children}
              selectedRunId={selectedRunId}
              onSelect={onSelect}
              depth={depth + 1}
            />
          )}
        </li>
      ))}
    </ul>
  );
}
