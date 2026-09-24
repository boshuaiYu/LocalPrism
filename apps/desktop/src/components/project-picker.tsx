import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
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
  Loader2Icon,
  SearchIcon,
  GithubIcon,
  MonitorIcon,
  MoonIcon,
  SunIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
import { useProjectStore } from "@/stores/project-store";
import { useDocumentStore } from "@/stores/document-store";
import { getMupdfClient } from "@/lib/mupdf/mupdf-client";
import { exists, join } from "@/lib/tauri/fs";
import { AppStatusBar } from "@/components/app-status-cluster";
import { HomeEmptyState } from "@/components/home/home-empty-state";
import { Button } from "@/components/ui/button";
import {
  homeProjectListState,
  OPEN_FOLDER_HINT,
} from "@/lib/home-project-list";
import { projectCardMetaLine } from "@/lib/project-card-meta";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ProjectWizard, type CreationMode } from "./project-wizard";
import { HomepageEnvironmentStatus } from "./homepage-environment-status";

interface DefaultProject {
  path: string;
  name: string;
  last_modified: number;
  has_main_tex: boolean;
}

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
  const [searchQuery, setSearchQuery] = useState("");
  const [removeProjectTarget, setRemoveProjectTarget] =
    useState<RecentProject | null>(null);
  const defaultProjectsDiscoveredRef = useRef(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const { theme = "system", setTheme } = useTheme();
  const searchShortcutLabel = useMemo(() => {
    if (typeof navigator === "undefined") return "Ctrl+K";
    return /Mac|iPhone|iPad/i.test(navigator.platform) ? "⌘K" : "Ctrl+K";
  }, []);

  const recentProjects = useProjectStore((s) => s.recentProjects);
  const addRecentProject = useProjectStore((s) => s.addRecentProject);
  const removeRecentProject = useProjectStore((s) => s.removeRecentProject);
  const openProject = useDocumentStore((s) => s.openProject);

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

      if (recentProjects.length === 0) {
        return;
      }

      event.preventDefault();
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    };

    window.addEventListener("keydown", handleSearchShortcut);
    return () => window.removeEventListener("keydown", handleSearchShortcut);
  }, [recentProjects.length]);

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
  const listState = homeProjectListState({
    recentCount: recentProjects.length,
    query: normalizedSearch,
    matchCount: visibleProjects.length,
  });

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
      <header
        data-testid="app-chrome-header"
        className="relative z-10 flex min-h-[calc(40px+var(--titlebar-height))] shrink-0 flex-wrap items-center justify-end gap-2 px-4 pt-[var(--titlebar-height)] pb-1"
      >
        <div className="flex shrink-0 items-center gap-2">
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
        </div>
      </header>

      <main className="relative z-10 min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex min-h-full w-full max-w-xl flex-col justify-center px-6 py-10">
          <div className="mb-8 text-center">
            <div className="lp-mark mx-auto mb-4 flex size-16 items-center justify-center rounded-lg p-0.5">
              <div className="flex size-full items-center justify-center rounded-md bg-background">
                <img src="/icon-192.png" alt="" className="size-10" />
              </div>
            </div>
            <h1 className="lp-title text-[1.75rem]">LocalPrism</h1>
            <p className="lp-meta mt-2">
              AI-powered academic writing workspace
            </p>
          </div>

          <div className="flex gap-2">
            <Button
              onClick={() => setShowModeDialog(true)}
              size="lg"
              variant="outline"
              className="h-10 flex-1 gap-2 rounded-lg"
            >
              <FolderPlusIcon className="size-4" />
              New Project
            </Button>
            <Button
              onClick={handleOpenFolder}
              size="lg"
              className="lp-primary-cta h-10 flex-1 gap-2 rounded-lg"
            >
              <FolderOpenIcon className="size-4" />
              Open Folder
            </Button>
          </div>
          <p className="lp-meta mt-2 text-center">{OPEN_FOLDER_HINT}</p>

          <HomepageEnvironmentStatus />

          {listState === "empty" && (
            <HomeEmptyState
              variant="empty"
              onNewProject={() => setShowModeDialog(true)}
              onOpenFolder={() => void handleOpenFolder()}
            />
          )}

          {(listState === "list" || listState === "no-results") && (
            <section className="mt-8">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="lp-meta flex items-center gap-2 uppercase tracking-wide">
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
                    className="lp-focus h-8 w-full rounded-lg border border-input bg-background pr-12 pl-8 text-xs outline-none transition-colors placeholder:text-muted-foreground"
                  />
                  <kbd className="pointer-events-none absolute top-1/2 right-1.5 -translate-y-1/2 rounded border border-border/70 px-1 font-medium text-[10px] text-muted-foreground">
                    {searchShortcutLabel}
                  </kbd>
                </div>
              </div>

              {listState === "no-results" ? (
                <HomeEmptyState
                  variant="no-results"
                  query={searchQuery}
                  onNewProject={() => setShowModeDialog(true)}
                  onOpenFolder={() => void handleOpenFolder()}
                  onClearSearch={() => setSearchQuery("")}
                />
              ) : (
                <div className="overflow-hidden rounded-lg border border-border/70 bg-background/70">
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
        </div>
      </main>
      {/* New Project mode selection dialog */}
      <Dialog open={showModeDialog} onOpenChange={setShowModeDialog}>
        <DialogContent showCloseButton={false} className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create New Project</DialogTitle>
            <DialogDescription>How would you like to start?</DialogDescription>
          </DialogHeader>
          <div className="flex gap-2 pt-2">
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
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="h-10 rounded-lg"
              onClick={() => setShowModeDialog(false)}
            >
              Cancel
            </Button>
          </DialogFooter>
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
      <AppStatusBar className="relative z-10 shrink-0 border-border bg-background" />
    </div>
  );
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
          <div className="lp-meta truncate" title={project.path}>
            {projectCardMetaLine({
              path: project.path,
              updatedAt: project.lastOpened,
              now: Date.now(),
              preview:
                preview.status === "ready" ? preview.data.kind : preview.status,
            })}
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
