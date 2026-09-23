import { useEffect, useMemo, useState } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SkillTargetPicker } from "@/components/skills/skill-target-picker";
import { useSkillStore } from "@/stores/skill-store";
import { skillCatalogDescription } from "@/lib/default-skill-packs";
import { groupItemsBySkillCategory } from "@/lib/skill-categories";
import type { RuntimeSkill, SkillTarget } from "@/runtime/types";
import { useI18n } from "@/lib/use-i18n";

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
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>(
    {},
  );
  const { t } = useI18n();

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
      title: t("skills.importTitle"),
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
      <div>
        <p className="mb-2 font-medium text-sm">{t("skills.destination")}</p>
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
          {importing ? t("skills.importing") : t("skills.importFolder")}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => void refresh(projectPath ?? undefined)}
        >
          {t("skills.refresh")}
        </Button>
      </div>

      <div className="space-y-2">
        <p className="font-medium text-sm">{t("skills.addUrl")}</p>
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
            {t("skills.addUrlAction")}
          </Button>
        </div>
      </div>

      {error && <p className="text-destructive text-sm">{error}</p>}
      {loading && (
        <p className="text-muted-foreground text-sm">{t("skills.loading")}</p>
      )}

      <div className="space-y-2">
        {grouped.map((group) => {
          const open = expandedGroups[group.id] === true;
          return (
            <div key={group.id} data-testid={`skill-pack-${group.id}`}>
              <button
                type="button"
                className="flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left font-medium text-muted-foreground text-xs uppercase tracking-wide hover:bg-muted/60"
                aria-expanded={open}
                data-testid={`skill-pack-toggle-${group.id}`}
                onClick={() =>
                  setExpandedGroups((current) => ({
                    ...current,
                    [group.id]: !open,
                  }))
                }
              >
                {open ? (
                  <ChevronDownIcon className="size-3.5 shrink-0" />
                ) : (
                  <ChevronRightIcon className="size-3.5 shrink-0" />
                )}
                <span className="min-w-0 truncate">{group.name}</span>
                <span className="font-normal normal-case">
                  · {group.items.length}
                </span>
              </button>
              {open && (
                <ul className="mt-1 space-y-1">
                  {group.items.map((skill) => (
                    <SkillRow
                      key={`${skill.id}:${skill.sourcePath}`}
                      skill={skill}
                      selectedTargets={selectedTargets}
                      onRemove={
                        skill.managed
                          ? () => void removeManaged(skill.id, false)
                          : undefined
                      }
                    />
                  ))}
                </ul>
              )}
            </div>
          );
        })}
        {!loading && skills.length === 0 && (
          <p className="text-muted-foreground text-sm">{t("skills.empty")}</p>
        )}
      </div>
    </div>
  );
}

function skillExceptionNotes(
  skill: RuntimeSkill,
  selectedTargets: SkillTarget[],
  labels: { project: string; disabled: string },
): string[] {
  const notes: string[] = [];
  const selectedScopes = new Set(selectedTargets.map((target) => target.scope));
  const userOnly = selectedScopes.has("user") && !selectedScopes.has("project");
  if (userOnly && skill.targets.some((target) => target.scope === "project")) {
    notes.push(labels.project);
  }
  if (!skill.enabled) notes.push(labels.disabled);
  return notes;
}

function SkillRow({
  skill,
  selectedTargets,
  onRemove,
}: {
  skill: RuntimeSkill;
  selectedTargets: SkillTarget[];
  onRemove?: () => void;
}) {
  const { t } = useI18n();
  const [showPath, setShowPath] = useState(false);
  const description = (
    skillCatalogDescription(skill.folder) ?? skill.description
  ).trim();
  const notes = skillExceptionNotes(skill, selectedTargets, {
    project: t("skills.projectTarget"),
    disabled: t("skills.disabled"),
  });

  return (
    <li
      className="rounded-lg border border-border px-3 py-2"
      data-testid={`skill-row-${skill.folder}`}
      title={skill.sourcePath}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-medium text-sm">{skill.name}</p>
          {description && (
            <p className="truncate text-muted-foreground text-xs">
              {description}
            </p>
          )}
          {notes.length > 0 && (
            <p className="text-muted-foreground text-xs">{notes.join(" · ")}</p>
          )}
          <button
            type="button"
            className="mt-1 text-muted-foreground text-xs underline-offset-2 hover:underline"
            data-testid={`skill-path-toggle-${skill.folder}`}
            onClick={() => setShowPath((current) => !current)}
          >
            {showPath ? t("skills.hidePath") : t("skills.showPath")}
          </button>
          {showPath && (
            <p
              className="mt-1 break-all text-muted-foreground text-xs"
              data-testid={`skill-path-${skill.folder}`}
            >
              {skill.sourcePath}
            </p>
          )}
          {skill.discoveryError && (
            <p className="mt-1 text-amber-600 text-xs">
              {skill.discoveryError}
            </p>
          )}
        </div>
        {onRemove && (
          <Button type="button" size="sm" variant="ghost" onClick={onRemove}>
            {t("skills.remove")}
          </Button>
        )}
      </div>
    </li>
  );
}
