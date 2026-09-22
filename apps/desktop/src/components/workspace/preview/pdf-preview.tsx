import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  FileTextIcon,
  SpellCheckIcon,
  AlertCircleIcon,
  LoaderIcon,
  RefreshCwIcon,
  MinusIcon,
  PlusIcon,
  DownloadIcon,
  HistoryIcon,
  MousePointerClickIcon,
  CrosshairIcon,
  ChevronUpIcon,
  ChevronDownIcon,
  ZapIcon,
} from "lucide-react";
import { writeFile, mkdir, exists, readFile } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import {
  useDocumentStore,
  getPdfBytes,
  getCurrentPdfBytes,
  getCurrentPdfRootId,
  hasPdfData,
} from "@/stores/document-store";
import { useHistoryStore } from "@/stores/history-store";
import { useClaudeChatStore } from "@/stores/claude-chat-store";
import { useSettingsStore } from "@/stores/settings-store";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import { HistoryPanel } from "@/components/workspace/history-panel";
import {
  synctexEdit,
  resolveCompileTarget,
  detectTexlive,
  getCachedTexliveAvailable,
  activeCompileUsesTexlive,
} from "@/lib/latex-compiler";
import { runOwnedProjectCompile } from "@/lib/project-compile";
import { shouldScheduleLiveCompile } from "@/lib/live-compile";
import { useLiveCompile } from "@/hooks/use-live-compile";
import {
  ownsProjectFsState,
  runProjectFsOperation,
} from "@/lib/project-fs-operations";
import { ErrorBoundary } from "react-error-boundary";
import {
  SelectionToolbar,
  type ToolbarAction,
} from "@/components/workspace/editor/selection-toolbar";
import { save } from "@tauri-apps/plugin-dialog";
import {
  PdfViewer,
  type PdfTextSelection,
  type CaptureResult,
} from "./pdf-viewer";
import { resolveTexRoot, type ProjectFile } from "@/stores/document-store";
import { MarkdownPreviewPane } from "@/components/workspace/preview/markdown-preview-pane";
import { createLogger } from "@/lib/debug/logger";
import {
  PDF_PREVIEW_DEFAULT_FIT_MODE,
  fitPreviewScale,
  nextPdfZoomState,
  type PdfFitMode,
} from "@/lib/pdf-preview-zoom";

const log = createLogger("pdf-preview");

type FitMode = PdfFitMode;

/** Per-root zoom state cache: rootFileId -> { scale, fitMode } */
const zoomCache = new Map<string, { scale: number; fitMode: FitMode }>();

/** Max number of PdfViewer instances kept alive simultaneously. */
const MAX_ALIVE_VIEWERS = 5;

/** Clear zoom cache (e.g., on project close). */
export function clearZoomCache(): void {
  zoomCache.clear();
}

function parseCompileErrors(compileError: string): string[] {
  return [
    ...new Set(
      compileError
        .split(/\s*!\s*/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && s !== "Compilation failed"),
    ),
  ];
}

const ZOOM_OPTIONS = [
  { value: "0.5", label: "50%" },
  { value: "0.75", label: "75%" },
  { value: "1", label: "100%" },
  { value: "1.25", label: "125%" },
  { value: "1.5", label: "150%" },
  { value: "2", label: "200%" },
  { value: "3", label: "300%" },
  { value: "4", label: "400%" },
];

export function PdfPreview() {
  const compilerBackend = useSettingsStore((s) => s.compilerBackend);
  const setCompilerBackend = useSettingsStore((s) => s.setCompilerBackend);
  const autoCompile = useSettingsStore((s) => s.autoCompile);
  const setAutoCompile = useSettingsStore((s) => s.setAutoCompile);
  const [texliveAvailable, setTexliveAvailable] = useState<boolean | null>(
    getCachedTexliveAvailable(),
  );
  const usingTexliveFallback =
    compilerBackend === "texlive" && texliveAvailable === false;
  const pdfRevision = useDocumentStore((s) => s.pdfRevision);
  const compileError = useDocumentStore((s) => s.compileError);
  const isCompiling = useDocumentStore((s) => s.isCompiling);
  const isSaving = useDocumentStore((s) => s.isSaving);
  const contentGeneration = useDocumentStore((s) => s.contentGeneration);
  const content = useDocumentStore((s) => s.content);
  const projectRoot = useDocumentStore((s) => s.projectRoot);
  const projectGeneration = useDocumentStore((s) => s.projectGeneration);
  const isProjectMutating = useDocumentStore((s) => s.isProjectMutating);
  const files = useDocumentStore((s) => s.files);
  const setActiveFile = useDocumentStore((s) => s.setActiveFile);
  const activeFile = useDocumentStore((s) => {
    return s.files.find((f) => f.id === s.activeFileId) ?? null;
  });
  const activeFileType = activeFile?.type ?? "tex";
  const isTexActive = activeFileType === "tex";
  const isMarkdownActive = activeFileType === "markdown";
  const isSourcePdfActive = activeFileType === "pdf";
  const showCompiledPreview = !isMarkdownActive && !isSourcePdfActive;
  const requestJumpToPosition = useDocumentStore(
    (s) => s.requestJumpToPosition,
  );

  const [pdfError, setPdfError] = useState<string | null>(null);
  const [numPages, setNumPages] = useState<number>(0);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [pageInputValue, setPageInputValue] = useState<string>("1");
  const [isEditingPage, setIsEditingPage] = useState(false);
  const scrollToPageRef = useRef<((page: number) => void) | null>(null);
  const [scale, setScale] = useState<number>(1.0);
  const [captureMode, setCaptureMode] = useState(false);
  const [fitMode, setFitMode] = useState<FitMode>(PDF_PREVIEW_DEFAULT_FIT_MODE);
  const [containerSize, setContainerSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [firstPageSize, setFirstPageSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const hasInitialCompile = useRef<string | null>(null);
  const initialized = useDocumentStore((s) => s.initialized);

  // Derive pdfData from external cache, re-read whenever pdfRevision bumps
  const pdfData = useMemo(() => getCurrentPdfBytes(), [pdfRevision]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep-alive: track which root files have PdfViewer instances alive (LRU order)
  const currentRootFileId =
    activeFile?.type === "tex"
      ? resolveTexRoot(activeFile.id, files)
      : (getCurrentPdfRootId() ?? resolveTexRoot(activeFile?.id ?? "", files));
  const [aliveOrder, setAliveOrder] = useState<string[]>([]);
  const prevRootRef = useRef(currentRootFileId);

  useEffect(() => {
    let cancelled = false;
    void detectTexlive()
      .then((status) => {
        if (!cancelled) setTexliveAvailable(status.available);
      })
      .catch(() => {
        if (!cancelled) setTexliveAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Save/restore zoom state per root file on switch.
  // Documents without a saved zoom open fit-to-width.
  useEffect(() => {
    const prev = prevRootRef.current;
    const switchedRoot = Boolean(prev && prev !== currentRootFileId);
    if (switchedRoot && prev) {
      zoomCache.set(prev, { scale, fitMode });
    }
    const next = nextPdfZoomState(
      { scale, fitMode },
      zoomCache.get(currentRootFileId),
      switchedRoot,
    );
    if (next.scale !== scale) setScale(next.scale);
    if (next.fitMode !== fitMode) setFitMode(next.fitMode);
    prevRootRef.current = currentRootFileId;
  }, [currentRootFileId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Update alive set when active root changes and has PDF data
  useEffect(() => {
    if (!currentRootFileId || !pdfData) return;
    setAliveOrder((prev) => {
      if (prev[0] === currentRootFileId) return prev; // already at front
      const without = prev.filter((id) => id !== currentRootFileId);
      return [currentRootFileId, ...without].slice(0, MAX_ALIVE_VIEWERS);
    });
  }, [currentRootFileId, pdfData]);

  // PDF text selection toolbar
  const [pdfSelection, setPdfSelection] = useState<PdfTextSelection | null>(
    null,
  );
  const previewContainerRef = useRef<HTMLDivElement>(null);

  const handleTextClick = useCallback(
    (text: string) => {
      let index = content.indexOf(text);
      if (index === -1) {
        const cleanText = text.replace(/[{}\\$]/g, "");
        if (cleanText.length > 2) index = content.indexOf(cleanText);
      }
      if (index === -1 && text.length > 5) {
        const words = text.split(/\s+/).filter((w) => w.length > 3);
        for (const word of words) {
          index = content.indexOf(word);
          if (index !== -1) break;
        }
      }
      if (index !== -1) requestJumpToPosition(index);
    },
    [content, requestJumpToPosition],
  );

  const handleSynctexClick = useCallback(
    async (page: number, x: number, y: number) => {
      if (!projectRoot) return;
      const result = await synctexEdit(projectRoot, page, x, y);
      if (!result) return;

      const normalize = (p: string) =>
        p.replace(/\\/g, "/").replace(/^\.\//, "");
      const normalizedTarget = normalize(result.file);
      const targetFile = files.find(
        (f) => normalize(f.relativePath) === normalizedTarget,
      );
      if (!targetFile) return;

      const state = useDocumentStore.getState();
      const needsSwitch = state.activeFileId !== targetFile.id;
      if (needsSwitch) {
        setActiveFile(targetFile.id);
      }

      const fileContent = targetFile.content ?? "";
      const fileLines = fileContent.split("\n");
      const targetLine = Math.max(1, Math.min(result.line, fileLines.length));
      let offset = 0;
      for (let i = 0; i < targetLine - 1; i++) {
        offset += fileLines[i].length + 1;
      }
      if (result.column > 0) {
        offset += Math.min(
          result.column,
          fileLines[targetLine - 1]?.length ?? 0,
        );
      }

      if (needsSwitch) {
        setTimeout(() => requestJumpToPosition(offset), 100);
      } else {
        requestJumpToPosition(offset);
      }
    },
    [projectRoot, files, setActiveFile, requestJumpToPosition],
  );

  // Resolved source location from synctex
  const [resolvedSource, setResolvedSource] = useState<{
    file: string;
    line: number;
    column: number;
  } | null>(null);

  const handleTextSelect = useCallback((selection: PdfTextSelection | null) => {
    setPdfSelection(selection);
    setResolvedSource(null);
  }, []);

  // When PDF selection changes, resolve source via synctex
  useEffect(() => {
    if (!pdfSelection || !projectRoot) return;
    let cancelled = false;
    synctexEdit(
      projectRoot,
      pdfSelection.pageNumber,
      pdfSelection.pdfX,
      pdfSelection.pdfY,
    )
      .then((result) => {
        if (cancelled || !result) return;
        setResolvedSource(result);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [pdfSelection, projectRoot]);

  const pdfContextLabel = resolvedSource
    ? `~@${resolvedSource.file}:${resolvedSource.line}`
    : pdfSelection
      ? `~@PDF page ${pdfSelection.pageNumber}`
      : "";

  const navigateToSource = useCallback(() => {
    if (!resolvedSource) return;
    const normalize = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");
    const normalizedTarget = normalize(resolvedSource.file);
    const targetFile = files.find(
      (f) => normalize(f.relativePath) === normalizedTarget,
    );
    if (!targetFile) return;

    const state = useDocumentStore.getState();
    const needsSwitch = state.activeFileId !== targetFile.id;
    if (needsSwitch) setActiveFile(targetFile.id);

    const fileContent = targetFile.content ?? "";
    const fileLines = fileContent.split("\n");
    const targetLine = Math.max(
      1,
      Math.min(resolvedSource.line, fileLines.length),
    );
    let offset = 0;
    for (let i = 0; i < targetLine - 1; i++) {
      offset += fileLines[i].length + 1;
    }
    if (resolvedSource.column > 0) {
      offset += Math.min(
        resolvedSource.column,
        fileLines[targetLine - 1]?.length ?? 0,
      );
    }

    if (needsSwitch) {
      setTimeout(() => requestJumpToPosition(offset), 100);
    } else {
      requestJumpToPosition(offset);
    }
  }, [resolvedSource, files, setActiveFile, requestJumpToPosition]);

  const buildPdfContext = useCallback(
    (text: string) => {
      const locationNote = resolvedSource
        ? `near ${resolvedSource.file}:${resolvedSource.line}`
        : pdfSelection
          ? `PDF page ${pdfSelection.pageNumber}`
          : "PDF";
      return `[Selected from PDF output, approximate source location: ${locationNote}]\n${text}`;
    },
    [resolvedSource, pdfSelection],
  );

  const handlePdfToolbarSendPrompt = useCallback(
    (prompt: string) => {
      if (!pdfSelection) return;
      const label = pdfContextLabel;
      const sel = pdfSelection;
      setPdfSelection(null);
      window.getSelection()?.removeAllRanges();
      useClaudeChatStore.getState().sendPrompt(prompt, {
        label,
        filePath: resolvedSource?.file ?? "document.pdf",
        selectedText: buildPdfContext(sel.text),
      });
    },
    [pdfSelection, pdfContextLabel, resolvedSource, buildPdfContext],
  );

  const pdfToolbarActions: ToolbarAction[] = useMemo(
    () => [
      {
        id: "proofread",
        label: "Proofread",
        icon: <SpellCheckIcon className="size-4" />,
      },
      {
        id: "navigate",
        label: "Navigate to source",
        icon: <FileTextIcon className="size-4" />,
        hint: "dbl-click",
      },
    ],
    [],
  );

  const handlePdfToolbarAction = useCallback(
    (actionId: string) => {
      if (!pdfSelection) return;
      const label = pdfContextLabel;
      const sel = pdfSelection;
      setPdfSelection(null);
      window.getSelection()?.removeAllRanges();
      if (actionId === "proofread") {
        useClaudeChatStore
          .getState()
          .sendPrompt("Proofread and fix any errors in this text", {
            label,
            filePath: resolvedSource?.file ?? "document.pdf",
            selectedText: buildPdfContext(sel.text),
          });
      } else if (actionId === "navigate") {
        navigateToSource();
      }
    },
    [
      pdfSelection,
      pdfContextLabel,
      resolvedSource,
      navigateToSource,
      buildPdfContext,
    ],
  );

  const handlePdfToolbarDismiss = useCallback(() => {
    setPdfSelection(null);
    window.getSelection()?.removeAllRanges();
  }, []);

  const pdfToolbarPosition = (() => {
    if (!pdfSelection || !previewContainerRef.current) return null;
    const containerRect = previewContainerRef.current.getBoundingClientRect();
    const relTop = pdfSelection.position.top - containerRect.top + 4;
    const relLeft = Math.max(
      8,
      Math.min(
        pdfSelection.position.left - containerRect.left,
        containerRect.width - 272,
      ),
    );
    return { top: relTop, left: relLeft };
  })();

  useEffect(() => {
    if (!initialized || !projectRoot || isProjectMutating) return;
    if (pdfData || isCompiling || compileError) return;
    const initialCompileKey = `${projectGeneration}:${projectRoot}`;
    if (hasInitialCompile.current === initialCompileKey) return;

    hasInitialCompile.current = initialCompileKey;

    const compile = async () => {
      const state = useDocumentStore.getState();
      const owner = { projectRoot, projectGeneration };
      if (state.isProjectMutating || !ownsProjectFsState(owner, state)) return;
      const resolved = resolveCompileTarget(state.activeFileId, state.files);
      if (!resolved) {
        state.setCompileError(
          "No .tex file found in this project. Create a main.tex file to compile.",
        );
        return;
      }
      await runOwnedProjectCompile({
        owner,
        rootFileId: resolved.rootId,
        targetPath: resolved.targetPath,
        useTexlive: activeCompileUsesTexlive(),
        minimumBusyMs: 0,
      });
    };
    void compile();
  }, [
    initialized,
    projectRoot,
    pdfData,
    isCompiling,
    compileError,
    projectGeneration,
    isProjectMutating,
    files,
    activeFile,
  ]);

  // Recompute scale when fit mode is active and container/page size changes
  useEffect(() => {
    if (!fitMode || !containerSize || !firstPageSize) return;
    setScale(fitPreviewScale(fitMode, containerSize, firstPageSize));
  }, [fitMode, containerSize, firstPageSize]);

  const zoomIn = () => {
    setFitMode(null);
    setScale((s) => Math.min(4, s + 0.1));
  };
  const zoomOut = () => {
    setFitMode(null);
    setScale((s) => Math.max(0.25, s - 0.1));
  };

  const handleExport = async () => {
    const currentPdf = getCurrentPdfBytes();
    if (!currentPdf) return;
    const mainFile = files.find(
      (f) => f.name === "main.tex" || f.name === "document.tex",
    );
    const defaultName = mainFile
      ? mainFile.name.replace(/\.tex$/, ".pdf")
      : "document.pdf";
    const filePath = await save({
      title: "Export PDF",
      defaultPath: defaultName,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (!filePath) return;
    await writeFile(filePath, new Uint8Array(currentPdf));
  };

  const handleCurrentPageChange = useCallback(
    (page: number) => {
      setCurrentPage((prev) => {
        if (prev === page) return prev;
        if (!isEditingPage) setPageInputValue(String(page));
        return page;
      });
    },
    [isEditingPage],
  );

  const goToPage = useCallback(
    (page: number) => {
      const clamped = Math.max(1, Math.min(numPages, page));
      scrollToPageRef.current?.(clamped);
    },
    [numPages],
  );

  const handlePageInputCommit = useCallback(() => {
    setIsEditingPage(false);
    const parsed = parseInt(pageInputValue, 10);
    if (!Number.isNaN(parsed) && parsed >= 1 && parsed <= numPages) {
      goToPage(parsed);
    } else {
      setPageInputValue(String(currentPage));
    }
  }, [pageInputValue, numPages, currentPage, goToPage]);

  const handleLoadSuccess = (pages: number) => setNumPages(pages);
  const handleScaleChange = (newScale: number) => {
    setFitMode(null);
    setScale(newScale);
  };

  const handleCompile = useCallback(
    async (force = false, options?: { minimumBusyMs?: number }) => {
      const state = useDocumentStore.getState();
      if (!state.projectRoot || state.isProjectMutating) return;
      const allFiles = state.files;
      const activeFileId = state.activeFileId;
      const activeEntry = allFiles.find((f) => f.id === activeFileId);
      if (!activeEntry || activeEntry.type !== "tex") return;
      const resolved = resolveCompileTarget(activeFileId, allFiles);
      if (!resolved) {
        state.setCompileError(
          "No .tex file found in this project. Create a main.tex file to compile.",
        );
        return;
      }
      const { rootId, targetPath: targetFile } = resolved;
      const owner = {
        projectRoot: state.projectRoot,
        projectGeneration: state.projectGeneration,
      };
      if (!force) {
        const lastGen = state.lastCompiledGenerations.get(rootId);
        if (
          hasPdfData() &&
          lastGen !== undefined &&
          state.contentGeneration === lastGen
        )
          return;
      }
      useHistoryStore.getState().stopReview();
      setPdfError(null);
      await runOwnedProjectCompile({
        owner,
        rootFileId: rootId,
        targetPath: targetFile,
        useTexlive: activeCompileUsesTexlive(),
        minimumBusyMs: options?.minimumBusyMs,
      });
    },
    [],
  );

  const compileLive = useCallback(() => {
    const state = useDocumentStore.getState();
    const activeEntry = state.files.find(
      (file) => file.id === state.activeFileId,
    );
    if (!activeEntry || activeEntry.type !== "tex") return;
    const rootId = resolveTexRoot(activeEntry.id, state.files);
    if (
      !shouldScheduleLiveCompile({
        autoCompile: useSettingsStore.getState().autoCompile,
        isTexPreview: true,
        isProjectMutating: state.isProjectMutating,
        isCompiling: state.isCompiling,
        pendingRecompile: state.pendingRecompile,
        contentGeneration: state.contentGeneration,
        lastCompiledGeneration: state.lastCompiledGenerations.get(rootId),
      })
    ) {
      return;
    }
    void handleCompile(false, { minimumBusyMs: 0 });
  }, [handleCompile]);

  useLiveCompile({
    enabled: autoCompile && showCompiledPreview && isTexActive,
    contentGeneration,
    projectGeneration,
    activeRootId: currentRootFileId,
    compile: compileLive,
  });

  const handleCapture = async (result: CaptureResult) => {
    setCaptureMode(false);
    const state = useDocumentStore.getState();
    if (!state.projectRoot || state.isProjectMutating) return;
    const owner = {
      projectRoot: state.projectRoot,
      projectGeneration: state.projectGeneration,
    };

    const fileName = `capture-p${result.pageNumber}-${Date.now()}.png`;
    const relativePath = `attachments/${fileName}`;

    try {
      await runProjectFsOperation(owner, async () => {
        const attachmentsDir = await join(owner.projectRoot, "attachments");
        if (!(await exists(attachmentsDir))) {
          await mkdir(attachmentsDir, { recursive: true });
        }
        const fullPath = await join(owner.projectRoot, relativePath);

        const base64 = result.dataUrl.split(",")[1];
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        await writeFile(fullPath, bytes);
      });

      const current = useDocumentStore.getState();
      if (current.isProjectMutating || !ownsProjectFsState(owner, current)) {
        return;
      }
      await current.refreshFiles();
      if (!ownsProjectFsState(owner, useDocumentStore.getState())) return;

      useClaudeChatStore.getState().addPendingAttachment({
        label: `@${relativePath}`,
        filePath: relativePath,
        selectedText: `[Captured region from PDF page ${result.pageNumber}]`,
        imageDataUrl: result.dataUrl,
      });
    } catch (err) {
      log.error("Capture failed to save", { error: String(err) });
    }
  };

  // Listen for global Capture & Ask shortcut (Cmd+Shift+X / Ctrl+Shift+X)
  useEffect(() => {
    const handleToggleCapture = () => {
      if (pdfData) setCaptureMode((prev) => !prev);
    };
    window.addEventListener("toggle-capture-mode", handleToggleCapture);
    return () =>
      window.removeEventListener("toggle-capture-mode", handleToggleCapture);
  }, [pdfData]);

  const renderContent = () => {
    if (isMarkdownActive) {
      return <MarkdownPreviewPane file={activeFile} />;
    }
    if (isSourcePdfActive && activeFile) {
      return <SourcePdfPreview file={activeFile} />;
    }
    if (compileError && !pdfData) {
      const errors = parseCompileErrors(compileError);

      const handleFixWithChat = () => {
        const errorList = errors.map((e) => `- ${e}`).join("\n");
        useClaudeChatStore
          .getState()
          .sendPrompt(
            `[Compilation errors]\n${errorList}\n\nFix these LaTeX compilation errors.`,
          );
      };

      return (
        <div className="flex flex-1 flex-col items-center justify-center bg-muted/30 p-6">
          <div className="w-full max-w-lg">
            <div className="mb-4 flex items-center gap-2 text-destructive">
              <AlertCircleIcon className="size-5" />
              <h2 className="font-semibold text-base">Compilation Failed</h2>
              <span className="ml-auto rounded-full bg-destructive/15 px-2 py-0.5 font-medium text-xs">
                {errors.length} {errors.length === 1 ? "error" : "errors"}
              </span>
            </div>
            <div className="rounded-lg border border-destructive/20 bg-background">
              <div className="max-h-60 divide-y divide-border overflow-y-auto">
                {errors.map((error, i) => (
                  <div key={i} className="flex items-start gap-2.5 px-3 py-2.5">
                    <AlertCircleIcon className="mt-0.5 size-3.5 shrink-0 text-destructive/70" />
                    <span className="text-foreground text-sm">{error}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <button
                onClick={handleFixWithChat}
                className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 font-medium text-primary-foreground text-xs shadow-sm transition-colors hover:bg-primary/90"
              >
                <MousePointerClickIcon className="size-3.5" />
                Fix with Chat
              </button>
              <button
                onClick={() => void handleCompile(true)}
                className="flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 font-medium text-foreground text-xs transition-colors hover:bg-muted"
              >
                <RefreshCwIcon className="size-3.5" />
                Retry
              </button>
            </div>
          </div>
        </div>
      );
    }
    if (!pdfData && isCompiling) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center bg-muted/30 p-8">
          <LoaderIcon className="mb-4 size-8 animate-spin text-muted-foreground" />
          <h2 className="mb-2 font-medium text-foreground text-lg">
            Compiling PDF…
          </h2>
          <p className="max-w-sm text-center text-muted-foreground text-sm">
            First compile can take a minute while Tectonic fetches packages and
            fonts.
          </p>
        </div>
      );
    }
    if (!pdfData) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center bg-muted/30 p-8">
          <FileTextIcon className="mb-4 size-16 text-muted-foreground/50" />
          <h2 className="mb-2 font-medium text-lg text-muted-foreground">
            PDF Preview
          </h2>
          <p className="mb-4 text-center text-muted-foreground text-sm">
            {autoCompile
              ? "Preview updates as you type, or press Cmd+Enter to compile now"
              : "Press Cmd+Enter to compile your document"}
          </p>
          {isTexActive && (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => handleCompile(true)}
            >
              <RefreshCwIcon className="size-3.5" />
              Compile
            </Button>
          )}
        </div>
      );
    }
    if (pdfError) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center bg-muted/30 p-8">
          <AlertCircleIcon className="mb-4 size-12 text-destructive" />
          <h2 className="mb-2 font-medium text-destructive text-lg">
            PDF Load Error
          </h2>
          <p className="max-w-md text-center text-muted-foreground text-sm">
            {pdfError}
          </p>
        </div>
      );
    }

    // Keep-alive rendering: one PdfViewer per root file, toggle via CSS.
    // Use visibility:hidden + absolute positioning instead of display:none
    // so that the browser preserves scrollTop on the overflow container.
    const compileErrors = compileError ? parseCompileErrors(compileError) : [];
    const handleFixWithChat = () => {
      const errorList = compileErrors.map((e) => `- ${e}`).join("\n");
      useClaudeChatStore
        .getState()
        .sendPrompt(
          `[Compilation errors]\n${errorList}\n\nFix these LaTeX compilation errors.`,
        );
    };

    return (
      <div className="relative flex min-h-0 flex-1">
        {aliveOrder.map((rootId) => {
          const data = getPdfBytes(rootId);
          if (!data) return null;
          const isActive = rootId === currentRootFileId;
          return (
            <ErrorBoundary
              key={rootId}
              fallback={
                <div className="flex h-full flex-col items-center justify-center gap-3 bg-muted/30 p-8">
                  <AlertCircleIcon className="size-10 text-destructive" />
                  <p className="text-muted-foreground text-sm">
                    PDF viewer crashed. Try recompiling.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    onClick={() => handleCompile(true)}
                  >
                    <RefreshCwIcon className="size-3.5" />
                    Recompile
                  </Button>
                </div>
              }
            >
              <div
                className={
                  isActive
                    ? "absolute inset-0 flex flex-col"
                    : "pointer-events-none invisible absolute inset-0 flex flex-col"
                }
              >
                <PdfViewer
                  data={data}
                  scale={scale}
                  rootFileId={rootId}
                  isActive={isActive}
                  onError={isActive ? setPdfError : undefined}
                  onLoadSuccess={isActive ? handleLoadSuccess : undefined}
                  onScaleChange={isActive ? handleScaleChange : undefined}
                  onTextClick={isActive ? handleTextClick : undefined}
                  onSynctexClick={isActive ? handleSynctexClick : undefined}
                  onTextSelect={isActive ? handleTextSelect : undefined}
                  onFirstPageSize={
                    isActive
                      ? (w, h) => setFirstPageSize({ width: w, height: h })
                      : undefined
                  }
                  onContainerResize={
                    isActive
                      ? (w, h) => setContainerSize({ width: w, height: h })
                      : undefined
                  }
                  onCurrentPageChange={
                    isActive ? handleCurrentPageChange : undefined
                  }
                  scrollToPageRef={isActive ? scrollToPageRef : undefined}
                  captureMode={isActive ? captureMode : false}
                  onCapture={isActive ? handleCapture : undefined}
                  onCancelCapture={
                    isActive ? () => setCaptureMode(false) : undefined
                  }
                />
              </div>
            </ErrorBoundary>
          );
        })}
        {compileError && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 p-3">
            <div className="pointer-events-auto mx-auto max-w-lg rounded-lg border border-destructive/30 bg-background/95 shadow-lg backdrop-blur-sm">
              <div className="flex items-center gap-2 px-3 pt-2.5 text-destructive">
                <AlertCircleIcon className="size-4" />
                <h2 className="font-semibold text-sm">Compilation Failed</h2>
                <span className="ml-auto rounded-full bg-destructive/15 px-2 py-0.5 font-medium text-xs">
                  {compileErrors.length}{" "}
                  {compileErrors.length === 1 ? "error" : "errors"}
                </span>
              </div>
              <div className="max-h-28 divide-y divide-border overflow-y-auto px-1 py-1">
                {compileErrors.map((error, i) => (
                  <div key={i} className="flex items-start gap-2 px-2 py-1.5">
                    <AlertCircleIcon className="mt-0.5 size-3 shrink-0 text-destructive/70" />
                    <span className="text-foreground text-xs">{error}</span>
                  </div>
                ))}
              </div>
              <div className="flex items-center gap-2 px-3 pb-2.5">
                <button
                  onClick={handleFixWithChat}
                  className="flex items-center gap-1.5 rounded-lg bg-primary px-2.5 py-1 font-medium text-primary-foreground text-xs shadow-sm transition-colors hover:bg-primary/90"
                >
                  <MousePointerClickIcon className="size-3.5" />
                  Fix with Chat
                </button>
                <button
                  onClick={() => void handleCompile(true)}
                  className="flex items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 py-1 font-medium text-foreground text-xs transition-colors hover:bg-muted"
                >
                  <RefreshCwIcon className="size-3.5" />
                  Retry
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      ref={previewContainerRef}
      className="@container/pv relative flex h-full flex-col bg-muted/50"
    >
      <div className="flex min-h-[calc(var(--workspace-topbar-height)+var(--titlebar-height))] shrink-0 flex-wrap items-center gap-x-1 gap-y-1 border-border border-b bg-background px-2 py-1">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
          {isMarkdownActive ? (
            <span className="px-1 font-medium text-muted-foreground text-xs">
              Markdown preview
            </span>
          ) : isSourcePdfActive ? (
            <span className="px-1 font-medium text-muted-foreground text-xs">
              PDF preview
            </span>
          ) : (
            <>
              <Button
                variant={autoCompile ? "secondary" : "ghost"}
                size="sm"
                className="h-7 gap-1 px-2 text-xs"
                onClick={() => setAutoCompile(!autoCompile)}
                title={
                  autoCompile
                    ? "Live preview on — click to pause"
                    : "Live preview off — click to compile as you type"
                }
              >
                <ZapIcon
                  className={`size-3.5 ${autoCompile ? "text-amber-500" : ""}`}
                />
                <span className="@[42rem]/pv:inline hidden">Live</span>
              </Button>
              <Select
                value={compilerBackend}
                onValueChange={(v) =>
                  setCompilerBackend(v as "tectonic" | "texlive")
                }
              >
                <SelectTrigger
                  size="sm"
                  className="@[24rem]/pv:flex hidden h-7! @[44rem]/pv:w-[8.5rem] w-[6.75rem] text-xs"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="tectonic">Tectonic</SelectItem>
                  <SelectItem value="texlive">
                    {texliveAvailable === false
                      ? "TeXLive (not found)"
                      : "TeXLive"}
                  </SelectItem>
                </SelectContent>
              </Select>
            </>
          )}
          {usingTexliveFallback && (
            <span className="@[36rem]/pv:inline hidden max-w-[12rem] truncate px-1 text-amber-700 text-xs dark:text-amber-400">
              xelatex not found — using Tectonic
            </span>
          )}
          {showCompiledPreview && isSaving && (
            <div className="flex items-center gap-1.5 rounded-md bg-muted/50 px-2 py-1">
              <LoaderIcon className="size-3.5 animate-spin text-muted-foreground" />
              <span className="@[38rem]/pv:inline hidden font-medium text-muted-foreground text-xs">
                Saving...
              </span>
            </div>
          )}
          {showCompiledPreview && !isSaving && isCompiling && (
            <div className="flex items-center gap-1.5 rounded-md bg-muted/50 px-2 py-1">
              <LoaderIcon className="size-3.5 animate-spin text-muted-foreground" />
              <span className="@[38rem]/pv:inline hidden font-medium text-muted-foreground text-xs">
                Compiling...
              </span>
            </div>
          )}
          {!isSaving && !isCompiling && !compileError && isTexActive && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 @[42rem]/pv:px-2.5 px-2 text-xs"
              onClick={() => handleCompile(true)}
              title={pdfData ? "Recompile" : "Compile"}
            >
              <RefreshCwIcon className="size-3.5" />
              <span className="@[42rem]/pv:inline hidden">
                {pdfData ? "Recompile" : "Compile"}
              </span>
            </Button>
          )}
          {showCompiledPreview && !isSaving && !isCompiling && compileError && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 px-2.5 text-destructive text-xs hover:text-destructive"
              onClick={() => handleCompile(true)}
              disabled={!isTexActive}
              title="Retry compile"
            >
              <RefreshCwIcon className="size-3.5" />
              <span className="@[42rem]/pv:inline hidden">Retry</span>
            </Button>
          )}
        </div>
        <div className="ml-auto flex shrink-0 items-center justify-end gap-0.5">
          {showCompiledPreview && pdfData && (
            <>
              <div className="@[22rem]/pv:flex hidden items-center gap-0.5">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0"
                  onClick={() => goToPage(currentPage - 1)}
                  disabled={currentPage <= 1}
                  title="Page Up"
                >
                  <ChevronUpIcon className="size-3.5" />
                </Button>
                {isEditingPage ? (
                  <input
                    type="text"
                    inputMode="numeric"
                    className="h-6 w-7 shrink-0 rounded border border-border bg-background text-center text-foreground text-xs outline-none focus:ring-1 focus:ring-ring"
                    value={pageInputValue}
                    onChange={(e) => setPageInputValue(e.target.value)}
                    onBlur={handlePageInputCommit}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handlePageInputCommit();
                      if (e.key === "Escape") {
                        setIsEditingPage(false);
                        setPageInputValue(String(currentPage));
                      }
                    }}
                  />
                ) : (
                  <button
                    className="flex h-6 w-7 shrink-0 items-center justify-center rounded text-muted-foreground text-xs tabular-nums hover:bg-muted"
                    onClick={() => {
                      setIsEditingPage(true);
                      setPageInputValue(String(currentPage));
                    }}
                    title="Click to jump to page"
                  >
                    {currentPage}
                  </button>
                )}
                <span className="shrink-0 text-muted-foreground/80 text-xs tabular-nums">
                  /
                </span>
                <span className="flex h-6 w-7 shrink-0 items-center justify-center text-muted-foreground text-xs tabular-nums">
                  {numPages}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0"
                  onClick={() => goToPage(currentPage + 1)}
                  disabled={currentPage >= numPages}
                  title="Page Down"
                >
                  <ChevronDownIcon className="size-3.5" />
                </Button>
              </div>
              <div className="@[28rem]/pv:flex hidden items-center gap-0.5">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  onClick={zoomOut}
                  disabled={scale <= 0.25}
                  title="Zoom out"
                >
                  <MinusIcon className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  onClick={zoomIn}
                  disabled={scale >= 4}
                  title="Zoom in"
                >
                  <PlusIcon className="size-3.5" />
                </Button>
                <Select
                  value={fitMode ?? scale.toString()}
                  onValueChange={(v) => {
                    if (v === "fit-width" || v === "fit-height") {
                      setFitMode(v);
                    } else {
                      setFitMode(null);
                      setScale(Number(v));
                    }
                  }}
                >
                  <SelectTrigger
                    size="sm"
                    className="h-7! @[48rem]/pv:w-[7.5rem] w-[4.5rem] text-xs"
                  >
                    <SelectValue>
                      {fitMode === "fit-width"
                        ? "Fit width"
                        : fitMode === "fit-height"
                          ? "Fit height"
                          : `${Math.round(scale * 100)}%`}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent position="popper" align="end">
                    <SelectItem value="fit-width">Fit to width</SelectItem>
                    <SelectItem value="fit-height">Fit to height</SelectItem>
                    <SelectSeparator />
                    {ZOOM_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                variant={captureMode ? "default" : "secondary"}
                size="icon"
                className={`size-7 shrink-0 ${
                  captureMode
                    ? "ring-2 ring-primary/30"
                    : "bg-foreground text-background hover:bg-foreground/90"
                }`}
                onClick={() => setCaptureMode(!captureMode)}
                title={`Capture & Ask (${navigator.userAgent.includes("Mac") ? "Cmd+Shift+X" : "Ctrl+Shift+X"})`}
              >
                <CrosshairIcon className="size-3.5 shrink-0" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0"
                onClick={handleExport}
                title="Export PDF"
              >
                <DownloadIcon className="size-3.5" />
              </Button>
            </>
          )}
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 shrink-0"
                title="History"
              >
                <HistoryIcon className="size-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-96">
              <HistoryPanel maxHeight="max-h-[32rem]" />
            </PopoverContent>
          </Popover>
        </div>
      </div>
      {renderContent()}
      {/* PDF selection toolbar */}
      {pdfToolbarPosition && pdfSelection && (
        <SelectionToolbar
          position={pdfToolbarPosition}
          contextLabel={pdfContextLabel}
          actions={pdfToolbarActions}
          onSendPrompt={handlePdfToolbarSendPrompt}
          onAction={handlePdfToolbarAction}
          onDismiss={handlePdfToolbarDismiss}
        />
      )}
      {/* Capture mode floating banner */}
      {showCompiledPreview && captureMode && (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
          <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-border bg-background/95 px-3 py-2 shadow-lg backdrop-blur-sm">
            <CrosshairIcon className="size-3.5 text-primary" />
            <span className="text-foreground text-xs">
              Drag to select a region
            </span>
            <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-medium text-[10px] text-muted-foreground">
              ESC
            </kbd>
            <span className="text-[10px] text-muted-foreground">or</span>
            <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-medium text-[10px] text-muted-foreground">
              {navigator.userAgent.includes("Mac") ? "Cmd+" : "Ctrl+"}X
            </kbd>
            <span className="text-[10px] text-muted-foreground">to cancel</span>
          </div>
        </div>
      )}
    </div>
  );
}

function SourcePdfPreview({ file }: { file: ProjectFile }) {
  const [pdfData, setPdfData] = useState<Uint8Array | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    let cancelled = false;
    setPdfData(null);
    setError(null);
    readFile(file.absolutePath)
      .then((data) => {
        if (!cancelled) setPdfData(new Uint8Array(data));
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [file.absolutePath]);

  if (error) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 bg-muted/30 p-8 text-sm">
        <AlertCircleIcon className="size-10 text-destructive" />
        <p className="text-destructive">Failed to load PDF</p>
        <p className="max-w-md text-center text-muted-foreground">{error}</p>
      </div>
    );
  }

  if (!pdfData) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground text-sm">
        Loading PDF…
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-end gap-1 border-border border-b bg-background px-2 py-1">
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={() => setScale((value) => Math.max(0.25, value - 0.25))}
          disabled={scale <= 0.25}
        >
          <MinusIcon className="size-3.5" />
        </Button>
        <span className="min-w-12 text-center text-muted-foreground text-xs tabular-nums">
          {Math.round(scale * 100)}%
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={() => setScale((value) => Math.min(4, value + 0.25))}
          disabled={scale >= 4}
        >
          <PlusIcon className="size-3.5" />
        </Button>
      </div>
      <PdfViewer data={pdfData} scale={scale} onScaleChange={setScale} />
    </div>
  );
}
