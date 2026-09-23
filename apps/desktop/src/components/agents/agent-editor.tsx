import { useEffect, useMemo, useState } from "react";
import type { AgentProfile, RuntimeKind, SkillScope } from "@/runtime/types";
import { emptyAgentProfile, useAgentStore } from "@/stores/agent-store";
import { useSkillStore } from "@/stores/skill-store";
import { useProviderStore } from "@/stores/provider-store";
import {
  skillAssignmentAliases,
  skillAssignmentId,
  skillMatchesAssignmentId,
  skillsCompatibleWith,
} from "@/lib/compatible-skills";
import {
  formatReasoningEffortLabel,
  normalizeReasoningEffortOptions,
  resolveReasoningEffort,
} from "@/lib/reasoning-effort";
import { PERMISSION_MODE_OPTIONS } from "@/lib/permission-mode";
import { AgentSkillPicker } from "@/components/agents/agent-skill-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/lib/use-i18n";

export interface AgentEditorProps {
  runtime?: RuntimeKind;
  projectPath?: string | null;
  /** Saved agent being edited. Saving overwrites that file. */
  initial?: AgentProfile | null;
  /** Draft for a new agent, including preset name, prompt, and skills. */
  seed?: AgentProfile | null;
  onSaved?: (profile: AgentProfile) => void;
  onCancel?: () => void;
}

export function AgentEditor({
  runtime: _runtime = "claude",
  projectPath,
  initial = null,
  seed = null,
  onSaved,
  onCancel,
}: AgentEditorProps) {
  const { t } = useI18n();
  const runtime: RuntimeKind = "claude";
  const save = useAgentStore((state) => state.save);
  const error = useAgentStore((state) => state.error);
  const skills = useSkillStore((state) => state.skills);
  const skillsLoading = useSkillStore((state) => state.loading);
  const skillsError = useSkillStore((state) => state.error);
  const refreshSkills = useSkillStore((state) => state.refresh);
  const catalogModels = useProviderStore((state) => state.models);
  const [profile, setProfile] = useState<AgentProfile>(
    () => initial ?? seed ?? emptyAgentProfile(runtime, "user"),
  );
  const [overwrite, setOverwrite] = useState(false);
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [awaitingSkills, setAwaitingSkills] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setAwaitingSkills(true);
    void refreshSkills(projectPath ?? undefined).finally(() => {
      if (!cancelled) setAwaitingSkills(false);
    });
    return () => {
      cancelled = true;
    };
  }, [projectPath, refreshSkills]);

  const catalogReady = !awaitingSkills && !skillsLoading;

  const compatibleSkills = useMemo(
    () => skillsCompatibleWith(skills, runtime, profile.scope),
    [skills, runtime, profile.scope],
  );

  const modelOptions = useMemo(() => {
    const options = catalogModels.map((model) => ({
      id: model.id,
      label: model.displayName || model.id,
    }));
    const current = profile.model?.trim();
    if (current && !options.some((model) => model.id === current)) {
      options.push({ id: current, label: current });
    }
    return options;
  }, [catalogModels, profile.model]);

  const catalogEfforts = useMemo(() => {
    const selected = catalogModels.find((model) => model.id === profile.model);
    return normalizeReasoningEffortOptions(selected?.reasoningEfforts);
  }, [catalogModels, profile.model]);

  const effortOptions = useMemo(() => {
    const options = [...catalogEfforts];
    const current = profile.reasoningEffort?.trim();
    if (current && !options.includes(current)) {
      options.push(current);
    }
    return options;
  }, [catalogEfforts, profile.reasoningEffort]);

  const selectedApproval = PERMISSION_MODE_OPTIONS.find(
    (option) => option.id === profile.permissionMode,
  );

  const update = <K extends keyof AgentProfile>(
    key: K,
    value: AgentProfile[K],
  ) => {
    setProfile((current) => ({ ...current, [key]: value }));
  };

  const onModelChange = (nextModel: string | null) => {
    setProfile((current) => {
      const selected = catalogModels.find((model) => model.id === nextModel);
      const nextEfforts = normalizeReasoningEffortOptions(
        selected?.reasoningEfforts,
      );
      const nextEffort = nextModel
        ? resolveReasoningEffort(current.reasoningEffort, nextEfforts)
        : current.reasoningEffort;
      return {
        ...current,
        model: nextModel,
        reasoningEffort: nextEffort,
      };
    });
  };

  const toggleSkill = (skillId: string, enabled: boolean) => {
    setProfile((current) => {
      const skill = compatibleSkills.find((item) =>
        skillMatchesAssignmentId(item, skillId),
      );
      const aliases = new Set(
        skill ? skillAssignmentAliases(skill) : [skillId],
      );
      aliases.add(skillId);
      const next = current.skillIds.filter((id) => !aliases.has(id));
      if (enabled) {
        next.push(skill ? skillAssignmentId(skill) : skillId);
      }
      return { ...current, skillIds: next };
    });
  };

  const onSubmit = async () => {
    if (!catalogReady) return;
    setSaving(true);
    setLocalError(null);
    try {
      const saved = await save(
        {
          ...profile,
          runtime,
          id: profile.id || profile.name,
          skillIds: profile.skillIds.filter((skillId) =>
            compatibleSkills.some((skill) =>
              skillMatchesAssignmentId(skill, skillId),
            ),
          ),
        },
        projectPath ?? undefined,
        overwrite || Boolean(initial),
      );
      onSaved?.(saved);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3" data-testid="agent-editor">
      <div className="grid gap-2">
        <Label htmlFor="agent-name">{t("providers.name")}</Label>
        <Input
          id="agent-name"
          value={profile.name}
          onChange={(event) => update("name", event.target.value)}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="agent-description">{t("agents.description")}</Label>
        <Input
          id="agent-description"
          value={profile.description}
          onChange={(event) => update("description", event.target.value)}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="agent-scope">{t("agents.scope")}</Label>
        <select
          id="agent-scope"
          className="rounded-md border border-border bg-background px-3 py-2 text-sm"
          value={profile.scope}
          onChange={(event) =>
            update("scope", event.target.value as SkillScope)
          }
          disabled={!projectPath && profile.scope === "user"}
        >
          <option value="user">{t("agents.user")}</option>
          <option value="project" disabled={!projectPath}>
            {t("agents.project")}
          </option>
        </select>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="agent-model">{t("providers.model")}</Label>
        <select
          id="agent-model"
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          value={profile.model ?? ""}
          onChange={(event) =>
            onModelChange(event.target.value.trim() ? event.target.value : null)
          }
        >
          <option value="">{t("agents.workspaceDefault")}</option>
          {modelOptions.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="agent-effort">{t("agents.effort")}</Label>
        <select
          id="agent-effort"
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          value={profile.reasoningEffort ?? ""}
          onChange={(event) =>
            update(
              "reasoningEffort",
              event.target.value.trim() ? event.target.value : null,
            )
          }
        >
          <option value="">{t("agents.workspaceDefault")}</option>
          {effortOptions.map((effort) => (
            <option key={effort} value={effort}>
              {formatReasoningEffortLabel(effort) || effort}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="agent-permission">{t("agents.approvals")}</Label>
        <select
          id="agent-permission"
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          value={profile.permissionMode ?? ""}
          onChange={(event) =>
            update(
              "permissionMode",
              event.target.value.trim() ? event.target.value : null,
            )
          }
        >
          <option value="">{t("agents.useWorkspaceDefault")}</option>
          {PERMISSION_MODE_OPTIONS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        {selectedApproval && (
          <p className="text-muted-foreground text-xs">
            {selectedApproval.description}
          </p>
        )}
      </div>
      <div className="grid gap-2">
        <Label>{t("agents.assigned")}</Label>
        <p className="text-muted-foreground text-xs">
          {t("agents.assignedHelp", { scope: profile.scope })}
          {profile.scope === "project" ? ` ${t("agents.projectHint")}` : null}
        </p>
        {!catalogReady ? (
          <p className="text-muted-foreground text-sm">
            {t("agents.loadingSkills")}
          </p>
        ) : skillsError && compatibleSkills.length === 0 ? (
          <p className="text-destructive text-sm">{skillsError}</p>
        ) : compatibleSkills.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {t("agents.noCompatible")}
          </p>
        ) : (
          <AgentSkillPicker
            skills={compatibleSkills}
            selectedIds={profile.skillIds}
            onToggle={toggleSkill}
          />
        )}
      </div>
      <div className="grid gap-2">
        <Label htmlFor="agent-instructions">{t("agents.instructions")}</Label>
        <Textarea
          id="agent-instructions"
          rows={8}
          value={profile.instructions}
          onChange={(event) => update("instructions", event.target.value)}
        />
      </div>
      {!initial && (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={overwrite}
            onChange={(event) => setOverwrite(event.target.checked)}
          />
          {t("agents.overwrite")}
        </label>
      )}
      {(localError || error) && (
        <p className="text-destructive text-sm">{localError || error}</p>
      )}
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t("chrome.cancel")}
          </Button>
        )}
        <Button
          type="button"
          disabled={saving || !catalogReady || !profile.name.trim()}
          onClick={() => void onSubmit()}
        >
          {saving ? t("agents.saving") : t("agents.save")}
        </Button>
      </div>
    </div>
  );
}
