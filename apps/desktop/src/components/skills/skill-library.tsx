import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SkillTargetPicker } from "@/components/skills/skill-target-picker";
import { useSkillStore } from "@/stores/skill-store";
import { groupItemsBySkillCategory } from "@/lib/skill-categories";
import { skillPaperWorkflowGuidance } from "@/lib/skill-workflow-copy";
import type { RuntimeSkill } from "@/runtime/types";

export interface SkillLibraryProps {
  projectPath?: string | null;
}

export function SkillLibrary({ projectPath = null }: SkillLibraryProps) {
  const skills = useSkillStore((state) => state.skills);
  const loading = useSkillStore((state) => state.loading);
  const error = useSkillStore((state) => state.error);
  const selectedTargets = useSkillStore((state) => state.selectedTargets);
  const setSelectedTargets = useSkillStore((state) => state.setSelectedTargets);
  const refresh = useSkillStore((state) => state.refresh);
  const importFolder = useSkillStore((state) => state.importFolder);
  const importUrl = useSkillStore((state) => state.importUrl);
  const removeManaged = useSkillStore((state) => state.removeManaged);
  const [importing, setImporting] = useState(false);
  const [sourceUrl, setSourceUrl] = useState("");

  useEffect(() => {
    void refresh(projectPath ?? undefined);
  }, [projectPath, refresh]);

  const grouped = useMemo(
    () =>
      groupItemsBySkillCategory(
        skills,
        (skill) => ({ folder: skill.folder, name: skill.name }),
        { categories: [], assignments: {} },
        [],
      ),
    [skills],
  );

  const onImport = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Select skill folder",
    });
    if (!selected || Array.isArray(selected)) return;
    setImporting(true);
    try {
      await importFolder(selected, selectedTargets, projectPath ?? undefined);
    } finally {
      setImporting(false);
    }
  };

  const onImportUrl = async () => {
    const url = sourceUrl.trim();
    if (!url) return;
    setImporting(true);
    try {
      await importUrl(url, selectedTargets, projectPath ?? undefined);
      setSourceUrl("");
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="skill-library">
      <p
        className="text-muted-foreground text-xs leading-relaxed"
        data-testid="skill-paper-workflow-hint"
      >
        {skillPaperWorkflowGuidance()}
      </p>
      <div>
        <p className="mb-2 font-medium text-sm">Import destination</p>
        <p className="mb-2 text-muted-foreground text-xs">
          Skills and subagents live next to the LocalPrism install, not
          ~/.claude or %APPDATA%. User skills go to claude-home/skills and
          subagents to claude-home/agents in the install folder (for example
          D:\LocalPrism\claude-home\skills). Project skills go to .localprism in
          the current paper. If the install folder is read-only, LocalPrism
          falls back to its app data folder.
        </p>
        <SkillTargetPicker
          value={selectedTargets}
          projectPath={projectPath}
          onChange={setSelectedTargets}
        />
      </div>

      <div className="flex gap-2">
        <Button
          type="button"
          disabled={importing || selectedTargets.length === 0}
          onClick={() => void onImport()}
        >
          {importing ? "Importing…" : "Import folder"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => void refresh(projectPath ?? undefined)}
        >
          Refresh
        </Button>
      </div>

      <div className="space-y-2">
        <p className="font-medium text-sm">Add from URL</p>
        <p className="text-muted-foreground text-xs">
          GitHub repo, skill folder tree URL, .tar.gz archive, or a raw SKILL.md
          link.
        </p>
        <div className="flex gap-2">
          <Input
            value={sourceUrl}
            onChange={(event) => setSourceUrl(event.target.value)}
            placeholder="https://github.com/owner/skill-repo"
            disabled={importing}
          />
          <Button
            type="button"
            variant="outline"
            disabled={
              importing ||
              selectedTargets.length === 0 ||
              sourceUrl.trim().length === 0
            }
            onClick={() => void onImportUrl()}
          >
            Add URL
          </Button>
        </div>
      </div>

      {error && <p className="text-destructive text-sm">{error}</p>}
      {loading && (
        <p className="text-muted-foreground text-sm">Loading skills…</p>
      )}

      <div className="space-y-3">
        {grouped.map((group) => (
          <div key={group.id}>
            <p className="mb-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">
              {group.name}
              <span className="ml-1 font-normal normal-case">
                · {group.items.length}
              </span>
            </p>
            <ul className="space-y-2">
              {group.items.map((skill) => (
                <SkillRow
                  key={`${skill.id}:${skill.sourcePath}`}
                  skill={skill}
                  onRemove={
                    skill.managed
                      ? () => void removeManaged(skill.id, false)
                      : undefined
                  }
                />
              ))}
            </ul>
          </div>
        ))}
        {!loading && skills.length === 0 && (
          <p className="text-muted-foreground text-sm">No skills found.</p>
        )}
      </div>
    </div>
  );
}

function SkillRow({
  skill,
  onRemove,
}: {
  skill: RuntimeSkill;
  onRemove?: () => void;
}) {
  return (
    <li className="rounded-lg border border-border px-3 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium text-sm">{skill.name}</p>
          <p className="text-muted-foreground text-xs">
            {skill.targets
              .map((target) =>
                target.scope === "user"
                  ? "LocalPrism / user"
                  : "LocalPrism / project",
              )
              .join(", ")}
            {skill.managed ? " · managed" : " · unmanaged"}
            {skill.enabled ? " · enabled" : " · disabled"}
          </p>
          <p className="mt-1 break-all text-muted-foreground text-xs">
            {skill.sourcePath}
          </p>
          {skill.discoveryError && (
            <p className="mt-1 text-amber-600 text-xs">
              {skill.discoveryError}
            </p>
          )}
        </div>
        {onRemove && (
          <Button type="button" size="sm" variant="ghost" onClick={onRemove}>
            Remove
          </Button>
        )}
      </div>
    </li>
  );
}
