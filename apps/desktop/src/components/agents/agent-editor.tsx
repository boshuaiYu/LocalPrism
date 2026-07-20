import { useEffect, useMemo, useState } from "react";
import type { AgentProfile, RuntimeKind, SkillScope } from "@/runtime/types";
import { emptyAgentProfile, useAgentStore } from "@/stores/agent-store";
import { useSkillStore } from "@/stores/skill-store";
import {
  skillAssignmentId,
  skillsCompatibleWith,
} from "@/lib/compatible-skills";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

export interface AgentEditorProps {
  runtime: RuntimeKind;
  projectPath?: string | null;
  initial?: AgentProfile | null;
  onSaved?: (profile: AgentProfile) => void;
  onCancel?: () => void;
}

export function AgentEditor({
  runtime,
  projectPath,
  initial = null,
  onSaved,
  onCancel,
}: AgentEditorProps) {
  const save = useAgentStore((state) => state.save);
  const error = useAgentStore((state) => state.error);
  const skills = useSkillStore((state) => state.skills);
  const refreshSkills = useSkillStore((state) => state.refresh);
  const [profile, setProfile] = useState<AgentProfile>(
    () =>
      initial ?? emptyAgentProfile(runtime, projectPath ? "project" : "user"),
  );
  const [overwrite, setOverwrite] = useState(false);
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    void refreshSkills(projectPath ?? undefined);
  }, [projectPath, refreshSkills]);

  const compatibleSkills = useMemo(
    () => skillsCompatibleWith(skills, runtime, profile.scope),
    [skills, runtime, profile.scope],
  );

  const update = <K extends keyof AgentProfile>(
    key: K,
    value: AgentProfile[K],
  ) => {
    setProfile((current) => ({ ...current, [key]: value }));
  };

  const toggleSkill = (skillId: string, enabled: boolean) => {
    setProfile((current) => {
      const next = new Set(current.skillIds);
      if (enabled) next.add(skillId);
      else next.delete(skillId);
      return { ...current, skillIds: [...next] };
    });
  };

  const onSubmit = async () => {
    setSaving(true);
    setLocalError(null);
    try {
      const saved = await save(
        {
          ...profile,
          runtime,
          id: profile.id || profile.name,
          // Persist only skills still compatible with the chosen runtime/scope.
          skillIds: profile.skillIds.filter((skillId) =>
            compatibleSkills.some(
              (skill) =>
                skillAssignmentId(skill) === skillId ||
                skill.id === skillId ||
                skill.folder === skillId ||
                skill.name === skillId,
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
        <Label htmlFor="agent-name">Name</Label>
        <Input
          id="agent-name"
          value={profile.name}
          onChange={(event) => update("name", event.target.value)}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="agent-description">Description</Label>
        <Input
          id="agent-description"
          value={profile.description}
          onChange={(event) => update("description", event.target.value)}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="agent-scope">Scope</Label>
        <select
          id="agent-scope"
          className="rounded-md border border-border bg-background px-3 py-2 text-sm"
          value={profile.scope}
          onChange={(event) =>
            update("scope", event.target.value as SkillScope)
          }
          disabled={!projectPath && profile.scope === "user"}
        >
          <option value="user">User</option>
          <option value="project" disabled={!projectPath}>
            Project
          </option>
        </select>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="agent-model">Model</Label>
        <Input
          id="agent-model"
          value={profile.model ?? ""}
          onChange={(event) =>
            update(
              "model",
              event.target.value.trim() ? event.target.value : null,
            )
          }
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="agent-effort">
          {runtime === "codex" ? "Reasoning effort" : "Effort"}
        </Label>
        <Input
          id="agent-effort"
          value={profile.reasoningEffort ?? ""}
          onChange={(event) =>
            update(
              "reasoningEffort",
              event.target.value.trim() ? event.target.value : null,
            )
          }
        />
      </div>
      {runtime === "claude" ? (
        <div className="grid gap-2">
          <Label htmlFor="agent-permission">Permission mode</Label>
          <Input
            id="agent-permission"
            value={profile.permissionMode ?? ""}
            onChange={(event) =>
              update(
                "permissionMode",
                event.target.value.trim() ? event.target.value : null,
              )
            }
          />
        </div>
      ) : (
        <div className="grid gap-2">
          <Label htmlFor="agent-sandbox">Sandbox mode</Label>
          <Input
            id="agent-sandbox"
            value={profile.sandboxMode ?? ""}
            onChange={(event) =>
              update(
                "sandboxMode",
                event.target.value.trim() ? event.target.value : null,
              )
            }
          />
        </div>
      )}
      <div className="grid gap-2">
        <Label>Assigned skills</Label>
        <p className="text-muted-foreground text-xs">
          Only skills installed for {runtime} / {profile.scope} can be assigned.
          Saving writes native Claude <code>skills:</code> or Codex skill config
          fields.
        </p>
        {compatibleSkills.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No compatible skills for this runtime and scope.
          </p>
        ) : (
          <ul className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-border p-2">
            {compatibleSkills.map((skill) => {
              const id = skillAssignmentId(skill);
              const checked = profile.skillIds.some(
                (skillId) =>
                  skillId === id ||
                  skillId === skill.id ||
                  skillId === skill.folder ||
                  skillId === skill.name,
              );
              return (
                <li key={`${skill.id}:${skill.sourcePath}`}>
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={checked}
                      onChange={(event) =>
                        toggleSkill(id, event.target.checked)
                      }
                    />
                    <span>
                      <span className="font-medium">{skill.name}</span>
                      <span className="ml-1 text-muted-foreground text-xs">
                        ({id})
                      </span>
                      {skill.description && (
                        <span className="mt-0.5 block text-muted-foreground text-xs">
                          {skill.description}
                        </span>
                      )}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div className="grid gap-2">
        <Label htmlFor="agent-instructions">Instructions</Label>
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
          Overwrite if an agent with the same name already exists
        </label>
      )}
      {(localError || error) && (
        <p className="text-destructive text-sm">{localError || error}</p>
      )}
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button
          type="button"
          disabled={saving || !profile.name.trim()}
          onClick={() => void onSubmit()}
        >
          {saving ? "Saving…" : "Save agent"}
        </Button>
      </div>
    </div>
  );
}
