import { useEffect, useState } from "react";
import { AgentEditor } from "@/components/agents/agent-editor";
import { Button } from "@/components/ui/button";
import {
  PRESET_AGENTS,
  buildPresetAgentProfile,
  type PresetAgentId,
} from "@/lib/preset-agents";
import { useAgentStore } from "@/stores/agent-store";
import { useSkillStore } from "@/stores/skill-store";
import type { AgentProfile } from "@/runtime/types";

export interface AgentLibraryProps {
  projectPath?: string | null;
}

export function AgentLibrary({ projectPath = null }: AgentLibraryProps) {
  const agents = useAgentStore((state) => state.agents);
  const loading = useAgentStore((state) => state.loading);
  const error = useAgentStore((state) => state.error);
  const refresh = useAgentStore((state) => state.refresh);
  const save = useAgentStore((state) => state.save);
  const remove = useAgentStore((state) => state.remove);
  const refreshSkills = useSkillStore((state) => state.refresh);
  const [editing, setEditing] = useState<AgentProfile | null>(null);
  const [creating, setCreating] = useState(false);
  const [creatingPreset, setCreatingPreset] = useState<PresetAgentId | null>(
    null,
  );

  useEffect(() => {
    void refresh("claude", projectPath ?? undefined);
  }, [projectPath, refresh]);

  const installedIds = new Set(agents.map((agent) => agent.id));
  const availablePresets = PRESET_AGENTS.filter(
    (preset) => !installedIds.has(preset.id),
  );
  const showPresets =
    !loading && !creating && !editing && availablePresets.length > 0;

  const addPreset = async (presetId: PresetAgentId) => {
    setCreatingPreset(presetId);
    try {
      await refreshSkills(projectPath ?? undefined);
      const profile = buildPresetAgentProfile(
        presetId,
        useSkillStore.getState().skills,
        { projectPath },
      );
      await save(profile, projectPath ?? undefined, false);
    } catch {
      // save() records the error on the agent store
    } finally {
      setCreatingPreset(null);
    }
  };

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

      {showPresets && (
        <div className="space-y-2" data-testid="agent-presets">
          {agents.length === 0 && (
            <p className="text-muted-foreground text-sm">
              No custom agents yet.
            </p>
          )}
          <p className="text-muted-foreground text-xs">
            Matching installed Skills are attached when you add a preset. If
            none are installed, the preset still runs from its built-in
            instructions.
          </p>
          <div className="grid gap-2">
            {availablePresets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                data-testid={`agent-preset-${preset.id}`}
                disabled={creatingPreset !== null}
                onClick={() => void addPreset(preset.id)}
                className="rounded-lg border border-border px-3 py-2 text-left transition-colors hover:bg-muted/50 disabled:opacity-60"
              >
                <span className="font-medium text-sm">
                  {creatingPreset === preset.id ? "Adding…" : preset.name}
                </span>
                <span className="mt-1 block text-xs">{preset.summaryZh}</span>
                <span className="mt-0.5 block text-muted-foreground text-xs">
                  {preset.summaryEn}
                </span>
              </button>
            ))}
            {agents.length === 0 && (
              <button
                type="button"
                data-testid="agent-preset-custom"
                disabled={creatingPreset !== null}
                onClick={() => {
                  setCreating(true);
                  setEditing(null);
                }}
                className="rounded-lg border border-border border-dashed px-3 py-2 text-left transition-colors hover:bg-muted/50 disabled:opacity-60"
              >
                <span className="font-medium text-sm">Custom agent</span>
                <span className="mt-1 block text-xs">空白自定义</span>
                <span className="mt-0.5 block text-muted-foreground text-xs">
                  Blank agent with your own instructions.
                </span>
              </button>
            )}
          </div>
        </div>
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
      </ul>
    </div>
  );
}
