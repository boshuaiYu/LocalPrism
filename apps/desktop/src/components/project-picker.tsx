import {
  type ComponentType,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { toast } from "sonner";
import {
  FolderOpenIcon,
  FolderPlusIcon,
  ClockIcon,
  XIcon,
  FileTextIcon,
  SparklesIcon,
  CheckCircle2Icon,
  CircleIcon,
  DownloadIcon,
  Loader2Icon,
  KeyRoundIcon,
  SearchIcon,
  ArrowLeftIcon,
  SettingsIcon,
  GithubIcon,
  MonitorIcon,
  MoonIcon,
  SunIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { useProjectStore } from "@/stores/project-store";
import { useDocumentStore } from "@/stores/document-store";
import { useRuntimeStore } from "@/stores/runtime-store";
import { useUvSetupStore } from "@/stores/uv-setup-store";
import { getMupdfClient } from "@/lib/mupdf/mupdf-client";
import { exists, join } from "@/lib/tauri/fs";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ProjectWizard, type CreationMode } from "./project-wizard";
import { RuntimeSettings } from "./runtime/runtime-settings";
import { HomepageEnvironmentStatus } from "./homepage-environment-status";
import { areDefaultSkillPacksReady } from "@/lib/default-skill-packs";
import { useAgentStore } from "@/stores/agent-store";
import { useSkillStore } from "@/stores/skill-store";
import { cn } from "@/lib/utils";

interface DefaultProject {
  path: string;
  name: string;
  last_modified: number;
  has_main_tex: boolean;
}

type ProjectPickerSection = "projects" | "settings";
type SettingsDetailSection = "runtimes" | "environment";

type RecentProject = {
  path: string;
  name: string;
  lastOpened: number;
};

type ProjectPreviewData = {
  createdAt: number | null;
} & (
  | { kind: "pdf"; url: string }
  | { kind: "tex"; fileName: string; lines: string[] }
  | { kind: "empty" }
);

type ProjectPreviewState =
  | { status: "loading" }
  | { status: "ready"; data: ProjectPreviewData }
  | { status: "error" };

const projectPreviewCache = new Map<string, ProjectPreviewData>();
const projectPreviewRequests = new Map<string, Promise<ProjectPreviewData>>();

export function ProjectPicker() {
  const [showModeDialog, setShowModeDialog] = useState(false);
  const [wizardMode, setWizardMode] = useState<CreationMode | null>(null);
  const [appVersion, setAppVersion] = useState("");
  const [activeSection, setActiveSection] =
    useState<ProjectPickerSection>("projects");
  const [settingsDetailSection, setSettingsDetailSection] =
    useState<SettingsDetailSection>("runtimes");
  const [searchQuery, setSearchQuery] = useState("");
  const [removeProjectTarget, setRemoveProjectTarget] =
    useState<RecentProject | null>(null);
  const defaultProjectsDiscoveredRef = useRef(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const pendingSearchFocus = useRef(false);
  const { theme = "system", setTheme } = useTheme();
  const searchShortcutLabel = useMemo(() => {
    if (typeof navigator === "undefined") return "Ctrl+K";
    return /Mac|iPhone|iPad/i.test(navigator.platform) ? "⌘K" : "Ctrl+K";
  }, []);

  const recentProjects = useProjectStore((s) => s.recentProjects);
  const addRecentProject = useProjectStore((s) => s.addRecentProject);
  const removeRecentProject = useProjectStore((s) => s.removeRecentProject);
  const openProject = useDocumentStore((s) => s.openProject);

  const readyRuntimeCount = useRuntimeStore(
    (state) =>
      Object.values(state.accounts).filter(
        (account) => account.installed && account.authenticated,
      ).length,
  );

  useEffect(() => {
    getVersion().then(setAppVersion);
  }, []);

  useEffect(() => {
    const handleSearchShortcut = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() !== "k" ||
        event.altKey ||
        event.shiftKey ||
        (!event.metaKey && !event.ctrlKey)
      ) {
        return;
      }

      if (recentProjects.length === 0 && activeSection === "projects") {
        return;
      }

      event.preventDefault();
      pendingSearchFocus.current = true;
      setActiveSection("projects");
    };

    window.addEventListener("keydown", handleSearchShortcut);
    return () => window.removeEventListener("keydown", handleSearchShortcut);
  }, [activeSection, recentProjects.length]);

  useEffect(() => {
    if (!pendingSearchFocus.current) return;
    if (activeSection !== "projects" || !searchInputRef.current) return;
    pendingSearchFocus.current = false;
    searchInputRef.current.focus();
    searchInputRef.current.select();
  }, [activeSection, recentProjects.length, searchQuery]);

  useEffect(() => {
    if (defaultProjectsDiscoveredRef.current || recentProjects.length > 0) {
      return;
    }
    defaultProjectsDiscoveredRef.current = true;

    let cancelled = false;

    async function discoverDefaultProjects() {
      try {
        const projects = await invoke<DefaultProject[]>(
          "list_default_projects",
        );
        if (cancelled || projects.length === 0) return;

        for (const project of [...projects].reverse()) {
          addRecentProject(project.path);
        }
      } catch (err) {
        console.warn("Failed to discover default projects:", err);
      }
    }

    discoverDefaultProjects();

    return () => {
      cancelled = true;
    };
  }, [addRecentProject, recentProjects.length]);

  const handleOpenFolder = async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Open Project Folder",
      });
      if (typeof selected === "string" && selected) {
        await openProject(selected);
        addRecentProject(selected);
      }
    } catch (err) {
      console.warn("Failed to open selected project folder:", err);
      toast.error("Failed to open project folder", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleOpenRecent = async (path: string) => {
    try {
      await openProject(path);
      addRecentProject(path);
    } catch (err) {
      const stillExists = await exists(path).catch(() => false);
      if (!stillExists) {
        removeRecentProject(path);
      }
      console.warn("Failed to open recent project:", { path, error: err });
      toast.error("Failed to open recent project", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleSelectMode = (mode: CreationMode) => {
    setShowModeDialog(false);
    setWizardMode(mode);
  };

  const normalizedSearch = searchQuery.trim().toLowerCase();
  const visibleProjects = useMemo(() => {
    if (!normalizedSearch) return recentProjects;
    return recentProjects.filter(
      (project) =>
        project.name.toLowerCase().includes(normalizedSearch) ||
        project.path.toLowerCase().includes(normalizedSearch),
    );
  }, [normalizedSearch, recentProjects]);

  if (wizardMode) {
    return (
      <ProjectWizard mode={wizardMode} onBack={() => setWizardMode(null)} />
    );
  }

  const cycleTheme = () => {
    if (theme === "system") setTheme("light");
    else if (theme === "light") setTheme("dark");
    else setTheme("system");
  };

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-background text-foreground">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,oklch(0.96_0.02_85)_0%,transparent_55%)] dark:bg-[radial-gradient(ellipse_at_top,oklch(0.22_0.03_270)_0%,transparent_55%)]"
      />

      <header className="relative z-10 flex h-[calc(44px+var(--titlebar-height))] shrink-0 items-center justify-end gap-1 px-4 pt-[var(--titlebar-height)]">
        <Button variant="ghost" size="icon" className="size-8" asChild>
          <a
            href="https://github.com/boshuaiYu/LocalPrism"
            target="_blank"
            rel="noopener noreferrer"
            title="GitHub"
          >
            <GithubIcon className="size-4" />
          </a>
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          onClick={cycleTheme}
          title={
            theme === "system"
              ? "System theme"
              : theme === "light"
                ? "Light mode"
                : "Dark mode"
          }
        >
          {theme === "system" ? (
            <MonitorIcon className="size-4" />
          ) : theme === "light" ? (
            <SunIcon className="size-4" />
          ) : (
            <MoonIcon className="size-4" />
          )}
        </Button>
        <Button
          variant={activeSection === "settings" ? "secondary" : "ghost"}
          className="h-8 gap-1.5 px-2.5 text-muted-foreground hover:text-foreground"
          onClick={() =>
            setActiveSection((section) =>
              section === "settings" ? "projects" : "settings",
            )
          }
        >
          <SettingsIcon className="size-4" />
          Settings
        </Button>
      </header>

      <main className="relative z-10 min-h-0 flex-1 overflow-auto">
        {activeSection === "settings" ? (
          <div className="mx-auto w-full max-w-4xl px-6 pb-12">
            <button
              type="button"
              onClick={() => setActiveSection("projects")}
              className="mb-5 inline-flex items-center gap-1.5 text-muted-foreground text-sm transition-colors hover:text-foreground"
            >
              <ArrowLeftIcon className="size-3.5" />
              Back to home
            </button>
            <h1 className="mb-6 font-semibold text-xl tracking-tight">
              Settings
            </h1>
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-[13rem_minmax(0,1fr)]">
              <aside className="space-y-1 lg:border-border/60 lg:border-r lg:pr-4">
                <SettingsDetailButton
                  active={settingsDetailSection === "runtimes"}
                  icon={KeyRoundIcon}
                  label="Providers"
                  meta={`${readyRuntimeCount}/2 ready`}
                  onClick={() => setSettingsDetailSection("runtimes")}
                />
                <SettingsDetailButton
                  active={settingsDetailSection === "environment"}
                  icon={CheckCircle2Icon}
                  label="Environment"
                  meta="Python / Skills"
                  onClick={() => setSettingsDetailSection("environment")}
                />
              </aside>
              <div className="min-w-0">
                {settingsDetailSection === "runtimes" ? (
                  <SettingsPanel
                    title="Providers"
                    icon={KeyRoundIcon}
                    contentClassName="p-0"
                  >
                    <RuntimeSettings />
                  </SettingsPanel>
                ) : (
                  <SettingsPanel
                    title="Environment"
                    icon={CheckCircle2Icon}
                    contentClassName="p-0"
                  >
                    <EnvironmentStatus appVersion={appVersion} />
                  </SettingsPanel>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="mx-auto flex min-h-full w-full max-w-xl flex-col justify-center px-6 py-10">
            <div className="mb-8 text-center">
              <div className="mx-auto mb-4 flex size-16 items-center justify-center rounded-2xl border border-border/70 bg-background/80 shadow-sm">
                <img src="/icon-192.png" alt="" className="size-10" />
              </div>
              <h1 className="font-semibold text-3xl tracking-tight">
                LocalPrism
              </h1>
              <p className="mt-2 text-muted-foreground text-sm">
                AI-powered academic writing workspace
              </p>
            </div>

            <div className="flex gap-3">
              <Button
                onClick={() => setShowModeDialog(true)}
                size="lg"
                variant="outline"
                className="h-11 flex-1 gap-2 rounded-xl"
              >
                <FolderPlusIcon className="size-4" />
                New Project
              </Button>
              <Button
                onClick={handleOpenFolder}
                size="lg"
                className="h-11 flex-1 gap-2 rounded-xl"
              >
                <FolderOpenIcon className="size-4" />
                Open Folder
              </Button>
            </div>

            <HomepageEnvironmentStatus />

            {(recentProjects.length > 0 || normalizedSearch) && (
              <section className="mt-8">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 text-muted-foreground text-xs uppercase tracking-wide">
                    <ClockIcon className="size-3.5" />
                    Recent Projects
                  </div>
                  <div className="relative w-40">
                    <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <input
                      ref={searchInputRef}
                      value={searchQuery}
                      onChange={(event) => setSearchQuery(event.target.value)}
                      placeholder="Search"
                      className="h-8 w-full rounded-lg border border-input bg-background pr-12 pl-8 text-xs outline-none transition-colors placeholder:text-muted-foreground focus:border-ring"
                    />
                    <kbd className="pointer-events-none absolute top-1/2 right-1.5 -translate-y-1/2 rounded border border-border/70 px-1 font-medium text-[10px] text-muted-foreground">
                      {searchShortcutLabel}
                    </kbd>
                  </div>
                </div>

                {visibleProjects.length === 0 ? (
                  <div className="rounded-xl border border-border border-dashed px-4 py-8 text-center text-muted-foreground text-sm">
                    No matching projects
                  </div>
                ) : (
                  <div className="overflow-hidden rounded-xl border border-border/70 bg-background/70 shadow-sm">
                    {visibleProjects.map((project) => (
                      <RecentProjectRow
                        key={project.path}
                        project={project}
                        onOpen={() => handleOpenRecent(project.path)}
                        onRemove={() => setRemoveProjectTarget(project)}
                      />
                    ))}
                  </div>
                )}
              </section>
            )}

            <p className="mt-10 text-center text-muted-foreground text-xs">
              LocalPrism{appVersion ? ` v${appVersion}` : ""}
            </p>
          </div>
        )}
      </main>

      {/* New Project mode selection dialog */}
      <Dialog open={showModeDialog} onOpenChange={setShowModeDialog}>
        <DialogContent showCloseButton={false} className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create New Project</DialogTitle>
            <DialogDescription>How would you like to start?</DialogDescription>
          </DialogHeader>
          <div className="flex gap-3 pt-2">
            <button
              onClick={() => handleSelectMode("template")}
              className="group flex flex-1 flex-col items-center gap-3 rounded-lg border border-border/70 p-4 text-center transition-colors hover:border-border hover:bg-muted/50"
            >
              <div className="flex size-10 items-center justify-center rounded-md bg-muted/50 transition-colors group-hover:bg-muted">
                <SparklesIcon className="size-5 text-muted-foreground transition-colors group-hover:text-foreground" />
              </div>
              <div>
                <div className="font-semibold text-sm">Guided Setup</div>
                <p className="mt-1 text-muted-foreground text-xs leading-relaxed">
                  Pick a template and let AI help you get started
                </p>
              </div>
              <span className="rounded-md bg-muted px-2 py-0.5 font-medium text-[10px] text-muted-foreground">
                Recommended
              </span>
            </button>

            <button
              onClick={() => handleSelectMode("scratch")}
              className="group flex flex-1 flex-col items-center gap-3 rounded-lg border border-border/70 p-4 text-center transition-colors hover:border-border hover:bg-muted/50"
            >
              <div className="flex size-10 items-center justify-center rounded-md bg-muted/50 transition-colors group-hover:bg-muted">
                <FileTextIcon className="size-5 text-muted-foreground transition-colors group-hover:text-foreground" />
              </div>
              <div>
                <div className="font-semibold text-sm">Blank Document</div>
                <p className="mt-1 text-muted-foreground text-xs leading-relaxed">
                  Start with an empty LaTeX file
                </p>
              </div>
            </button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!removeProjectTarget}
        onOpenChange={(open) => {
          if (!open) setRemoveProjectTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Remove Project</DialogTitle>
            <DialogDescription>
              Remove "{removeProjectTarget?.name ?? "this project"}" from Recent
              Projects? The project files will stay on disk.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRemoveProjectTarget(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (!removeProjectTarget) return;
                removeRecentProject(removeProjectTarget.path);
                setRemoveProjectTarget(null);
              }}
              disabled={!removeProjectTarget}
            >
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Environment Status (shown when Claude is ready) ───

interface SkillsStatus {
  installed: boolean;
  skill_count: number;
  location: string;
}

function projectPreviewCacheKey(project: RecentProject) {
  return `${project.path}:${project.lastOpened}`;
}

async function firstExistingProjectFile(
  projectPath: string,
  candidates: string[][],
): Promise<{ absolutePath: string; relativePath: string } | null> {
  for (const segments of candidates) {
    const absolutePath = await join(projectPath, ...segments);
    if (await exists(absolutePath)) {
      return {
        absolutePath,
        relativePath: segments.join("/"),
      };
    }
  }
  return null;
}

async function firstExistingPath(
  projectPath: string,
  candidates: string[][],
): Promise<string | null> {
  return (
    (await firstExistingProjectFile(projectPath, candidates))?.absolutePath ??
    null
  );
}

async function renderPdfThumbnailFromBytes(bytes: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const client = getMupdfClient();
  let docId: number | null = null;

  try {
    docId = await client.openDocument(buffer);
    const pngBuffer = await client.renderThumbnail(docId, 0, 420);
    const blob = new Blob([new Uint8Array(pngBuffer)], { type: "image/png" });
    return URL.createObjectURL(blob);
  } finally {
    if (docId !== null) {
      await client.closeDocument(docId).catch(() => {});
    }
  }
}

async function renderPdfThumbnail(pdfPath: string): Promise<string> {
  return renderPdfThumbnailFromBytes(await readFile(pdfPath));
}

async function loadProjectPreview(
  project: RecentProject,
): Promise<ProjectPreviewData> {
  const cacheKey = projectPreviewCacheKey(project);
  const cached = projectPreviewCache.get(cacheKey);
  if (cached) return cached;

  const pending = projectPreviewRequests.get(cacheKey);
  if (pending) return pending;

  const promise = (async () => {
    const createdAt = null;
    const pdfPath = await firstExistingPath(project.path, [
      [".prism", "build", "main.pdf"],
      [".prism", "build", "document.pdf"],
      ["main.pdf"],
      ["document.pdf"],
    ]);

    if (pdfPath) {
      const data: ProjectPreviewData = {
        kind: "pdf",
        url: await renderPdfThumbnail(pdfPath),
        createdAt,
      };
      projectPreviewCache.set(cacheKey, data);
      return data;
    }

    const data: ProjectPreviewData = { kind: "empty", createdAt };
    projectPreviewCache.set(cacheKey, data);
    return data;
  })();

  projectPreviewRequests.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    projectPreviewRequests.delete(cacheKey);
  }
}

function RecentProjectRow({
  project,
  onOpen,
  onRemove,
}: {
  project: RecentProject;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const [preview, setPreview] = useState<ProjectPreviewState>(() => {
    const cached = projectPreviewCache.get(projectPreviewCacheKey(project));
    return cached ? { status: "ready", data: cached } : { status: "loading" };
  });
  useEffect(() => {
    let cancelled = false;
    const cacheKey = projectPreviewCacheKey(project);
    const cached = projectPreviewCache.get(cacheKey);
    if (cached) {
      setPreview({ status: "ready", data: cached });
      return;
    }

    setPreview({ status: "loading" });
    loadProjectPreview(project)
      .then((data) => {
        if (!cancelled) setPreview({ status: "ready", data });
      })
      .catch((err) => {
        console.warn("Failed to load project preview:", {
          path: project.path,
          error: err,
        });
        if (!cancelled) setPreview({ status: "error" });
      });

    return () => {
      cancelled = true;
    };
  }, [project]);

  return (
    <div className="group flex items-center gap-3 border-border/60 border-b px-3 py-2.5 last:border-b-0 hover:bg-muted/50">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
        onClick={onOpen}
      >
        <div className="h-12 w-9 shrink-0 overflow-hidden rounded-md border border-border/70 bg-muted/20">
          <ProjectPreviewSurface preview={preview} projectName={project.name} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-sm">{project.name}</div>
          <div className="truncate text-muted-foreground text-xs">
            {project.path}
          </div>
        </div>
      </button>
      <Button
        variant="ghost"
        size="icon"
        className="size-7 shrink-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
        onClick={onRemove}
        aria-label={`Remove ${project.name}`}
      >
        <XIcon className="size-3.5" />
      </Button>
    </div>
  );
}

function ProjectPreviewSurface({
  preview,
  projectName,
}: {
  preview: ProjectPreviewState;
  projectName: string;
}) {
  if (preview.status === "loading") {
    return (
      <div className="flex h-full w-full items-center justify-center bg-muted/10">
        <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (preview.status === "ready" && preview.data.kind === "pdf") {
    return (
      <img
        src={preview.data.url}
        alt={`${projectName} preview`}
        className="h-full w-full bg-white object-cover object-top"
      />
    );
  }

  if (preview.status === "ready" && preview.data.kind === "tex") {
    return (
      <div className="h-full w-full overflow-hidden bg-background">
        <div className="flex h-7 items-center border-border/60 border-b px-2">
          <span className="truncate font-mono text-[10px] text-muted-foreground">
            {preview.data.fileName}
          </span>
        </div>
        <div className="space-y-1 px-2 py-2 font-mono text-[10px] text-muted-foreground">
          {preview.data.lines.map((line, index) => (
            <div key={`${index}-${line}`} className="truncate">
              {line}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full items-center justify-center bg-muted/10 text-muted-foreground">
      <FileTextIcon className="size-4" />
    </div>
  );
}

function SettingsDetailButton({
  active,
  icon: Icon,
  label,
  meta,
  onClick,
}: {
  active: boolean;
  icon: LucideIcon;
  label: string;
  meta: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors",
        active
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
      )}
    >
      <div
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-md border",
          active
            ? "border-border/70 bg-background/70"
            : "border-border/60 bg-muted/20",
        )}
      >
        <Icon className="size-3.5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-sm">{label}</div>
        <div className="truncate text-muted-foreground text-xs">{meta}</div>
      </div>
    </button>
  );
}

function SettingsPanel({
  title,
  icon: Icon,
  contentClassName,
  children,
}: {
  title: string;
  icon: LucideIcon;
  contentClassName?: string;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-border/60 bg-muted/10">
      <div className="flex items-center gap-3 border-border/60 border-b px-5 py-4">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/70 bg-muted/30 text-muted-foreground">
          <Icon className="size-4" />
        </div>
        <div className="min-w-0">
          <h2 className="truncate font-semibold text-sm">{title}</h2>
        </div>
      </div>
      <div className={cn("p-4", contentClassName)}>{children}</div>
    </section>
  );
}

function EnvironmentStatus({ appVersion }: { appVersion: string }) {
  const uvStatus = useUvSetupStore((s) => s.status);
  const uvVersion = useUvSetupStore((s) => s.version);
  const uvInstalling = useUvSetupStore((s) => s.isInstalling);
  const checkUv = useUvSetupStore((s) => s.checkStatus);
  const installUv = useUvSetupStore((s) => s.install);
  const _finishUvInstall = useUvSetupStore((s) => s._finishInstall);

  const [skillsStatus, setSkillsStatus] = useState<SkillsStatus | null>(null);
  const [skillsInstalling, _setSkillsInstalling] = useState(false);
  const [showSkillsOnboarding, setShowSkillsOnboarding] = useState(false);
  const [paperSpineInstalling, setPaperSpineInstalling] = useState(false);
  const paperSpineSkills = useSkillStore((state) => state.skills);
  const refreshSkills = useSkillStore((state) => state.refresh);
  const ensurePaperSpineSkills = useSkillStore(
    (state) => state.ensurePaperSpineSkills,
  );
  const ensureDefaultSkillPacks = useSkillStore(
    (state) => state.ensureDefaultSkillPacks,
  );
  const installingPackId = useSkillStore((state) => state.installingPackId);
  const agents = useAgentStore((state) => state.agents);
  const paperSpineReady = areDefaultSkillPacksReady(paperSpineSkills, agents);

  const checkSkills = useCallback(async () => {
    try {
      const gs = await invoke<SkillsStatus>("check_skills_installed", {
        projectPath: null,
      });
      setSkillsStatus(gs);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    checkUv();
    checkSkills();
    void refreshSkills();
    void ensureDefaultSkillPacks().finally(() => {
      void checkSkills();
    });
  }, [checkSkills, checkUv, ensureDefaultSkillPacks, refreshSkills]);

  // Listen for uv install completion
  useEffect(() => {
    const unlisten = listen<boolean>("uv-install-complete", (event) => {
      _finishUvInstall(event.payload);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [_finishUvInstall]);

  // Lazy load skills onboarding
  const [OnboardingComponent, setOnboardingComponent] = useState<ComponentType<{
    onClose: () => void;
  }> | null>(null);

  useEffect(() => {
    if (showSkillsOnboarding && !OnboardingComponent) {
      import(
        "@/components/scientific-skills/scientific-skills-onboarding"
      ).then((mod) =>
        setOnboardingComponent(() => mod.ScientificSkillsOnboarding),
      );
    }
  }, [showSkillsOnboarding, OnboardingComponent]);

  return (
    <>
      <div className="divide-y divide-border/60">
        {/* Python (uv) */}
        <StatusRow
          ok={uvStatus === "ready"}
          label="Python (uv)"
          detail={
            uvInstalling
              ? "Installing..."
              : uvStatus === "ready"
                ? (uvVersion ?? "Installed")
                : uvStatus === "checking"
                  ? "Checking..."
                  : "Not installed"
          }
          action={
            uvStatus === "not-installed" && !uvInstalling
              ? { label: "Install", onClick: installUv }
              : uvInstalling
                ? { label: "Installing...", loading: true }
                : undefined
          }
        />

        <StatusRow
          ok={paperSpineReady}
          label="PaperSpine + default skills"
          detail={
            paperSpineInstalling || installingPackId
              ? installingPackId
                ? `Installing ${installingPackId}...`
                : "Installing PaperSpine, academic-research, nature, and scientific skills..."
              : paperSpineReady
                ? "PaperSpine and default skill packs installed"
                : "Not installed"
          }
          action={
            paperSpineInstalling
              ? { label: "Installing...", loading: true }
              : paperSpineReady
                ? undefined
                : {
                    label: "Install",
                    onClick: () => {
                      setPaperSpineInstalling(true);
                      void ensurePaperSpineSkills().finally(() =>
                        setPaperSpineInstalling(false),
                      );
                    },
                  }
          }
        />

        {/* Optional scientific packs */}
        <StatusRow
          ok={!!skillsStatus?.installed}
          label="Scientific Skills"
          detail={
            skillsInstalling
              ? "Installing..."
              : skillsStatus?.installed
                ? `${skillsStatus.skill_count} skills`
                : "Not installed"
          }
          action={
            skillsInstalling
              ? { label: "Installing...", loading: true }
              : {
                  label: skillsStatus?.installed ? "Manage" : "Install",
                  onClick: () => setShowSkillsOnboarding(true),
                  icon: skillsStatus?.installed ? "settings" : "download",
                }
          }
        />

        <StatusRow
          ok={true}
          label="LocalPrism"
          detail={appVersion ? `v${appVersion}` : "Checking..."}
        />
      </div>

      {showSkillsOnboarding && OnboardingComponent && (
        <OnboardingComponent
          onClose={() => {
            setShowSkillsOnboarding(false);
            checkSkills();
          }}
        />
      )}
    </>
  );
}

function StatusRow({
  ok,
  label,
  detail,
  action,
}: {
  ok: boolean;
  label: string;
  detail: string;
  action?: {
    label: string;
    onClick?: () => void;
    loading?: boolean;
    icon?: "download" | "key" | "settings";
  };
}) {
  return (
    <div className="flex min-h-12 min-w-0 items-center gap-3 px-4 py-3">
      <div
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-md border",
          ok
            ? "border-green-500/20 bg-green-500/10 text-green-600"
            : "border-border/70 bg-muted/30 text-muted-foreground",
        )}
      >
        {ok ? (
          <CheckCircle2Icon className="size-3.5" />
        ) : (
          <CircleIcon className="size-3.5" />
        )}
      </div>
      <div className="flex min-w-0 flex-1 items-baseline gap-3">
        <span
          className={cn(
            "w-32 shrink-0 truncate font-medium text-sm",
            ok ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {label}
        </span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
          {detail}
        </span>
      </div>
      {action && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 rounded-md px-2.5 text-xs"
          onClick={action.onClick}
          disabled={action.loading}
        >
          {action.loading ? (
            <Loader2Icon className="mr-1 size-3 animate-spin" />
          ) : action.icon === "key" ? (
            <KeyRoundIcon className="mr-1 size-3" />
          ) : action.icon === "settings" ? (
            <SettingsIcon className="mr-1 size-3" />
          ) : (
            <DownloadIcon className="mr-1 size-3" />
          )}
          {action.label}
        </Button>
      )}
    </div>
  );
}
