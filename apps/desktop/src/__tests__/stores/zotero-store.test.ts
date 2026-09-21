import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  validateApiKey: vi.fn(),
  fetchCollections: vi.fn(),
  importCollection: vi.fn(),
  syncCollection: vi.fn(),
  startOAuth: vi.fn(),
  completeOAuth: vi.fn(),
  cancelOAuth: vi.fn(),
}));
const toastApi = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));
const getDocumentState = vi.hoisted(() => vi.fn());
const documentStateSubscribers = vi.hoisted(
  () => new Set<(state: unknown, previousState: unknown) => void>(),
);
const subscribeDocumentState = vi.hoisted(() =>
  vi.fn((subscriber: (state: unknown, previousState: unknown) => void) => {
    documentStateSubscribers.add(subscriber);
    return () => documentStateSubscribers.delete(subscriber);
  }),
);
const createFileOnDisk = vi.hoisted(() => vi.fn());

vi.mock("sonner", () => ({ toast: toastApi }));
vi.mock("@/lib/zotero-api", () => api);
vi.mock("@/stores/document-store", () => ({
  useDocumentStore: {
    getState: getDocumentState,
    subscribe: subscribeDocumentState,
  },
}));
vi.mock("@/lib/tauri/fs", () => ({ createFileOnDisk }));

import { drainProjectFsOperations } from "@/lib/project-fs-operations";
import type {
  CollectionImportResult,
  CollectionSyncResult,
} from "@/lib/zotero-api";
import { type CollectionSyncInfo, useZoteroStore } from "@/stores/zotero-store";

interface MockFile {
  id: string;
  name: string;
  relativePath: string;
  absolutePath: string;
  type: string;
  content?: string;
  isDirty: boolean;
}

interface MockDocumentState {
  projectRoot: string | null;
  projectGeneration: number;
  isProjectMutating: boolean;
  files: MockFile[];
  updateFileContent: ReturnType<typeof vi.fn>;
  addFile: ReturnType<typeof vi.fn>;
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

function bibFile(
  root: string,
  name = "papers.bib",
  content = "@article{old,\n  title = {Old}\n}",
): MockFile {
  return {
    id: name,
    name,
    relativePath: name,
    absolutePath: `${root}/${name}`,
    type: "bib",
    content,
    isDirty: false,
  };
}

function makeDocumentState(
  root: string,
  projectGeneration: number,
  files: MockFile[] = [],
): MockDocumentState {
  const state: MockDocumentState = {
    projectRoot: root,
    projectGeneration,
    isProjectMutating: false,
    files,
    updateFileContent: vi.fn((id: string, content: string) => {
      state.files = state.files.map((file) =>
        file.id === id ? { ...file, content, isDirty: true } : file,
      );
    }),
    addFile: vi.fn((file: Omit<MockFile, "id" | "isDirty">) => {
      state.files = [
        ...state.files,
        { ...file, id: file.relativePath, isDirty: false },
      ];
      return file.relativePath;
    }),
  };
  return state;
}

function syncInfo(
  overrides: Partial<CollectionSyncInfo> = {},
): CollectionSyncInfo {
  return {
    collectionKey: "COLL",
    name: "Papers",
    bibFileName: "papers.bib",
    libraryVersion: 1,
    keyMap: { itemOld: "old" },
    ...overrides,
  };
}

function setSyncedCollection(
  projectRoot: string,
  collectionKey: string,
  info: CollectionSyncInfo,
) {
  useZoteroStore.setState((state) => ({
    syncedCollections: {
      ...state.syncedCollections,
      [projectRoot]: {
        ...(state.syncedCollections[projectRoot] ?? {}),
        [collectionKey]: info,
      },
    },
  }));
}

describe("useZoteroStore project isolation", () => {
  let documentState: MockDocumentState;

  function mountDocumentState(nextState: MockDocumentState) {
    const previousState = documentState;
    documentState = nextState;
    for (const subscriber of documentStateSubscribers) {
      subscriber(nextState, previousState);
    }
  }

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    api.cancelOAuth.mockResolvedValue(undefined);
    api.fetchCollections.mockResolvedValue([]);
    documentState = makeDocumentState("/project-a", 1);
    getDocumentState.mockImplementation(() => documentState);
    useZoteroStore.setState({
      apiKey: "api-key",
      userID: "user-id",
      username: "user",
      syncedCollections: {},
      isAuthenticated: true,
      isValidating: false,
      isSyncing: null,
      syncProgress: null,
      error: null,
      collections: [],
      isLoadingCollections: false,
      activeSyncRequestId: null,
      activeSyncProjectOwner: null,
    });
  });

  it("ignores an OAuth completion that arrives after the connection is cancelled", async () => {
    const oauth = deferred<{
      apiKey: string;
      userID: string;
      username: string;
    }>();
    api.startOAuth.mockResolvedValue(undefined);
    api.completeOAuth.mockReturnValue(oauth.promise);
    useZoteroStore.setState({
      apiKey: null,
      userID: null,
      username: null,
      isAuthenticated: false,
    });

    const connection = useZoteroStore.getState().connectWithOAuth();
    await vi.waitFor(() => expect(api.completeOAuth).toHaveBeenCalledOnce());
    useZoteroStore.getState().cancelConnect();
    oauth.resolve({
      apiKey: "cancelled-key",
      userID: "cancelled-user",
      username: "cancelled",
    });

    await expect(connection).resolves.toBe(false);
    expect(useZoteroStore.getState()).toMatchObject({
      apiKey: null,
      userID: null,
      username: null,
      isAuthenticated: false,
      isValidating: false,
      error: null,
    });
    expect(api.fetchCollections).not.toHaveBeenCalled();
  });

  it("lets only the latest API-key connection publish credentials", async () => {
    const firstValidation = deferred<{
      apiKey: string;
      userID: string;
      username: string;
    }>();
    api.validateApiKey
      .mockReturnValueOnce(firstValidation.promise)
      .mockResolvedValueOnce({
        apiKey: "new-key",
        userID: "new-user",
        username: "new-account",
      });

    const firstConnection = useZoteroStore
      .getState()
      .connectWithApiKey("old-key");
    await vi.waitFor(() => expect(api.validateApiKey).toHaveBeenCalledOnce());
    await expect(
      useZoteroStore.getState().connectWithApiKey("new-key"),
    ).resolves.toBe(true);
    firstValidation.resolve({
      apiKey: "old-key",
      userID: "old-user",
      username: "old-account",
    });

    await expect(firstConnection).resolves.toBe(false);
    expect(useZoteroStore.getState()).toMatchObject({
      apiKey: "new-key",
      userID: "new-user",
      username: "new-account",
      isAuthenticated: true,
      isValidating: false,
    });
  });

  it("does not let a revalidation restore an account after switching accounts", async () => {
    const oldRevalidation = deferred<{
      apiKey: string;
      userID: string;
      username: string;
    }>();
    api.validateApiKey
      .mockReturnValueOnce(oldRevalidation.promise)
      .mockResolvedValueOnce({
        apiKey: "new-key",
        userID: "new-user",
        username: "new-account",
      });

    const revalidation = useZoteroStore.getState().revalidate();
    await vi.waitFor(() => expect(api.validateApiKey).toHaveBeenCalledOnce());
    await useZoteroStore.getState().connectWithApiKey("new-key");
    oldRevalidation.resolve({
      apiKey: "api-key",
      userID: "old-user",
      username: "old-account",
    });
    await revalidation;

    expect(useZoteroStore.getState()).toMatchObject({
      apiKey: "new-key",
      userID: "new-user",
      username: "new-account",
      isAuthenticated: true,
    });
  });

  it("ignores collections loaded for an account that has been replaced", async () => {
    const oldCollections =
      deferred<
        Array<{
          key: string;
          name: string;
          parentKey: false;
          itemCount: number;
        }>
      >();
    api.fetchCollections
      .mockReturnValueOnce(oldCollections.promise)
      .mockResolvedValueOnce([
        {
          key: "NEW",
          name: "New account collection",
          parentKey: false,
          itemCount: 1,
        },
      ]);
    api.validateApiKey.mockResolvedValue({
      apiKey: "new-key",
      userID: "new-user",
      username: "new-account",
    });

    const oldLoad = useZoteroStore.getState().loadCollections();
    await vi.waitFor(() => expect(api.fetchCollections).toHaveBeenCalledOnce());
    await useZoteroStore.getState().connectWithApiKey("new-key");
    await vi.waitFor(() =>
      expect(useZoteroStore.getState().collections).toEqual([
        expect.objectContaining({ key: "NEW" }),
      ]),
    );
    oldCollections.resolve([
      {
        key: "OLD",
        name: "Old account collection",
        parentKey: false,
        itemCount: 2,
      },
    ]);
    await oldLoad;

    expect(useZoteroStore.getState()).toMatchObject({
      collections: [expect.objectContaining({ key: "NEW" })],
      isLoadingCollections: false,
    });
  });

  it("exposes starting download progress before the first network callback", async () => {
    documentState.files = [bibFile("/project-a")];
    const network = deferred<CollectionImportResult>();
    api.importCollection.mockReturnValue(network.promise);

    const importPromise = useZoteroStore
      .getState()
      .importCollectionToBib("COLL", "Papers");
    expect(useZoteroStore.getState()).toMatchObject({
      isSyncing: "COLL",
      syncProgress: { loaded: 0, total: 0 },
    });

    network.resolve({
      bibtex: "@article{new,}",
      libraryVersion: 2,
      keyMap: { new: "new" },
      totalItems: 1,
    });
    await importPromise;
  });

  it("marks bibliography writing after the download and before the file lands", async () => {
    const network = deferred<CollectionImportResult>();
    const diskCreate = deferred<string>();
    let reportProgress!: (loaded: number, total: number) => void;
    api.importCollection.mockImplementation(
      (_apiKey, _userID, _collectionKey, onProgress) => {
        reportProgress = onProgress;
        return network.promise;
      },
    );
    createFileOnDisk.mockReturnValue(diskCreate.promise);

    const importPromise = useZoteroStore
      .getState()
      .importCollectionToBib("COLL", "Papers");
    expect(useZoteroStore.getState().syncProgress).toEqual({
      loaded: 0,
      total: 0,
    });
    reportProgress(4, 10);
    expect(useZoteroStore.getState().syncProgress).toEqual({
      loaded: 4,
      total: 10,
    });

    network.resolve({
      bibtex: "@book{created,}",
      libraryVersion: 2,
      keyMap: { item: "created" },
      totalItems: 1,
    });
    await vi.waitFor(() => expect(createFileOnDisk).toHaveBeenCalledOnce());
    expect(useZoteroStore.getState()).toMatchObject({
      isSyncing: "COLL",
      syncProgress: { loaded: 4, total: 10, writing: true },
    });

    const drain = drainProjectFsOperations(["/project-a"]);
    diskCreate.resolve("/project-a/papers.bib");
    await Promise.all([importPromise, drain]);
    expect(useZoteroStore.getState()).toMatchObject({
      isSyncing: null,
      syncProgress: null,
    });
  });

  it("clears project A busy state immediately when project B is mounted", async () => {
    const network = deferred<CollectionImportResult>();
    let reportProgress!: (loaded: number, total: number) => void;
    api.importCollection.mockImplementation(
      (_apiKey, _userID, _collectionKey, onProgress) => {
        reportProgress = onProgress;
        return network.promise;
      },
    );

    const importPromise = useZoteroStore
      .getState()
      .importCollectionToBib("COLL", "Papers");
    reportProgress(3, 10);
    expect(useZoteroStore.getState()).toMatchObject({
      isSyncing: "COLL",
      syncProgress: { loaded: 3, total: 10 },
    });

    const projectB = makeDocumentState("/project-b", 2, [
      bibFile("/project-b"),
    ]);
    mountDocumentState(projectB);
    expect(useZoteroStore.getState()).toMatchObject({
      activeSyncRequestId: null,
      activeSyncProjectOwner: null,
      isSyncing: null,
      syncProgress: null,
    });

    network.resolve({
      bibtex: "@article{stale,}",
      libraryVersion: 9,
      keyMap: { stale: "stale" },
      totalItems: 1,
    });
    await importPromise;
    expect(projectB.updateFileContent).not.toHaveBeenCalled();
    expect(useZoteroStore.getState().syncedCollections["/project-b"]).toBe(
      undefined,
    );
    expect(toastApi.success).not.toHaveBeenCalled();
    expect(toastApi.error).not.toHaveBeenCalled();
  });

  it("uses one canonical Windows project key across case and slash variants", async () => {
    mountDocumentState(
      makeDocumentState("c:/work/paper", 7, [bibFile("c:/work/paper")]),
    );
    useZoteroStore.setState({
      syncedCollections: {
        "C:\\Work\\Paper\\": { COLL: syncInfo() },
      },
    });
    api.syncCollection.mockResolvedValue({
      updatedEntries: [
        { key: "new", citekey: "new", bibtex: "@article{new,}" },
      ],
      deletedKeys: [],
      libraryVersion: 5,
    });

    await useZoteroStore.getState().syncCollectionBib("COLL");

    expect(api.syncCollection).toHaveBeenCalledOnce();
    expect(useZoteroStore.getState().syncedCollections).toEqual({
      "c:/work/paper": {
        COLL: expect.objectContaining({
          libraryVersion: 5,
          keyMap: { new: "new" },
        }),
      },
    });
  });

  it("imports into the exact existing .bib file owned by the current project", async () => {
    const existing = bibFile("/project-a");
    documentState.files = [existing];
    api.importCollection.mockResolvedValue({
      bibtex: "@article{new,\n  title = {New}\n}",
      libraryVersion: 4,
      keyMap: { itemNew: "new" },
      totalItems: 1,
    });

    await useZoteroStore.getState().importCollectionToBib("COLL", "Papers");

    expect(documentState.updateFileContent).toHaveBeenCalledWith(
      existing.id,
      "@article{new,\n  title = {New}\n}",
    );
    expect(createFileOnDisk).not.toHaveBeenCalled();
    expect(
      useZoteroStore.getState().syncedCollections["/project-a"].COLL,
    ).toMatchObject({ libraryVersion: 4, keyMap: { itemNew: "new" } });
    expect(toastApi.success).toHaveBeenCalledWith("Imported Papers");
  });

  it("registers a new .bib create before awaiting it and adds it as type bib", async () => {
    const diskCreate = deferred<string>();
    createFileOnDisk.mockReturnValue(diskCreate.promise);
    api.importCollection.mockResolvedValue({
      bibtex: "@book{created,}",
      libraryVersion: 2,
      keyMap: { item: "created" },
      totalItems: 1,
    });

    const importPromise = useZoteroStore
      .getState()
      .importCollectionToBib("COLL", "Papers");
    await vi.waitFor(() => expect(createFileOnDisk).toHaveBeenCalledOnce());

    const drain = drainProjectFsOperations(["/project-a"]);
    diskCreate.resolve("/project-a/papers.bib");
    await Promise.all([importPromise, drain]);

    expect(drain).not.toBeNull();
    expect(documentState.addFile).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "papers.bib",
        relativePath: "papers.bib",
        absolutePath: "/project-a/papers.bib",
        type: "bib",
      }),
    );
    expect(drainProjectFsOperations(["/project-a"])).toBeNull();
  });

  it("accepts a new .bib created directly under a filesystem root", async () => {
    documentState = makeDocumentState("/", 2);
    createFileOnDisk.mockResolvedValue("/papers.bib");
    api.importCollection.mockResolvedValue({
      bibtex: "@article{root,}",
      libraryVersion: 2,
      keyMap: { root: "root" },
      totalItems: 1,
    });

    await useZoteroStore.getState().importCollectionToBib("COLL", "Papers");

    expect(documentState.addFile).toHaveBeenCalledWith(
      expect.objectContaining({
        absolutePath: "/papers.bib",
        relativePath: "papers.bib",
        type: "bib",
      }),
    );
  });

  it("does not publish a completed create after its project owner changes", async () => {
    const diskCreate = deferred<string>();
    createFileOnDisk.mockReturnValue(diskCreate.promise);
    api.importCollection.mockResolvedValue({
      bibtex: "@article{stale,}",
      libraryVersion: 2,
      keyMap: { stale: "stale" },
      totalItems: 1,
    });
    const projectA = documentState;

    const importPromise = useZoteroStore
      .getState()
      .importCollectionToBib("COLL", "Papers");
    await vi.waitFor(() => expect(createFileOnDisk).toHaveBeenCalledOnce());
    const projectB = makeDocumentState("/project-b", 2);
    documentState = projectB;
    diskCreate.resolve("/project-a/papers.bib");
    await importPromise;

    expect(projectA.addFile).not.toHaveBeenCalled();
    expect(projectB.addFile).not.toHaveBeenCalled();
    expect(useZoteroStore.getState().syncedCollections).toEqual({});
    expect(drainProjectFsOperations(["/project-a"])).toBeNull();
  });

  it("does not write or publish metadata when project A import resolves in project B", async () => {
    const network = deferred<{
      bibtex: string;
      libraryVersion: number;
      keyMap: Record<string, string>;
      totalItems: number;
    }>();
    api.importCollection.mockReturnValue(network.promise);
    const projectA = documentState;

    const importPromise = useZoteroStore
      .getState()
      .importCollectionToBib("COLL", "Papers");
    const projectB = makeDocumentState("/project-b", 2, [
      bibFile("/project-b"),
    ]);
    documentState = projectB;
    network.resolve({
      bibtex: "@article{stale,}",
      libraryVersion: 9,
      keyMap: { stale: "stale" },
      totalItems: 1,
    });
    await importPromise;

    expect(createFileOnDisk).not.toHaveBeenCalled();
    expect(projectA.updateFileContent).not.toHaveBeenCalled();
    expect(projectB.updateFileContent).not.toHaveBeenCalled();
    expect(useZoteroStore.getState().syncedCollections["/project-a"]).toBe(
      undefined,
    );
    expect(useZoteroStore.getState().syncedCollections["/project-b"]).toBe(
      undefined,
    );
  });

  it("invalidates an in-flight import when the Zotero account disconnects", async () => {
    const network = deferred<CollectionImportResult>();
    documentState.files = [bibFile("/project-a")];
    api.importCollection.mockReturnValue(network.promise);

    const importPromise = useZoteroStore
      .getState()
      .importCollectionToBib("COLL", "Papers");
    useZoteroStore.getState().disconnect();
    network.resolve({
      bibtex: "@article{stale,}",
      libraryVersion: 9,
      keyMap: { stale: "stale" },
      totalItems: 1,
    });
    await importPromise;

    expect(documentState.updateFileContent).not.toHaveBeenCalled();
    expect(createFileOnDisk).not.toHaveBeenCalled();
    expect(useZoteroStore.getState()).toMatchObject({
      isAuthenticated: false,
      isSyncing: null,
      syncProgress: null,
      syncedCollections: {},
    });
  });

  it("lets only the latest same-collection import own progress, content, metadata, and error", async () => {
    documentState.files = [bibFile("/project-a")];
    const first = deferred<CollectionImportResult>();
    const second = deferred<CollectionImportResult>();
    let firstProgress!: (loaded: number, total: number) => void;
    let secondProgress!: (loaded: number, total: number) => void;
    api.importCollection
      .mockImplementationOnce(
        (_apiKey, _userID, _collectionKey, onProgress) => {
          firstProgress = onProgress;
          return first.promise;
        },
      )
      .mockImplementationOnce(
        (_apiKey, _userID, _collectionKey, onProgress) => {
          secondProgress = onProgress;
          return second.promise;
        },
      );

    const firstPromise = useZoteroStore
      .getState()
      .importCollectionToBib("COLL", "Papers");
    const secondPromise = useZoteroStore
      .getState()
      .importCollectionToBib("COLL", "Papers");
    firstProgress(1, 10);
    expect(useZoteroStore.getState().syncProgress).toEqual({
      loaded: 0,
      total: 0,
    });
    secondProgress(7, 10);
    expect(useZoteroStore.getState().syncProgress).toEqual({
      loaded: 7,
      total: 10,
    });

    first.reject(new Error("stale request failed"));
    await firstPromise;
    expect(useZoteroStore.getState()).toMatchObject({
      error: null,
      isSyncing: "COLL",
      syncProgress: { loaded: 7, total: 10 },
    });

    second.resolve({
      bibtex: "@article{latest,}",
      libraryVersion: 3,
      keyMap: { latest: "latest" },
      totalItems: 1,
    });
    await secondPromise;

    expect(documentState.updateFileContent).toHaveBeenCalledTimes(1);
    expect(documentState.updateFileContent).toHaveBeenCalledWith(
      "papers.bib",
      "@article{latest,}",
    );
    expect(useZoteroStore.getState()).toMatchObject({
      error: null,
      isSyncing: null,
      syncProgress: null,
    });
    expect(
      useZoteroStore.getState().syncedCollections["/project-a"].COLL,
    ).toMatchObject({ libraryVersion: 3, keyMap: { latest: "latest" } });
  });

  it("fully rebuilds a specific collection sync", async () => {
    documentState.files = [bibFile("/project-a")];
    setSyncedCollection("/project-a", "COLL", syncInfo());
    api.syncCollection.mockResolvedValue({
      updatedEntries: [
        { key: "one", citekey: "one", bibtex: "@article{one,}" },
        { key: "two", citekey: "two", bibtex: "@book{two,}" },
      ],
      deletedKeys: [],
      libraryVersion: 5,
    });

    await useZoteroStore.getState().syncCollectionBib("COLL");

    expect(api.syncCollection).toHaveBeenCalledWith(
      "api-key",
      "user-id",
      "COLL",
      1,
      expect.any(Function),
    );
    expect(documentState.updateFileContent).toHaveBeenCalledWith(
      "papers.bib",
      "@article{one,}\n\n@book{two,}\n",
    );
    expect(
      useZoteroStore.getState().syncedCollections["/project-a"].COLL,
    ).toMatchObject({
      libraryVersion: 5,
      keyMap: { one: "one", two: "two" },
    });
  });

  it("lets only the latest same-collection sync commit and retain its busy state", async () => {
    documentState.files = [bibFile("/project-a")];
    setSyncedCollection("/project-a", "COLL", syncInfo());
    const first = deferred<CollectionSyncResult>();
    const second = deferred<CollectionSyncResult>();
    api.syncCollection
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const firstPromise = useZoteroStore.getState().syncCollectionBib("COLL");
    const secondPromise = useZoteroStore.getState().syncCollectionBib("COLL");
    first.reject(new Error("stale sync failed"));
    await firstPromise;
    expect(useZoteroStore.getState()).toMatchObject({
      error: null,
      isSyncing: "COLL",
    });

    second.resolve({
      updatedEntries: [
        { key: "latest", citekey: "latest", bibtex: "@article{latest,}" },
      ],
      deletedKeys: [],
      libraryVersion: 7,
    });
    await secondPromise;

    expect(documentState.updateFileContent).toHaveBeenCalledTimes(1);
    expect(documentState.updateFileContent).toHaveBeenCalledWith(
      "papers.bib",
      "@article{latest,}\n",
    );
    expect(useZoteroStore.getState()).toMatchObject({
      error: null,
      isSyncing: null,
    });
    expect(
      useZoteroStore.getState().syncedCollections["/project-a"].COLL,
    ).toMatchObject({ libraryVersion: 7, keyMap: { latest: "latest" } });
  });

  it("applies My Library incremental results to current content and metadata at network return", async () => {
    const network = deferred<CollectionSyncResult>();
    documentState.files = [
      bibFile("/project-a", "library.bib", "@article{old,}\n\n@article{keep,}"),
    ];
    setSyncedCollection(
      "/project-a",
      "__my_library__",
      syncInfo({
        collectionKey: null,
        name: "My Library",
        bibFileName: "library.bib",
        keyMap: { renamed: "old", keepItem: "keep" },
      }),
    );
    api.syncCollection.mockReturnValue(network.promise);

    const syncPromise = useZoteroStore.getState().syncCollectionBib(null);
    documentState.files = [
      bibFile(
        "/project-a",
        "library.bib",
        "@article{old,}\n\n@article{keep,}\n\n@misc{concurrent,}",
      ),
    ];
    setSyncedCollection(
      "/project-a",
      "__my_library__",
      syncInfo({
        collectionKey: null,
        name: "My Library",
        bibFileName: "library.bib",
        libraryVersion: 2,
        keyMap: {
          renamed: "old",
          keepItem: "keep",
          concurrentItem: "concurrent",
        },
      }),
    );
    network.resolve({
      updatedEntries: [
        { key: "renamed", citekey: "new", bibtex: "@article{new,}" },
      ],
      deletedKeys: ["keepItem"],
      libraryVersion: 6,
    });
    await syncPromise;

    expect(documentState.updateFileContent).toHaveBeenCalledWith(
      "library.bib",
      "@misc{concurrent,}\n\n@article{new,}\n",
    );
    expect(
      useZoteroStore.getState().syncedCollections["/project-a"][
        "__my_library__"
      ],
    ).toMatchObject({
      libraryVersion: 6,
      keyMap: { renamed: "new", concurrentItem: "concurrent" },
    });
  });

  it("does not apply a deferred sync after switching projects", async () => {
    const network = deferred<CollectionSyncResult>();
    documentState.files = [bibFile("/project-a")];
    setSyncedCollection("/project-a", "COLL", syncInfo());
    api.syncCollection.mockReturnValue(network.promise);
    const projectA = documentState;

    const syncPromise = useZoteroStore.getState().syncCollectionBib("COLL");
    const projectB = makeDocumentState("/project-b", 2, [
      bibFile("/project-b"),
    ]);
    documentState = projectB;
    network.resolve({
      updatedEntries: [
        { key: "stale", citekey: "stale", bibtex: "@article{stale,}" },
      ],
      deletedKeys: [],
      libraryVersion: 8,
    });
    await syncPromise;

    expect(projectA.updateFileContent).not.toHaveBeenCalled();
    expect(projectB.updateFileContent).not.toHaveBeenCalled();
    expect(
      useZoteroStore.getState().syncedCollections["/project-a"].COLL,
    ).toMatchObject({ libraryVersion: 1, keyMap: { itemOld: "old" } });
    expect(useZoteroStore.getState().syncedCollections["/project-b"]).toBe(
      undefined,
    );
  });

  it("releases a failed create and reports the error only for the current request", async () => {
    api.importCollection.mockResolvedValue({
      bibtex: "@article{new,}",
      libraryVersion: 2,
      keyMap: { new: "new" },
      totalItems: 1,
    });
    createFileOnDisk.mockRejectedValue(new Error("disk full"));

    await useZoteroStore.getState().importCollectionToBib("COLL", "Papers");

    expect(drainProjectFsOperations(["/project-a"])).toBeNull();
    expect(useZoteroStore.getState()).toMatchObject({
      error: "disk full",
      isSyncing: null,
      syncProgress: null,
    });
    expect(toastApi.error).toHaveBeenCalledWith("disk full");
  });

  it("renames persisted bib file names only in the mounted project", () => {
    useZoteroStore.setState({
      syncedCollections: {
        "/project-a": { COLL: syncInfo({ bibFileName: "research.bib" }) },
        "/project-b": {
          COLL: syncInfo({ bibFileName: "research.bib", libraryVersion: 99 }),
        },
      },
    });

    useZoteroStore
      .getState()
      .renameSyncedBibFile("research.bib", "refs.bib", "/project-a");

    expect(
      useZoteroStore.getState().syncedCollections["/project-a"].COLL
        .bibFileName,
    ).toBe("refs.bib");
    expect(
      useZoteroStore.getState().syncedCollections["/project-b"].COLL
        .bibFileName,
    ).toBe("research.bib");
  });

  it("follows a 1:1 root bib rename when syncing the old stored name", async () => {
    documentState.files = [bibFile("/project-a", "refs.bib")];
    setSyncedCollection(
      "/project-a",
      "COLL",
      syncInfo({ bibFileName: "papers.bib" }),
    );
    api.syncCollection.mockResolvedValue({
      updatedEntries: [],
      deletedKeys: [],
      libraryVersion: 3,
    });

    await useZoteroStore.getState().syncCollectionBib("COLL");

    expect(api.syncCollection).toHaveBeenCalled();
    expect(
      useZoteroStore.getState().syncedCollections["/project-a"].COLL
        .bibFileName,
    ).toBe("refs.bib");
  });

  it("updates synced bib names when the mounted project file is renamed", () => {
    documentState.files = [bibFile("/project-a", "research.bib")];
    setSyncedCollection(
      "/project-a",
      "COLL",
      syncInfo({ bibFileName: "research.bib" }),
    );

    mountDocumentState({
      ...documentState,
      files: [bibFile("/project-a", "refs.bib")],
    });

    expect(
      useZoteroStore.getState().syncedCollections["/project-a"].COLL
        .bibFileName,
    ).toBe("refs.bib");
  });

  it("removes sync metadata only from the mounted project", () => {
    useZoteroStore.setState({
      syncedCollections: {
        "/project-a": { COLL: syncInfo() },
        "/project-b": { COLL: syncInfo({ libraryVersion: 99 }) },
      },
    });

    useZoteroStore.getState().removeCollection("COLL");

    expect(useZoteroStore.getState().syncedCollections).toEqual({
      "/project-a": {},
      "/project-b": { COLL: syncInfo({ libraryVersion: 99 }) },
    });
  });

  it("invalidates an in-flight sync when its collection is removed", async () => {
    const network = deferred<CollectionSyncResult>();
    documentState.files = [bibFile("/project-a")];
    setSyncedCollection("/project-a", "COLL", syncInfo());
    api.syncCollection.mockReturnValue(network.promise);

    const syncPromise = useZoteroStore.getState().syncCollectionBib("COLL");
    useZoteroStore.getState().removeCollection("COLL");
    expect(useZoteroStore.getState()).toMatchObject({
      isSyncing: null,
      syncProgress: null,
    });
    network.resolve({
      updatedEntries: [
        { key: "stale", citekey: "stale", bibtex: "@article{stale,}" },
      ],
      deletedKeys: [],
      libraryVersion: 10,
    });
    await syncPromise;

    expect(documentState.updateFileContent).not.toHaveBeenCalled();
    expect(useZoteroStore.getState().syncedCollections["/project-a"]).toEqual(
      {},
    );
  });
});
