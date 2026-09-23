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
import { useSkillStore } from "@/stores/skill-store";
import { useDocumentStore } from "@/stores/document-store";
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

const STORAGE_KEY = "scientific-skills-installed";

interface InstallResult {
  success: boolean;
  skills_installed: number;
  target_dir: string;
  message: string;
}

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
  const [categories, setCategories] = useState<SkillCategoryData[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isInstalling, setIsInstalling] = useState(false);
  const [isComplete, setIsComplete] = useState(false);
  const [installLogs, setInstallLogs] = useState<string[]>([]);
  const [installResult, setInstallResult] = useState<InstallResult | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<SkillsStatus | null>(null);
  const [installedSkills, setInstalledSkills] = useState<SkillInfo[]>([]);
  const [isUninstalling, setIsUninstalling] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [confirmUninstallAllOpen, setConfirmUninstallAllOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SkillEntryData | null>(null);
  const [deletingSkillFolder, setDeletingSkillFolder] = useState<string | null>(
    null,
  );
  const mountedRef = useRef(true);
  const installBackendLogSeenRef = useRef(false);
  const selectedTargets = useSkillStore((state) => state.selectedTargets);
  const importFolder = useSkillStore((state) => state.importFolder);
  const refreshSkills = useSkillStore((state) => state.refresh);
  const updateDefaultSkillPacks = useSkillStore(
    (state) => state.updateDefaultSkillPacks,
  );
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
            name: skill.name,
            folder: skill.folder,
            category: skill.category,
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
      }),
    [categories, installedRuntimeSkills, installedSkills],
  );

  useEffect(() => {
    if (
      selectedId &&
      displayCategories.some((category) => category.id === selectedId)
    ) {
      return;
    }
    const firstInstalled = displayCategories.find((category) =>
      category.id.startsWith("installed:"),
    );
    setSelectedId(firstInstalled?.id ?? displayCategories[0]?.id ?? null);
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

  const handleInstall = useCallback(async () => {
    installBackendLogSeenRef.current = false;
    let noBackendLogTimer: number | undefined;
    setInstallLogs(["Preparing installer..."]);
    setIsInstalling(true);
    setIsComplete(false);
    setInstallResult(null);
    setError(null);

    try {
      noBackendLogTimer = window.setTimeout(() => {
        if (installBackendLogSeenRef.current || !mountedRef.current) return;
        setInstallLogs((previous) => {
          const hasBackendLog = previous.some(
            (line) => !line.startsWith("Preparing installer"),
          );
          if (hasBackendLog) return previous;
          return [...previous, "Waiting for the installer command to start..."];
        });
      }, 2500);

      await new Promise((resolve) => window.setTimeout(resolve, 150));
      if (!mountedRef.current) return;

      const results = await updateDefaultSkillPacks();
      if (noBackendLogTimer !== undefined) {
        window.clearTimeout(noBackendLogTimer);
      }
      if (!mountedRef.current) return;
      const imported = results.filter(
        (item) => item.status === "imported",
      ).length;
      const failed = results.find((item) => item.status === "error");
      if (failed) {
        throw new Error(failed.error ?? `Failed to update ${failed.id}`);
      }
      setInstallResult({
        success: true,
        skills_installed: imported,
        target_dir: "LocalPrism skills",
        message: `Updated ${imported} default skill packs`,
      });
      setIsComplete(true);
      localStorage.setItem(STORAGE_KEY, "true");
      await checkStatus();
      await refreshSkills(projectPath ?? undefined);
    } catch (e) {
      if (noBackendLogTimer !== undefined) {
        window.clearTimeout(noBackendLogTimer);
      }
      if (!mountedRef.current) return;
      const message = String(e);
      setInstallLogs((previous) => [...previous, message]);
      setError(message);
      setIsInstalling(false);
    }
  }, [checkStatus, projectPath, refreshSkills, updateDefaultSkillPacks]);

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
      toast.success("All skills uninstalled");
    } catch (e) {
      console.error("Failed to uninstall:", e);
      toast.error("Failed to uninstall skills", {
        description: String(e),
      });
    } finally {
      setIsUninstalling(false);
    }
  }, [checkStatus, projectPath, refreshSkills]);

  const handleImportSkill = useCallback(async () => {
    setIsImporting(true);
    try {
      const selectedFolder = await open({
        directory: true,
        multiple: false,
        title: "Import Skill Folder",
      });

      if (typeof selectedFolder !== "string") return;

      const targets = useSkillStore.getState().selectedTargets;
      await importFolder(selectedFolder, targets, projectPath ?? undefined);

      localStorage.setItem(STORAGE_KEY, "true");
      await checkStatus();
      await refreshSkills(projectPath ?? undefined);
      toast.success("Skill imported", {
        description: "Saved to claude-home/skills",
      });
    } catch (e) {
      toast.error("Failed to import skill", {
        description: String(e),
      });
    } finally {
      setIsImporting(false);
    }
  }, [checkStatus, importFolder, projectPath, refreshSkills]);

  const handleConfirmDeleteSkill = useCallback(async () => {
    if (!deleteTarget) return;
    setDeletingSkillFolder(deleteTarget.folder);
    try {
      await invoke("delete_installed_skill", {
        skillFolder: deleteTarget.folder,
      });
      toast.success("Skill deleted", {
        description: deleteTarget.name,
      });
      setDeleteTarget(null);
      await checkStatus();
      await refreshSkills(projectPath ?? undefined);
    } catch (e) {
      toast.error("Failed to delete skill", {
        description: String(e),
      });
    } finally {
      setDeletingSkillFolder(null);
    }
  }, [checkStatus, deleteTarget, projectPath, refreshSkills]);

  // ─── Installing / Complete state ───
  if (isInstalling || isComplete || error) {
    return (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="gap-3 px-6 pt-6 pb-4 sm:max-w-md"
        >
          <button
            type="button"
            aria-label="Close"
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
              {isComplete
                ? "Update Complete"
                : error
                  ? "Update Failed"
                  : "Updating Skills"}
            </DialogTitle>
            {isComplete && (
              <DialogDescription>
                {installResult?.skills_installed ?? 0} default skill packs were
                updated.
              </DialogDescription>
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
                onClick={handleInstall}
                className="gap-1.5"
              >
                <RefreshCwIcon className="size-3.5" />
                Retry
              </Button>
            )}
            {(isComplete || error) && (
              <Button size="sm" onClick={onClose}>
                {isComplete ? "Done" : "Close"}
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
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="flex h-[min(36rem,calc(100vh-6rem))] w-[min(56rem,calc(100vw-4rem))] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
        >
          {/* Header */}
          <DialogHeader className="shrink-0 border-border border-b px-6 py-3">
            <div className="flex items-center gap-4">
              <div className="min-w-0 flex-1">
                <DialogTitle className="text-sm">Skills</DialogTitle>
                <DialogDescription className="mt-0.5 text-xs">
                  Skills stay in claude-home/skills, grouped by pack:
                  PaperSpine, academic-research-skills, nature-skills,
                  scientific-agent-skills, and paper-humanizer-skill. Update
                  refreshes those default packs without overwriting unrelated
                  imports. {totalSkills} skills across{" "}
                  {displayCategories.length} packs.
                </DialogDescription>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {isInstalled ? (
                  <>
                    <Badge variant="secondary" className="gap-1 text-xs">
                      <CheckCircle2Icon className="size-3" />
                      {totalSkills} installed
                    </Badge>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleInstall}
                      className="gap-1.5"
                    >
                      <RefreshCwIcon className="size-3.5" />
                      Update
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setConfirmUninstallAllOpen(true)}
                      disabled={isUninstalling}
                      className="gap-1.5 text-destructive hover:text-destructive"
                    >
                      {isUninstalling ? (
                        <Loader2Icon className="size-3.5 animate-spin" />
                      ) : (
                        <Trash2Icon className="size-3.5" />
                      )}
                      Uninstall
                    </Button>
                  </>
                ) : (
                  <Button size="sm" onClick={handleInstall} className="gap-1.5">
                    <DownloadIcon className="size-3.5" />
                    Install All
                  </Button>
                )}
                <Badge variant="secondary" className="h-8 px-2 text-xs">
                  LocalPrism · claude-home/skills
                </Badge>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleImportSkill}
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
                  Import Skill
                </Button>
              </div>
            </div>
          </DialogHeader>

          {/* Body — sidebar + detail */}
          <div className="flex flex-1 overflow-hidden">
            {/* Category sidebar */}
            <nav className="w-64 max-w-64 shrink-0 overflow-hidden border-border border-r">
              <ScrollArea className="h-full w-full overflow-hidden [&_[data-slot=scroll-area-scrollbar]]:hidden">
                <div className="box-border flex w-full min-w-0 flex-col gap-0.5 overflow-x-hidden p-2">
                  {displayCategories.map((cat, index) => {
                    const Icon = ICON_MAP[cat.icon] || FlaskConicalIcon;
                    const isActive = selectedId === cat.id;
                    return (
                      <div key={cat.id}>
                        {index === 0 && (
                          <p className="px-3 pt-1 pb-1 font-medium text-[11px] text-muted-foreground/80 uppercase tracking-wide">
                            Skill packs
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
                    />
                  </div>
                </ScrollArea>
              ) : (
                <div className="flex flex-1 items-center justify-center text-muted-foreground text-sm">
                  Select a category
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
              Close
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
            <DialogTitle>Delete Skill</DialogTitle>
            <DialogDescription>
              Delete {deleteTarget?.name ?? "this skill"} from its installed
              skill destination. This cannot be undone.
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
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={deletingSkillFolder !== null}
              onClick={handleConfirmDeleteSkill}
              className="gap-1.5"
            >
              {deletingSkillFolder ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : (
                <Trash2Icon className="size-3.5" />
              )}
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={confirmUninstallAllOpen}
        onOpenChange={(open) => {
          if (!open && !isUninstalling) setConfirmUninstallAllOpen(false);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Uninstall All Skills</DialogTitle>
            <DialogDescription>
              This will uninstall managed skills from their skill destinations,
              including imported local skills. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive text-xs">
            {status?.skill_count ?? 0} installed skills will be removed.
          </div>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={isUninstalling}
              onClick={() => setConfirmUninstallAllOpen(false)}
            >
              Cancel
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
              Uninstall All
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
  return (
    <a
      href={href}
      data-testid="skill-pack-github-link"
      title={href}
      aria-label={`Open ${label} on GitHub`}
      onClick={(event) => {
        event.preventDefault();
        void shellOpen(href).catch((error) => {
          toast.error("Failed to open GitHub", {
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

function CategoryDetail({
  category,
  isInstalled,
  installedSkillFolders,
  deletingSkillFolder,
  onDeleteSkill,
}: {
  category: SkillCategoryData | SkillsBrowserCategory;
  isInstalled: boolean;
  installedSkillFolders: Set<string>;
  deletingSkillFolder: string | null;
  onDeleteSkill: (skill: SkillEntryData) => void;
}) {
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
              title="Delete skill"
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
            Loading skill content…
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
              {category.skill_count} skills
            </Badge>
            {isInstalled && (
              <Badge variant="secondary" className="gap-1 text-xs">
                <CheckCircle2Icon className="size-3" />
                Installed
              </Badge>
            )}
          </div>
          {packHomeUrl ? (
            <SkillGithubLink
              href={packHomeUrl}
              label={githubRepoLabel(packHomeUrl)}
            />
          ) : null}
        </div>
      </div>

      <Separator className="my-4" />

      <div>
        <h4 className="mb-2 font-medium text-muted-foreground text-xs uppercase tracking-wider">
          Skills
        </h4>
        {category.skills.length === 0 ? (
          <p className="rounded-lg border border-dashed px-3 py-6 text-center text-muted-foreground text-xs">
            No skills in this category yet. Import a folder to add one, then
            click a skill to view its SKILL.md.
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-1.5">
            {category.skills.map((skill) => {
              const canDelete = installedSkillFolders.has(skill.folder);
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
                      aria-label={`Delete ${skill.name}`}
                      title="Delete skill"
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
