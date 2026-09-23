import { useEffect, useRef, useState } from "react";
import { AgentEditor } from "@/components/agents/agent-editor";
import { Button } from "@/components/ui/button";
import {
  BUILTIN_AGENT_PRESETS,
  buildPresetAgentProfile,
  type BuiltinAgentPresetId,
} from "@/lib/agent-presets";
import { useAgentStore } from "@/stores/agent-store";
import { useSkillStore } from "@/stores/skill-store";
import type { AgentProfile } from "@/runtime/types";
import { useI18n } from "@/lib/use-i18n";

export interface AgentLibraryProps {
  projectPath?: string | null;
}

export function AgentLibrary({ projectPath = null }: AgentLibraryProps) {
  const agents = useAgentStore((state) => state.agents);
  const loading = useAgentStore((state) => state.loading);
  const error = useAgentStore((state) => state.error);
  const refresh = useAgentStore((state) => state.refresh);
  const remove = useAgentStore((state) => state.remove);
  const refreshSkills = useSkillStore((state) => state.refresh);
  const [editing, setEditing] = useState<AgentProfile | null>(null);
  const [creating, setCreating] = useState(false);
  const [seed, setSeed] = useState<AgentProfile | null>(null);
  const [preparingPreset, setPreparingPreset] = useState(false);
  const presetRequest = useRef(0);
  const { t } = useI18n();

  useEffect(() => {
    void refresh("claude", projectPath ?? undefined);
  }, [projectPath, refresh]);

  const startCustom = () => {
    presetRequest.current += 1;
    setPreparingPreset(false);
    setSeed(null);
    setCreating(true);
    setEditing(null);
  };

  const startPreset = async (id: BuiltinAgentPresetId) => {
    const request = ++presetRequest.current;
    setPreparingPreset(true);
    await refreshSkills(projectPath ?? undefined);
    if (request !== presetRequest.current) return;
    setSeed(
      buildPresetAgentProfile(id, useSkillStore.getState().skills, {
        projectPath,
      }),
    );
    setCreating(true);
    setEditing(null);
    setPreparingPreset(false);
  };

  return (
    <div className="space-y-4" data-testid="agent-library">
      <p className="text-muted-foreground text-xs">{t("agents.storage")}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          className="ml-auto"
          onClick={startCustom}
        >
          {t("agents.new")}
        </Button>
      </div>

      {error && <p className="text-destructive text-sm">{error}</p>}
      {loading && (
        <p className="text-muted-foreground text-sm">{t("agents.loading")}</p>
      )}

      {(creating || editing) && (
        <AgentEditor
          key={
            editing
              ? `edit:${editing.scope}:${editing.id}`
              : (seed?.id ?? "custom")
          }
          runtime="claude"
          projectPath={projectPath}
          initial={editing}
          seed={editing ? null : seed}
          onCancel={() => {
            presetRequest.current += 1;
            setPreparingPreset(false);
            setCreating(false);
            setEditing(null);
            setSeed(null);
          }}
          onSaved={() => {
            presetRequest.current += 1;
            setPreparingPreset(false);
            setCreating(false);
            setEditing(null);
            setSeed(null);
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
                    presetRequest.current += 1;
                    setPreparingPreset(false);
                    setSeed(null);
                    setEditing(agent);
                    setCreating(false);
                  }}
                >
                  {t("agents.edit")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => void remove(agent, projectPath ?? undefined)}
                >
                  {t("agents.delete")}
                </Button>
              </div>
            </div>
          </li>
        ))}
        {!loading && agents.length === 0 && !creating && !editing && (
          <li data-testid="agent-preset-empty" className="space-y-3">
            <div>
              <p className="font-medium text-sm">{t("agents.empty")}</p>
              <p className="mt-1 text-muted-foreground text-xs">
                {t("agents.emptyHint")}
              </p>
            </div>
            <div className="grid gap-2">
              {BUILTIN_AGENT_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  data-testid={`agent-preset-${preset.id}`}
                  className="rounded-lg border border-border px-3 py-2 text-left hover:bg-muted/60 disabled:opacity-60"
                  disabled={preparingPreset}
                  onClick={() => void startPreset(preset.id)}
                >
                  <span className="font-medium text-sm">{preset.name}</span>
                  <span className="text-muted-foreground text-xs">
                    {" "}
                    · {preset.titleSecondary}
                  </span>
                  <p className="mt-1 text-muted-foreground text-xs">
                    {preset.description}
                  </p>
                </button>
              ))}
              <Button
                type="button"
                size="sm"
                variant="outline"
                data-testid="agent-preset-custom"
                disabled={preparingPreset}
                onClick={startCustom}
              >
                {t("agents.custom")}
              </Button>
            </div>
            {preparingPreset && (
              <p className="text-muted-foreground text-xs">
                {t("agents.checkingSkills")}
              </p>
            )}
          </li>
        )}
      </ul>
    </div>
  );
}
