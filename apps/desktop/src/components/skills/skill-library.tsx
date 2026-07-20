import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { SkillTargetPicker } from "@/components/skills/skill-target-picker";
import { useSkillStore } from "@/stores/skill-store";

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
  const removeManaged = useSkillStore((state) => state.removeManaged);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    void refresh(projectPath ?? undefined);
  }, [projectPath, refresh]);

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

  return (
    <div className="space-y-4" data-testid="skill-library">
      <div>
        <p className="mb-2 font-medium text-sm">Import destination</p>
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

      {error && <p className="text-destructive text-sm">{error}</p>}
      {loading && (
        <p className="text-muted-foreground text-sm">Loading skills…</p>
      )}

      <ul className="space-y-2">
        {skills.map((skill) => (
          <li
            key={`${skill.id}:${skill.sourcePath}`}
            className="rounded-lg border border-border px-3 py-2"
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-medium text-sm">{skill.name}</p>
                <p className="text-muted-foreground text-xs">
                  {skill.targets
                    .map((target) => `${target.runtime}/${target.scope}`)
                    .join(", ")}
                  {skill.managed ? " · managed" : " · unmanaged"}
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
              {skill.managed && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => void removeManaged(skill.id, false)}
                >
                  Remove
                </Button>
              )}
            </div>
          </li>
        ))}
        {!loading && skills.length === 0 && (
          <li className="text-muted-foreground text-sm">No skills found.</li>
        )}
      </ul>
    </div>
  );
}
