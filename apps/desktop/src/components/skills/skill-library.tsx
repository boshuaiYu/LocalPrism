import { useEffect, useMemo, useRef, useState } from "react";
import {
  FolderPlusIcon,
  Link2Icon,
  RefreshCwIcon,
  ChevronDownIcon,
  ChevronRightIcon,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSkillStore } from "@/stores/skill-store";
import { skillCatalogDescription } from "@/lib/default-skill-packs";
import {
  groupItemsBySkillCategory,
  type CatalogSkillCategory,
} from "@/lib/skill-categories";
import type { RuntimeSkill, SkillTarget } from "@/runtime/types";
import { useI18n } from "@/lib/use-i18n";

export interface SkillLibraryProps {
  projectPath?: string | null;
}

/** User library is always included. Project scope is an explicit extra copy. */
export function targetsForSkillImport(
  includeProject: boolean,
  projectPath?: string | null,
): SkillTarget[] {
  const user: SkillTarget = { runtime: "claude", scope: "user" };
  if (includeProject && projectPath) {
    return [user, { runtime: "claude", scope: "project" }];
  }
  return [user];
}

export function SkillLibrary({ projectPath = null }: SkillLibraryProps) {
  const skills = useSkillStore((state) => state.skills);
  const loading = useSkillStore((state) => state.loading);
  const error = useSkillStore((state) => state.error);
  const selectedTargets = useSkillStore((state) => state.selectedTargets);
  const refresh = useSkillStore((state) => state.refresh);
  const importFolder = useSkillStore((state) => state.importFolder);
  const importUrl = useSkillStore((state) => state.importUrl);
  const removeManaged = useSkillStore((state) => state.removeManaged);
  const [busy, setBusy] = useState<"folder" | "url" | null>(null);
  const [scanning, setScanning] = useState(false);
  const [sourceUrl, setSourceUrl] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>(
    {},
  );
  const [catalog, setCatalog] = useState<CatalogSkillCategory[]>([]);
  const [alsoProject, setAlsoProjectState] = useState(false);
  const [alsoProjectPath, setAlsoProjectPath] = useState(projectPath);
  const alsoProjectRef = useRef(false);
  const projectPathRef = useRef(projectPath);
  const { t } = useI18n();
  if (alsoProjectPath !== projectPath) {
    setAlsoProjectPath(projectPath);
    setAlsoProjectState(false);
    alsoProjectRef.current = false;
  }
  projectPathRef.current = projectPath;

  useEffect(() => {
    void refresh(projectPath ?? null);
  }, [projectPath, refresh]);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve(invoke<CatalogSkillCategory[]>("get_skill_categories"))
      .then((categories) => {
        if (!cancelled && Array.isArray(categories)) setCatalog(categories);
      })
      .catch(() => {
        if (!cancelled) setCatalog([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const grouped = useMemo(
    () =>
      groupItemsBySkillCategory(
        skills,
        (skill) => ({
          folder: skill.folder,
          name: skill.name,
          category: skill.category,
          sourceUrl: skill.sourceUrl,
        }),
        { categories: [], assignments: {} },
        catalog,
      ),
    [catalog, skills],
  );

  const onImport = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: t("skills.importTitle"),
    });
    if (!selected || Array.isArray(selected)) return;
    const path = projectPathRef.current;
    setBusy("folder");
    try {
      await importFolder(
        selected,
        targetsForSkillImport(alsoProjectRef.current, path),
        path ?? undefined,
      );
    } catch {
      // importFolder records the error on the skill store.
    } finally {
      setBusy(null);
    }
  };

  const onImportUrl = async () => {
    const url = sourceUrl.trim();
    if (!url || busy) return;
    const path = projectPathRef.current;
    setBusy("url");
    try {
      await importUrl(
        url,
        targetsForSkillImport(alsoProjectRef.current, path),
        path ?? undefined,
      );
      setSourceUrl("");
    } catch {
      // importUrl records the error on the skill store.
    } finally {
      setBusy(null);
    }
  };

  const onRefreshList = async () => {
    setScanning(true);
    try {
      await refresh(projectPath ?? undefined, { silent: true });
    } finally {
      setScanning(false);
    }
  };

  const setAlsoProject = (checked: boolean) => {
    const next = checked && Boolean(projectPathRef.current);
    alsoProjectRef.current = next;
    setAlsoProjectState(next);
  };

  return (
    <div className="space-y-4" data-testid="skill-library">
      <section
        className="lp-panel space-y-4 rounded-xl border p-4"
        data-testid="skill-add-card"
      >
        <div>
          <h3 className="font-medium text-sm">{t("skills.addTitle")}</h3>
          <p className="mt-1 text-lp-meta text-xs">{t("skills.addHelp")}</p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col rounded-lg bg-muted/30 p-3">
            <div className="flex items-center gap-2">
              <FolderPlusIcon className="size-4 text-muted-foreground" />
              <p className="font-medium text-sm">{t("skills.importFolder")}</p>
            </div>
            <p className="mt-1 flex-1 text-muted-foreground text-xs">
              {t("skills.importFolderHelp")}
            </p>
            <Button
              type="button"
              size="sm"
              className="mt-3 w-fit"
              data-testid="skill-import-folder"
              disabled={busy !== null}
              onClick={() => void onImport()}
            >
              {busy === "folder"
                ? t("skills.importing")
                : t("skills.importFolder")}
            </Button>
          </div>

          <form
            className="flex flex-col rounded-lg bg-muted/30 p-3"
            onSubmit={(event) => {
              event.preventDefault();
              void onImportUrl();
            }}
          >
            <div className="flex items-center gap-2">
              <Link2Icon className="size-4 text-muted-foreground" />
              <p className="font-medium text-sm">{t("skills.addUrl")}</p>
            </div>
            <p className="mt-1 text-muted-foreground text-xs">
              {t("skills.addUrlHelp")}
            </p>
            <div className="mt-3 flex gap-2">
              <Input
                value={sourceUrl}
                onChange={(event) => setSourceUrl(event.target.value)}
                placeholder={t("skills.addUrlPlaceholder")}
                aria-label={t("skills.addUrl")}
                data-testid="skill-import-url-input"
                disabled={busy !== null}
              />
              <Button
                type="submit"
                size="sm"
                className="shrink-0"
                data-testid="skill-import-url"
                disabled={busy !== null || sourceUrl.trim().length === 0}
              >
                {busy === "url"
                  ? t("skills.importing")
                  : t("skills.addUrlAction")}
              </Button>
            </div>
          </form>
        </div>

        {projectPath ? (
          <details className="text-xs" data-testid="skill-import-advanced">
            <summary className="cursor-pointer text-muted-foreground">
              {t("skills.advanced")}
            </summary>
            <label className="mt-2 flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-0.5"
                data-testid="skill-also-project"
                checked={alsoProject}
                onChange={(event) => setAlsoProject(event.target.checked)}
              />
              <span>
                <span className="text-foreground">
                  {t("skills.alsoProject")}
                </span>
                <span className="mt-0.5 block text-muted-foreground">
                  {t("skills.alsoProjectHelp")}
                </span>
              </span>
            </label>
          </details>
        ) : null}
      </section>

      {error && <p className="text-destructive text-sm">{error}</p>}

      <div className="flex items-start justify-between gap-3 px-1">
        <div className="min-w-0">
          <p className="font-medium text-sm">{t("skills.installed")}</p>
          <p className="mt-0.5 text-lp-meta text-xs">
            {t("skills.refreshHelp")}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          data-testid="skill-refresh-list"
          title={t("skills.refreshHelp")}
          aria-busy={scanning}
          disabled={scanning}
          onClick={() => void onRefreshList()}
        >
          <RefreshCwIcon className={scanning ? "animate-spin" : undefined} />
          {scanning ? t("skills.refreshing") : t("skills.refreshList")}
        </Button>
      </div>

      {loading && (
        <p className="text-muted-foreground text-sm">{t("skills.loading")}</p>
      )}

      <div className="space-y-2">
        {grouped.map((group) => {
          const open =
            expandedGroups[group.id] ??
            (group.source === "imported" || group.source === "custom");
          const label =
            group.id === "imported" ? t("skills.uncategorized") : group.name;
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
                <span className="min-w-0 truncate">{label}</span>
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
