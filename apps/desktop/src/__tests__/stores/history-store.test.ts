import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useHistoryStore, type SnapshotInfo } from "@/stores/history-store";
import { drainProjectFsOperations } from "@/lib/project-fs-operations";

const { documentState, documentStore } = vi.hoisted(() => {
  const state = {
    projectRoot: "/project-a" as string | null,
    projectGeneration: 1,
    isProjectMutating: false,
  };
  return {
    documentState: state,
    documentStore: {
      getState: vi.fn(() => state),
      setState: vi.fn(
        (
          update:
            | Partial<typeof state>
            | ((current: typeof state) => Partial<typeof state>),
        ) => {
          Object.assign(
            state,
            typeof update === "function" ? update({ ...state }) : update,
          );
        },
      ),
    },
  };
});

vi.mock("@/stores/document-store", () => ({
  useDocumentStore: documentStore,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function snapshot(id: string): SnapshotInfo {
  return {
    id,
    message: id,
    timestamp: 1,
    labels: [],
    changed_files: [],
  };
}

describe("useHistoryStore project ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(documentState, {
      projectRoot: "/project-a",
      projectGeneration: 1,
      isProjectMutating: false,
    });
    useHistoryStore.getState().reset();
    useHistoryStore.getState().bindProject("/project-a", 1, false);
  });

  it("does not let a late project A list overwrite project B or clear B loading", async () => {
    const listA = deferred<SnapshotInfo[]>();
    const listB = deferred<SnapshotInfo[]>();
    vi.mocked(invoke).mockImplementation((command, args) => {
      if (command !== "history_list") throw new Error(`Unexpected ${command}`);
      return (
        (args as { projectRoot: string }).projectRoot === "/project-a"
          ? listA.promise
          : listB.promise
      ) as ReturnType<typeof invoke>;
    });

    const loadingA = useHistoryStore.getState().loadSnapshots("/project-a");
    useHistoryStore.getState().bindProject("/project-b", 2, false);
    Object.assign(documentState, {
      projectRoot: "/project-b",
      projectGeneration: 2,
    });
    const loadingB = useHistoryStore.getState().loadSnapshots("/project-b");

    listA.resolve([snapshot("a")]);
    await loadingA;
    expect(useHistoryStore.getState().isLoading).toBe(true);
    expect(useHistoryStore.getState().snapshots).toEqual([]);

    listB.resolve([snapshot("b")]);
    await loadingB;
    expect(useHistoryStore.getState().isLoading).toBe(false);
    expect(useHistoryStore.getState().snapshots.map((item) => item.id)).toEqual(
      ["b"],
    );
  });

  it("gives the newest same-project list request exclusive commit ownership", async () => {
    const first = deferred<SnapshotInfo[]>();
    const second = deferred<SnapshotInfo[]>();
    vi.mocked(invoke)
      .mockReturnValueOnce(first.promise as ReturnType<typeof invoke>)
      .mockReturnValueOnce(second.promise as ReturnType<typeof invoke>);

    const firstLoad = useHistoryStore.getState().loadSnapshots("/project-a");
    const secondLoad = useHistoryStore.getState().loadSnapshots("/project-a");

    first.resolve([snapshot("old")]);
    await firstLoad;
    expect(useHistoryStore.getState().isLoading).toBe(true);
    expect(useHistoryStore.getState().snapshots).toEqual([]);

    second.resolve([snapshot("new")]);
    await secondLoad;
    expect(useHistoryStore.getState().isLoading).toBe(false);
    expect(useHistoryStore.getState().snapshots[0]?.id).toBe("new");
  });

  it("drops a stale pagination result after a same-root rebind", async () => {
    useHistoryStore.setState({ snapshots: [snapshot("first-page")] });
    const more = deferred<SnapshotInfo[]>();
    vi.mocked(invoke).mockReturnValue(
      more.promise as ReturnType<typeof invoke>,
    );

    const loadingMore = useHistoryStore
      .getState()
      .loadMoreSnapshots("/project-a");
    useHistoryStore.getState().bindProject("/project-a", 2, false);
    Object.assign(documentState, { projectGeneration: 2 });
    more.resolve([snapshot("stale-page")]);
    await loadingMore;

    expect(useHistoryStore.getState().snapshots).toEqual([]);
    expect(useHistoryStore.getState().isLoading).toBe(false);
  });

  it("keeps only the newest diff result and loading finalizer", async () => {
    const first =
      deferred<
        Array<{
          file_path: string;
          status: "modified";
          old_content: string;
          new_content: string;
        }>
      >();
    const second =
      deferred<
        Array<{
          file_path: string;
          status: "modified";
          old_content: string;
          new_content: string;
        }>
      >();
    vi.mocked(invoke)
      .mockReturnValueOnce(first.promise as ReturnType<typeof invoke>)
      .mockReturnValueOnce(second.promise as ReturnType<typeof invoke>);

    const firstLoad = useHistoryStore
      .getState()
      .loadDiff("/project-a", "a", "b");
    const secondLoad = useHistoryStore
      .getState()
      .loadDiff("/project-a", "b", "c");
    first.resolve([
      {
        file_path: "old.tex",
        status: "modified",
        old_content: "a",
        new_content: "b",
      },
    ]);
    await firstLoad;
    expect(useHistoryStore.getState().isDiffLoading).toBe(true);
    expect(useHistoryStore.getState().diffResult).toBeNull();

    second.resolve([
      {
        file_path: "new.tex",
        status: "modified",
        old_content: "b",
        new_content: "c",
      },
    ]);
    await secondLoad;
    expect(useHistoryStore.getState().isDiffLoading).toBe(false);
    expect(useHistoryStore.getState().diffResult?.[0]?.file_path).toBe(
      "new.tex",
    );
  });

  it("lets the current read request settle across a short same-owner mutation barrier", async () => {
    const listing = deferred<SnapshotInfo[]>();
    vi.mocked(invoke).mockReturnValue(
      listing.promise as ReturnType<typeof invoke>,
    );

    const loading = useHistoryStore.getState().loadSnapshots("/project-a");
    Object.assign(documentState, { isProjectMutating: true });
    useHistoryStore.getState().bindProject("/project-a", 1, true);

    listing.resolve([snapshot("current")]);
    await loading;

    expect(useHistoryStore.getState().snapshots[0]?.id).toBe("current");
    expect(useHistoryStore.getState().isLoading).toBe(false);
  });

  it("blocks every history write while the project mutation barrier is held", async () => {
    useHistoryStore.getState().bindProject("/project-a", 1, true);

    await useHistoryStore.getState().init("/project-a");
    await expect(
      useHistoryStore.getState().createSnapshot("/project-a", "blocked"),
    ).resolves.toBeNull();
    await expect(
      useHistoryStore.getState().restoreSnapshot("/project-a", "snapshot"),
    ).rejects.toThrow(/project|mutation/i);
    await expect(
      useHistoryStore.getState().addLabel("/project-a", "snapshot", "v1"),
    ).rejects.toThrow(/project|mutation/i);
    await expect(
      useHistoryStore.getState().removeLabel("/project-a", "v1"),
    ).rejects.toThrow(/project|mutation/i);

    expect(invoke).not.toHaveBeenCalled();
  });

  it("coalesces concurrent init calls for the same project owner", async () => {
    const initialization = deferred<void>();
    vi.mocked(invoke).mockReturnValue(
      initialization.promise as ReturnType<typeof invoke>,
    );

    const first = useHistoryStore.getState().init("/project-a");
    const second = useHistoryStore.getState().init("/project-a");

    expect(invoke).toHaveBeenCalledTimes(1);
    initialization.resolve();
    await Promise.all([first, second]);
  });

  it("registers a snapshot before invoking and releases it after failure", async () => {
    const write = deferred<SnapshotInfo | null>();
    vi.mocked(invoke).mockReturnValue(
      write.promise as ReturnType<typeof invoke>,
    );

    const creating = useHistoryStore
      .getState()
      .createSnapshot("/project-a", "snapshot");
    const draining = drainProjectFsOperations(["/project-a"]);
    expect(draining).not.toBeNull();

    const rejected = expect(creating).rejects.toThrow("disk failed");
    write.reject(new Error("disk failed"));
    await rejected;
    await draining;
    expect(drainProjectFsOperations(["/project-a"])).toBeNull();
  });

  it("serializes history mutations for one project for their full queued lifetime", async () => {
    const firstWrite = deferred<SnapshotInfo | null>();
    const secondWrite = deferred<SnapshotInfo | null>();
    vi.mocked(invoke)
      .mockReturnValueOnce(firstWrite.promise as ReturnType<typeof invoke>)
      .mockReturnValueOnce(secondWrite.promise as ReturnType<typeof invoke>);

    const first = useHistoryStore
      .getState()
      .createSnapshot("/project-a", "first");
    const second = useHistoryStore
      .getState()
      .createSnapshot("/project-a", "second");

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(drainProjectFsOperations(["/project-a"])).not.toBeNull();

    firstWrite.resolve(snapshot("first"));
    await first;
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    secondWrite.resolve(snapshot("second"));
    await second;

    expect(
      vi
        .mocked(invoke)
        .mock.calls.map(([, args]) => (args as { message?: string })?.message),
    ).toEqual(["first", "second"]);
    expect(drainProjectFsOperations(["/project-a"])).toBeNull();
  });

  it("recovers the history mutation queue after a failed write", async () => {
    const firstWrite = deferred<SnapshotInfo | null>();
    const secondWrite = deferred<SnapshotInfo | null>();
    vi.mocked(invoke)
      .mockReturnValueOnce(firstWrite.promise as ReturnType<typeof invoke>)
      .mockReturnValueOnce(secondWrite.promise as ReturnType<typeof invoke>);

    const first = useHistoryStore
      .getState()
      .createSnapshot("/project-a", "fails");
    const second = useHistoryStore
      .getState()
      .createSnapshot("/project-a", "recovers");
    expect(invoke).toHaveBeenCalledTimes(1);

    const rejected = expect(first).rejects.toThrow("git index locked");
    firstWrite.reject(new Error("git index locked"));
    await rejected;
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));

    secondWrite.resolve(snapshot("recovered"));
    await expect(second).resolves.toMatchObject({ id: "recovered" });
    expect(drainProjectFsOperations(["/project-a"])).toBeNull();
  });

  it("raises the restore barrier synchronously and drains existing writes before checkout", async () => {
    const snapshotWrite = deferred<SnapshotInfo | null>();
    const restoreWrite = deferred<SnapshotInfo>();
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "history_snapshot") {
        return snapshotWrite.promise as ReturnType<typeof invoke>;
      }
      if (command === "history_restore") {
        return restoreWrite.promise as ReturnType<typeof invoke>;
      }
      throw new Error(`Unexpected ${command}`);
    });

    const snapshotting = useHistoryStore
      .getState()
      .createSnapshot("/project-a", "before restore");
    const restoring = useHistoryStore
      .getState()
      .restoreSnapshot("/project-a", "target");

    expect(documentState.isProjectMutating).toBe(true);
    expect(invoke).not.toHaveBeenCalledWith(
      "history_restore",
      expect.anything(),
    );

    snapshotWrite.resolve(snapshot("before"));
    await snapshotting;
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("history_restore", {
        projectRoot: "/project-a",
        snapshotId: "target",
      }),
    );

    restoreWrite.resolve(snapshot("restored"));
    await restoring;
    expect(documentState.isProjectMutating).toBe(false);
  });

  it("holds the document mutation barrier for restore and releases it on failure", async () => {
    const restore = deferred<SnapshotInfo>();
    vi.mocked(invoke).mockReturnValue(
      restore.promise as ReturnType<typeof invoke>,
    );

    const restoring = useHistoryStore
      .getState()
      .restoreSnapshot("/project-a", "snapshot");
    expect(documentState.isProjectMutating).toBe(true);
    expect(invoke).toHaveBeenCalledWith("history_restore", {
      projectRoot: "/project-a",
      snapshotId: "snapshot",
    });

    restore.reject(new Error("checkout failed"));
    await expect(restoring).rejects.toThrow("checkout failed");
    expect(documentState.isProjectMutating).toBe(false);
    expect(drainProjectFsOperations(["/project-a"])).toBeNull();
  });

  it("does not commit a late snapshot into a newly bound project", async () => {
    const creation = deferred<SnapshotInfo | null>();
    vi.mocked(invoke).mockReturnValue(
      creation.promise as ReturnType<typeof invoke>,
    );

    const creating = useHistoryStore
      .getState()
      .createSnapshot("/project-a", "old project");
    useHistoryStore.getState().bindProject("/project-b", 2, false);
    Object.assign(documentState, {
      projectRoot: "/project-b",
      projectGeneration: 2,
    });
    creation.resolve(snapshot("a-snapshot"));
    await creating;

    expect(useHistoryStore.getState().snapshots).toEqual([]);
  });

  it("does not let an old restore finalizer clear a newer project barrier", async () => {
    const restore = deferred<SnapshotInfo>();
    vi.mocked(invoke).mockReturnValue(
      restore.promise as ReturnType<typeof invoke>,
    );

    const restoring = useHistoryStore
      .getState()
      .restoreSnapshot("/project-a", "snapshot");
    useHistoryStore.getState().bindProject("/project-b", 2, true);
    Object.assign(documentState, {
      projectRoot: "/project-b",
      projectGeneration: 2,
      isProjectMutating: true,
    });

    restore.resolve(snapshot("old-restore"));
    await restoring;

    expect(useHistoryStore.getState()).toMatchObject({
      projectRoot: "/project-b",
      projectGeneration: 2,
      isProjectMutating: true,
    });
    expect(documentState.isProjectMutating).toBe(true);
  });
});
