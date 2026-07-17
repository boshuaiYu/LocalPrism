import { beforeEach, describe, expect, it, vi } from "vitest";
import { drainProjectFsOperations } from "@/lib/project-fs-operations";
import { useProposedChangesStore } from "@/stores/proposed-changes-store";

const mocks = vi.hoisted(() => {
  const writeTexFileContent = vi.fn<
    (absolutePath: string, content: string) => Promise<void>
  >(() => Promise.resolve());
  const reloadFile = vi.fn<(relativePath: string) => Promise<void>>(() =>
    Promise.resolve(),
  );
  const document = {
    current: {
      projectRoot: "/project-a",
      projectGeneration: 1,
      isProjectMutating: false,
      files: [] as Array<{
        id: string;
        relativePath: string;
        absolutePath: string;
        content?: string;
      }>,
      reloadFile,
    },
  };
  return { document, reloadFile, writeTexFileContent };
});

vi.mock("@/stores/document-store", () => ({
  useDocumentStore: {
    getState: () => mocks.document.current,
  },
}));

vi.mock("@/lib/tauri/fs", () => ({
  writeTexFileContent: mocks.writeTexFileContent,
}));

function file(
  relativePath: string,
  absolutePath: string,
  content = "editor content",
) {
  return {
    id: relativePath,
    relativePath,
    absolutePath,
    content,
  };
}

function mountProject(
  projectRoot: string,
  projectGeneration: number,
  files = [file("main.tex", `${projectRoot}/main.tex`)],
  isProjectMutating = false,
) {
  mocks.document.current = {
    projectRoot,
    projectGeneration,
    isProjectMutating,
    files,
    reloadFile: mocks.reloadFile,
  };
}

function addMainChange(id = "tool-1") {
  useProposedChangesStore.getState().addChange({
    id,
    filePath: "main.tex",
    absolutePath: "/project-a/main.tex",
    oldContent: "old",
    newContent: "new",
    toolName: "Edit",
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("useProposedChangesStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mountProject("/project-a", 1);
    useProposedChangesStore.setState({ changes: [] });
  });

  describe("addChange", () => {
    it("binds a new change to the current project incarnation", () => {
      mountProject("/project-a", 7);

      addMainChange();

      expect(useProposedChangesStore.getState().changes).toEqual([
        expect.objectContaining({
          id: "tool-1",
          oldContent: "old",
          newContent: "new",
          projectRoot: "/project-a",
          projectGeneration: 7,
          timestamp: expect.any(Number),
        }),
      ]);
    });

    it("ignores a late change whose absolute path is not the current relative file", () => {
      mountProject("/project-b", 2, [file("main.tex", "/project-b/main.tex")]);

      addMainChange();

      expect(useProposedChangesStore.getState().changes).toEqual([]);
    });

    it("merges same-project changes while preserving the original baseline", () => {
      const store = useProposedChangesStore.getState();
      store.addChange({
        id: "tool-1",
        filePath: "main.tex",
        absolutePath: "/project-a/main.tex",
        oldContent: "original",
        newContent: "first-edit",
        toolName: "Edit",
      });
      store.addChange({
        id: "tool-2",
        filePath: "main.tex",
        absolutePath: "/project-a/main.tex",
        oldContent: "first-edit",
        newContent: "second-edit",
        toolName: "Edit",
      });

      expect(useProposedChangesStore.getState().changes).toEqual([
        expect.objectContaining({
          id: "tool-2",
          oldContent: "original",
          newContent: "second-edit",
          projectRoot: "/project-a",
          projectGeneration: 1,
        }),
      ]);
    });

    it("keeps changes for different files separate", () => {
      mountProject("/project-a", 1, [
        file("main.tex", "/project-a/main.tex"),
        file("refs.bib", "/project-a/refs.bib"),
      ]);
      const store = useProposedChangesStore.getState();
      store.addChange({
        id: "tool-1",
        filePath: "main.tex",
        absolutePath: "/project-a/main.tex",
        oldContent: "a",
        newContent: "b",
        toolName: "Edit",
      });
      store.addChange({
        id: "tool-2",
        filePath: "refs.bib",
        absolutePath: "/project-a/refs.bib",
        oldContent: "c",
        newContent: "d",
        toolName: "Write",
      });

      expect(useProposedChangesStore.getState().changes).toHaveLength(2);
    });
  });

  describe.each([
    [
      "keepChange",
      (id: string) => useProposedChangesStore.getState().keepChange(id),
    ],
    [
      "undoChange",
      (id: string) => useProposedChangesStore.getState().undoChange(id),
    ],
  ] as const)("%s isolation", (_name, runAction) => {
    it("does not write either project after switching to another project with the same relative path", async () => {
      addMainChange();
      mountProject("/project-b", 2, [
        file("main.tex", "/project-b/main.tex", "project B content"),
      ]);

      await runAction("tool-1");

      expect(mocks.writeTexFileContent).not.toHaveBeenCalled();
      expect(mocks.reloadFile).not.toHaveBeenCalled();
      expect(useProposedChangesStore.getState().changes).toEqual([]);
    });

    it("does not cross the project-mutation barrier", async () => {
      addMainChange();
      mountProject(
        "/project-a",
        1,
        [file("main.tex", "/project-a/main.tex")],
        true,
      );

      await runAction("tool-1");

      expect(mocks.writeTexFileContent).not.toHaveBeenCalled();
      expect(mocks.reloadFile).not.toHaveBeenCalled();
      expect(useProposedChangesStore.getState().changes).toHaveLength(1);
    });
  });

  describe("keepChange", () => {
    it("writes current editor content to the current file path instead of the recorded path", async () => {
      addMainChange();
      mountProject("/project-a", 1, [
        file("main.tex", "/project-a/current-main.tex", "accepted content"),
      ]);

      await useProposedChangesStore.getState().keepChange("tool-1");

      expect(mocks.writeTexFileContent).toHaveBeenCalledWith(
        "/project-a/current-main.tex",
        "accepted content",
      );
      expect(useProposedChangesStore.getState().changes).toEqual([]);
    });

    it("persists the editor's partially resolved merge content before clearing", async () => {
      addMainChange();
      mountProject("/project-a", 1, [
        file("main.tex", "/project-a/main.tex", "original editor state"),
      ]);

      await expect(
        useProposedChangesStore
          .getState()
          .keepChange("tool-1", "partially accepted content"),
      ).resolves.toBe(true);

      expect(mocks.writeTexFileContent).toHaveBeenCalledWith(
        "/project-a/main.tex",
        "partially accepted content",
      );
      expect(useProposedChangesStore.getState().changes).toEqual([]);
    });
  });

  describe("undoChange", () => {
    it("writes the baseline to the current file path, reloads, and resolves", async () => {
      addMainChange();
      mountProject("/project-a", 1, [
        file("main.tex", "/project-a/current-main.tex", "new"),
      ]);

      await useProposedChangesStore.getState().undoChange("tool-1");

      expect(mocks.writeTexFileContent).toHaveBeenCalledWith(
        "/project-a/current-main.tex",
        "old",
      );
      expect(mocks.reloadFile).toHaveBeenCalledWith("main.tex");
      expect(useProposedChangesStore.getState().changes).toEqual([]);
    });

    it("invalidates a change from an older incarnation of the same project", async () => {
      addMainChange();
      mountProject("/project-a", 2);

      await useProposedChangesStore.getState().undoChange("tool-1");

      expect(mocks.writeTexFileContent).not.toHaveBeenCalled();
      expect(mocks.reloadFile).not.toHaveBeenCalled();
      expect(useProposedChangesStore.getState().changes).toEqual([]);
    });

    it("invalidates a change when its exact relative file was renamed", async () => {
      addMainChange();
      mountProject("/project-a", 1, [
        file("renamed.tex", "/project-a/renamed.tex"),
      ]);

      await useProposedChangesStore.getState().undoChange("tool-1");

      expect(mocks.writeTexFileContent).not.toHaveBeenCalled();
      expect(mocks.reloadFile).not.toHaveBeenCalled();
      expect(useProposedChangesStore.getState().changes).toEqual([]);
    });

    it("registers its write before a rename barrier begins draining", async () => {
      const write = deferred<void>();
      mocks.writeTexFileContent.mockReturnValueOnce(write.promise);
      addMainChange();

      const undo = useProposedChangesStore.getState().undoChange("tool-1");
      const barrier = drainProjectFsOperations(["/project-a"]);

      expect(barrier).not.toBeNull();
      let barrierSettled = false;
      void barrier?.then(() => {
        barrierSettled = true;
      });
      await Promise.resolve();
      expect(barrierSettled).toBe(false);

      mountProject(
        "/project-a",
        2,
        [file("main.tex", "/project-a/main.tex")],
        true,
      );
      write.resolve();
      await barrier;
      await undo;

      expect(mocks.reloadFile).not.toHaveBeenCalled();
      expect(useProposedChangesStore.getState().changes).toHaveLength(1);
    });

    it("does not resolve or reload when the registered write fails", async () => {
      const write = deferred<void>();
      mocks.writeTexFileContent.mockReturnValueOnce(write.promise);
      addMainChange();

      const undo = useProposedChangesStore.getState().undoChange("tool-1");
      const barrier = drainProjectFsOperations(["/project-a"]);
      expect(barrier).not.toBeNull();

      write.reject(new Error("disk full"));
      await expect(undo).rejects.toThrow("disk full");
      await barrier;

      expect(mocks.reloadFile).not.toHaveBeenCalled();
      expect(useProposedChangesStore.getState().changes).toHaveLength(1);
    });
  });

  describe("undoAll", () => {
    it("discards a stale change without removing a current change that reused its tool id", async () => {
      addMainChange("reused-tool-id");
      const staleChange = useProposedChangesStore.getState().changes[0];
      mountProject("/project-b", 2, [
        file("main.tex", "/project-b/main.tex", "new B"),
      ]);
      useProposedChangesStore.getState().addChange({
        id: "reused-tool-id",
        filePath: "main.tex",
        absolutePath: "/project-b/main.tex",
        oldContent: "old B",
        newContent: "new B",
        toolName: "Edit",
      });
      const currentChange = useProposedChangesStore.getState().changes[0];
      useProposedChangesStore.setState({
        changes: [staleChange, currentChange],
      });

      await useProposedChangesStore.getState().undoAll();

      expect(mocks.writeTexFileContent).toHaveBeenCalledTimes(1);
      expect(mocks.writeTexFileContent).toHaveBeenCalledWith(
        "/project-b/main.tex",
        "old B",
      );
      expect(useProposedChangesStore.getState().changes).toEqual([]);
    });

    it("uses ordered current-file writes for every change", async () => {
      mountProject("/project-a", 1, [
        file("main.tex", "/project-a/current-main.tex"),
        file("refs.bib", "/project-a/current-refs.bib"),
      ]);
      addMainChange();
      useProposedChangesStore.getState().addChange({
        id: "tool-2",
        filePath: "refs.bib",
        absolutePath: "/project-a/refs.bib",
        oldContent: "old refs",
        newContent: "new refs",
        toolName: "Write",
      });

      await useProposedChangesStore.getState().undoAll();

      expect(mocks.writeTexFileContent).toHaveBeenNthCalledWith(
        1,
        "/project-a/current-main.tex",
        "old",
      );
      expect(mocks.writeTexFileContent).toHaveBeenNthCalledWith(
        2,
        "/project-a/current-refs.bib",
        "old refs",
      );
      expect(mocks.reloadFile).toHaveBeenCalledTimes(2);
      expect(useProposedChangesStore.getState().changes).toEqual([]);
    });

    it("leaves the failed and later changes pending", async () => {
      mountProject("/project-a", 1, [
        file("main.tex", "/project-a/main.tex"),
        file("refs.bib", "/project-a/refs.bib"),
      ]);
      addMainChange();
      useProposedChangesStore.getState().addChange({
        id: "tool-2",
        filePath: "refs.bib",
        absolutePath: "/project-a/refs.bib",
        oldContent: "old refs",
        newContent: "new refs",
        toolName: "Write",
      });
      mocks.writeTexFileContent.mockRejectedValueOnce(new Error("disk full"));

      await expect(
        useProposedChangesStore.getState().undoAll(),
      ).rejects.toThrow("disk full");

      expect(mocks.reloadFile).not.toHaveBeenCalled();
      expect(
        useProposedChangesStore.getState().changes.map((change) => change.id),
      ).toEqual(["tool-1", "tool-2"]);
    });
  });

  describe("keepAll compatibility", () => {
    it("reloads current-project changes and clears them", () => {
      mountProject("/project-a", 1, [
        file("main.tex", "/project-a/main.tex"),
        file("refs.bib", "/project-a/refs.bib"),
      ]);
      addMainChange();
      useProposedChangesStore.getState().addChange({
        id: "tool-2",
        filePath: "refs.bib",
        absolutePath: "/project-a/refs.bib",
        oldContent: "old refs",
        newContent: "new refs",
        toolName: "Write",
      });

      useProposedChangesStore.getState().keepAll();

      expect(mocks.reloadFile).toHaveBeenCalledTimes(2);
      expect(useProposedChangesStore.getState().changes).toEqual([]);
    });
  });

  describe("resolve and lookup", () => {
    it("removes a change by id", () => {
      addMainChange();

      useProposedChangesStore.getState().resolveChange("tool-1");

      expect(useProposedChangesStore.getState().changes).toEqual([]);
    });

    it("only returns changes owned by the current project incarnation", () => {
      addMainChange();
      expect(
        useProposedChangesStore.getState().getChangeForFile("main.tex")?.id,
      ).toBe("tool-1");

      mountProject("/project-a", 2);

      expect(
        useProposedChangesStore.getState().getChangeForFile("main.tex"),
      ).toBeUndefined();
    });
  });
});
