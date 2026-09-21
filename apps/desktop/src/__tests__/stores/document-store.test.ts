import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  exists,
  mkdir,
  readDir,
  readFile,
  readTextFile,
  remove,
  rename,
  stat,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import {
  useDocumentStore,
  getCurrentPdfBytes,
  getCurrentPdfRootId,
  clearPdfBytesCache,
  type ProjectFile,
} from "@/stores/document-store";
import { useProjectStore } from "@/stores/project-store";

const {
  getChatState,
  cancelExecution,
  anyStreaming,
  resetChatForProject,
  historyBindProject,
  historyInit,
  historyLoadSnapshots,
  historyCreateSnapshot,
  historyReset,
} = vi.hoisted(() => ({
  getChatState: vi.fn(),
  cancelExecution: vi.fn(),
  anyStreaming: vi.fn(),
  resetChatForProject: vi.fn(),
  historyBindProject: vi.fn(),
  historyInit: vi.fn(() => Promise.resolve()),
  historyLoadSnapshots: vi.fn(() => Promise.resolve()),
  historyCreateSnapshot: vi.fn(() => Promise.resolve()),
  historyReset: vi.fn(),
}));

// Mock history store
vi.mock("@/stores/history-store", () => ({
  useHistoryStore: {
    getState: vi.fn(() => ({
      bindProject: historyBindProject,
      init: historyInit,
      loadSnapshots: historyLoadSnapshots,
      createSnapshot: historyCreateSnapshot,
      reset: historyReset,
    })),
  },
}));

// Mock claude-chat-store
vi.mock("@/stores/claude-chat-store", () => ({
  useClaudeChatStore: {
    getState: getChatState,
  },
}));

function makeFile(overrides: Partial<ProjectFile> = {}): ProjectFile {
  return {
    id: "main.tex",
    name: "main.tex",
    relativePath: "main.tex",
    absolutePath: "/project/main.tex",
    type: "tex",
    content: "Hello World",
    isDirty: false,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const originalSaveAllFiles = useDocumentStore.getState().saveAllFiles;

describe("useDocumentStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(writeTextFile).mockReset();
    cancelExecution.mockResolvedValue("not-found");
    anyStreaming.mockReturnValue(false);
    resetChatForProject.mockReturnValue("reset");
    getChatState.mockReturnValue({
      newSession: vi.fn(),
      cancelExecution,
      anyStreaming,
      resetForProject: resetChatForProject,
      tabs: [],
    });
    clearPdfBytesCache();
    useDocumentStore.setState({
      projectRoot: "/project",
      files: [makeFile()],
      folders: [],
      activeFileId: "main.tex",
      cursorPosition: 5, // after "Hello"
      selectionRange: null,
      jumpToPosition: null,
      isThreadOpen: false,
      pdfRevision: 0,
      compileError: null,
      isCompiling: false,
      isProjectMutating: false,
      pendingRecompile: false,
      isSaving: false,
      initialized: true,
      saveAllFiles: originalSaveAllFiles,
    });
    useProjectStore.setState({
      recentProjects: [],
      lastProjectFolder: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("getActiveFile logic", () => {
    it("insertAtCursor finds the correct active file", () => {
      // Validates that getActiveFile() correctly resolves the active file
      // by confirming insertAtCursor modifies the right file's content
      useDocumentStore.getState().insertAtCursor("!");
      const file = useDocumentStore
        .getState()
        .files.find((f) => f.id === "main.tex")!;
      expect(file.content).toBe("Hello! World");
    });

    it("returns null for nonexistent activeFileId (no-op on insert)", () => {
      useDocumentStore.setState({ activeFileId: "nonexistent" });
      useDocumentStore.getState().insertAtCursor("text");
      // Files should not be modified
      const file = useDocumentStore
        .getState()
        .files.find((f) => f.id === "main.tex")!;
      expect(file.content).toBe("Hello World");
    });
  });

  describe("openProject", () => {
    it("binds the real open lifecycle to history and initializes only after the barrier releases", async () => {
      const authorization = deferred<void>();
      vi.mocked(invoke).mockImplementation((command) => {
        if (command === "allow_project_directory") {
          return authorization.promise as ReturnType<typeof invoke>;
        }
        return Promise.resolve(undefined) as ReturnType<typeof invoke>;
      });
      vi.mocked(readDir).mockResolvedValue([] as any);

      const opening = useDocumentStore.getState().openProject("/opened");
      const guarded = useDocumentStore.getState();
      expect(guarded.isProjectMutating).toBe(true);
      expect(historyBindProject).toHaveBeenLastCalledWith(
        "/project",
        guarded.projectGeneration,
        true,
      );
      expect(historyInit).not.toHaveBeenCalled();

      authorization.resolve();
      await opening;
      await vi.waitFor(() => expect(historyLoadSnapshots).toHaveBeenCalled());

      const mounted = useDocumentStore.getState();
      expect(mounted).toMatchObject({
        projectRoot: "/opened",
        isProjectMutating: false,
      });
      expect(historyBindProject).toHaveBeenLastCalledWith(
        "/opened",
        mounted.projectGeneration,
        false,
      );
      expect(historyInit).toHaveBeenCalledWith("/opened");
      expect(historyLoadSnapshots).toHaveBeenCalledWith("/opened");
      expect(
        historyBindProject.mock.invocationCallOrder[
          historyBindProject.mock.invocationCallOrder.length - 1
        ],
      ).toBeLessThan(historyInit.mock.invocationCallOrder[0]);
    });

    it("gives a same-root reopen a fresh history owner generation", async () => {
      vi.mocked(invoke).mockResolvedValue(undefined as never);
      vi.mocked(readDir).mockResolvedValue([] as any);

      await useDocumentStore.getState().openProject("/project");
      const firstGeneration = useDocumentStore.getState().projectGeneration;
      await useDocumentStore.getState().openProject("/project");
      const secondGeneration = useDocumentStore.getState().projectGeneration;

      expect(secondGeneration).toBeGreaterThan(firstGeneration);
      expect(historyBindProject).toHaveBeenCalledWith(
        "/project",
        firstGeneration,
        false,
      );
      expect(historyBindProject).toHaveBeenLastCalledWith(
        "/project",
        secondGeneration,
        false,
      );
      expect(historyInit).toHaveBeenCalledTimes(2);
      expect(historyLoadSnapshots).toHaveBeenCalledTimes(2);
    });

    it("re-authorizes the project directory before scanning", async () => {
      const projectPath = "E:\\overleaf-cache\\论文项目";
      let resolveAuthorization!: () => void;
      const authorizationPromise = new Promise<void>((resolve) => {
        resolveAuthorization = resolve;
      });

      vi.mocked(invoke).mockReturnValue(
        authorizationPromise as ReturnType<typeof invoke>,
      );
      vi.mocked(readDir).mockResolvedValue([
        { name: "main.tex", isDirectory: false },
      ] as any);
      vi.mocked(readTextFile).mockResolvedValue("\\documentclass{article}");

      const openProjectPromise = useDocumentStore
        .getState()
        .openProject(projectPath);

      expect(invoke).toHaveBeenCalledWith("allow_project_directory", {
        rootPath: projectPath,
      });
      expect(readDir).not.toHaveBeenCalled();

      resolveAuthorization();
      await openProjectPromise;

      expect(readDir).toHaveBeenCalled();
    });

    it("skips Python cache directories and bytecode files during open", async () => {
      vi.mocked(invoke).mockResolvedValue(undefined as never);
      vi.mocked(readDir).mockImplementation(async (dir: string | URL) => {
        const dirPath = String(dir);
        if (dirPath === "/project") {
          return [
            { name: "__pycache__", isDirectory: true },
            { name: "main.tex", isDirectory: false },
            { name: "tool.py", isDirectory: false },
            { name: "compiled.pyc", isDirectory: false },
          ] as any;
        }

        throw new Error(`Unexpected readDir path: ${dirPath}`);
      });
      vi.mocked(stat).mockResolvedValue({ size: 32 } as any);
      vi.mocked(readTextFile).mockImplementation(async (path: string | URL) => {
        const filePath = String(path);
        if (filePath === "/project/main.tex") {
          return "\\documentclass{article}";
        }
        if (filePath === "/project/tool.py") {
          return "print('hello')";
        }
        throw new Error(`Unexpected readTextFile path: ${filePath}`);
      });

      await useDocumentStore.getState().openProject("/project");

      expect(readDir).toHaveBeenCalledWith("/project");
      expect(readDir).not.toHaveBeenCalledWith("/project/__pycache__");
      expect(stat).toHaveBeenCalledTimes(1);
      expect(stat).toHaveBeenCalledWith("/project/tool.py");
      expect(readTextFile).toHaveBeenCalledTimes(2);
      expect(readTextFile).not.toHaveBeenCalledWith("/project/compiled.pyc");
      expect(
        useDocumentStore.getState().files.map((file) => file.relativePath),
      ).toEqual(["main.tex", "tool.py"]);
    });
  });

  describe("renameProject", () => {
    it("cancels streaming Claude and Codex tabs through the chat attempt lifecycle", async () => {
      vi.mocked(invoke).mockResolvedValue(undefined as never);
      vi.mocked(readDir).mockResolvedValue([
        { name: "main.tex", isDirectory: false },
      ] as any);
      vi.mocked(readTextFile).mockResolvedValue("\\documentclass{article}");
      const tabs = [
        { id: "claude-tab", runtime: "claude", isStreaming: true },
        { id: "codex-tab", runtime: "codex", isStreaming: true },
        { id: "idle-tab", runtime: "codex", isStreaming: false },
      ];
      cancelExecution.mockImplementation(async (tabId: string) => {
        const tab = tabs.find((candidate) => candidate.id === tabId);
        if (tab) tab.isStreaming = false;
        return "stopped";
      });
      getChatState.mockImplementation(() => ({
        newSession: vi.fn(),
        cancelExecution,
        tabs,
      }));
      useDocumentStore.setState({
        projectRoot: "/work/old",
        files: [makeFile({ absolutePath: "/work/old/main.tex" })],
      });

      await useDocumentStore.getState().renameProject("renamed");

      expect(cancelExecution).toHaveBeenCalledWith("claude-tab");
      expect(cancelExecution).toHaveBeenCalledWith("codex-tab");
      expect(cancelExecution).not.toHaveBeenCalledWith("idle-tab");
    });

    it("waits for an accepted Claude stop marker to receive terminal completion", async () => {
      vi.mocked(invoke).mockResolvedValue(undefined as never);
      vi.mocked(readDir).mockResolvedValue([
        { name: "main.tex", isDirectory: false },
      ] as any);
      vi.mocked(readTextFile).mockResolvedValue("\\documentclass{article}");
      const tab = {
        id: "claude-tab",
        runtime: "claude",
        isStreaming: true,
        cancelledAttempts: [] as Array<{ mode: string }>,
      };
      cancelExecution.mockImplementation(async () => {
        tab.isStreaming = false;
        tab.cancelledAttempts = [{ mode: "terminate" }];
        return "stopped";
      });
      getChatState.mockImplementation(() => ({
        newSession: vi.fn(),
        cancelExecution,
        tabs: [tab],
      }));
      useDocumentStore.setState({
        projectRoot: "/work/old",
        files: [makeFile({ absolutePath: "/work/old/main.tex" })],
      });

      const renaming = useDocumentStore.getState().renameProject("renamed");
      await vi.waitFor(() => expect(cancelExecution).toHaveBeenCalled());
      expect(rename).not.toHaveBeenCalled();

      tab.cancelledAttempts = [];
      await renaming;
      expect(rename).toHaveBeenCalledWith("/work/old", "/work/renamed");
    });

    it("aborts rename when cancellation cannot confirm whether the run stopped", async () => {
      const tab = { id: "claude-tab", runtime: "claude", isStreaming: true };
      cancelExecution.mockResolvedValue("uncertain");
      getChatState.mockReturnValue({
        newSession: vi.fn(),
        cancelExecution,
        tabs: [tab],
      });
      useDocumentStore.setState({
        projectRoot: "/work/old",
        files: [makeFile({ absolutePath: "/work/old/main.tex" })],
      });

      await expect(
        useDocumentStore.getState().renameProject("renamed"),
      ).rejects.toThrow(/stop|cancel/i);
      expect(rename).not.toHaveBeenCalled();
      expect(useDocumentStore.getState().isProjectMutating).toBe(false);
    });

    it("holds a project mutation guard until rename and reopen finish", async () => {
      const save = (() => {
        let resolve!: () => void;
        const promise = new Promise<void>((done) => {
          resolve = done;
        });
        return { promise, resolve };
      })();
      const saveAllFiles = vi.fn(() => save.promise);
      vi.mocked(invoke).mockResolvedValue(undefined as never);
      vi.mocked(readDir).mockResolvedValue([
        { name: "main.tex", isDirectory: false },
      ] as any);
      vi.mocked(readTextFile).mockResolvedValue("\\documentclass{article}");
      useDocumentStore.setState({
        projectRoot: "/work/old",
        files: [makeFile({ absolutePath: "/work/old/main.tex" })],
        saveAllFiles,
      });

      const renaming = useDocumentStore.getState().renameProject("renamed");
      await vi.waitFor(() => expect(saveAllFiles).toHaveBeenCalled());
      expect(useDocumentStore.getState().isProjectMutating).toBe(true);
      expect(rename).not.toHaveBeenCalled();

      save.resolve();
      await renaming;
      expect(useDocumentStore.getState().isProjectMutating).toBe(false);
    });

    it("blocks content and tree writes while a deferred project rename owns the mutation guard", async () => {
      const diskRename = deferred<void>();
      vi.mocked(rename).mockReturnValue(diskRename.promise);
      vi.mocked(invoke).mockResolvedValue(undefined as never);
      vi.mocked(readDir).mockResolvedValue([
        { name: "main.tex", isDirectory: false },
      ] as any);
      vi.mocked(readTextFile).mockResolvedValue("original");
      useDocumentStore.setState({
        projectRoot: "/work/old",
        files: [
          makeFile({
            absolutePath: "/work/old/main.tex",
            content: "original",
          }),
        ],
      });

      const renaming = useDocumentStore.getState().renameProject("renamed");
      await vi.waitFor(() =>
        expect(rename).toHaveBeenCalledWith("/work/old", "/work/renamed"),
      );

      useDocumentStore
        .getState()
        .updateFileContent("main.tex", "must be rejected");
      await useDocumentStore
        .getState()
        .createNewFile("must-not-exist.tex", "tex");

      expect(useDocumentStore.getState().files).toHaveLength(1);
      expect(useDocumentStore.getState().files[0]).toMatchObject({
        content: "original",
        isDirty: false,
      });
      expect(writeTextFile).not.toHaveBeenCalled();

      diskRename.resolve();
      await renaming;
      expect(useDocumentStore.getState().isProjectMutating).toBe(false);
    });

    it("waits for a file creation that started before the rename barrier", async () => {
      const write = deferred<void>();
      vi.mocked(writeTextFile).mockReturnValue(write.promise);
      vi.mocked(invoke).mockResolvedValue(undefined as never);
      vi.mocked(readDir).mockResolvedValue([
        { name: "main.tex", isDirectory: false },
      ] as any);
      vi.mocked(readTextFile).mockResolvedValue("saved");
      useDocumentStore.setState({
        projectRoot: "/work/old",
        files: [makeFile({ absolutePath: "/work/old/main.tex" })],
      });

      const creating = useDocumentStore
        .getState()
        .createNewFile("created.tex", "tex");
      await vi.waitFor(() => expect(writeTextFile).toHaveBeenCalled());
      const renaming = useDocumentStore.getState().renameProject("renamed");
      await Promise.resolve();
      expect(rename).not.toHaveBeenCalled();

      write.resolve();
      await Promise.all([creating, renaming]);
      expect(rename).toHaveBeenCalledWith("/work/old", "/work/renamed");
    });

    it("waits for a file deletion that started before the rename barrier", async () => {
      const removal = deferred<void>();
      vi.mocked(remove).mockReturnValue(removal.promise);
      vi.mocked(invoke).mockResolvedValue(undefined as never);
      vi.mocked(readDir).mockResolvedValue([
        { name: "main.tex", isDirectory: false },
      ] as any);
      vi.mocked(readTextFile).mockResolvedValue("saved");
      useDocumentStore.setState({
        projectRoot: "/work/old",
        files: [
          makeFile({ absolutePath: "/work/old/main.tex" }),
          makeFile({
            id: "second.tex",
            name: "second.tex",
            relativePath: "second.tex",
            absolutePath: "/work/old/second.tex",
          }),
        ],
      });

      const deleting = useDocumentStore.getState().deleteFile("second.tex");
      await vi.waitFor(() => expect(remove).toHaveBeenCalled());
      const renaming = useDocumentStore.getState().renameProject("renamed");
      await Promise.resolve();
      expect(rename).not.toHaveBeenCalled();

      removal.resolve();
      await Promise.all([deleting, renaming]);
      expect(rename).toHaveBeenCalledWith("/work/old", "/work/renamed");
    });

    it("renames the project folder and reopens the new path", async () => {
      vi.mocked(invoke).mockResolvedValue(undefined as never);
      vi.mocked(readDir).mockResolvedValue([
        { name: "main.tex", isDirectory: false },
      ] as any);
      vi.mocked(readTextFile).mockResolvedValue("\\documentclass{article}");
      useProjectStore.setState({
        recentProjects: [{ path: "/work/old", name: "old", lastOpened: 1 }],
        lastProjectFolder: "/work",
      });
      useDocumentStore.setState({
        projectRoot: "/work/old",
        files: [makeFile({ absolutePath: "/work/old/main.tex" })],
      });

      await useDocumentStore.getState().renameProject("renamed");

      expect(rename).toHaveBeenCalledWith("/work/old", "/work/renamed");
      expect(invoke).toHaveBeenCalledWith("migrate_project_sessions", {
        oldProjectPath: "/work/old",
        newProjectPath: "/work/renamed",
      });
      expect(invoke).toHaveBeenCalledWith("allow_project_directory", {
        rootPath: "/work/renamed",
      });
      expect(useDocumentStore.getState().projectRoot).toBe("/work/renamed");
      expect(useProjectStore.getState().recentProjects[0]).toMatchObject({
        path: "/work/renamed",
        name: "renamed",
      });
      expect(
        useProjectStore
          .getState()
          .recentProjects.some((project) => project.path === "/work/old"),
      ).toBe(false);
      expect(useProjectStore.getState().lastProjectFolder).toBe("/work");
    });

    it("saves dirty files before renaming the project folder", async () => {
      vi.mocked(invoke).mockResolvedValue(undefined as never);
      vi.mocked(writeTextFile).mockResolvedValue(undefined);
      vi.mocked(readDir).mockResolvedValue([
        { name: "main.tex", isDirectory: false },
      ] as any);
      vi.mocked(readTextFile).mockResolvedValue("\\documentclass{article}");
      useDocumentStore.setState({
        projectRoot: "/work/old",
        files: [
          makeFile({
            absolutePath: "/work/old/main.tex",
            content: "dirty",
            isDirty: true,
          }),
        ],
      });

      await useDocumentStore.getState().renameProject("renamed");

      expect(writeTextFile).toHaveBeenCalledWith("/work/old/main.tex", "dirty");
      expect(rename).toHaveBeenCalledWith("/work/old", "/work/renamed");
    });

    it("closes the stale old-root document if reopening fails after the disk rename", async () => {
      vi.mocked(rename).mockResolvedValue(undefined);
      vi.mocked(invoke).mockImplementation((command) => {
        if (command === "allow_project_directory") {
          return Promise.reject(new Error("reopen failed")) as never;
        }
        return Promise.resolve(undefined) as never;
      });
      useDocumentStore.setState({
        projectRoot: "/work/old",
        files: [
          makeFile({
            absolutePath: "/work/old/main.tex",
            content: "saved",
          }),
        ],
      });

      await expect(
        useDocumentStore.getState().renameProject("renamed"),
      ).rejects.toThrow("reopen failed");

      expect(rename).toHaveBeenCalledWith("/work/old", "/work/renamed");
      expect(useDocumentStore.getState()).toMatchObject({
        projectRoot: null,
        files: [],
        folders: [],
        activeFileId: "",
        initialized: false,
        isProjectMutating: false,
      });
    });
  });

  describe("project lifecycle guards", () => {
    it("keeps the project mounted while a runtime is streaming or stopping", () => {
      anyStreaming.mockReturnValue(true);

      const closed = useDocumentStore.getState().closeProject();

      expect(closed).toBe(false);
      expect(useDocumentStore.getState().projectRoot).toBe("/project");
      expect(resetChatForProject).not.toHaveBeenCalled();
    });

    it("blocks switching projects while a runtime is streaming or stopping", async () => {
      anyStreaming.mockReturnValue(true);

      await expect(
        useDocumentStore.getState().openProject("/other-project"),
      ).rejects.toThrow(/stop|runtime/i);
      expect(invoke).not.toHaveBeenCalledWith("allow_project_directory", {
        rootPath: "/other-project",
      });
      expect(useDocumentStore.getState().projectRoot).toBe("/project");
    });

    it("waits for an older project write before reopening the same root", async () => {
      const write = deferred<void>();
      vi.mocked(writeTextFile).mockReturnValue(write.promise);
      vi.mocked(invoke).mockResolvedValue(undefined as never);
      vi.mocked(readDir).mockResolvedValue([
        { name: "main.tex", isDirectory: false },
      ] as any);
      vi.mocked(readTextFile).mockResolvedValue("version A");
      useDocumentStore.setState({
        files: [makeFile({ content: "version A", isDirty: true })],
      });

      const saving = useDocumentStore.getState().saveFile("main.tex");
      await vi.waitFor(() => expect(writeTextFile).toHaveBeenCalledTimes(1));
      const closing = useDocumentStore.getState().closeProject();
      await Promise.resolve();
      expect(closing).toBeInstanceOf(Promise);
      await expect(
        useDocumentStore.getState().openProject("/project"),
      ).rejects.toThrow(/progress|change/i);

      write.resolve();
      await Promise.all([saving, closing]);
      await useDocumentStore.getState().openProject("/project");
      expect(useDocumentStore.getState().files[0]).toMatchObject({
        content: "version A",
        isDirty: false,
      });
    });

    it.each([
      ["POSIX", "/", "/", "/main.tex"],
      ["Windows drive", "C:\\", "c:/", "C:/main.tex"],
      [
        "UNC share",
        "\\\\Server\\Share",
        "//server/share",
        "//Server/Share/main.tex",
      ],
    ])("drains a pending write when reopening the %s root", async (_label, projectRoot, reopenedRoot, absolutePath) => {
      const write = deferred<void>();
      vi.mocked(writeTextFile).mockReturnValue(write.promise);
      vi.mocked(invoke).mockResolvedValue(undefined as never);
      vi.mocked(readDir).mockResolvedValue([
        { name: "main.tex", isDirectory: false },
      ] as any);
      vi.mocked(readTextFile).mockResolvedValue("version A");
      useDocumentStore.setState({
        projectRoot,
        files: [
          makeFile({ absolutePath, content: "version A", isDirty: true }),
        ],
      });

      const saving = useDocumentStore.getState().saveFile("main.tex");
      await vi.waitFor(() => expect(writeTextFile).toHaveBeenCalledTimes(1));
      const closing = useDocumentStore.getState().closeProject();
      await Promise.resolve();
      expect(closing).toBeInstanceOf(Promise);
      const openedBeforeWriteFinished = vi
        .mocked(invoke)
        .mock.calls.some(
          ([command, args]) =>
            command === "allow_project_directory" &&
            (args as { rootPath?: string })?.rootPath === reopenedRoot,
        );

      write.resolve();
      await Promise.all([saving, closing]);
      await useDocumentStore.getState().openProject(reopenedRoot);
      expect(openedBeforeWriteFinished).toBe(false);
    });

    it("does not run content, tree, refresh, or reload mutations while the project barrier is active", async () => {
      const original = makeFile();
      useDocumentStore.setState({
        isProjectMutating: true,
        files: [original, makeFile({ id: "second.tex", name: "second.tex" })],
        folders: ["chapter"],
      });

      const state = useDocumentStore.getState();
      state.updateFileContent("main.tex", "changed");
      state.updateImageDataUrl("main.tex", "data:image/png;base64,changed");
      state.insertAtCursor("!");
      state.replaceSelection(0, 1, "X");
      expect(state.findAndReplace("Hello", "Changed")).toBe(false);
      state.setContent("changed");
      state.setFileName("changed.tex");
      state.addFile({
        name: "added.tex",
        relativePath: "added.tex",
        absolutePath: "/project/added.tex",
        type: "tex",
        content: "added",
      });
      await state.deleteFile("second.tex");
      await state.deleteFolder("chapter");
      await state.renameFile("main.tex", "renamed.tex");
      await state.createNewFile("created.tex", "tex");
      await state.createFolder("created-folder");
      await state.importFiles(["/outside/imported.tex"]);
      await state.moveFile("main.tex", "chapter");
      await state.moveFolder("chapter", null);
      await state.reloadFile("main.tex");
      await state.refreshFiles();

      expect(useDocumentStore.getState().files).toEqual([
        original,
        makeFile({ id: "second.tex", name: "second.tex" }),
      ]);
      expect(useDocumentStore.getState().folders).toEqual(["chapter"]);
      expect(remove).not.toHaveBeenCalled();
      expect(rename).not.toHaveBeenCalled();
      expect(mkdir).not.toHaveBeenCalled();
      expect(writeTextFile).not.toHaveBeenCalled();
      expect(readDir).not.toHaveBeenCalled();
      expect(readTextFile).not.toHaveBeenCalled();
    });

    it("keeps a file in state when deleting it from disk fails", async () => {
      vi.mocked(remove).mockRejectedValueOnce(new Error("delete failed"));
      useDocumentStore.setState({
        files: [
          makeFile(),
          makeFile({
            id: "second.tex",
            name: "second.tex",
            relativePath: "second.tex",
            absolutePath: "/project/second.tex",
          }),
        ],
      });

      await useDocumentStore.getState().deleteFile("second.tex");

      expect(useDocumentStore.getState().files.map((file) => file.id)).toEqual([
        "main.tex",
        "second.tex",
      ]);
    });

    it("keeps a folder in state when deleting it from disk fails", async () => {
      vi.mocked(remove).mockRejectedValueOnce(new Error("delete failed"));
      useDocumentStore.setState({
        files: [
          makeFile(),
          makeFile({
            id: "chapter/part.tex",
            name: "part.tex",
            relativePath: "chapter/part.tex",
            absolutePath: "/project/chapter/part.tex",
          }),
        ],
        folders: ["chapter"],
      });

      await useDocumentStore.getState().deleteFolder("chapter");

      expect(useDocumentStore.getState().folders).toEqual(["chapter"]);
      expect(
        useDocumentStore.getState().files.map((file) => file.relativePath),
      ).toContain("chapter/part.tex");
    });

    it("blocks reopening the same project while a runtime is streaming or stopping", async () => {
      anyStreaming.mockReturnValue(true);

      await expect(
        useDocumentStore.getState().openProject("/project"),
      ).rejects.toThrow(/stop|runtime/i);
      expect(invoke).not.toHaveBeenCalledWith("allow_project_directory", {
        rootPath: "/project",
      });
      expect(useDocumentStore.getState().projectRoot).toBe("/project");
    });

    it("resets chat scope only after a safe close", () => {
      anyStreaming.mockReturnValue(false);

      const closed = useDocumentStore.getState().closeProject();

      expect(closed).toBe(true);
      expect(resetChatForProject).toHaveBeenCalledWith(null);
      expect(useDocumentStore.getState().projectRoot).toBeNull();
    });

    it("holds the close barrier until an older project write drains", async () => {
      const write = deferred<void>();
      vi.mocked(writeTextFile).mockReturnValue(write.promise);
      useDocumentStore.setState({
        files: [makeFile({ content: "version A", isDirty: true })],
      });

      const saving = useDocumentStore.getState().saveFile("main.tex");
      await vi.waitFor(() => expect(writeTextFile).toHaveBeenCalledTimes(1));
      const closing = useDocumentStore.getState().closeProject();

      try {
        expect(useDocumentStore.getState()).toMatchObject({
          projectRoot: "/project",
          isProjectMutating: true,
        });
        await expect(
          useDocumentStore.getState().openProject("/project-b"),
        ).rejects.toThrow(/progress|change/i);
      } finally {
        write.resolve();
        await saving;
        await closing;
      }
      expect(useDocumentStore.getState()).toMatchObject({
        projectRoot: null,
        isProjectMutating: false,
      });
    });
  });

  describe("project structure mutation ordering", () => {
    async function expectStructureOperationToDrainPendingSave({
      files,
      folders = [],
      run,
      diskMutation,
    }: {
      files: ProjectFile[];
      folders?: string[];
      run: () => Promise<void>;
      diskMutation: ReturnType<typeof vi.fn>;
    }) {
      const write = deferred<void>();
      vi.mocked(writeTextFile).mockReturnValue(write.promise);
      vi.mocked(rename).mockResolvedValue(undefined);
      vi.mocked(remove).mockResolvedValue(undefined);
      vi.mocked(exists).mockResolvedValue(false);
      vi.mocked(readDir).mockResolvedValue([]);
      useDocumentStore.setState({ files, folders, activeFileId: files[0].id });

      const saving = useDocumentStore.getState().saveFile(files[0].id);
      await vi.waitFor(() => expect(writeTextFile).toHaveBeenCalledTimes(1));
      const mutating = run();

      try {
        expect(useDocumentStore.getState().isProjectMutating).toBe(true);
        expect(diskMutation).not.toHaveBeenCalled();
      } finally {
        write.resolve();
        await Promise.all([saving, mutating]);
      }
      expect(diskMutation).toHaveBeenCalledTimes(1);
      expect(useDocumentStore.getState().isProjectMutating).toBe(false);
    }

    it("drains an older save before renaming its file", async () => {
      await expectStructureOperationToDrainPendingSave({
        files: [makeFile({ content: "saved first", isDirty: true })],
        run: () =>
          useDocumentStore.getState().renameFile("main.tex", "renamed.tex"),
        diskMutation: vi.mocked(rename),
      });
      expect(useDocumentStore.getState().files[0].id).toBe("renamed.tex");
    });

    it("drains an older save before moving its file", async () => {
      await expectStructureOperationToDrainPendingSave({
        files: [makeFile({ content: "saved first", isDirty: true })],
        folders: ["chapter"],
        run: () => useDocumentStore.getState().moveFile("main.tex", "chapter"),
        diskMutation: vi.mocked(rename),
      });
      expect(useDocumentStore.getState().files[0].id).toBe("chapter/main.tex");
    });

    it("drains an older save before deleting its file", async () => {
      await expectStructureOperationToDrainPendingSave({
        files: [
          makeFile({ content: "saved first", isDirty: true }),
          makeFile({
            id: "keep.tex",
            name: "keep.tex",
            relativePath: "keep.tex",
            absolutePath: "/project/keep.tex",
          }),
        ],
        run: () => useDocumentStore.getState().deleteFile("main.tex"),
        diskMutation: vi.mocked(remove),
      });
      expect(useDocumentStore.getState().files.map((file) => file.id)).toEqual([
        "keep.tex",
      ]);
    });

    it("drains an older descendant save before deleting its folder", async () => {
      await expectStructureOperationToDrainPendingSave({
        files: [
          makeFile({
            id: "chapter/main.tex",
            relativePath: "chapter/main.tex",
            absolutePath: "/project/chapter/main.tex",
            content: "saved first",
            isDirty: true,
          }),
          makeFile({
            id: "keep.tex",
            name: "keep.tex",
            relativePath: "keep.tex",
            absolutePath: "/project/keep.tex",
          }),
        ],
        folders: ["chapter"],
        run: () => useDocumentStore.getState().deleteFolder("chapter"),
        diskMutation: vi.mocked(remove),
      });
      expect(useDocumentStore.getState().folders).not.toContain("chapter");
    });

    it("drains an older descendant save before moving its folder", async () => {
      await expectStructureOperationToDrainPendingSave({
        files: [
          makeFile({
            id: "chapter/main.tex",
            relativePath: "chapter/main.tex",
            absolutePath: "/project/chapter/main.tex",
            content: "saved first",
            isDirty: true,
          }),
          makeFile({
            id: "keep.tex",
            name: "keep.tex",
            relativePath: "keep.tex",
            absolutePath: "/project/keep.tex",
          }),
        ],
        folders: ["chapter", "dest"],
        run: () => useDocumentStore.getState().moveFolder("chapter", "dest"),
        diskMutation: vi.mocked(rename),
      });
      expect(
        useDocumentStore
          .getState()
          .files.some((file) => file.id === "dest/chapter/main.tex"),
      ).toBe(true);
    });

    it("retries autosave after its owned structure mutation releases", async () => {
      vi.useFakeTimers();
      const diskRename = deferred<void>();
      vi.mocked(rename).mockReturnValue(diskRename.promise);
      vi.mocked(writeTextFile).mockResolvedValue(undefined);

      useDocumentStore.getState().updateFileContent("main.tex", "edited");
      const renaming = useDocumentStore
        .getState()
        .renameFile("main.tex", "renamed.tex");
      await vi.waitFor(() => expect(rename).toHaveBeenCalledTimes(1));

      await vi.advanceTimersByTimeAsync(2_000);
      expect(writeTextFile).not.toHaveBeenCalled();

      diskRename.resolve();
      await renaming;
      await vi.advanceTimersByTimeAsync(1_999);
      expect(writeTextFile).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(writeTextFile).toHaveBeenCalledTimes(1);
      expect(writeTextFile).toHaveBeenCalledWith(
        "/project/renamed.tex",
        "edited",
      );
      await vi.advanceTimersByTimeAsync(10_000);
      expect(writeTextFile).toHaveBeenCalledTimes(1);
    });

    it("does not let a released autosave retry write after project ownership changes", async () => {
      vi.useFakeTimers();
      const diskRename = deferred<void>();
      vi.mocked(rename).mockReturnValue(diskRename.promise);
      vi.mocked(writeTextFile).mockResolvedValue(undefined);

      useDocumentStore.getState().updateFileContent("main.tex", "project A");
      const renaming = useDocumentStore
        .getState()
        .renameFile("main.tex", "renamed.tex");
      await vi.waitFor(() => expect(rename).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(2_000);

      diskRename.resolve();
      await renaming;
      expect(vi.getTimerCount()).toBe(1);

      useDocumentStore.setState({
        projectRoot: "/project-b",
        projectGeneration: useDocumentStore.getState().projectGeneration + 1,
        files: [
          makeFile({
            absolutePath: "/project-b/main.tex",
            content: "project B",
            isDirty: true,
          }),
        ],
      });
      await vi.advanceTimersByTimeAsync(2_000);

      expect(writeTextFile).not.toHaveBeenCalled();
    });

    it("rejects a second structure mutation while the first owns the barrier", async () => {
      const diskRename = deferred<void>();
      vi.mocked(rename).mockReturnValue(diskRename.promise);
      vi.mocked(remove).mockResolvedValue(undefined);
      useDocumentStore.setState({
        files: [
          makeFile(),
          makeFile({
            id: "second.tex",
            name: "second.tex",
            relativePath: "second.tex",
            absolutePath: "/project/second.tex",
          }),
        ],
      });

      const first = useDocumentStore
        .getState()
        .renameFile("main.tex", "renamed.tex");
      await vi.waitFor(() => expect(rename).toHaveBeenCalledTimes(1));
      const second = useDocumentStore.getState().deleteFile("second.tex");

      try {
        expect(remove).not.toHaveBeenCalled();
      } finally {
        diskRename.resolve();
        await Promise.all([first, second]);
      }
      expect(
        useDocumentStore.getState().files.map((file) => file.id),
      ).toContain("second.tex");
      expect(useDocumentStore.getState().isProjectMutating).toBe(false);
    });
  });

  describe("project async ownership", () => {
    it("ignores an old refresh after the project is closed and another project opens", async () => {
      const oldScan = deferred<any[]>();
      vi.mocked(invoke).mockResolvedValue(undefined as never);
      vi.mocked(readDir).mockImplementation((path: string | URL) => {
        const directory = String(path);
        if (directory === "/project") return oldScan.promise as any;
        if (directory === "/other-project") {
          return Promise.resolve([
            { name: "other.tex", isDirectory: false },
          ]) as any;
        }
        throw new Error(`Unexpected readDir path: ${directory}`);
      });
      vi.mocked(readTextFile).mockImplementation(async (path: string | URL) =>
        String(path).includes("other.tex") ? "new project" : "old project",
      );

      const staleRefresh = useDocumentStore.getState().refreshFiles();
      await vi.waitFor(() => expect(readDir).toHaveBeenCalledWith("/project"));

      expect(useDocumentStore.getState().closeProject()).toBe(true);
      await useDocumentStore.getState().openProject("/other-project");

      oldScan.resolve([{ name: "stale.tex", isDirectory: false }]);
      await staleRefresh;

      expect(useDocumentStore.getState().projectRoot).toBe("/other-project");
      expect(
        useDocumentStore.getState().files.map((file) => file.relativePath),
      ).toEqual(["other.tex"]);
    });

    it("ignores an old refresh after the same project is closed and reopened", async () => {
      const oldScan = deferred<any[]>();
      let projectScanCount = 0;
      vi.mocked(invoke).mockResolvedValue(undefined as never);
      vi.mocked(readDir).mockImplementation((path: string | URL) => {
        const directory = String(path);
        if (directory !== "/project") {
          throw new Error(`Unexpected readDir path: ${directory}`);
        }
        projectScanCount += 1;
        if (projectScanCount === 1) return oldScan.promise as any;
        return Promise.resolve([
          { name: "reopened.tex", isDirectory: false },
        ]) as any;
      });
      vi.mocked(readTextFile).mockImplementation(async (path: string | URL) =>
        String(path).includes("reopened.tex") ? "reopened" : "stale",
      );

      const staleRefresh = useDocumentStore.getState().refreshFiles();
      await vi.waitFor(() => expect(readDir).toHaveBeenCalledTimes(1));

      expect(useDocumentStore.getState().closeProject()).toBe(true);
      await useDocumentStore.getState().openProject("/project");

      oldScan.resolve([{ name: "stale.tex", isDirectory: false }]);
      await staleRefresh;

      expect(
        useDocumentStore.getState().files.map((file) => file.relativePath),
      ).toEqual(["reopened.tex"]);
    });

    it("lets the latest concurrent refresh own the final file snapshot", async () => {
      const firstScan = deferred<any[]>();
      const secondScan = deferred<any[]>();
      let scanCount = 0;
      vi.mocked(readDir).mockImplementation((path: string | URL) => {
        expect(String(path)).toBe("/project");
        scanCount += 1;
        return (
          scanCount === 1 ? firstScan.promise : secondScan.promise
        ) as any;
      });
      vi.mocked(readTextFile).mockImplementation(async (path: string | URL) =>
        String(path).includes("latest.tex") ? "latest" : "stale",
      );

      const staleRefresh = useDocumentStore.getState().refreshFiles();
      const latestRefresh = useDocumentStore.getState().refreshFiles();
      await vi.waitFor(() => expect(readDir).toHaveBeenCalledTimes(2));

      secondScan.resolve([{ name: "latest.tex", isDirectory: false }]);
      await latestRefresh;
      firstScan.resolve([{ name: "stale.tex", isDirectory: false }]);
      await staleRefresh;

      expect(
        useDocumentStore.getState().files.map((file) => file.relativePath),
      ).toEqual(["latest.tex"]);
      expect(useDocumentStore.getState().files[0]?.content).toBe("latest");
    });

    it("does not bump contentGeneration when refresh only adds a non-tex file", async () => {
      useDocumentStore.setState({
        contentGeneration: 4,
        fileTreeGeneration: 1,
      });
      vi.mocked(readDir).mockResolvedValue([
        { name: "main.tex", isDirectory: false },
        { name: "shot.png", isDirectory: false },
      ] as any);
      vi.mocked(readTextFile).mockResolvedValue("Hello World");
      vi.mocked(stat).mockResolvedValue({ size: 16 } as any);
      vi.mocked(readFile).mockResolvedValue(
        new Uint8Array([1, 2, 3, 4]) as any,
      );

      await useDocumentStore.getState().refreshFiles();

      expect(useDocumentStore.getState().contentGeneration).toBe(4);
      expect(useDocumentStore.getState().fileTreeGeneration).toBe(2);
      expect(
        useDocumentStore.getState().files.map((file) => file.relativePath),
      ).toEqual(["main.tex", "shot.png"]);
    });

    it("bumps contentGeneration when refresh sees tex content change", async () => {
      useDocumentStore.setState({ contentGeneration: 4 });
      vi.mocked(readDir).mockResolvedValue([
        { name: "main.tex", isDirectory: false },
      ] as any);
      vi.mocked(readTextFile).mockResolvedValue("Changed tex");

      await useDocumentStore.getState().refreshFiles();

      expect(useDocumentStore.getState().contentGeneration).toBe(5);
      expect(useDocumentStore.getState().files[0]?.content).toBe("Changed tex");
    });

    it("does not overwrite an unsaved edit made while a refresh is reading disk", async () => {
      const diskRead = deferred<string>();
      vi.mocked(readDir).mockResolvedValue([
        { name: "main.tex", isDirectory: false },
      ] as any);
      vi.mocked(readTextFile).mockReturnValue(diskRead.promise);

      const refresh = useDocumentStore.getState().refreshFiles();
      await vi.waitFor(() =>
        expect(readTextFile).toHaveBeenCalledWith("/project/main.tex"),
      );

      useDocumentStore
        .getState()
        .updateFileContent("main.tex", "unsaved local edit");
      diskRead.resolve("stale disk content");
      await refresh;

      expect(useDocumentStore.getState().files[0]).toMatchObject({
        content: "unsaved local edit",
        isDirty: true,
      });
    });

    it("preserves a newer active-file choice made while refresh is reading disk", async () => {
      const mainRead = deferred<string>();
      useDocumentStore.setState({
        files: [
          makeFile(),
          makeFile({
            id: "other.tex",
            name: "other.tex",
            relativePath: "other.tex",
            absolutePath: "/project/other.tex",
            content: "Other",
          }),
        ],
        activeFileId: "main.tex",
      });
      vi.mocked(readDir).mockResolvedValue([
        { name: "main.tex", isDirectory: false },
        { name: "other.tex", isDirectory: false },
      ] as any);
      vi.mocked(readTextFile).mockImplementation((path: string | URL) =>
        String(path).endsWith("main.tex")
          ? mainRead.promise
          : Promise.resolve("Other from disk"),
      );

      const refresh = useDocumentStore.getState().refreshFiles();
      await vi.waitFor(() =>
        expect(readTextFile).toHaveBeenCalledWith("/project/main.tex"),
      );
      useDocumentStore.getState().setActiveFile("other.tex");
      mainRead.resolve("Main from disk");
      await refresh;

      expect(useDocumentStore.getState().activeFileId).toBe("other.tex");
    });

    it("preserves a folder created while refresh is reading disk", async () => {
      const diskRead = deferred<string>();
      vi.mocked(readDir).mockResolvedValue([
        { name: "main.tex", isDirectory: false },
      ] as any);
      vi.mocked(readTextFile).mockReturnValue(diskRead.promise);
      vi.mocked(exists).mockResolvedValue(false);
      vi.mocked(mkdir).mockResolvedValue(undefined);

      const refresh = useDocumentStore.getState().refreshFiles();
      await vi.waitFor(() => expect(readTextFile).toHaveBeenCalled());
      await useDocumentStore.getState().createFolder("new-folder");
      diskRead.resolve("disk content");
      await refresh;

      expect(useDocumentStore.getState().folders).toContain("new-folder");
    });

    it("does not open project B before a deferred delete from project A settles", async () => {
      const removal = deferred<void>();
      useDocumentStore.setState({
        files: [
          makeFile(),
          makeFile({
            id: "keep.tex",
            name: "keep.tex",
            relativePath: "keep.tex",
            absolutePath: "/project/keep.tex",
          }),
        ],
      });
      vi.mocked(remove).mockReturnValue(removal.promise);
      vi.mocked(invoke).mockResolvedValue(undefined as never);
      vi.mocked(readDir).mockResolvedValue([
        { name: "project-b.tex", isDirectory: false },
      ] as any);
      vi.mocked(readTextFile).mockResolvedValue("project b");

      const deleting = useDocumentStore.getState().deleteFile("main.tex");
      await vi.waitFor(() => expect(remove).toHaveBeenCalled());
      expect(useDocumentStore.getState().closeProject()).toBe(false);
      await expect(
        useDocumentStore.getState().openProject("/project-b"),
      ).rejects.toThrow(/progress|change/i);

      removal.resolve();
      await deleting;
      expect(useDocumentStore.getState().closeProject()).toBe(true);
      await useDocumentStore.getState().openProject("/project-b");

      expect(useDocumentStore.getState().projectRoot).toBe("/project-b");
      expect(
        useDocumentStore.getState().files.map((file) => file.relativePath),
      ).toEqual(["project-b.tex"]);
    });

    it("does not open project B before a deferred create from project A settles", async () => {
      const write = deferred<void>();
      vi.mocked(exists).mockResolvedValue(true);
      vi.mocked(writeTextFile).mockReturnValue(write.promise);
      vi.mocked(invoke).mockResolvedValue(undefined as never);
      vi.mocked(readDir).mockResolvedValue([
        { name: "project-b.tex", isDirectory: false },
      ] as any);
      vi.mocked(readTextFile).mockResolvedValue("project b");

      const creating = useDocumentStore
        .getState()
        .createNewFile("created.tex", "tex");
      await vi.waitFor(() => expect(writeTextFile).toHaveBeenCalled());
      const closing = useDocumentStore.getState().closeProject();
      expect(closing).toBeInstanceOf(Promise);
      await expect(
        useDocumentStore.getState().openProject("/project-b"),
      ).rejects.toThrow(/progress|change/i);

      write.resolve();
      await Promise.all([creating, closing]);
      await useDocumentStore.getState().openProject("/project-b");

      expect(useDocumentStore.getState().projectRoot).toBe("/project-b");
      expect(
        useDocumentStore.getState().files.map((file) => file.relativePath),
      ).toEqual(["project-b.tex"]);
    });

    it("does not open project B before a deferred rename from project A settles", async () => {
      const renamingOnDisk = deferred<void>();
      vi.mocked(rename).mockReturnValue(renamingOnDisk.promise);
      vi.mocked(invoke).mockResolvedValue(undefined as never);
      vi.mocked(readDir).mockResolvedValue([
        { name: "project-b.tex", isDirectory: false },
      ] as any);
      vi.mocked(readTextFile).mockResolvedValue("project b");

      const renamingFile = useDocumentStore
        .getState()
        .renameFile("main.tex", "renamed.tex");
      await vi.waitFor(() => expect(rename).toHaveBeenCalled());
      expect(useDocumentStore.getState().closeProject()).toBe(false);
      await expect(
        useDocumentStore.getState().openProject("/project-b"),
      ).rejects.toThrow(/progress|change/i);

      renamingOnDisk.resolve();
      await renamingFile;
      expect(useDocumentStore.getState().closeProject()).toBe(true);
      await useDocumentStore.getState().openProject("/project-b");

      expect(useDocumentStore.getState().projectRoot).toBe("/project-b");
      expect(
        useDocumentStore.getState().files.map((file) => file.relativePath),
      ).toEqual(["project-b.tex"]);
    });

    it("does not open project B before a deferred move from project A settles", async () => {
      const movingOnDisk = deferred<void>();
      vi.mocked(exists).mockResolvedValue(false);
      vi.mocked(rename).mockReturnValue(movingOnDisk.promise);
      vi.mocked(invoke).mockResolvedValue(undefined as never);
      vi.mocked(readDir).mockResolvedValue([
        { name: "project-b.tex", isDirectory: false },
      ] as any);
      vi.mocked(readTextFile).mockResolvedValue("project b");

      const movingFile = useDocumentStore
        .getState()
        .moveFile("main.tex", "chapter");
      await vi.waitFor(() => expect(rename).toHaveBeenCalled());
      expect(useDocumentStore.getState().closeProject()).toBe(false);
      await expect(
        useDocumentStore.getState().openProject("/project-b"),
      ).rejects.toThrow(/progress|change/i);

      movingOnDisk.resolve();
      await movingFile;
      expect(useDocumentStore.getState().closeProject()).toBe(true);
      await useDocumentStore.getState().openProject("/project-b");

      expect(useDocumentStore.getState().projectRoot).toBe("/project-b");
      expect(
        useDocumentStore.getState().files.map((file) => file.relativePath),
      ).toEqual(["project-b.tex"]);
    });
  });

  describe("content revision ownership", () => {
    it("keeps a newer edit dirty when an older save finishes", async () => {
      const write = deferred<void>();
      useDocumentStore.setState({
        files: [makeFile({ content: "first edit", isDirty: true })],
      });
      vi.mocked(writeTextFile).mockReturnValue(write.promise);

      const saving = useDocumentStore.getState().saveFile("main.tex");
      await vi.waitFor(() => expect(writeTextFile).toHaveBeenCalled());
      useDocumentStore.getState().updateFileContent("main.tex", "newer edit");
      write.resolve();
      await saving;

      expect(useDocumentStore.getState().files[0]).toMatchObject({
        content: "newer edit",
        isDirty: true,
      });
    });

    it("serializes saves for one file so an older write cannot finish last", async () => {
      const firstWrite = deferred<void>();
      const secondWrite = deferred<void>();
      vi.mocked(writeTextFile)
        .mockReturnValueOnce(firstWrite.promise)
        .mockReturnValueOnce(secondWrite.promise);
      useDocumentStore.setState({
        files: [makeFile({ content: "version A", isDirty: true })],
      });

      const savingA = useDocumentStore.getState().saveFile("main.tex");
      await vi.waitFor(() => expect(writeTextFile).toHaveBeenCalledTimes(1));
      useDocumentStore.getState().updateFileContent("main.tex", "version B");
      const savingB = useDocumentStore.getState().saveFile("main.tex");
      await Promise.resolve();

      expect(writeTextFile).toHaveBeenCalledTimes(1);
      firstWrite.resolve();
      await vi.waitFor(() => expect(writeTextFile).toHaveBeenCalledTimes(2));
      expect(writeTextFile).toHaveBeenNthCalledWith(
        2,
        "/project/main.tex",
        "version B",
      );
      secondWrite.resolve();
      await Promise.all([savingA, savingB]);

      expect(useDocumentStore.getState().files[0]).toMatchObject({
        content: "version B",
        isDirty: false,
      });
    });

    it("continues the per-file write queue after an earlier write rejects", async () => {
      vi.mocked(writeTextFile)
        .mockRejectedValueOnce(new Error("disk unavailable"))
        .mockResolvedValueOnce(undefined);
      useDocumentStore.setState({
        files: [makeFile({ content: "version A", isDirty: true })],
      });

      await expect(
        useDocumentStore.getState().saveFile("main.tex"),
      ).rejects.toThrow("disk unavailable");
      useDocumentStore.getState().updateFileContent("main.tex", "version B");
      await useDocumentStore.getState().saveFile("main.tex");

      expect(writeTextFile).toHaveBeenCalledTimes(2);
      expect(writeTextFile).toHaveBeenLastCalledWith(
        "/project/main.tex",
        "version B",
      );
      expect(useDocumentStore.getState().files[0]).toMatchObject({
        content: "version B",
        isDirty: false,
      });
    });

    it("lets only the latest same-project manual save clear the saving indicator", async () => {
      vi.useFakeTimers();
      const firstWrite = deferred<void>();
      const secondWrite = deferred<void>();
      vi.mocked(writeTextFile)
        .mockReturnValueOnce(firstWrite.promise)
        .mockReturnValueOnce(secondWrite.promise);
      useDocumentStore.setState({
        files: [makeFile({ content: "version A", isDirty: true })],
      });

      const firstSave = useDocumentStore.getState().saveCurrentFile();
      try {
        expect(useDocumentStore.getState().isSaving).toBe(true);
      } finally {
        firstWrite.resolve();
        await firstSave;
      }

      useDocumentStore.setState({
        files: [makeFile({ content: "version B", isDirty: true })],
      });
      const secondSave = useDocumentStore.getState().saveCurrentFile();
      await vi.advanceTimersByTimeAsync(500);
      expect(useDocumentStore.getState().isSaving).toBe(true);

      secondWrite.resolve();
      await secondSave;
      await vi.advanceTimersByTimeAsync(499);
      expect(useDocumentStore.getState().isSaving).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(useDocumentStore.getState().isSaving).toBe(false);
    });

    it("does not let project A's delayed save indicator clear project B", async () => {
      vi.useFakeTimers();
      const secondWrite = deferred<void>();
      vi.mocked(writeTextFile)
        .mockResolvedValueOnce(undefined)
        .mockReturnValueOnce(secondWrite.promise);
      useDocumentStore.setState({
        projectRoot: "/project-a",
        projectGeneration: 10,
        files: [
          makeFile({
            absolutePath: "/project-a/main.tex",
            content: "A",
            isDirty: true,
          }),
        ],
      });

      await useDocumentStore.getState().saveCurrentFile();
      useDocumentStore.setState({
        projectRoot: "/project-b",
        projectGeneration: 11,
        files: [
          makeFile({
            absolutePath: "/project-b/main.tex",
            content: "B",
            isDirty: true,
          }),
        ],
      });
      const projectBSave = useDocumentStore.getState().saveCurrentFile();

      await vi.advanceTimersByTimeAsync(500);
      expect(useDocumentStore.getState().isSaving).toBe(true);
      secondWrite.resolve();
      await projectBSave;
      await vi.advanceTimersByTimeAsync(500);
      expect(useDocumentStore.getState().isSaving).toBe(false);
    });

    it("settles a rejected manual save and eventually releases its busy indicator", async () => {
      vi.useFakeTimers();
      vi.mocked(writeTextFile).mockRejectedValueOnce(new Error("disk failed"));
      useDocumentStore.setState({
        files: [makeFile({ content: "unsaved", isDirty: true })],
      });

      await expect(
        useDocumentStore.getState().saveCurrentFile(),
      ).resolves.toBeUndefined();
      expect(useDocumentStore.getState().isSaving).toBe(true);
      await vi.advanceTimersByTimeAsync(500);
      expect(useDocumentStore.getState().isSaving).toBe(false);
      expect(useDocumentStore.getState().files[0].isDirty).toBe(true);
    });

    it.each([
      ["insertAtCursor", () => useDocumentStore.getState().insertAtCursor("!")],
      [
        "replaceSelection",
        () => useDocumentStore.getState().replaceSelection(0, 5, "Hi"),
      ],
      [
        "findAndReplace",
        () => useDocumentStore.getState().findAndReplace("World", "Codex"),
      ],
    ])("bumps contentGeneration for %s", (_name, edit) => {
      useDocumentStore.setState({ contentGeneration: 10 });

      edit();

      expect(useDocumentStore.getState().contentGeneration).toBe(11);
      expect(useDocumentStore.getState().files[0]?.isDirty).toBe(true);
    });

    it("does not let reloadFile overwrite an edit made while reading disk", async () => {
      const diskRead = deferred<string>();
      vi.mocked(readTextFile).mockReturnValue(diskRead.promise);

      const reload = useDocumentStore.getState().reloadFile("main.tex");
      await vi.waitFor(() => expect(readTextFile).toHaveBeenCalled());
      useDocumentStore
        .getState()
        .updateFileContent("main.tex", "newer local edit");
      diskRead.resolve("old disk content");
      await reload;

      expect(useDocumentStore.getState().files[0]).toMatchObject({
        content: "newer local edit",
        isDirty: true,
      });
    });

    it("does not let loadFileContent overwrite content supplied while reading", async () => {
      const diskRead = deferred<string>();
      useDocumentStore.setState({
        files: [makeFile({ content: undefined, type: "other" })],
      });
      vi.mocked(readTextFile).mockReturnValue(diskRead.promise);

      const load = useDocumentStore.getState().loadFileContent("main.tex");
      await vi.waitFor(() => expect(readTextFile).toHaveBeenCalled());
      useDocumentStore
        .getState()
        .updateFileContent("main.tex", "user supplied content");
      diskRead.resolve("old disk content");
      await load;

      expect(useDocumentStore.getState().files[0]).toMatchObject({
        content: "user supplied content",
        isDirty: true,
      });
    });
  });

  describe("insertAtCursor", () => {
    it("inserts text at cursor position", () => {
      useDocumentStore.getState().insertAtCursor(", Beautiful");
      const state = useDocumentStore.getState();
      const file = state.files.find((f) => f.id === "main.tex")!;
      expect(file.content).toBe("Hello, Beautiful World");
      expect(file.isDirty).toBe(true);
    });

    it("updates cursor position after insert", () => {
      useDocumentStore.getState().insertAtCursor("!");
      expect(useDocumentStore.getState().cursorPosition).toBe(6);
    });

    it("inserts at beginning when cursor is at 0", () => {
      useDocumentStore.setState({ cursorPosition: 0 });
      useDocumentStore.getState().insertAtCursor(">> ");
      const file = useDocumentStore
        .getState()
        .files.find((f) => f.id === "main.tex")!;
      expect(file.content).toBe(">> Hello World");
    });

    it("inserts at end when cursor is at content length", () => {
      useDocumentStore.setState({ cursorPosition: 11 }); // "Hello World".length
      useDocumentStore.getState().insertAtCursor("!");
      const file = useDocumentStore
        .getState()
        .files.find((f) => f.id === "main.tex")!;
      expect(file.content).toBe("Hello World!");
    });

    it("does nothing for image files", () => {
      useDocumentStore.setState({
        files: [makeFile({ type: "image", content: undefined })],
      });
      useDocumentStore.getState().insertAtCursor("text");
      const file = useDocumentStore.getState().files[0];
      expect(file.content).toBeUndefined();
    });

    it("handles empty content", () => {
      useDocumentStore.setState({
        files: [makeFile({ content: "" })],
        cursorPosition: 0,
      });
      useDocumentStore.getState().insertAtCursor("New text");
      const file = useDocumentStore.getState().files[0];
      expect(file.content).toBe("New text");
    });
  });

  describe("replaceSelection", () => {
    it("replaces a range of text", () => {
      // Replace "World" (indices 6-11) with "Universe"
      useDocumentStore.getState().replaceSelection(6, 11, "Universe");
      const file = useDocumentStore
        .getState()
        .files.find((f) => f.id === "main.tex")!;
      expect(file.content).toBe("Hello Universe");
      expect(file.isDirty).toBe(true);
    });

    it("updates cursor position to end of replacement", () => {
      useDocumentStore.getState().replaceSelection(6, 11, "Universe");
      expect(useDocumentStore.getState().cursorPosition).toBe(14); // 6 + "Universe".length
    });

    it("can delete text (empty replacement)", () => {
      useDocumentStore.getState().replaceSelection(5, 11, "");
      const file = useDocumentStore
        .getState()
        .files.find((f) => f.id === "main.tex")!;
      expect(file.content).toBe("Hello");
    });

    it("can insert at a point (start === end)", () => {
      useDocumentStore.getState().replaceSelection(5, 5, " Beautiful");
      const file = useDocumentStore
        .getState()
        .files.find((f) => f.id === "main.tex")!;
      expect(file.content).toBe("Hello Beautiful World");
    });

    it("does nothing for pdf files", () => {
      useDocumentStore.setState({
        files: [makeFile({ type: "pdf", content: "pdf-data" })],
      });
      useDocumentStore.getState().replaceSelection(0, 3, "new");
      expect(useDocumentStore.getState().files[0].content).toBe("pdf-data");
    });
  });

  describe("findAndReplace", () => {
    it("replaces first occurrence", () => {
      const result = useDocumentStore
        .getState()
        .findAndReplace("World", "Universe");
      expect(result).toBe(true);
      const file = useDocumentStore
        .getState()
        .files.find((f) => f.id === "main.tex")!;
      expect(file.content).toBe("Hello Universe");
      expect(file.isDirty).toBe(true);
    });

    it("returns false when find string is not found", () => {
      const result = useDocumentStore.getState().findAndReplace("xyz", "abc");
      expect(result).toBe(false);
      const file = useDocumentStore
        .getState()
        .files.find((f) => f.id === "main.tex")!;
      expect(file.isDirty).toBe(false); // not modified
    });

    it("replaces only first occurrence (String.replace behavior)", () => {
      useDocumentStore.setState({
        files: [makeFile({ content: "aaa bbb aaa" })],
      });
      useDocumentStore.getState().findAndReplace("aaa", "ccc");
      const file = useDocumentStore.getState().files[0];
      expect(file.content).toBe("ccc bbb aaa");
    });

    it("handles special regex characters in find string", () => {
      useDocumentStore.setState({
        files: [makeFile({ content: "price is $10.00" })],
      });
      const result = useDocumentStore
        .getState()
        .findAndReplace("$10.00", "€12.00");
      expect(result).toBe(true);
      expect(useDocumentStore.getState().files[0].content).toBe(
        "price is €12.00",
      );
    });

    it("does nothing for image files", () => {
      useDocumentStore.setState({
        files: [makeFile({ type: "image" })],
      });
      const result = useDocumentStore.getState().findAndReplace("Hello", "Bye");
      expect(result).toBe(false);
    });
  });

  describe("updateFileContent", () => {
    it("updates content and marks dirty", () => {
      useDocumentStore.getState().updateFileContent("main.tex", "New content");
      const file = useDocumentStore
        .getState()
        .files.find((f) => f.id === "main.tex")!;
      expect(file.content).toBe("New content");
      expect(file.isDirty).toBe(true);
    });

    it("does not affect other files", () => {
      useDocumentStore.setState({
        files: [
          makeFile(),
          makeFile({
            id: "other.tex",
            name: "other.tex",
            relativePath: "other.tex",
            content: "Other",
          }),
        ],
      });
      useDocumentStore.getState().updateFileContent("main.tex", "Changed");
      const other = useDocumentStore
        .getState()
        .files.find((f) => f.id === "other.tex")!;
      expect(other.content).toBe("Other");
      expect(other.isDirty).toBe(false);
    });
  });

  describe("addFile", () => {
    it("adds a new file and sets it active", () => {
      const id = useDocumentStore.getState().addFile({
        name: "refs.bib",
        relativePath: "refs.bib",
        absolutePath: "/project/refs.bib",
        type: "bib",
        content: "@article{...}",
      });
      expect(id).toBe("refs.bib");
      const state = useDocumentStore.getState();
      expect(state.files).toHaveLength(2);
      expect(state.activeFileId).toBe("refs.bib");
    });
  });

  describe("setActiveFile", () => {
    it("changes active file and resets selection", () => {
      useDocumentStore.setState({
        files: [
          makeFile(),
          makeFile({ id: "ch1.tex", name: "ch1.tex", relativePath: "ch1.tex" }),
        ],
        cursorPosition: 100,
        selectionRange: { start: 10, end: 20 },
      });
      useDocumentStore.getState().setActiveFile("ch1.tex");
      const state = useDocumentStore.getState();
      expect(state.activeFileId).toBe("ch1.tex");
      // cursorPosition is preserved — the editor restores it from per-file cache
      expect(state.cursorPosition).toBe(100);
      expect(state.selectionRange).toBeNull();
    });

    it("keeps the current PDF when switching to a non-tex file", () => {
      const pdfBytes = new Uint8Array([1, 2, 3]);
      useDocumentStore.setState({
        files: [
          makeFile({
            content:
              "\\documentclass{article}\\begin{document}Hi\\end{document}",
          }),
          makeFile({
            id: "analysis.py",
            name: "analysis.py",
            relativePath: "analysis.py",
            absolutePath: "/project/analysis.py",
            type: "other",
            content: "print('hello')",
          }),
        ],
        activeFileId: "main.tex",
        selectionRange: { start: 0, end: 3 },
      });
      useDocumentStore.getState().setPdfData(pdfBytes, "main.tex");
      const revisionBefore = useDocumentStore.getState().pdfRevision;

      useDocumentStore.getState().setActiveFile("analysis.py");

      const state = useDocumentStore.getState();
      expect(state.activeFileId).toBe("analysis.py");
      expect(state.selectionRange).toBeNull();
      expect(state.pdfRevision).toBe(revisionBefore);
      expect(getCurrentPdfRootId()).toBe("main.tex");
      expect(getCurrentPdfBytes()).toEqual(pdfBytes);
    });
  });

  describe("saveFile", () => {
    beforeEach(() => {
      vi.mocked(writeTextFile).mockClear();
      vi.mocked(writeTextFile).mockResolvedValue(undefined);
    });

    it("saves a dirty file with content to disk", async () => {
      useDocumentStore.setState({
        files: [makeFile({ isDirty: true, content: "saved content" })],
      });
      await useDocumentStore.getState().saveFile("main.tex");
      expect(writeTextFile).toHaveBeenCalledWith(
        "/project/main.tex",
        "saved content",
      );
      expect(useDocumentStore.getState().files[0].isDirty).toBe(false);
    });

    it("saves a dirty file with empty string content (regression: empty content is not falsy-skipped)", async () => {
      useDocumentStore.setState({
        files: [makeFile({ isDirty: true, content: "" })],
      });
      await useDocumentStore.getState().saveFile("main.tex");
      expect(writeTextFile).toHaveBeenCalledWith("/project/main.tex", "");
      expect(useDocumentStore.getState().files[0].isDirty).toBe(false);
    });

    it("skips saving when content is null", async () => {
      useDocumentStore.setState({
        files: [
          makeFile({ isDirty: true, content: null as unknown as string }),
        ],
      });
      await useDocumentStore.getState().saveFile("main.tex");
      expect(writeTextFile).not.toHaveBeenCalled();
    });

    it("skips saving when file is not dirty", async () => {
      useDocumentStore.setState({
        files: [makeFile({ isDirty: false, content: "clean" })],
      });
      await useDocumentStore.getState().saveFile("main.tex");
      expect(writeTextFile).not.toHaveBeenCalled();
    });
  });

  describe("saveAllFiles", () => {
    beforeEach(() => {
      vi.mocked(writeTextFile).mockClear();
      vi.mocked(writeTextFile).mockResolvedValue(undefined);
    });

    it("saves all dirty files", async () => {
      useDocumentStore.setState({
        files: [
          makeFile({ isDirty: true, content: "dirty content" }),
          makeFile({
            id: "clean.tex",
            name: "clean.tex",
            absolutePath: "/project/clean.tex",
            relativePath: "clean.tex",
            isDirty: false,
            content: "clean",
          }),
        ],
      });
      await useDocumentStore.getState().saveAllFiles();
      expect(writeTextFile).toHaveBeenCalledTimes(1);
      expect(writeTextFile).toHaveBeenCalledWith(
        "/project/main.tex",
        "dirty content",
      );
    });

    it("saves dirty files with empty string content (regression: empty string is not falsy-skipped)", async () => {
      useDocumentStore.setState({
        files: [
          makeFile({ isDirty: true, content: "" }),
          makeFile({
            id: "slide.tex",
            name: "slide.tex",
            absolutePath: "/project/slide.tex",
            relativePath: "slide.tex",
            isDirty: true,
            content: "",
          }),
        ],
      });
      await useDocumentStore.getState().saveAllFiles();
      expect(writeTextFile).toHaveBeenCalledTimes(2);
      expect(writeTextFile).toHaveBeenCalledWith("/project/main.tex", "");
      expect(writeTextFile).toHaveBeenCalledWith("/project/slide.tex", "");
      // Both should be marked clean
      const files = useDocumentStore.getState().files;
      expect(files.every((f) => !f.isDirty)).toBe(true);
    });

    it("skips files with null content even if dirty", async () => {
      useDocumentStore.setState({
        files: [
          makeFile({ isDirty: true, content: null as unknown as string }),
        ],
      });
      await useDocumentStore.getState().saveAllFiles();
      expect(writeTextFile).not.toHaveBeenCalled();
    });
  });

  describe("setPdfData / setCompileError", () => {
    it("setPdfData clears compile error", () => {
      useDocumentStore.setState({ compileError: "some error" });
      useDocumentStore.getState().setPdfData(new Uint8Array([1, 2, 3]));
      const state = useDocumentStore.getState();
      expect(getCurrentPdfBytes()).toEqual(new Uint8Array([1, 2, 3]));
      expect(state.compileError).toBeNull();
    });

    it("setCompileError stores the error string (regression: Tauri string errors must be preserved)", () => {
      useDocumentStore
        .getState()
        .setCompileError("Compilation failed\n\n! Undefined control sequence.");
      expect(useDocumentStore.getState().compileError).toBe(
        "Compilation failed\n\n! Undefined control sequence.",
      );
    });
  });
});
