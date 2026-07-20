import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import {
  scanProjectFolder,
  readTexFileContent,
  readImageAsDataUrl,
  createFileOnDisk,
  copyFileToProject,
  deleteFileFromDisk,
  deleteFolderFromDisk,
  renameFileOnDisk,
  getUniqueTargetName,
  createDirectory,
  join,
  LARGE_FILE_THRESHOLD,
  type ProjectFileType,
} from "@/lib/tauri/fs";
import { useHistoryStore } from "@/stores/history-store";
import { useClaudeChatStore } from "@/stores/claude-chat-store";
import { clearDocCache } from "@/lib/mupdf/pdf-doc-cache";
import { clearScrollPositionCache } from "@/components/workspace/preview/pdf-viewer";
import { clearZoomCache } from "@/components/workspace/preview/pdf-preview";
import { clearEditorStateCache } from "@/components/workspace/editor/latex-editor";
import { useProjectStore } from "@/stores/project-store";
import { createLogger } from "@/lib/debug/logger";
import {
  drainProjectFsOperations,
  runProjectFsOperation,
  runProjectFsOperationAfterDrain,
} from "@/lib/project-fs-operations";
import { writeProjectTextFileInOrder } from "@/lib/project-file-writes";

const log = createLogger("document");
const PROJECT_RENAME_LOCK_RETRY_DELAYS_MS = [150, 300, 600, 1000];
const PROJECT_RENAME_CHAT_STOP_TIMEOUT_MS = 5_000;
const PROJECT_RENAME_CHAT_STOP_POLL_MS = 50;
const MANUAL_SAVE_BUSY_DELAY_MS = 500;

export interface ProjectFile {
  id: string; // relativePath is the id
  name: string;
  relativePath: string;
  absolutePath: string;
  type: ProjectFileType;
  content?: string;
  dataUrl?: string;
  isDirty: boolean;
  /** File size in bytes (from stat). Used to skip auto-loading large files. */
  fileSize?: number;
}

interface ProjectOwner {
  projectRoot: string;
  projectGeneration: number;
}

function captureProjectOwner(state: DocumentState): ProjectOwner | null {
  return state.projectRoot
    ? {
        projectRoot: state.projectRoot,
        projectGeneration: state.projectGeneration,
      }
    : null;
}

function stillOwnsProject(
  state: DocumentState,
  owner: ProjectOwner | null,
): boolean {
  return (
    owner != null &&
    state.projectRoot === owner.projectRoot &&
    state.projectGeneration === owner.projectGeneration
  );
}

function bindHistoryToDocumentProject(
  state: Pick<
    DocumentState,
    "projectRoot" | "projectGeneration" | "isProjectMutating"
  >,
): void {
  useHistoryStore
    .getState()
    .bindProject(
      state.projectRoot,
      state.projectGeneration,
      state.isProjectMutating,
    );
}

function initializeHistoryForMountedProject(
  projectRoot: string,
  projectGeneration: number,
): void {
  const history = useHistoryStore.getState();
  void history
    .init(projectRoot)
    .then(() => {
      const document = useDocumentStore.getState();
      if (
        document.projectRoot !== projectRoot ||
        document.projectGeneration !== projectGeneration ||
        document.isProjectMutating
      ) {
        return;
      }
      return useHistoryStore.getState().loadSnapshots(projectRoot);
    })
    .catch((err) => {
      log.error("Failed to initialize history", { error: String(err) });
    });
}

// ── PDF bytes cache (kept outside Zustand to avoid React diffing large buffers) ──
// Keyed by rootFileId. Consumers read via getPdfBytes() / getCurrentPdfBytes().
const _pdfBytesCache = new Map<string, Uint8Array>();
/** Current active PDF root file id (mirrors what Zustand tracks via pdfRevision). */
let _currentPdfRootId: string | null = null;

/** Get PDF bytes for a specific root file id. */
export function getPdfBytes(rootFileId: string): Uint8Array | undefined {
  return _pdfBytesCache.get(rootFileId);
}

/** Get the current active PDF bytes (convenience for components that don't know the rootId). */
export function getCurrentPdfBytes(): Uint8Array | null {
  return _currentPdfRootId
    ? (_pdfBytesCache.get(_currentPdfRootId) ?? null)
    : null;
}

/** Get the root file id for the currently displayed PDF, if any. */
export function getCurrentPdfRootId(): string | null {
  return _currentPdfRootId;
}

/** Check if any PDF data exists for the current root. */
export function hasPdfData(): boolean {
  return _currentPdfRootId != null && _pdfBytesCache.has(_currentPdfRootId);
}

export function clearPdfBytesCache() {
  _pdfBytesCache.clear();
  _currentPdfRootId = null;
}

interface DocumentState {
  projectRoot: string | null;
  files: ProjectFile[];
  folders: string[];
  activeFileId: string;
  cursorPosition: number;
  selectionRange: { start: number; end: number } | null;
  jumpToPosition: number | null;
  isThreadOpen: boolean;
  /** Bumped whenever PDF bytes change — triggers re-render without storing bytes in state. */
  pdfRevision: number;
  compileError: string | null;
  isCompiling: boolean;
  /** Serializes project open/close/rename against runtime turn preflight. */
  isProjectMutating: boolean;
  /** Invalidates async work whenever the mounted project incarnation changes. */
  projectGeneration: number;
  /** Gives the latest refresh request exclusive ownership of its commit. */
  refreshRequestGeneration: number;
  /** Invalidates scans and async tree operations after any structural change. */
  fileTreeGeneration: number;
  /** When true, a recompile will be triggered after the current compile finishes. */
  pendingRecompile: boolean;
  isSaving: boolean;
  initialized: boolean;
  /** Incremented on every file content change; used to skip no-op recompiles. */
  contentGeneration: number;
  /** Per-root-file cache: rootFileId → compile error message. */
  compileErrorCache: Map<string, string>;
  /** Per-root-file: rootFileId → contentGeneration at last successful compile. */
  lastCompiledGenerations: Map<string, number>;

  openProject: (
    rootPath: string,
    options?: { allowDuringMutation?: boolean },
  ) => Promise<void>;
  renameProject: (newName: string) => Promise<void>;
  closeProject: () => boolean | Promise<boolean>;
  setActiveFile: (id: string) => void;
  addFile: (file: Omit<ProjectFile, "id" | "isDirty">) => string;
  deleteFile: (id: string) => Promise<void>;
  deleteFolder: (folderPath: string) => Promise<void>;
  renameFile: (id: string, name: string) => Promise<void>;
  updateFileContent: (id: string, content: string) => void;
  updateImageDataUrl: (id: string, dataUrl: string) => void;
  setCursorPosition: (position: number) => void;
  setSelectionRange: (range: { start: number; end: number } | null) => void;
  requestJumpToPosition: (position: number) => void;
  clearJumpRequest: () => void;
  setThreadOpen: (open: boolean) => void;
  setPdfData: (data: Uint8Array | null, rootFileId?: string) => void;
  setCompileError: (error: string | null, rootFileId?: string) => void;
  setIsCompiling: (isCompiling: boolean) => void;
  setPendingRecompile: (pending: boolean) => void;
  setIsSaving: (isSaving: boolean) => void;
  insertAtCursor: (text: string) => void;
  replaceSelection: (start: number, end: number, text: string) => void;
  findAndReplace: (find: string, replace: string) => boolean;
  setInitialized: () => void;
  saveFile: (
    id: string,
    options?: { allowDuringMutation?: boolean },
  ) => Promise<void>;
  saveAllFiles: (options?: { allowDuringMutation?: boolean }) => Promise<void>;
  saveCurrentFile: () => Promise<void>;
  createNewFile: (
    name: string,
    type: "tex" | "image",
    folder?: string,
  ) => Promise<void>;
  createFolder: (name: string, parentFolder?: string) => Promise<void>;
  importFiles: (
    sourcePaths: string[],
    targetFolder?: string,
  ) => Promise<string[]>;
  moveFile: (fileId: string, targetFolder: string | null) => Promise<void>;
  moveFolder: (
    folderPath: string,
    targetFolder: string | null,
  ) => Promise<void>;
  reloadFile: (relativePath: string) => Promise<void>;
  refreshFiles: () => Promise<void>;
  /** Load content for a file that was skipped during project open (large file). */
  loadFileContent: (id: string) => Promise<void>;

  get fileName(): string;
  get content(): string;
  setFileName: (name: string) => void;
  setContent: (content: string) => void;
}

function getActiveFile(state: { files: ProjectFile[]; activeFileId: string }) {
  return state.files.find((f) => f.id === state.activeFileId);
}

/**
 * Resolve the root .tex file for compilation.
 *
 * Priority order:
 * 1. `% !TEX root = <file>` magic comment in the first 20 lines of the active file
 * 2. The file itself, if it contains `\documentclass`
 * 3. `main.tex` or `document.tex` that contains `\documentclass`
 * 4. Any other .tex file in the project that contains `\documentclass`
 * 5. Fallback: the active file itself
 */
export function resolveTexRoot(fileId: string, files: ProjectFile[]): string {
  const file = files.find((f) => f.id === fileId);
  if (!file || file.type !== "tex" || !file.content) return fileId;

  // 1. Check for % !TEX root magic comment
  const lines = file.content.split("\n").slice(0, 20);
  for (const line of lines) {
    const match = line.match(/^%\s*!TEX\s+root\s*=\s*(.+)/i);
    if (match) {
      const rootPath = match[1].trim();
      const target =
        files.find((f) => f.relativePath === rootPath) ??
        files.find((f) => f.name === rootPath);
      if (target) return target.id;
    }
  }

  // 2. If the current file contains \documentclass, it is a root file
  if (/\\documentclass[\s{[]/.test(file.content)) {
    return fileId;
  }

  // 3. Look for main.tex or document.tex with \documentclass
  const wellKnown = files.find(
    (f) =>
      (f.name === "main.tex" || f.name === "document.tex") &&
      f.type === "tex" &&
      f.content &&
      /\\documentclass[\s{[]/.test(f.content),
  );
  if (wellKnown) return wellKnown.id;

  // 4. Any .tex file with \documentclass
  const anyRoot = files.find(
    (f) =>
      f.type === "tex" &&
      f.id !== fileId &&
      f.content &&
      /\\documentclass[\s{[]/.test(f.content),
  );
  if (anyRoot) return anyRoot.id;

  // 5. Fallback: the active file itself
  return fileId;
}

/** Re-key the external PDF bytes cache when a file is renamed/moved. */
function migratePdfBytesKey(oldKey: string, newKey: string) {
  if (!_pdfBytesCache.has(oldKey)) return;
  const bytes = _pdfBytesCache.get(oldKey)!;
  _pdfBytesCache.delete(oldKey);
  _pdfBytesCache.set(newKey, bytes);
  if (_currentPdfRootId === oldKey) _currentPdfRootId = newKey;
}

/** Re-key a Map entry when a file is renamed/moved. */
function migrateCacheKey<V>(
  map: Map<string, V>,
  oldKey: string,
  newKey: string,
): Map<string, V> {
  if (!map.has(oldKey)) return map;
  const copy = new Map(map);
  const val = copy.get(oldKey)!;
  copy.delete(oldKey);
  copy.set(newKey, val);
  return copy;
}

function normalizeProjectRoot(rootPath: string): string {
  return rootPath.replace(/[\\/]+$/, "");
}

function splitProjectRoot(rootPath: string): {
  parentPath: string;
  folderName: string;
  separator: string;
} {
  const normalized = normalizeProjectRoot(rootPath);
  const lastSep = Math.max(
    normalized.lastIndexOf("/"),
    normalized.lastIndexOf("\\"),
  );
  if (lastSep < 0) {
    throw new Error("Project path has no parent folder");
  }

  const separator = normalized[lastSep];
  return {
    parentPath: lastSep === 0 ? separator : normalized.slice(0, lastSep),
    folderName: normalized.slice(lastSep + 1),
    separator,
  };
}

function buildRenamedProjectRoot(rootPath: string, newName: string): string {
  const name = newName.trim();
  if (!name) throw new Error("Project name cannot be empty");
  if (name === "." || name === "..") {
    throw new Error("Project name cannot be . or ..");
  }
  if (/[\\/<>:"|?*]/.test(name) || /[\s.]$/.test(name)) {
    throw new Error("Project name contains characters Windows cannot use");
  }

  const { parentPath, folderName, separator } = splitProjectRoot(rootPath);
  if (name === folderName) return normalizeProjectRoot(rootPath);
  return `${parentPath}${parentPath.endsWith(separator) ? "" : separator}${name}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isWindowsFolderLockError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("os error 32") ||
    message.includes("being used by another process") ||
    message.includes("another program is using") ||
    message.includes("进程无法访问") ||
    message.includes("另一个程序正在使用")
  );
}

function formatProjectRenameError(error: unknown): string {
  if (isWindowsFolderLockError(error)) {
    return [
      "Project folder is still in use.",
      "Close any external PDF viewer, terminal, Python process, or file explorer preview using this project, then try again.",
    ].join(" ");
  }
  return error instanceof Error ? error.message : String(error);
}

async function renameProjectRootWithRetry(
  oldRoot: string,
  newRoot: string,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await renameFileOnDisk(oldRoot, newRoot);
      return;
    } catch (error) {
      const delay = PROJECT_RENAME_LOCK_RETRY_DELAYS_MS[attempt];
      if (!isWindowsFolderLockError(error) || delay == null) {
        throw new Error(formatProjectRenameError(error));
      }
      await sleep(delay);
    }
  }
}

async function waitForCompileToFinish(
  getState: () => DocumentState,
): Promise<void> {
  const started = Date.now();
  while (getState().isCompiling) {
    if (Date.now() - started > 10_000) {
      throw new Error(
        "Compilation is still running. Wait for it to finish before renaming the project.",
      );
    }
    await sleep(200);
  }
}

async function waitForChatTabsToSettle(tabIds: string[]): Promise<void> {
  const pendingIds = new Set(tabIds);
  const started = Date.now();
  while (true) {
    const pending = useClaudeChatStore
      .getState()
      .tabs.some(
        (tab) =>
          pendingIds.has(tab.id) &&
          (tab.isStreaming || (tab.cancelledAttempts?.length ?? 0) > 0),
      );
    if (!pending) return;
    if (Date.now() - started > PROJECT_RENAME_CHAT_STOP_TIMEOUT_MS) {
      throw new Error(
        "Runtime stop did not reach terminal completion. Project rename was cancelled.",
      );
    }
    await sleep(PROJECT_RENAME_CHAT_STOP_POLL_MS);
  }
}

// Auto-save: debounced save 2 seconds after last content change
let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingAutoSaveOwner: ProjectOwner | null = null;
// Store reference set after creation to avoid TDZ issues
let storeRef: typeof useDocumentStore | null = null;
let nextManualSaveRequest = 0;
let activeManualSaveRequest: {
  id: number;
  owner: ProjectOwner;
} | null = null;

function scheduleAutoSave(retryOwner?: ProjectOwner) {
  const store = storeRef;
  const owner =
    retryOwner ?? (store ? captureProjectOwner(store.getState()) : null);
  if (!owner) return;
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  pendingAutoSaveOwner = null;
  autoSaveTimer = setTimeout(async () => {
    autoSaveTimer = null;
    const store = storeRef;
    if (!store) return;
    const state = store.getState();
    if (!stillOwnsProject(state, owner)) return;
    if (state.isProjectMutating) {
      pendingAutoSaveOwner = owner;
      return;
    }
    const dirtyFiles = state.files.filter(
      (f) => f.isDirty && f.content != null,
    );
    if (dirtyFiles.length > 0) {
      await state.saveAllFiles();
    }
  }, 2000);
}

function acquireProjectStructureMutation(
  state: DocumentState,
): ProjectOwner | null {
  if (state.isProjectMutating) return null;
  const owner = captureProjectOwner(state);
  if (!owner) return null;

  let acquired = false;
  useDocumentStore.setState((current) => {
    if (current.isProjectMutating || !stillOwnsProject(current, owner)) {
      return {};
    }
    acquired = true;
    return { isProjectMutating: true };
  });
  if (!acquired) return null;
  bindHistoryToDocumentProject(useDocumentStore.getState());
  return owner;
}

function releaseProjectStructureMutation(owner: ProjectOwner): void {
  let released = false;
  useDocumentStore.setState((current) => {
    if (!current.isProjectMutating || !stillOwnsProject(current, owner)) {
      return {};
    }
    released = true;
    return { isProjectMutating: false };
  });
  if (released) {
    const current = useDocumentStore.getState();
    bindHistoryToDocumentProject(current);
    const retryOwner = pendingAutoSaveOwner;
    pendingAutoSaveOwner = null;
    if (
      retryOwner &&
      stillOwnsProject(current, retryOwner) &&
      current.files.some((file) => file.isDirty && file.content != null)
    ) {
      scheduleAutoSave(retryOwner);
    }
  }
}

export const useDocumentStore = create<DocumentState>()((set, get) => ({
  projectRoot: null,
  files: [],
  folders: [],
  activeFileId: "",
  cursorPosition: 0,
  selectionRange: null,
  jumpToPosition: null,
  isThreadOpen: false,
  pdfRevision: 0,
  compileError: null,
  isCompiling: false,
  isProjectMutating: false,
  projectGeneration: 0,
  refreshRequestGeneration: 0,
  fileTreeGeneration: 0,
  pendingRecompile: false,
  isSaving: false,
  initialized: false,
  contentGeneration: 0,
  compileErrorCache: new Map(),
  lastCompiledGenerations: new Map(),

  openProject: async (
    rootPath: string,
    options?: { allowDuringMutation?: boolean },
  ) => {
    const initialState = get();
    const allowDuringMutation = options?.allowDuringMutation === true;
    if (initialState.isProjectMutating && !allowDuringMutation) {
      throw new Error("Another project change is already in progress.");
    }
    if (!allowDuringMutation && useClaudeChatStore.getState().anyStreaming()) {
      throw new Error(
        "Stop all runtime turns before opening or refreshing a project.",
      );
    }
    const ownsMutationGuard = !initialState.isProjectMutating;
    let openGeneration = 0;
    set((state) => {
      openGeneration = state.projectGeneration + 1;
      return {
        isProjectMutating: ownsMutationGuard ? true : state.isProjectMutating,
        projectGeneration: openGeneration,
        refreshRequestGeneration: state.refreshRequestGeneration + 1,
      };
    });
    bindHistoryToDocumentProject(get());
    const stillOwnsOpen = () => get().projectGeneration === openGeneration;

    try {
      if (autoSaveTimer) {
        clearTimeout(autoSaveTimer);
        autoSaveTimer = null;
      }
      pendingAutoSaveOwner = null;
      const pendingOperations = drainProjectFsOperations([
        initialState.projectRoot,
        rootPath,
      ]);
      if (pendingOperations) {
        await pendingOperations;
        if (!stillOwnsOpen()) return;
      }
      log.info(`Opening project: ${rootPath}`);
      await invoke("allow_project_directory", { rootPath });
      if (!stillOwnsOpen()) return;
      const { files: fsFiles, folders: fsFolders } =
        await scanProjectFolder(rootPath);
      if (!stillOwnsOpen()) return;
      const projectFiles: ProjectFile[] = [];

      for (const f of fsFiles) {
        const pf: ProjectFile = {
          id: f.relativePath,
          name: f.relativePath.split(/[/\\]/).pop() || f.relativePath,
          relativePath: f.relativePath,
          absolutePath: f.absolutePath,
          type: f.type,
          isDirty: false,
          fileSize: f.fileSize,
        };

        // Load content for text-based files (skip large non-essential files)
        if (
          f.type === "tex" ||
          f.type === "bib" ||
          f.type === "style" ||
          f.type === "other"
        ) {
          const isLargeNonEssential =
            f.type === "other" && f.fileSize > LARGE_FILE_THRESHOLD;
          if (!isLargeNonEssential) {
            try {
              pf.content = await readTexFileContent(f.absolutePath);
            } catch {
              pf.content = "";
            }
            if (!stillOwnsOpen()) return;
          }
          // Large "other" files: content stays undefined, loaded on-demand via loadFileContent
        }

        // Load dataUrl for image files (skip very large images)
        if (f.type === "image") {
          if (f.fileSize <= LARGE_FILE_THRESHOLD) {
            try {
              pf.dataUrl = await readImageAsDataUrl(f.absolutePath);
            } catch {
              // Image loading failed, that's ok
            }
            if (!stillOwnsOpen()) return;
          }
        }

        // PDF files are loaded on-demand via readFile in InlinePdfContent

        projectFiles.push(pf);
      }

      // Find the main tex file
      const mainTex =
        projectFiles.find(
          (f) => f.name === "main.tex" || f.name === "document.tex",
        ) || projectFiles.find((f) => f.type === "tex");

      if (!stillOwnsOpen()) return;
      clearPdfBytesCache();
      set((state) =>
        state.projectGeneration === openGeneration
          ? {
              projectRoot: rootPath,
              files: projectFiles,
              folders: fsFolders,
              activeFileId: mainTex?.id || projectFiles[0]?.id || "",
              pdfRevision: 0,
              compileError: null,
              isCompiling: false,
              compileErrorCache: new Map(),
              lastCompiledGenerations: new Map(),
              initialized: true,
              cursorPosition: 0,
              selectionRange: null,
              fileTreeGeneration: state.fileTreeGeneration + 1,
              contentGeneration: state.contentGeneration + 1,
            }
          : {},
      );
      if (!stillOwnsOpen()) return;
      bindHistoryToDocumentProject(get());
      // Non-destructive: register project skill folders that are not yet managed.
      // Dynamic import avoids a document↔editor↔zotero circular init cycle.
      void import("@/stores/skill-store")
        .then(({ useSkillStore }) =>
          useSkillStore.getState().autoImportProject(rootPath),
        )
        .catch((error) => {
          log.warn("Project skill auto-import failed", {
            error: String(error),
          });
        });
    } finally {
      if (ownsMutationGuard) {
        set((state) =>
          state.projectGeneration === openGeneration
            ? { isProjectMutating: false }
            : {},
        );
      }
      const finalState = get();
      if (finalState.projectGeneration === openGeneration) {
        bindHistoryToDocumentProject(finalState);
        if (
          ownsMutationGuard &&
          finalState.projectRoot &&
          finalState.initialized &&
          !finalState.isProjectMutating
        ) {
          initializeHistoryForMountedProject(
            finalState.projectRoot,
            finalState.projectGeneration,
          );
        }
      }
    }
  },

  renameProject: async (newName: string) => {
    let state = get();
    if (!state.projectRoot) throw new Error("No project open");
    if (state.isProjectMutating) {
      const waitingRoot = state.projectRoot;
      const waitingGeneration = state.projectGeneration;
      const pendingStructureMutation = drainProjectFsOperations([waitingRoot]);
      if (!pendingStructureMutation) {
        throw new Error("Another project change is already in progress.");
      }
      await pendingStructureMutation;
      await Promise.resolve();
      state = get();
      if (
        state.projectRoot !== waitingRoot ||
        state.projectGeneration !== waitingGeneration ||
        state.isProjectMutating
      ) {
        throw new Error("Another project change is already in progress.");
      }
    }

    const oldRoot = state.projectRoot;
    const newRoot = buildRenamedProjectRoot(oldRoot, newName);
    if (newRoot === normalizeProjectRoot(oldRoot)) return;
    let mutationProjectGeneration = 0;
    let mutationFileTreeGeneration = 0;
    let mutationContentGeneration = 0;
    set((current) => {
      mutationProjectGeneration = current.projectGeneration + 1;
      mutationFileTreeGeneration = current.fileTreeGeneration + 1;
      mutationContentGeneration = current.contentGeneration + 1;
      return {
        isProjectMutating: true,
        projectGeneration: mutationProjectGeneration,
        refreshRequestGeneration: current.refreshRequestGeneration + 1,
        fileTreeGeneration: mutationFileTreeGeneration,
        contentGeneration: mutationContentGeneration,
      };
    });
    bindHistoryToDocumentProject(get());
    const stillOwnsRename = () => {
      const current = get();
      return (
        current.isProjectMutating &&
        current.projectRoot === oldRoot &&
        current.projectGeneration === mutationProjectGeneration &&
        current.fileTreeGeneration === mutationFileTreeGeneration &&
        current.contentGeneration === mutationContentGeneration
      );
    };
    const assertOwnsRename = () => {
      if (!stillOwnsRename()) {
        throw new Error(
          "Project files changed while rename was preparing. Rename was cancelled.",
        );
      }
    };
    let diskRenameCompleted = false;

    try {
      if (autoSaveTimer) {
        clearTimeout(autoSaveTimer);
        autoSaveTimer = null;
      }
      pendingAutoSaveOwner = null;
      const pendingOperations = drainProjectFsOperations([oldRoot, newRoot]);
      if (pendingOperations) {
        await pendingOperations;
        assertOwnsRename();
      }
      await waitForCompileToFinish(get);

      const chatState = useClaudeChatStore.getState();
      const streamingTabs =
        "tabs" in chatState && Array.isArray(chatState.tabs)
          ? chatState.tabs.filter(
              (tab) =>
                tab.isStreaming || (tab.cancelledAttempts?.length ?? 0) > 0,
            )
          : [];
      if (streamingTabs.length > 0) {
        const outcomes = await Promise.all(
          streamingTabs.map((tab) => chatState.cancelExecution(tab.id)),
        );
        if (outcomes.some((outcome) => outcome === "uncertain")) {
          throw new Error(
            "Unable to confirm that all runtime turns stopped. Project rename was cancelled.",
          );
        }
        await waitForChatTabsToSettle(streamingTabs.map((tab) => tab.id));
      }

      assertOwnsRename();
      await get().saveAllFiles({ allowDuringMutation: true });
      assertOwnsRename();
      const dirtyFiles = get().files.filter(
        (f) => f.isDirty && f.content != null,
      );
      if (dirtyFiles.length > 0) {
        throw new Error("Save failed. Please save changes before renaming.");
      }

      clearPdfBytesCache();
      clearScrollPositionCache();
      clearZoomCache();
      clearEditorStateCache();
      set((s) => ({
        pdfRevision: s.pdfRevision + 1,
        compileError: null,
        compileErrorCache: new Map(),
        lastCompiledGenerations: new Map(),
      }));
      await clearDocCache();
      await sleep(150);

      assertOwnsRename();
      await renameProjectRootWithRetry(oldRoot, newRoot);
      diskRenameCompleted = true;
      try {
        await invoke("migrate_project_sessions", {
          oldProjectPath: oldRoot,
          newProjectPath: newRoot,
        });
      } catch (err) {
        log.warn("Failed to migrate project sessions after rename", {
          oldRoot,
          newRoot,
          error: String(err),
        });
      }
      const projectStore = useProjectStore.getState();
      projectStore.renameRecentProject(oldRoot, newRoot);
      projectStore.setLastProjectFolder(splitProjectRoot(newRoot).parentPath);

      await get().openProject(newRoot, { allowDuringMutation: true });
      mutationProjectGeneration = get().projectGeneration;
    } catch (error) {
      if (diskRenameCompleted) {
        clearPdfBytesCache();
        set((current) => ({
          projectRoot: null,
          files: [],
          folders: [],
          activeFileId: "",
          cursorPosition: 0,
          selectionRange: null,
          pdfRevision: current.pdfRevision + 1,
          compileError: null,
          isCompiling: false,
          pendingRecompile: false,
          isSaving: false,
          compileErrorCache: new Map(),
          lastCompiledGenerations: new Map(),
          initialized: false,
          projectGeneration: current.projectGeneration + 1,
          refreshRequestGeneration: current.refreshRequestGeneration + 1,
          fileTreeGeneration: current.fileTreeGeneration + 1,
          contentGeneration: current.contentGeneration + 1,
          isProjectMutating: false,
        }));
        bindHistoryToDocumentProject(get());
        useClaudeChatStore.getState().resetForProject(null);
      }
      throw error;
    } finally {
      set((current) =>
        current.projectGeneration === mutationProjectGeneration &&
        current.isProjectMutating
          ? { isProjectMutating: false }
          : {},
      );
      const finalState = get();
      if (finalState.projectGeneration === mutationProjectGeneration) {
        bindHistoryToDocumentProject(finalState);
        if (
          finalState.projectRoot &&
          finalState.initialized &&
          !finalState.isProjectMutating
        ) {
          initializeHistoryForMountedProject(
            finalState.projectRoot,
            finalState.projectGeneration,
          );
        }
      }
    }
  },

  closeProject: () => {
    const state = get();
    const chatState = useClaudeChatStore.getState();
    if (state.isProjectMutating || chatState.anyStreaming()) return false;
    const owner = captureProjectOwner(state);
    if (owner) {
      set((current) =>
        stillOwnsProject(current, owner) && !current.isProjectMutating
          ? { isProjectMutating: true }
          : {},
      );
      if (!get().isProjectMutating || !stillOwnsProject(get(), owner)) {
        return false;
      }
      bindHistoryToDocumentProject(get());
    }

    const finishClose = () => {
      const current = get();
      if (owner && !stillOwnsProject(current, owner)) return false;
      log.info("Closing project");
      if (autoSaveTimer) {
        clearTimeout(autoSaveTimer);
        autoSaveTimer = null;
      }
      pendingAutoSaveOwner = null;
      void clearDocCache();
      clearScrollPositionCache();
      clearZoomCache();
      clearEditorStateCache();
      clearPdfBytesCache();
      set((mounted) => ({
        projectRoot: null,
        files: [],
        folders: [],
        activeFileId: "",
        pdfRevision: 0,
        compileError: null,
        isCompiling: false,
        isProjectMutating: false,
        isSaving: false,
        compileErrorCache: new Map(),
        lastCompiledGenerations: new Map(),
        initialized: false,
        projectGeneration: mounted.projectGeneration + 1,
        refreshRequestGeneration: mounted.refreshRequestGeneration + 1,
      }));
      bindHistoryToDocumentProject(get());
      // Reset chat session so stale messages don't leak into the next project
      chatState.resetForProject(null);
      return true;
    };

    const pendingOperations = owner
      ? drainProjectFsOperations([owner.projectRoot])
      : null;
    if (!pendingOperations) return finishClose();
    return pendingOperations.then(finishClose);
  },

  setActiveFile: (id) => {
    const state = get();
    const file = state.files.find((f) => f.id === id);
    if (!file || file.type !== "tex") {
      set({
        activeFileId: id,
        selectionRange: null,
      });
      return;
    }

    const rootId = resolveTexRoot(id, state.files);
    const newPdfRootId = _pdfBytesCache.has(rootId) ? rootId : null;
    const pdfRootChanged = newPdfRootId !== _currentPdfRootId;
    _currentPdfRootId = newPdfRootId;
    const cachedError = state.compileErrorCache.get(rootId) ?? null;
    set((s) => ({
      activeFileId: id,
      selectionRange: null,
      ...(pdfRootChanged ? { pdfRevision: s.pdfRevision + 1 } : {}),
      compileError: cachedError,
    }));
  },

  setSelectionRange: (range) => set({ selectionRange: range }),

  requestJumpToPosition: (position) => set({ jumpToPosition: position }),

  clearJumpRequest: () => set({ jumpToPosition: null }),

  addFile: (file) => {
    const id = file.relativePath;
    if (get().isProjectMutating) return id;
    set((state) => ({
      files: [...state.files, { ...file, id, isDirty: false }],
      activeFileId: id,
      fileTreeGeneration: state.fileTreeGeneration + 1,
    }));
    return id;
  },

  deleteFile: async (id) => {
    const state = get();
    if (state.isProjectMutating) return;
    if (state.files.length <= 1) return;
    const file = state.files.find((f) => f.id === id);
    if (!file) return;
    const owner = acquireProjectStructureMutation(state);
    if (!owner) return;
    try {
      try {
        await runProjectFsOperationAfterDrain(owner, [owner.projectRoot], () =>
          deleteFileFromDisk(file.absolutePath),
        );
      } catch (e) {
        log.error("Failed to delete file from disk", { error: String(e) });
        return;
      }
      const current = get();
      if (!stillOwnsProject(current, owner)) return;
      const currentFile = current.files.find(
        (candidate) => candidate.id === id,
      );
      if (currentFile?.absolutePath !== file.absolutePath) return;
      const newFiles = current.files.filter((f) => f.id !== id);
      if (newFiles.length === 0) return;
      const newActiveId =
        current.activeFileId === id ? newFiles[0].id : current.activeFileId;
      const compileErrorCache = new Map(current.compileErrorCache);
      const lastCompiledGenerations = new Map(current.lastCompiledGenerations);
      _pdfBytesCache.delete(id);
      compileErrorCache.delete(id);
      lastCompiledGenerations.delete(id);
      // If the deleted file was active, show the new active file's cached PDF
      const switchingActive = current.activeFileId === id;
      const newRootId = switchingActive
        ? resolveTexRoot(newActiveId, newFiles)
        : undefined;
      if (switchingActive && newRootId) {
        _currentPdfRootId = _pdfBytesCache.has(newRootId) ? newRootId : null;
      }
      set((s) =>
        stillOwnsProject(s, owner) &&
        s.files.some(
          (candidate) =>
            candidate.id === id && candidate.absolutePath === file.absolutePath,
        )
          ? {
              files: newFiles,
              activeFileId: newActiveId,
              compileErrorCache,
              lastCompiledGenerations,
              fileTreeGeneration: s.fileTreeGeneration + 1,
              ...(switchingActive ? { pdfRevision: s.pdfRevision + 1 } : {}),
              ...(switchingActive && newRootId
                ? {
                    compileError: compileErrorCache.get(newRootId) ?? null,
                  }
                : {}),
            }
          : {},
      );
    } finally {
      releaseProjectStructureMutation(owner);
    }
  },

  deleteFolder: async (folderPath) => {
    const state = get();
    if (state.isProjectMutating) return;
    if (!state.projectRoot) return;
    const prefix = `${folderPath}/`;
    const remainingFiles = state.files.filter(
      (f) => !f.relativePath.startsWith(prefix),
    );
    // Must keep at least one file
    if (remainingFiles.length === 0) return;
    const owner = acquireProjectStructureMutation(state);
    if (!owner) return;

    try {
      // Delete folder from disk (recursive)
      try {
        await runProjectFsOperationAfterDrain(
          owner,
          [owner.projectRoot],
          async () => {
            const absPath = await join(state.projectRoot!, folderPath);
            await deleteFolderFromDisk(absPath);
          },
        );
      } catch (e) {
        log.error("Failed to delete folder from disk", { error: String(e) });
        return;
      }

      const current = get();
      if (!stillOwnsProject(current, owner)) return;
      const currentFilesToRemove = current.files.filter((f) =>
        f.relativePath.startsWith(prefix),
      );
      const currentRemainingFiles = current.files.filter(
        (f) => !f.relativePath.startsWith(prefix),
      );
      if (currentRemainingFiles.length === 0) return;

      // Clean caches
      const compileErrorCache = new Map(current.compileErrorCache);
      const lastCompiledGenerations = new Map(current.lastCompiledGenerations);
      for (const f of currentFilesToRemove) {
        _pdfBytesCache.delete(f.id);
        compileErrorCache.delete(f.id);
        lastCompiledGenerations.delete(f.id);
      }

      const removedIds = new Set(currentFilesToRemove.map((f) => f.id));
      const newActiveId = removedIds.has(current.activeFileId)
        ? currentRemainingFiles[0].id
        : current.activeFileId;
      const switchingActive = newActiveId !== current.activeFileId;
      const newRootId = switchingActive
        ? resolveTexRoot(newActiveId, currentRemainingFiles)
        : undefined;
      if (switchingActive && newRootId) {
        _currentPdfRootId = _pdfBytesCache.has(newRootId) ? newRootId : null;
      }

      // Remove folder from folders list
      const newFolders = current.folders.filter(
        (f) => f !== folderPath && !f.startsWith(prefix),
      ); // include exact match since folders list contains folder paths directly

      set((s) =>
        stillOwnsProject(s, owner)
          ? {
              files: currentRemainingFiles,
              folders: newFolders,
              activeFileId: newActiveId,
              compileErrorCache,
              lastCompiledGenerations,
              fileTreeGeneration: s.fileTreeGeneration + 1,
              ...(switchingActive ? { pdfRevision: s.pdfRevision + 1 } : {}),
              ...(switchingActive && newRootId
                ? {
                    compileError: compileErrorCache.get(newRootId) ?? null,
                  }
                : {}),
            }
          : {},
      );
    } finally {
      releaseProjectStructureMutation(owner);
    }
  },

  renameFile: async (id, name) => {
    const state = get();
    if (state.isProjectMutating) return;
    const file = state.files.find((f) => f.id === id);
    if (!file || !state.projectRoot) return;
    const owner = acquireProjectStructureMutation(state);
    if (!owner) return;

    const dir = file.relativePath.includes("/")
      ? file.relativePath.substring(0, file.relativePath.lastIndexOf("/"))
      : "";
    const newRelativePath = dir ? `${dir}/${name}` : name;

    try {
      let newAbsPath: string;
      try {
        newAbsPath = await runProjectFsOperationAfterDrain(
          owner,
          [owner.projectRoot],
          async () => {
            const path = await join(state.projectRoot!, newRelativePath);
            await renameFileOnDisk(file.absolutePath, path);
            return path;
          },
        );
      } catch (e) {
        log.error("Failed to rename file on disk", { error: String(e) });
        return;
      }
      const current = get();
      if (!stillOwnsProject(current, owner)) return;
      if (
        !current.files.some(
          (candidate) =>
            candidate.id === id && candidate.absolutePath === file.absolutePath,
        )
      ) {
        return;
      }
      migratePdfBytesKey(id, newRelativePath);
      set((s) => {
        if (!stillOwnsProject(s, owner)) return {};
        if (
          !s.files.some(
            (candidate) =>
              candidate.id === id &&
              candidate.absolutePath === file.absolutePath,
          )
        ) {
          return {};
        }
        const compileErrorCache = migrateCacheKey(
          s.compileErrorCache,
          id,
          newRelativePath,
        );
        const lastCompiledGenerations = migrateCacheKey(
          s.lastCompiledGenerations,
          id,
          newRelativePath,
        );
        const isActive = s.activeFileId === id;
        return {
          files: s.files.map((f) =>
            f.id === id
              ? {
                  ...f,
                  name,
                  relativePath: newRelativePath,
                  absolutePath: newAbsPath,
                  id: newRelativePath,
                }
              : f,
          ),
          activeFileId: isActive ? newRelativePath : s.activeFileId,
          compileErrorCache,
          lastCompiledGenerations,
          fileTreeGeneration: s.fileTreeGeneration + 1,
        };
      });
    } finally {
      releaseProjectStructureMutation(owner);
    }
  },

  updateFileContent: (id, content) => {
    if (get().isProjectMutating) return;
    set((state) => ({
      files: state.files.map((f) =>
        f.id === id ? { ...f, content, isDirty: true } : f,
      ),
      contentGeneration: state.contentGeneration + 1,
    }));
    scheduleAutoSave();
  },

  updateImageDataUrl: (id, dataUrl) => {
    if (get().isProjectMutating) return;
    set((state) => ({
      files: state.files.map((f) => (f.id === id ? { ...f, dataUrl } : f)),
      contentGeneration: state.contentGeneration + 1,
    }));
  },

  setThreadOpen: (open) => set({ isThreadOpen: open }),

  setPdfData: (data, rootFileId?) => {
    if (data) {
      const key = rootFileId ?? "__default__";
      _pdfBytesCache.set(key, data);
      _currentPdfRootId = key;
    } else if (rootFileId) {
      _pdfBytesCache.delete(rootFileId);
      if (_currentPdfRootId === rootFileId) _currentPdfRootId = null;
    } else {
      _currentPdfRootId = null;
    }
    if (rootFileId) {
      if (data) {
        const s = get();
        const compileErrorCache = new Map(s.compileErrorCache);
        const lastCompiledGenerations = new Map(s.lastCompiledGenerations);
        compileErrorCache.delete(rootFileId);
        lastCompiledGenerations.set(rootFileId, s.contentGeneration);
        set((prev) => ({
          pdfRevision: prev.pdfRevision + 1,
          compileError: null,
          compileErrorCache,
          lastCompiledGenerations,
        }));
      } else {
        set((prev) => ({
          pdfRevision: prev.pdfRevision + 1,
          compileError: null,
        }));
      }
    } else {
      set((prev) => ({
        pdfRevision: prev.pdfRevision + 1,
        compileError: null,
      }));
    }
  },

  setCompileError: (error, rootFileId?) => {
    if (rootFileId) {
      const compileErrorCache = new Map(get().compileErrorCache);
      if (error) {
        compileErrorCache.set(rootFileId, error);
      } else {
        compileErrorCache.delete(rootFileId);
      }
      set({ compileError: error, compileErrorCache });
    } else {
      set({ compileError: error });
    }
  },

  setIsCompiling: (isCompiling) => set({ isCompiling }),
  setPendingRecompile: (pending) => set({ pendingRecompile: pending }),

  setIsSaving: (isSaving) => {
    if (
      !isSaving &&
      activeManualSaveRequest &&
      stillOwnsProject(get(), activeManualSaveRequest.owner)
    ) {
      return;
    }
    set({ isSaving });
  },

  setCursorPosition: (position) => set({ cursorPosition: position }),

  insertAtCursor: (text) => {
    const state = get();
    if (state.isProjectMutating) return;
    const activeFile = getActiveFile(state);
    if (!activeFile || activeFile.type === "image" || activeFile.type === "pdf")
      return;

    const content = activeFile.content ?? "";
    const { cursorPosition } = state;
    const newContent =
      content.slice(0, cursorPosition) + text + content.slice(cursorPosition);

    set((current) => ({
      files: current.files.map((f) =>
        f.id === activeFile.id
          ? { ...f, content: newContent, isDirty: true }
          : f,
      ),
      cursorPosition: cursorPosition + text.length,
      contentGeneration: current.contentGeneration + 1,
    }));
    scheduleAutoSave();
  },

  replaceSelection: (start, end, text) => {
    const state = get();
    if (state.isProjectMutating) return;
    const activeFile = getActiveFile(state);
    if (!activeFile || activeFile.type === "image" || activeFile.type === "pdf")
      return;

    const content = activeFile.content ?? "";
    const newContent = content.slice(0, start) + text + content.slice(end);

    set((current) => ({
      files: current.files.map((f) =>
        f.id === activeFile.id
          ? { ...f, content: newContent, isDirty: true }
          : f,
      ),
      cursorPosition: start + text.length,
      contentGeneration: current.contentGeneration + 1,
    }));
    scheduleAutoSave();
  },

  findAndReplace: (find, replace) => {
    const state = get();
    if (state.isProjectMutating) return false;
    const activeFile = getActiveFile(state);
    if (!activeFile || activeFile.type === "image" || activeFile.type === "pdf")
      return false;

    const content = activeFile.content ?? "";
    if (!content.includes(find)) return false;

    const newContent = content.replace(find, replace);
    set((current) => ({
      files: current.files.map((f) =>
        f.id === activeFile.id
          ? { ...f, content: newContent, isDirty: true }
          : f,
      ),
      contentGeneration: current.contentGeneration + 1,
    }));
    scheduleAutoSave();
    return true;
  },

  setInitialized: () => set({ initialized: true }),

  saveFile: async (id, options) => {
    const state = get();
    if (state.isProjectMutating && !options?.allowDuringMutation) return;
    const file = state.files.find((f) => f.id === id);
    if (!file || !file.isDirty || file.content == null) return;
    const owner = captureProjectOwner(state);
    if (!owner) return;

    await writeProjectTextFileInOrder(owner, file.absolutePath, file.content!);
    set((s) => {
      if (!stillOwnsProject(s, owner)) return {};
      const currentFile = s.files.find((candidate) => candidate.id === id);
      if (
        currentFile?.absolutePath !== file.absolutePath ||
        currentFile.content !== file.content
      ) {
        return {};
      }
      return {
        files: s.files.map((candidate) =>
          candidate.id === id ? { ...candidate, isDirty: false } : candidate,
        ),
      };
    });
  },

  saveAllFiles: async (options) => {
    const state = get();
    if (state.isProjectMutating && !options?.allowDuringMutation) return;
    const owner = captureProjectOwner(state);
    if (!owner) return;
    const dirtyFiles = state.files.filter(
      (f) => f.isDirty && f.content != null,
    );
    const results = await Promise.allSettled(
      dirtyFiles.map((f) =>
        writeProjectTextFileInOrder(owner, f.absolutePath, f.content!),
      ),
    );
    // Only mark successfully saved files as clean
    const savedFiles = new Map<string, ProjectFile>();
    results.forEach((r, i) => {
      if (r.status === "fulfilled") {
        savedFiles.set(dirtyFiles[i].id, dirtyFiles[i]);
      }
    });
    if (savedFiles.size > 0) {
      set((s) => {
        if (!stillOwnsProject(s, owner)) return {};
        return {
          files: s.files.map((file) => {
            const saved = savedFiles.get(file.id);
            return saved &&
              file.absolutePath === saved.absolutePath &&
              file.content === saved.content
              ? { ...file, isDirty: false }
              : file;
          }),
        };
      });
    }
  },

  saveCurrentFile: async () => {
    const state = get();
    if (state.isProjectMutating) return;
    const owner = captureProjectOwner(state);
    if (!owner) return;
    const requestId = ++nextManualSaveRequest;
    activeManualSaveRequest = { id: requestId, owner };
    set({ isSaving: true });
    try {
      await state.saveFile(state.activeFileId);
      // Manual save → immediate snapshot
      if (stillOwnsProject(get(), owner)) {
        await useHistoryStore
          .getState()
          .createSnapshot(owner.projectRoot, "[manual] Save");
      }
    } catch {
      // Save failures are already presented by the caller. Keep the file dirty
      // and settle the transient indicator without an unhandled rejection.
    } finally {
      setTimeout(() => {
        if (activeManualSaveRequest?.id !== requestId) return;
        activeManualSaveRequest = null;
        set((current) =>
          stillOwnsProject(current, owner) ? { isSaving: false } : {},
        );
      }, MANUAL_SAVE_BUSY_DELAY_MS);
    }
  },

  createNewFile: async (name, type, folder) => {
    const state = get();
    if (state.isProjectMutating) return;
    if (!state.projectRoot) return;
    const owner = captureProjectOwner(state);
    if (!owner) return;

    const relativePath = folder ? `${folder}/${name}` : name;
    const isTexFile = name.endsWith(".tex") || name.endsWith(".ltx");
    const content = isTexFile
      ? `\\documentclass{article}\n\n\\begin{document}\n\n% Your content here\n\n\\end{document}\n`
      : "";

    const fullPath = await runProjectFsOperation(owner, () =>
      createFileOnDisk(state.projectRoot!, relativePath, content),
    );

    set((s) =>
      stillOwnsProject(s, owner) &&
      !s.files.some((file) => file.id === relativePath)
        ? {
            files: [
              ...s.files,
              {
                id: relativePath,
                name,
                relativePath,
                absolutePath: fullPath,
                type,
                content: type !== "image" ? content : undefined,
                isDirty: false,
              },
            ],
            activeFileId: relativePath,
            fileTreeGeneration: s.fileTreeGeneration + 1,
          }
        : {},
    );
  },

  createFolder: async (name, parentFolder) => {
    const state = get();
    if (state.isProjectMutating) return;
    if (!state.projectRoot) return;
    const owner = captureProjectOwner(state);
    if (!owner) return;

    const relativePath = parentFolder ? `${parentFolder}/${name}` : name;
    await runProjectFsOperation(owner, async () => {
      const absolutePath = await join(state.projectRoot!, relativePath);
      await createDirectory(absolutePath);
    });
    set((s) =>
      stillOwnsProject(s, owner) && !s.folders.includes(relativePath)
        ? {
            folders: [...s.folders, relativePath],
            fileTreeGeneration: s.fileTreeGeneration + 1,
          }
        : {},
    );
  },

  importFiles: async (sourcePaths, targetFolder) => {
    const state = get();
    if (state.isProjectMutating) return [];
    if (!state.projectRoot) return [];
    const owner = captureProjectOwner(state);
    if (!owner) return [];

    return runProjectFsOperation(owner, async () => {
      const importedPaths: string[] = [];
      for (const sourcePath of sourcePaths) {
        // Handle both Unix (/) and Windows (\) path separators
        const fileName = sourcePath.split(/[/\\]/).pop() || sourcePath;
        const targetName = targetFolder
          ? `${targetFolder}/${fileName}`
          : fileName;
        // copyFileToProject returns the actual (possibly deduplicated) relative path
        const actualName = await copyFileToProject(
          state.projectRoot!,
          sourcePath,
          targetName,
        );
        importedPaths.push(actualName);
        if (!stillOwnsProject(get(), owner)) return importedPaths;
      }
      if (stillOwnsProject(get(), owner)) {
        await get().refreshFiles();
      }
      return importedPaths;
    });
  },

  moveFile: async (fileId, targetFolder) => {
    const state = get();
    if (state.isProjectMutating) return;
    const file = state.files.find((f) => f.id === fileId);
    if (!file || !state.projectRoot) return;

    const desiredPath = targetFolder
      ? `${targetFolder}/${file.name}`
      : file.name;
    if (desiredPath === file.relativePath) return;
    const owner = acquireProjectStructureMutation(state);
    if (!owner) return;
    const stillOwnsFile = () => {
      const current = get();
      return (
        stillOwnsProject(current, owner) &&
        current.files.some(
          (candidate) =>
            candidate.id === fileId &&
            candidate.absolutePath === file.absolutePath,
        )
      );
    };

    try {
      // Auto-deduplicate if a file with the same name exists in the target
      const moveTarget = await runProjectFsOperationAfterDrain(
        owner,
        [owner.projectRoot],
        async () => {
          const newRelativePath = await getUniqueTargetName(
            state.projectRoot!,
            desiredPath,
          );
          if (!stillOwnsFile()) return null;
          const newAbsPath = await join(state.projectRoot!, newRelativePath);
          if (!stillOwnsFile()) return null;
          await renameFileOnDisk(file.absolutePath, newAbsPath);
          return { newRelativePath, newAbsPath };
        },
      );
      if (!moveTarget || !stillOwnsFile()) return;
      const { newRelativePath, newAbsPath } = moveTarget;

      const newName = newRelativePath.split(/[/\\]/).pop() || file.name;
      migratePdfBytesKey(fileId, newRelativePath);
      set((s) => {
        if (
          !stillOwnsProject(s, owner) ||
          !s.files.some(
            (candidate) =>
              candidate.id === fileId &&
              candidate.absolutePath === file.absolutePath,
          )
        ) {
          return {};
        }
        const compileErrorCache = migrateCacheKey(
          s.compileErrorCache,
          fileId,
          newRelativePath,
        );
        const lastCompiledGenerations = migrateCacheKey(
          s.lastCompiledGenerations,
          fileId,
          newRelativePath,
        );
        return {
          files: s.files.map((f) =>
            f.id === fileId
              ? {
                  ...f,
                  name: newName,
                  relativePath: newRelativePath,
                  absolutePath: newAbsPath,
                  id: newRelativePath,
                }
              : f,
          ),
          activeFileId:
            s.activeFileId === fileId ? newRelativePath : s.activeFileId,
          compileErrorCache,
          lastCompiledGenerations,
          fileTreeGeneration: s.fileTreeGeneration + 1,
        };
      });
    } finally {
      releaseProjectStructureMutation(owner);
    }
  },

  moveFolder: async (folderPath, targetFolder) => {
    const state = get();
    if (state.isProjectMutating) return;
    if (!state.projectRoot) return;

    const folderName = folderPath.split(/[/\\]/).pop()!;
    const newFolderPath = targetFolder
      ? `${targetFolder}/${folderName}`
      : folderName;
    if (newFolderPath === folderPath) return;
    // Prevent moving a folder into itself
    if (newFolderPath.startsWith(`${folderPath}/`)) return;
    const owner = acquireProjectStructureMutation(state);
    if (!owner) return;
    const oldPrefix = `${folderPath}/`;
    const newPrefix = `${newFolderPath}/`;

    try {
      const movedFiles = await runProjectFsOperationAfterDrain(
        owner,
        [owner.projectRoot],
        async () => {
          const current = get();
          if (!stillOwnsProject(current, owner)) return null;
          const pathChanges = new Map<
            string,
            { relativePath: string; absolutePath: string }
          >();
          for (const file of current.files) {
            if (!file.relativePath.startsWith(oldPrefix)) continue;
            const relativePath = `${newPrefix}${file.relativePath.slice(oldPrefix.length)}`;
            pathChanges.set(file.id, {
              relativePath,
              absolutePath: await join(owner.projectRoot, relativePath),
            });
          }
          if (!stillOwnsProject(get(), owner)) return null;
          const oldAbsPath = await join(owner.projectRoot, folderPath);
          const newAbsPath = await join(owner.projectRoot, newFolderPath);
          if (!stillOwnsProject(get(), owner)) return null;
          await renameFileOnDisk(oldAbsPath, newAbsPath);
          return pathChanges;
        },
      );
      if (!movedFiles || !stillOwnsProject(get(), owner)) return;

      for (const [oldId, moved] of movedFiles) {
        migratePdfBytesKey(oldId, moved.relativePath);
      }
      set((current) => {
        if (!stillOwnsProject(current, owner)) return {};
        let compileErrorCache = current.compileErrorCache;
        let lastCompiledGenerations = current.lastCompiledGenerations;
        for (const [oldId, moved] of movedFiles) {
          compileErrorCache = migrateCacheKey(
            compileErrorCache,
            oldId,
            moved.relativePath,
          );
          lastCompiledGenerations = migrateCacheKey(
            lastCompiledGenerations,
            oldId,
            moved.relativePath,
          );
        }
        const activeFileId =
          movedFiles.get(current.activeFileId)?.relativePath ??
          current.activeFileId;
        return {
          files: current.files.map((file) => {
            const moved = movedFiles.get(file.id);
            return moved
              ? {
                  ...file,
                  id: moved.relativePath,
                  relativePath: moved.relativePath,
                  absolutePath: moved.absolutePath,
                }
              : file;
          }),
          folders: current.folders.map((folder) =>
            folder === folderPath
              ? newFolderPath
              : folder.startsWith(oldPrefix)
                ? `${newPrefix}${folder.slice(oldPrefix.length)}`
                : folder,
          ),
          activeFileId,
          compileErrorCache,
          lastCompiledGenerations,
          fileTreeGeneration: current.fileTreeGeneration + 1,
        };
      });
    } finally {
      releaseProjectStructureMutation(owner);
    }
  },

  reloadFile: async (relativePath) => {
    const state = get();
    if (state.isProjectMutating) return;
    const file = state.files.find((f) => f.relativePath === relativePath);
    if (!file) return;
    const projectRoot = state.projectRoot;
    const projectGeneration = state.projectGeneration;
    const refreshRequestGeneration = state.refreshRequestGeneration;

    if (file.type === "tex" || file.type === "bib") {
      const content = await readTexFileContent(file.absolutePath);
      set((s) => {
        if (
          s.projectRoot !== projectRoot ||
          s.projectGeneration !== projectGeneration ||
          s.refreshRequestGeneration !== refreshRequestGeneration ||
          !s.files.some(
            (candidate) =>
              candidate.id === file.id &&
              candidate.absolutePath === file.absolutePath &&
              candidate.content === file.content &&
              candidate.isDirty === file.isDirty,
          )
        ) {
          return {};
        }
        return {
          files: s.files.map((candidate) =>
            candidate.id === file.id
              ? { ...candidate, content, isDirty: false }
              : candidate,
          ),
          contentGeneration: s.contentGeneration + 1,
        };
      });
    }
  },

  refreshFiles: async () => {
    const initialState = get();
    if (initialState.isProjectMutating) return;
    const {
      projectRoot,
      files,
      folders,
      activeFileId,
      projectGeneration,
      contentGeneration,
      fileTreeGeneration,
    } = initialState;
    if (!projectRoot) return;
    let refreshRequestGeneration = 0;
    set((state) => {
      if (
        state.projectRoot !== projectRoot ||
        state.projectGeneration !== projectGeneration
      ) {
        return {};
      }
      refreshRequestGeneration = state.refreshRequestGeneration + 1;
      return { refreshRequestGeneration };
    });
    if (refreshRequestGeneration === 0) return;
    const stillOwnsRefresh = () => {
      const state = get();
      return (
        state.projectRoot === projectRoot &&
        state.projectGeneration === projectGeneration &&
        state.refreshRequestGeneration === refreshRequestGeneration &&
        state.contentGeneration === contentGeneration &&
        state.fileTreeGeneration === fileTreeGeneration &&
        state.files === files &&
        state.folders === folders
      );
    };

    const { files: fsFiles, folders: fsFolders } =
      await scanProjectFolder(projectRoot);
    if (!stillOwnsRefresh()) return;
    const existingMap = new Map(files.map((f) => [f.relativePath, f]));
    const diskPaths = new Set(fsFiles.map((f) => f.relativePath));

    const merged: ProjectFile[] = [];

    for (const fsFile of fsFiles) {
      const existing = existingMap.get(fsFile.relativePath);

      if (existing) {
        // Existing file — reload content from disk unless the user has unsaved edits
        if (existing.isDirty) {
          merged.push(existing);
        } else {
          const updated = { ...existing, fileSize: fsFile.fileSize };
          if (
            updated.type === "tex" ||
            updated.type === "bib" ||
            updated.type === "style" ||
            updated.type === "other"
          ) {
            const isLargeNonEssential =
              updated.type === "other" &&
              fsFile.fileSize > LARGE_FILE_THRESHOLD;
            // Only reload if it was previously loaded (not a skipped large file)
            if (!isLargeNonEssential || updated.content !== undefined) {
              try {
                updated.content = await readTexFileContent(
                  updated.absolutePath,
                );
              } catch {
                /* keep previous content */
              }
              if (!stillOwnsRefresh()) return;
            }
          }
          merged.push(updated);
        }
      } else {
        // New file on disk
        const pf: ProjectFile = {
          id: fsFile.relativePath,
          name: fsFile.relativePath.split(/[/\\]/).pop() || fsFile.relativePath,
          relativePath: fsFile.relativePath,
          absolutePath: fsFile.absolutePath,
          type: fsFile.type,
          isDirty: false,
          fileSize: fsFile.fileSize,
        };
        const isLargeNonEssential =
          pf.type === "other" && fsFile.fileSize > LARGE_FILE_THRESHOLD;
        if (
          pf.type === "tex" ||
          pf.type === "bib" ||
          pf.type === "style" ||
          (pf.type === "other" && !isLargeNonEssential)
        ) {
          try {
            pf.content = await readTexFileContent(pf.absolutePath);
          } catch {
            /* skip unreadable */
          }
          if (!stillOwnsRefresh()) return;
        } else if (
          pf.type === "image" &&
          fsFile.fileSize <= LARGE_FILE_THRESHOLD
        ) {
          try {
            pf.dataUrl = await readImageAsDataUrl(pf.absolutePath);
          } catch {
            /* skip unreadable */
          }
          if (!stillOwnsRefresh()) return;
        }
        // PDF files and large files are loaded on-demand
        merged.push(pf);
      }
    }

    // Keep dirty files that were deleted from disk (user hasn't saved yet)
    for (const f of files) {
      if (!diskPaths.has(f.relativePath) && f.isDirty) {
        merged.push(f);
      }
    }

    const newActiveId = merged.some((f) => f.id === activeFileId)
      ? activeFileId
      : (merged[0]?.id ?? "");

    set((s) =>
      s.projectRoot === projectRoot &&
      s.projectGeneration === projectGeneration &&
      s.refreshRequestGeneration === refreshRequestGeneration &&
      s.contentGeneration === contentGeneration &&
      s.fileTreeGeneration === fileTreeGeneration &&
      s.files === files &&
      s.folders === folders
        ? {
            files: merged,
            folders: fsFolders,
            activeFileId: merged.some((file) => file.id === s.activeFileId)
              ? s.activeFileId
              : newActiveId,
            contentGeneration: s.contentGeneration + 1,
            fileTreeGeneration: s.fileTreeGeneration + 1,
          }
        : {},
    );
  },

  loadFileContent: async (id) => {
    const state = get();
    if (state.isProjectMutating) return;
    const file = state.files.find((f) => f.id === id);
    if (!file || file.content !== undefined) return; // already loaded
    const projectRoot = state.projectRoot;
    const projectGeneration = state.projectGeneration;
    const refreshRequestGeneration = state.refreshRequestGeneration;
    const commitContent = (content: string) => {
      set((current) => {
        if (
          current.projectRoot !== projectRoot ||
          current.projectGeneration !== projectGeneration ||
          current.refreshRequestGeneration !== refreshRequestGeneration ||
          !current.files.some(
            (candidate) =>
              candidate.id === id &&
              candidate.absolutePath === file.absolutePath &&
              candidate.content === undefined,
          )
        ) {
          return {};
        }
        return {
          files: current.files.map((candidate) =>
            candidate.id === id ? { ...candidate, content } : candidate,
          ),
        };
      });
    };
    try {
      const content = await readTexFileContent(file.absolutePath);
      commitContent(content);
    } catch {
      commitContent("");
    }
  },

  get fileName() {
    const activeFile = getActiveFile(get());
    return activeFile?.name ?? "main.tex";
  },

  get content() {
    const activeFile = getActiveFile(get());
    return activeFile?.content ?? "";
  },

  setFileName: (name) => {
    const state = get();
    if (state.isProjectMutating) return;
    set((current) => ({
      files: current.files.map((f) =>
        f.id === state.activeFileId ? { ...f, name } : f,
      ),
      fileTreeGeneration: current.fileTreeGeneration + 1,
    }));
  },

  setContent: (content) => {
    const state = get();
    if (state.isProjectMutating) return;
    set({
      files: state.files.map((f) =>
        f.id === state.activeFileId ? { ...f, content, isDirty: true } : f,
      ),
      contentGeneration: state.contentGeneration + 1,
    });
    scheduleAutoSave();
  },
}));

storeRef = useDocumentStore;
