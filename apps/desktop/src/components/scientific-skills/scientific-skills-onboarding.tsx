import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import {
  FlaskConicalIcon,
  DownloadIcon,
  CheckCircle2Icon,
  AlertCircleIcon,
  RefreshCwIcon,
  Trash2Icon,
  Loader2Icon,
  ChevronLeftIcon,
  FolderPlusIcon,
  FileArchiveIcon,
  Link2Icon,
  XIcon,
  GithubIcon,
} from "lucide-react";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  type SkillCategoryData,
  type SkillEntryData,
  ICON_MAP,
} from "./skill-category-card";
import { InstallProgress } from "./install-progress";
import { useProductTourDialogGuard } from "@/components/product-tour";
import { useSkillStore } from "@/stores/skill-store";
import { useDocumentStore } from "@/stores/document-store";
import { useI18n } from "@/lib/use-i18n";
import {
  buildSkillsBrowserCategories,
  packIdFromBrowserCategoryId,
  type SkillsBrowserCategory,
} from "@/lib/skills-browser";
import { SKILLS_LIST_UPDATED_EVENT } from "@/lib/skills-refresh";
import {
  githubRepoLabel,
  skillGithubUrl,
  skillPackDocsUrl,
} from "@/lib/default-skill-packs";
import {
  SKILL_ARCHIVE_FILTERS,
  SkillReplaceDialog,
  toastImportOutcome,
} from "@/components/skills/skill-import-dialogs";
import {
  normalizeSkillImportPreview,
  type SkillReplacePreview,
} from "@/lib/skill-import-flow";
import {
  categoryRefreshTarget,
  normalizePackUpdateReport,
  optedOutPackIdSet,
  remoteRefreshTargets,
  updateAllTargets,
  type PackRefreshTarget,
  type SkillPackUpdateReport,
} from "@/lib/skill-pack-actions";
import type { SkillTarget } from "@/runtime/types";

const STORAGE_KEY = "scientific-skills-installed";

interface SkillsStatus {
  installed: boolean;
  skill_count: number;
  location: string;
}

interface SkillInfo {
  id: string;
  name: string;
  domain: string;
  description: string;
  folder: string;
}

interface ScientificSkillsOnboardingProps {
  onClose: () => void;
}

export function ScientificSkillsOnboarding({
  onClose,
}: ScientificSkillsOnboardingProps) {
  const { t } = useI18n();
  const tourDialog = useProductTourDialogGuard();
  const [categories, setCategories] = useState<SkillCategoryData[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isInstalling, setIsInstalling] = useState(false);
  const [isComplete, setIsComplete] = useState(false);
  const [installLogs, setInstallLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<SkillsStatus | null>(null);
  const [installedSkills, setInstalledSkills] = useState<SkillInfo[]>([]);
  const [isUninstalling, setIsUninstalling] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [confirmUninstallAllOpen, setConfirmUninstallAllOpen] = useState(false);
  const [optedOutIds, setOptedOutIds] = useState<string[]>([]);
  const [confirmTargets, setConfirmTargets] = useState<
    PackRefreshTarget[] | null
  >(null);
  const [updateReports, setUpdateReports] = useState<SkillPackUpdateReport[]>(
    [],
  );
  const [uninstallPack, setUninstallPack] = useState<
    (PackRefreshTarget & { count: number }) | null
  >(null);
  const [importChooserOpen, setImportChooserOpen] = useState(false);
  const [importUrlDraft, setImportUrlDraft] = useState("");
  const [replaceConflicts, setReplaceConflicts] = useState<
    SkillReplacePreview[]
  >([]);
  const pendingImportRef = useRef<{
    sourcePath: string;
    targets: SkillTarget[];
  } | null>(null);
  const pendingUpdatesRef = useRef<PackRefreshTarget[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<SkillEntryData | null>(null);
  const [deletingSkillFolder, setDeletingSkillFolder] = useState<string | null>(
    null,
  );
  const mountedRef = useRef(true);
  const installBackendLogSeenRef = useRef(false);
  const selectedTargets = useSkillStore((state) => state.selectedTargets);
  const importFolder = useSkillStore((state) => state.importFolder);
  const refreshSkills = useSkillStore((state) => state.refresh);
  const installingPackId = useSkillStore((state) => state.installingPackId);
  const installedRuntimeSkills = useSkillStore((state) => state.skills);
  const projectPath = useDocumentStore((state) => state.projectRoot);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const unlisten = listen<string>("skills-install-log", (event) => {
      installBackendLogSeenRef.current = true;
      setInstallLogs((previous) => {
        const last = previous[previous.length - 1];
        if (last === event.payload) return previous;
        return [...previous, event.payload];
      });
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Installed skills live in claude-home/skills.
  const checkStatus = useCallback(async () => {
    try {
      const [gs, skills] = await Promise.all([
        invoke<SkillsStatus>("check_skills_installed", {
          projectPath: null,
        }),
        invoke<SkillInfo[]>("list_installed_skills", {
          projectPath: null,
        }),
      ]);
      setStatus(gs);
      setInstalledSkills(skills);
    } catch {
      setStatus(null);
      setInstalledSkills([]);
    }
  }, []);

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  useEffect(() => {
    void refreshSkills(projectPath ?? null);
  }, [projectPath, refreshSkills]);

  useEffect(() => {
    const onSkillsUpdated = () => {
      void checkStatus();
    };
    window.addEventListener(SKILLS_LIST_UPDATED_EVENT, onSkillsUpdated);
    return () => {
      window.removeEventListener(SKILLS_LIST_UPDATED_EVENT, onSkillsUpdated);
    };
  }, [checkStatus]);

  useEffect(() => {
    if (!installingPackId) return;
    setInstallLogs((previous) => {
      const line = `Updating ${installingPackId}…`;
      if (previous[previous.length - 1] === line) return previous;
      return [...previous, line];
    });
  }, [installingPackId]);

  useEffect(() => {
    invoke<SkillCategoryData[]>("get_skill_categories")
      .then((cats) => {
        setCategories(cats);
      })
      .catch(console.error);
  }, []);

  const installedSkillFolders = new Set(
    installedSkills.map((skill) => skill.folder),
  );
  const displayCategories = useMemo(
    () =>
      buildSkillsBrowserCategories({
        installedSkills: [
          ...installedRuntimeSkills.map((skill) => ({
            id: skill.managed ? skill.id : undefined,
            name: skill.name,
            folder: skill.folder,
            category: skill.category,
            sourceUrl: skill.sourceUrl,
            sourceFolder: skill.sourceFolder,
          })),
          ...installedSkills
            .filter(
              (skill) =>
                !installedRuntimeSkills.some(
                  (item) => item.folder === skill.folder,
                ),
            )
            .map((skill) => ({
              name: skill.name,
              folder: skill.folder,
            })),
        ],
        catalog: categories,
        optedOutPackIds: optedOutIds,
      }),
    [categories, installedRuntimeSkills, installedSkills, optedOutIds],
  );

  useEffect(() => {
    if (
      selectedId &&
      displayCategories.some((category) => category.id === selectedId)
    ) {
      return;
    }
    const firstWithSkills = displayCategories.find(
      (category) => category.skill_count > 0,
    );
    setSelectedId(firstWithSkills?.id ?? displayCategories[0]?.id ?? null);
  }, [displayCategories, selectedId]);

  const totalSkills = displayCategories.reduce(
    (sum, c) => sum + c.skill_count,
    0,
  );
  const selected =
    displayCategories.find((c) => c.id === selectedId) ??
    displayCategories[0] ??
    null;
  const isInstalled =
    (status?.installed ?? false) ||
    displayCategories.some((category) => category.skill_count > 0);

  const reloadOptOuts = useCallback(async () => {
    try {
      const preferences = await invoke("skill_pack_preferences");
      const ids = [...optedOutPackIdSet(preferences)];
      if (mountedRef.current) setOptedOutIds(ids);
      return new Set(ids);
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    void reloadOptOuts();
  }, [reloadOptOuts]);

  const runPackUpdates = useCallback(
    async (targets: PackRefreshTarget[]) => {
      if (targets.length === 0) {
        toast.message(t("skills.selectPackToUpdate"));
        return;
      }
      pendingUpdatesRef.current = targets;
      installBackendLogSeenRef.current = false;
      let noBackendLogTimer: number | undefined;
      const preparing = t("skills.preparing");
      const preparingPrefix = t("skills.preparingPrefix");
      setInstallLogs([preparing]);
      setUpdateReports([]);
      setIsInstalling(true);
      setIsComplete(false);
      setError(null);
      try {
        noBackendLogTimer = window.setTimeout(() => {
          if (installBackendLogSeenRef.current || !mountedRef.current) return;
          setInstallLogs((previous) => {
            const hasBackendLog = previous.some(
              (line) => !line.startsWith(preparingPrefix),
            );
            if (hasBackendLog) return previous;
            return [...previous, t("skills.waitingInstaller")];
          });
        }, 2500);
        const reports: SkillPackUpdateReport[] = [];
        for (const target of targets) {
          if (!mountedRef.current) return;
          setInstallLogs((previous) => [...previous, target.name]);
          try {
            const report = normalizePackUpdateReport(
              await invoke("skill_refresh_pack", {
                sourceUrl: target.sourceUrl ?? null,
                sourceFolder: target.sourceFolder ?? null,
                targets: useSkillStore.getState().selectedTargets,
                projectPath: null,
              }),
            );
            if (!report.name) report.name = target.name;
            if (!report.id) report.id = target.id;
            reports.push(report);
          } catch (error) {
            reports.push({
              id: target.id,
              name: target.name,
              added: [],
              updated: [],
              removed: [],
              unchanged: [],
              error: String(error),
            });
          }
        }
        if (noBackendLogTimer !== undefined) {
          window.clearTimeout(noBackendLogTimer);
        }
        if (!mountedRef.current) return;
        setUpdateReports(reports);
        const failed = reports.filter((report) => report.error);
        await checkStatus();
        await refreshSkills(projectPath ?? undefined);
        await reloadOptOuts();
        for (const report of reports) {
          if (report.errorCode === "missing-folder") {
            toast.error(
              t("skills.missingFolder", {
                name: report.name,
                path: report.detail ?? "",
              }),
            );
          }
        }
        if (failed.length > 0 && failed.length === reports.length) {
          setError(
            failed.map((report) => report.error ?? report.name).join("\n"),
          );
        }
        setIsComplete(true);
        setIsInstalling(false);
        if (failed.length < reports.length) {
          localStorage.setItem(STORAGE_KEY, "true");
        }
      } catch (error) {
        if (noBackendLogTimer !== undefined) {
          window.clearTimeout(noBackendLogTimer);
        }
        if (!mountedRef.current) return;
        const message = String(error);
        setInstallLogs((previous) => [...previous, message]);
        setError(message);
        setIsInstalling(false);
      }
    },
    [checkStatus, projectPath, refreshSkills, reloadOptOuts, t],
  );

  const requestPackUpdates = useCallback(
    (targets: PackRefreshTarget[]) => {
      if (targets.length === 0) {
        toast.message(t("skills.selectPackToUpdate"));
        return;
      }
      const remote = remoteRefreshTargets(targets);
      if (remote.length === 0) {
        void runPackUpdates(targets);
        return;
      }
      pendingUpdatesRef.current = targets;
      setConfirmTargets(targets);
    },
    [runPackUpdates, t],
  );

  const handleUpdateSelected = useCallback(() => {
    const category = displayCategories.find((item) => item.id === selectedId);
    const target = category ? categoryRefreshTarget(category) : null;
    if (!target) {
      toast.message(t("skills.noPackSource"));
      return;
    }
    requestPackUpdates([target]);
  }, [displayCategories, requestPackUpdates, selectedId, t]);

  const handleUpdateAll = useCallback(() => {
    const targets = updateAllTargets(displayCategories, new Set(optedOutIds));
    requestPackUpdates(targets);
  }, [displayCategories, optedOutIds, requestPackUpdates]);

  const handleUninstall = useCallback(async () => {
    setIsUninstalling(true);
    try {
      await invoke("uninstall_scientific_skills", {
        projectPath: null,
      });
      await checkStatus();
      await refreshSkills(projectPath ?? undefined);
      const gsAfter = await invoke<SkillsStatus>("check_skills_installed", {
        projectPath: null,
      });
      if (!gsAfter.installed) {
        localStorage.removeItem(STORAGE_KEY);
      }
      toast.success(t("skills.toastUninstalled"));
    } catch (e) {
      console.error("Failed to uninstall:", e);
      toast.error(t("skills.toastUninstallFailed"), {
        description: String(e),
      });
    } finally {
      setIsUninstalling(false);
    }
  }, [checkStatus, projectPath, refreshSkills, t]);

  const importLocalSource = useCallback(
    async (sourcePath: string) => {
      const targets = useSkillStore.getState().selectedTargets;
      setIsImporting(true);
      try {
        const preview = normalizeSkillImportPreview(
          await invoke("skill_import_preview", {
            sourcePath,
            targets,
            projectPath: null,
          }),
        );
        if (preview.conflicts.length > 0) {
          pendingImportRef.current = { sourcePath, targets };
          setReplaceConflicts(preview.conflicts);
          return;
        }
        const outcome = await importFolder(sourcePath, targets);
        localStorage.setItem(STORAGE_KEY, "true");
        await checkStatus();
        await refreshSkills(projectPath ?? undefined);
        toastImportOutcome(outcome, t);
      } catch (error) {
        toast.error(t("skills.toastImportFailed"), {
          description: String(error),
        });
      } finally {
        setIsImporting(false);
      }
    },
    [checkStatus, importFolder, projectPath, refreshSkills, t],
  );

  const handleImportFolder = useCallback(async () => {
    const selectedFolder = await open({
      directory: true,
      multiple: false,
      title: t("skills.importFolderTitle"),
    });
    if (typeof selectedFolder !== "string") return;
    setImportChooserOpen(false);
    await importLocalSource(selectedFolder);
  }, [importLocalSource, t]);

  const handleImportArchive = useCallback(async () => {
    const selectedFile = await open({
      directory: false,
      multiple: false,
      title: t("skills.importArchiveTitle"),
      filters: SKILL_ARCHIVE_FILTERS,
    });
    if (typeof selectedFile !== "string") return;
    setImportChooserOpen(false);
    await importLocalSource(selectedFile);
  }, [importLocalSource, t]);

  const handleImportUrl = useCallback(async () => {
    const url = importUrlDraft.trim();
    if (!url) return;
    const targets = useSkillStore.getState().selectedTargets;
    setIsImporting(true);
    try {
      const outcome = await useSkillStore
        .getState()
        .importUrl(url, targets, undefined, undefined, false);
      setImportUrlDraft("");
      setImportChooserOpen(false);
      localStorage.setItem(STORAGE_KEY, "true");
      await checkStatus();
      await refreshSkills(projectPath ?? undefined);
      toastImportOutcome(outcome, t);
    } catch (error) {
      toast.error(t("skills.toastImportFailed"), {
        description: String(error),
      });
    } finally {
      setIsImporting(false);
    }
  }, [checkStatus, importUrlDraft, projectPath, refreshSkills, t]);

  const handleConfirmReplace = useCallback(async () => {
    const pending = pendingImportRef.current;
    if (!pending) return;
    setIsImporting(true);
    try {
      const outcome = await importFolder(pending.sourcePath, pending.targets);
      pendingImportRef.current = null;
      setReplaceConflicts([]);
      localStorage.setItem(STORAGE_KEY, "true");
      await checkStatus();
      await refreshSkills(projectPath ?? undefined);
      toastImportOutcome(outcome, t);
    } catch (error) {
      toast.error(t("skills.toastImportFailed"), {
        description: String(error),
      });
    } finally {
      setIsImporting(false);
    }
  }, [checkStatus, importFolder, projectPath, refreshSkills, t]);

  const handleUninstallPack = useCallback(async () => {
    if (!uninstallPack) return;
    const packName = uninstallPack.name;
    setIsUninstalling(true);
    try {
      await invoke("skill_remove_pack", {
        sourceUrl: uninstallPack.sourceUrl ?? null,
        sourceFolder: uninstallPack.sourceFolder ?? null,
        defaultPackId: uninstallPack.defaultPackId ?? null,
        optOut: Boolean(uninstallPack.defaultPackId),
      });
      setUninstallPack(null);
      await reloadOptOuts();
      await checkStatus();
      await refreshSkills(projectPath ?? undefined);
      toast.success(t("skills.toastPackUninstalled", { name: packName }));
    } catch (error) {
      toast.error(t("skills.toastUninstallFailed"), {
        description: String(error),
      });
    } finally {
      setIsUninstalling(false);
    }
  }, [
    checkStatus,
    projectPath,
    refreshSkills,
    reloadOptOuts,
    t,
    uninstallPack,
  ]);

  const handleConfirmDeleteSkill = useCallback(async () => {
    if (!deleteTarget?.id) return;
    const entryId = deleteTarget.id;
    setDeletingSkillFolder(deleteTarget.folder);
    try {
      await invoke("skill_delete_managed", {
        entryId,
        confirmModified: false,
      });
      toast.success(t("skills.toastDeleted"), {
        description: deleteTarget.name,
      });
      setDeleteTarget(null);
      await checkStatus();
      await refreshSkills(projectPath ?? undefined);
    } catch (e) {
      toast.error(t("skills.toastDeleteFailed"), {
        description: String(e),
      });
    } finally {
      setDeletingSkillFolder(null);
    }
  }, [checkStatus, deleteTarget, projectPath, refreshSkills, t]);

  // ─── Installing / Complete state ───
  if (isInstalling || isComplete || error) {
    return (
      <Dialog
        modal={tourDialog.modal}
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <DialogContent
          showCloseButton={false}
          onInteractOutside={tourDialog.onInteractOutside}
          className="gap-3 px-6 pt-6 pb-4 sm:max-w-md"
        >
          <button
            type="button"
            aria-label={t("onboarding.close")}
            className="absolute top-4 right-4 z-10 rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:outline-hidden focus:ring-2 focus:ring-ring focus:ring-offset-2"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onClose();
            }}
          >
            <XIcon className="size-4" />
          </button>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm">
              {isComplete ? (
                <CheckCircle2Icon className="size-5 text-foreground" />
              ) : error ? (
                <AlertCircleIcon className="size-5 text-destructive" />
              ) : (
                <FlaskConicalIcon className="size-5 text-muted-foreground" />
              )}
              {error
                ? t("skills.updateFailed")
                : isComplete
                  ? t("skills.updateComplete")
                  : t("skills.updating")}
            </DialogTitle>
            {(isComplete || error) && updateReports.length > 0 && (
              <div className="space-y-2" data-testid="skill-update-summary">
                {updateReports.map((report) => (
                  <details
                    key={`${report.id}:${report.name}`}
                    className="rounded-md border border-border/70 px-3 py-2 text-xs"
                    open={Boolean(report.error)}
                  >
                    <summary className="cursor-pointer font-medium">
                      {report.name}
                      {report.error ? ` — ${report.error}` : ""}
                    </summary>
                    <PackChangeList
                      label={t("skills.updateSummaryAdded")}
                      names={report.added}
                      emptyLabel={t("skills.summaryNone")}
                    />
                    <PackChangeList
                      label={t("skills.updateSummaryUpdated")}
                      names={report.updated}
                      emptyLabel={t("skills.summaryNone")}
                    />
                    <PackChangeList
                      label={t("skills.updateSummaryRemoved")}
                      names={report.removed}
                      emptyLabel={t("skills.summaryNone")}
                    />
                    <PackChangeList
                      label={t("skills.updateSummaryUnchanged")}
                      names={report.unchanged}
                      emptyLabel={t("skills.summaryNone")}
                    />
                  </details>
                ))}
              </div>
            )}
          </DialogHeader>

          <InstallProgress
            isInstalling={isInstalling}
            isComplete={isComplete}
            error={error}
            logs={installLogs}
          />

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
              <AlertCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
              <p className="text-muted-foreground text-xs leading-relaxed">
                {error}
              </p>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            {error && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void runPackUpdates(pendingUpdatesRef.current)}
                className="gap-1.5"
              >
                <RefreshCwIcon className="size-3.5" />
                {t("errors.retry")}
              </Button>
            )}
            {(isComplete || error) && (
              <Button size="sm" onClick={onClose}>
                {isComplete ? t("onboarding.done") : t("onboarding.close")}
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  // ─── Browse state — two-column layout ───
  return (
    <>
      <Dialog
        modal={tourDialog.modal}
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <DialogContent
          showCloseButton={false}
          onInteractOutside={tourDialog.onInteractOutside}
          className="flex h-[min(36rem,calc(100vh-6rem))] w-[min(56rem,calc(100vw-4rem))] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
        >
          {/* Header */}
          <DialogHeader className="shrink-0 border-border border-b px-6 py-3">
            <div className="flex items-center gap-4">
              <div className="min-w-0 flex-1">
                <DialogTitle className="text-sm">
                  {t("settings.skills")}
                </DialogTitle>
                <DialogDescription className="mt-0.5 text-xs">
                  {t("skills.catalogBody", {
                    count: totalSkills,
                    packs: displayCategories.length,
                  })}
                </DialogDescription>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {isInstalled ? (
                  <>
                    <Badge variant="secondary" className="gap-1 text-xs">
                      <CheckCircle2Icon className="size-3" />
                      {t("skills.installedBadge", { count: totalSkills })}
                    </Badge>
                    <Button
                      variant="outline"
                      size="sm"
                      data-testid="skill-pack-update"
                      onClick={handleUpdateSelected}
                      className="gap-1.5"
                    >
                      <RefreshCwIcon className="size-3.5" />
                      {t("skills.update")}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      data-testid="skill-pack-update-all"
                      onClick={handleUpdateAll}
                      className="gap-1.5"
                    >
                      <RefreshCwIcon className="size-3.5" />
                      {t("skills.updateAll")}
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    data-testid="skill-pack-update-all"
                    onClick={handleUpdateAll}
                    className="gap-1.5"
                  >
                    <DownloadIcon className="size-3.5" />
                    {t("skills.installAll")}
                  </Button>
                )}
                <Badge variant="secondary" className="h-8 px-2 text-xs">
                  LocalPrism · claude-home/skills
                </Badge>
                <Button
                  variant="outline"
                  size="sm"
                  data-tour="tour-skill-import"
                  data-testid="skill-import-open"
                  onClick={() => setImportChooserOpen(true)}
                  disabled={
                    isImporting ||
                    isInstalling ||
                    isUninstalling ||
                    selectedTargets.length === 0
                  }
                  className="gap-1.5 border-border/70 bg-muted/30 text-foreground shadow-none hover:bg-muted/60 hover:text-foreground"
                >
                  {isImporting ? (
                    <Loader2Icon className="size-3.5 animate-spin text-muted-foreground" />
                  ) : (
                    <FolderPlusIcon className="size-3.5 text-muted-foreground" />
                  )}
                  {t("skills.importSkill")}
                </Button>
                {isInstalled ? (
                  <details className="relative" data-testid="skill-pack-more">
                    <summary className="inline-flex h-8 cursor-pointer list-none items-center rounded-md border border-input bg-background px-3 text-sm [&::-webkit-details-marker]:hidden">
                      {t("skills.moreActions")}
                    </summary>
                    <div className="absolute right-0 z-30 mt-1 w-56 rounded-md border bg-popover p-3 shadow-md">
                      <p className="mb-2 font-medium text-destructive text-xs">
                        {t("skills.dangerZone")}
                      </p>
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        data-testid="skill-pack-uninstall-all"
                        disabled={isUninstalling}
                        onClick={() => setConfirmUninstallAllOpen(true)}
                        className="w-full gap-1.5"
                      >
                        <Trash2Icon className="size-3.5" />
                        {t("skills.uninstallAllAction")}
                      </Button>
                    </div>
                  </details>
                ) : null}
              </div>
            </div>
          </DialogHeader>

          {/* Body — sidebar + detail */}
          <div className="flex flex-1 overflow-hidden">
            {/* Category sidebar */}
            <nav
              className="w-64 max-w-64 shrink-0 overflow-hidden border-border border-r"
              data-tour="tour-skill-categories"
            >
              <ScrollArea className="h-full w-full overflow-hidden [&_[data-slot=scroll-area-scrollbar]]:hidden">
                <div className="box-border flex w-full min-w-0 flex-col gap-0.5 overflow-x-hidden p-2">
                  {displayCategories.map((cat, index) => {
                    const Icon = ICON_MAP[cat.icon] || FlaskConicalIcon;
                    const isActive = selectedId === cat.id;
                    return (
                      <div key={cat.id}>
                        {index === 0 && (
                          <p className="px-3 pt-1 pb-1 font-medium text-[11px] text-muted-foreground/80 uppercase tracking-wide">
                            {t("skills.packs")}
                          </p>
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedId(cat.id);
                          }}
                          className={cn(
                            "box-border grid w-full min-w-0 max-w-full grid-cols-[1rem_minmax(0,1fr)] items-center gap-2.5 overflow-hidden rounded-lg px-3 py-2 text-left text-sm transition-colors",
                            isActive
                              ? "bg-accent font-medium text-accent-foreground"
                              : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                          )}
                          title={cat.name}
                        >
                          <Icon className="size-4 shrink-0" />
                          <span className="block min-w-0 truncate">
                            {cat.name}
                          </span>
                        </button>
                      </div>
                    );
                  })}
                </div>
              </ScrollArea>
            </nav>

            {/* Detail panel */}
            <div className="flex flex-1 flex-col overflow-hidden">
              {selected ? (
                <ScrollArea className="flex-1">
                  <div className="p-6">
                    <CategoryDetail
                      category={selected}
                      isInstalled={isInstalled}
                      installedSkillFolders={installedSkillFolders}
                      deletingSkillFolder={deletingSkillFolder}
                      onDeleteSkill={setDeleteTarget}
                      onUninstallPack={
                        selected.skill_count > 0
                          ? () => {
                              const target = categoryRefreshTarget(selected);
                              if (!target) {
                                toast.message(t("skills.noPackSource"));
                                return;
                              }
                              setUninstallPack({
                                ...target,
                                count: selected.skill_count,
                              });
                            }
                          : undefined
                      }
                    />
                  </div>
                </ScrollArea>
              ) : (
                <div className="flex flex-1 items-center justify-center text-muted-foreground text-sm">
                  {t("skills.selectCategory")}
                </div>
              )}
            </div>
          </div>

          {/* Footer */}
          <div className="flex shrink-0 items-center justify-between border-border border-t bg-muted/20 px-6 py-2.5">
            <p className="font-mono text-[11px] text-muted-foreground/60">
              {status?.location ?? "LocalPrism · claude-home/skills"}
            </p>
            <Button
              variant="ghost"
              size="sm"
              onClick={onClose}
              className="text-muted-foreground"
            >
              {t("onboarding.close")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !deletingSkillFolder) setDeleteTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("skills.deleteTitle")}</DialogTitle>
            <DialogDescription>
              {t("skills.deleteBody", {
                name: deleteTarget?.name ?? t("settings.skills"),
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2 font-mono text-muted-foreground text-xs">
            {deleteTarget?.folder}
          </div>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={deletingSkillFolder !== null}
              onClick={() => setDeleteTarget(null)}
            >
              {t("chrome.cancel")}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={deletingSkillFolder !== null}
              onClick={handleConfirmDeleteSkill}
              data-testid="skill-delete-confirm"
              className="gap-1.5"
            >
              {deletingSkillFolder ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : (
                <Trash2Icon className="size-3.5" />
              )}
              {t("chrome.delete")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={confirmTargets !== null}
        onOpenChange={(open) => {
          if (!open && !isInstalling) setConfirmTargets(null);
        }}
      >
        <DialogContent
          className="sm:max-w-sm"
          data-testid="skill-download-confirm"
        >
          <DialogHeader>
            <DialogTitle>{t("skills.downloadConfirmTitle")}</DialogTitle>
            <DialogDescription>
              {t("skills.downloadConfirmBody")}
            </DialogDescription>
          </DialogHeader>
          <ul className="space-y-1 text-sm">
            {remoteRefreshTargets(confirmTargets ?? []).map((target) => (
              <li key={target.id}>{target.name}</li>
            ))}
          </ul>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmTargets(null)}
            >
              {t("chrome.cancel")}
            </Button>
            <Button
              size="sm"
              data-testid="skill-download-confirm-action"
              onClick={() => {
                const targets = confirmTargets ?? [];
                setConfirmTargets(null);
                void runPackUpdates(targets);
              }}
            >
              {t("skills.downloadConfirmAction")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={uninstallPack !== null}
        onOpenChange={(open) => {
          if (!open && !isUninstalling) setUninstallPack(null);
        }}
      >
        <DialogContent
          className="sm:max-w-sm"
          data-testid="skill-pack-uninstall-confirm"
        >
          <DialogHeader>
            <DialogTitle>
              {t("skills.uninstallPackTitle", {
                name: uninstallPack?.name ?? "",
              })}
            </DialogTitle>
            <DialogDescription>
              {t("skills.uninstallPackBody")}
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive text-xs">
            {t("skills.uninstallPackCount", {
              name: uninstallPack?.name ?? "",
              count: uninstallPack?.count ?? 0,
            })}
          </div>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={isUninstalling}
              onClick={() => setUninstallPack(null)}
            >
              {t("chrome.cancel")}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              data-testid="skill-pack-uninstall-confirm-action"
              disabled={isUninstalling}
              onClick={() => void handleUninstallPack()}
            >
              {t("skills.uninstallPack")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={importChooserOpen} onOpenChange={setImportChooserOpen}>
        <DialogContent
          className="sm:max-w-md"
          data-testid="skill-import-chooser"
        >
          <DialogHeader>
            <DialogTitle>{t("skills.importChooserTitle")}</DialogTitle>
            <DialogDescription>{t("skills.addHelp")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              data-testid="skill-dialog-import-folder"
              disabled={isImporting}
              onClick={() => void handleImportFolder()}
            >
              <FolderPlusIcon className="size-3.5" />
              {t("skills.importFolder")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="skill-dialog-import-archive"
              disabled={isImporting}
              onClick={() => void handleImportArchive()}
            >
              <FileArchiveIcon className="size-3.5" />
              {t("skills.importArchive")}
            </Button>
          </div>
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              void handleImportUrl();
            }}
          >
            <p className="text-muted-foreground text-xs">
              {t("skills.addUrlHelp")}
            </p>
            <div className="flex gap-2">
              <Input
                value={importUrlDraft}
                onChange={(event) => setImportUrlDraft(event.target.value)}
                placeholder={t("skills.addUrlPlaceholder")}
                aria-label={t("skills.addUrl")}
                data-testid="skill-dialog-import-url"
              />
              <Button
                type="submit"
                size="sm"
                disabled={isImporting || importUrlDraft.trim().length === 0}
              >
                <Link2Icon className="size-3.5" />
                {t("skills.addUrlAction")}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <SkillReplaceDialog
        conflicts={replaceConflicts}
        busy={isImporting}
        onCancel={() => {
          pendingImportRef.current = null;
          setReplaceConflicts([]);
        }}
        onReplace={() => void handleConfirmReplace()}
      />

      <Dialog
        open={confirmUninstallAllOpen}
        onOpenChange={(open) => {
          if (!open && !isUninstalling) setConfirmUninstallAllOpen(false);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("skills.uninstallAllTitle")}</DialogTitle>
            <DialogDescription>
              {t("skills.uninstallAllBody")}
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive text-xs">
            {t("skills.uninstallAllCount", {
              count: status?.skill_count ?? 0,
            })}
          </div>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={isUninstalling}
              onClick={() => setConfirmUninstallAllOpen(false)}
            >
              {t("chrome.cancel")}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={isUninstalling}
              onClick={async () => {
                await handleUninstall();
                setConfirmUninstallAllOpen(false);
              }}
              className="gap-1.5"
            >
              {isUninstalling ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : (
                <Trash2Icon className="size-3.5" />
              )}
              {t("skills.uninstallAllAction")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ─── Category Detail Panel ───

function categorySourceUrl(
  category: SkillCategoryData | SkillsBrowserCategory,
): string | null {
  if ("sourceUrl" in category && category.sourceUrl) {
    return category.sourceUrl;
  }
  const packId = packIdFromBrowserCategoryId(category.id);
  return packId ? skillPackDocsUrl(packId) : null;
}

function SkillGithubLink({ href, label }: { href: string; label: string }) {
  const { t } = useI18n();
  return (
    <a
      href={href}
      data-testid="skill-pack-github-link"
      title={href}
      aria-label={t("skills.openGithub", { label })}
      onClick={(event) => {
        event.preventDefault();
        void shellOpen(href).catch((error) => {
          toast.error(t("skills.githubFailed"), {
            description: String(error),
          });
        });
      }}
      className="mt-2 inline-flex max-w-full items-center gap-1.5 text-left text-muted-foreground text-xs transition-colors hover:text-foreground"
    >
      <GithubIcon className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">{label}</span>
    </a>
  );
}

function PackChangeList({
  label,
  names,
  emptyLabel,
}: {
  label: string;
  names: string[];
  emptyLabel: string;
}) {
  return (
    <p className="mt-1 text-muted-foreground">
      {label}: {names.length > 0 ? names.join(", ") : emptyLabel}
    </p>
  );
}

function CategoryDetail({
  category,
  isInstalled,
  installedSkillFolders,
  deletingSkillFolder,
  onDeleteSkill,
  onUninstallPack,
}: {
  category: SkillCategoryData | SkillsBrowserCategory;
  isInstalled: boolean;
  installedSkillFolders: Set<string>;
  deletingSkillFolder: string | null;
  onDeleteSkill: (skill: SkillEntryData) => void;
  onUninstallPack?: () => void;
}) {
  const { t } = useI18n();
  const Icon = ICON_MAP[category.icon] || FlaskConicalIcon;
  const packSourceUrl = categorySourceUrl(category);
  const packHomeUrl = packSourceUrl ? skillGithubUrl(packSourceUrl) : null;
  const [selectedSkill, setSelectedSkill] = useState<SkillEntryData | null>(
    null,
  );
  const [skillContent, setSkillContent] = useState<string | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Reset when category changes
  useEffect(() => {
    setSelectedSkill(null);
    setSkillContent(null);
    setFetchError(null);
  }, [category.id]);

  const handleSkillClick = useCallback(
    async (skill: SkillEntryData) => {
      if (selectedSkill?.folder === skill.folder) {
        setSelectedSkill(null);
        setSkillContent(null);
        setFetchError(null);
        return;
      }
      setSelectedSkill(skill);
      setSkillContent(null);
      setFetchError(null);
      setLoadingContent(true);
      try {
        const content = await invoke<string>("get_skill_content", {
          skillFolder: skill.folder,
          projectPath: null,
        });
        setSkillContent(content);
      } catch (e) {
        setFetchError(String(e));
      } finally {
        setLoadingContent(false);
      }
    },
    [selectedSkill],
  );

  // Viewing a specific skill
  if (selectedSkill) {
    return (
      <div>
        <button
          onClick={() => {
            setSelectedSkill(null);
            setSkillContent(null);
            setFetchError(null);
          }}
          className="mb-3 flex items-center gap-1 text-muted-foreground text-xs transition-colors hover:text-foreground"
        >
          <ChevronLeftIcon className="size-3.5" />
          {category.name}
        </button>

        <div className="flex items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted">
            <Icon className="size-5 text-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold text-sm">{selectedSkill.name}</h3>
            <p className="mt-0.5 font-mono text-[11px] text-muted-foreground/60">
              {selectedSkill.folder}
            </p>
            {packSourceUrl ? (
              <SkillGithubLink
                href={skillGithubUrl(packSourceUrl, selectedSkill.folder)}
                label={`${githubRepoLabel(packSourceUrl)}/${selectedSkill.folder}`}
              />
            ) : null}
          </div>
          {installedSkillFolders.has(selectedSkill.folder) && (
            <Button
              variant="ghost"
              size="icon"
              className="size-8 shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              disabled={deletingSkillFolder === selectedSkill.folder}
              onClick={() => onDeleteSkill(selectedSkill)}
              title={t("skills.deleteSkill")}
            >
              {deletingSkillFolder === selectedSkill.folder ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : (
                <Trash2Icon className="size-4" />
              )}
            </Button>
          )}
        </div>

        <Separator className="my-4" />

        {loadingContent ? (
          <div className="flex items-center gap-2 py-4 text-muted-foreground text-xs">
            <Loader2Icon className="size-3.5 animate-spin" />
            {t("skills.loadingContent")}
          </div>
        ) : fetchError ? (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
            <AlertCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
            <p className="text-muted-foreground text-xs leading-relaxed">
              {fetchError}
            </p>
          </div>
        ) : skillContent ? (
          <div className="whitespace-pre-wrap rounded-lg border border-border/60 bg-muted/30 p-4 font-mono text-foreground/80 text-xs leading-relaxed">
            {skillContent}
          </div>
        ) : null}
      </div>
    );
  }

  // Skill list view
  return (
    <div>
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted">
          <Icon className="size-5 text-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold text-sm">{category.name}</h3>
          <div className="mt-1 flex items-center gap-2">
            <Badge variant="secondary" className="text-xs">
              {t("env.skillCount", { count: category.skill_count })}
            </Badge>
            {isInstalled && (
              <Badge variant="secondary" className="gap-1 text-xs">
                <CheckCircle2Icon className="size-3" />
                {t("env.installed")}
              </Badge>
            )}
          </div>
          {packHomeUrl ? (
            <SkillGithubLink
              href={packHomeUrl}
              label={githubRepoLabel(packHomeUrl)}
            />
          ) : null}
          {onUninstallPack ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3 text-destructive hover:text-destructive"
              data-testid="skill-pack-uninstall"
              onClick={onUninstallPack}
            >
              <Trash2Icon className="size-3.5" />
              {t("skills.uninstallPack")}
            </Button>
          ) : null}
        </div>
      </div>

      <Separator className="my-4" />

      <div>
        <h4 className="mb-2 font-medium text-muted-foreground text-xs uppercase tracking-wider">
          {t("settings.skills")}
        </h4>
        {category.skills.length === 0 ? (
          <p className="rounded-lg border border-dashed px-3 py-6 text-center text-muted-foreground text-xs">
            {t("skills.emptyCategory")}
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-1.5">
            {category.skills.map((skill) => {
              const canDelete =
                Boolean(skill.id) && installedSkillFolders.has(skill.folder);
              const isDeleting = deletingSkillFolder === skill.folder;
              return (
                <div
                  key={skill.folder}
                  className="group flex min-w-0 items-center rounded-lg border border-border/60 bg-card/30 transition-colors hover:border-border hover:bg-accent/30"
                >
                  <button
                    type="button"
                    onClick={() => handleSkillClick(skill)}
                    className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-sm"
                  >
                    <span className="size-1.5 shrink-0 rounded-full bg-foreground/40" />
                    <span className="min-w-0 truncate">{skill.name}</span>
                  </button>
                  {canDelete && (
                    <button
                      type="button"
                      aria-label={t("skills.deleteNamed", { name: skill.name })}
                      title={t("skills.deleteSkill")}
                      disabled={isDeleting}
                      onClick={(event) => {
                        event.stopPropagation();
                        onDeleteSkill(skill);
                      }}
                      className="mr-1 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-70 transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50 group-hover:opacity-100"
                    >
                      {isDeleting ? (
                        <Loader2Icon className="size-3.5 animate-spin" />
                      ) : (
                        <Trash2Icon className="size-3.5" />
                      )}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Helper ───

export function shouldShowOnboarding(): boolean {
  return localStorage.getItem(STORAGE_KEY) !== "true";
}

export function resetOnboardingFlag(): void {
  localStorage.removeItem(STORAGE_KEY);
}
