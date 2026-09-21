import { create } from "zustand";
import { persist } from "zustand/middleware";
import { toast } from "sonner";
import {
  validateApiKey,
  fetchCollections,
  importCollection,
  syncCollection,
  startOAuth,
  completeOAuth,
  cancelOAuth,
  type ZoteroCollection,
} from "@/lib/zotero-api";
import { useDocumentStore } from "@/stores/document-store";
import { createFileOnDisk } from "@/lib/tauri/fs";
import { createLogger } from "@/lib/debug/logger";
import {
  canonicalProjectPath,
  type ProjectFsOwner,
  ownsProjectFsState,
  runProjectFsOperation,
} from "@/lib/project-fs-operations";

const log = createLogger("zotero");

/** Per-collection sync metadata (persisted) */
export interface CollectionSyncInfo {
  collectionKey: string | null; // null = "My Library"
  name: string;
  bibFileName: string;
  libraryVersion: number;
  keyMap: Record<string, string>;
}

/** Synced collections scoped per project path */
type ProjectSyncedCollections = Record<
  string,
  Record<string, CollectionSyncInfo>
>;

interface ZoteroState {
  // Persisted
  apiKey: string | null;
  userID: string | null;
  username: string | null;
  /** Synced collections keyed by projectPath → collectionKey */
  syncedCollections: ProjectSyncedCollections;

  // Transient
  isAuthenticated: boolean;
  isValidating: boolean;
  isSyncing: string | null; // collectionKey currently syncing, or null
  syncProgress: { loaded: number; total: number; writing?: boolean } | null;
  error: string | null;
  collections: ZoteroCollection[];
  isLoadingCollections: boolean;
  /** Request currently allowed to own the global sync progress indicator. */
  activeSyncRequestId: number | null;
  /** Mounted project that owns the global sync progress indicator. */
  activeSyncProjectOwner: ProjectFsOwner | null;

  connectWithOAuth: () => Promise<boolean>;
  connectWithApiKey: (apiKey: string) => Promise<boolean>;
  cancelConnect: () => void;
  disconnect: () => void;
  revalidate: () => Promise<void>;
  loadCollections: () => Promise<void>;
  importCollectionToBib: (
    collectionKey: string | null,
    name: string,
  ) => Promise<void>;
  syncCollectionBib: (collectionKey: string | null) => Promise<void>;
  removeCollection: (collectionKey: string | null) => void;
  renameSyncedBibFile: (
    oldName: string,
    newName: string,
    projectRoot?: string | null,
  ) => void;
}

const MYLIB_KEY = "__my_library__";
let nextSyncRequestId = 0;
const latestCollectionRequests = new Map<string, number>();
let accountGeneration = 0;
let nextCollectionsRequestId = 0;
let latestCollectionsRequestId = 0;

interface AccountRequestOwner {
  generation: number;
}

interface AccountSnapshot extends AccountRequestOwner {
  apiKey: string;
  userID: string;
}

interface CollectionsRequest extends AccountSnapshot {
  id: number;
}

interface ProjectSyncRequest {
  id: number;
  key: string;
  owner: ProjectFsOwner;
}

function storeKey(collectionKey: string | null): string {
  return collectionKey ?? MYLIB_KEY;
}

function beginAccountRequest(): AccountRequestOwner {
  return { generation: ++accountGeneration };
}

function ownsAccountRequest(request: AccountRequestOwner): boolean {
  return request.generation === accountGeneration;
}

function captureAccountSnapshot(): AccountSnapshot | null {
  const { apiKey, userID } = useZoteroStore.getState();
  if (!apiKey || !userID) return null;
  return { generation: accountGeneration, apiKey, userID };
}

function beginCollectionsRequest(account: AccountSnapshot): CollectionsRequest {
  const request = { ...account, id: ++nextCollectionsRequestId };
  latestCollectionsRequestId = request.id;
  return request;
}

function ownsAccountSnapshot(request: AccountSnapshot): boolean {
  const state = useZoteroStore.getState();
  return (
    ownsAccountRequest(request) &&
    state.apiKey === request.apiKey &&
    state.userID === request.userID
  );
}

function ownsCollectionsRequest(request: CollectionsRequest): boolean {
  return (
    request.id === latestCollectionsRequestId && ownsAccountSnapshot(request)
  );
}

function projectStoreKey(projectRoot: string): string {
  return canonicalProjectPath(projectRoot);
}

function projectCollections(
  allCollections: ProjectSyncedCollections,
  projectRoot: string,
): Record<string, CollectionSyncInfo> {
  const key = projectStoreKey(projectRoot);
  if (allCollections[key]) return allCollections[key];
  return (
    Object.entries(allCollections).find(
      ([candidate]) => projectStoreKey(candidate) === key,
    )?.[1] ?? {}
  );
}

function withProjectCollections(
  allCollections: ProjectSyncedCollections,
  projectRoot: string,
  collections: Record<string, CollectionSyncInfo>,
): ProjectSyncedCollections {
  const key = projectStoreKey(projectRoot);
  const next: ProjectSyncedCollections = {};
  for (const [candidate, value] of Object.entries(allCollections)) {
    if (projectStoreKey(candidate) !== key) next[candidate] = value;
  }
  next[key] = collections;
  return next;
}

function normalizeProjectCollections(
  allCollections: ProjectSyncedCollections,
): ProjectSyncedCollections {
  const normalized: ProjectSyncedCollections = {};
  for (const [projectRoot, collections] of Object.entries(allCollections)) {
    const key = projectStoreKey(projectRoot);
    normalized[key] = { ...(normalized[key] ?? {}), ...collections };
  }
  return normalized;
}

function fileBaseName(file: { name?: string; relativePath?: string }): string {
  return (
    file.name?.trim() || file.relativePath?.split(/[\\/]/).pop()?.trim() || ""
  );
}

function sameBibFileName(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function listProjectBibFileNames(
  files:
    | ReadonlyArray<{
        name?: string;
        relativePath?: string;
        type?: string;
      }>
    | undefined,
): string[] {
  if (!files) return [];
  const names: string[] = [];
  for (const file of files) {
    const name = fileBaseName(file);
    const isBib =
      file.type === "bib" ||
      name.toLowerCase().endsWith(".bib") ||
      file.relativePath?.toLowerCase().endsWith(".bib") === true;
    if (isBib && name) names.push(name);
  }
  return names;
}

function reconcileRenamedBibFiles(
  current: {
    projectRoot: string | null;
    projectGeneration: number;
    files?: ReadonlyArray<{
      name?: string;
      relativePath?: string;
      type?: string;
    }>;
  },
  previous: {
    projectRoot: string | null;
    projectGeneration: number;
    files?: ReadonlyArray<{
      name?: string;
      relativePath?: string;
      type?: string;
    }>;
  },
): void {
  if (
    !current.projectRoot ||
    !previous.projectRoot ||
    current.projectRoot !== previous.projectRoot ||
    current.projectGeneration !== previous.projectGeneration
  ) {
    return;
  }
  const previousNames = listProjectBibFileNames(previous.files);
  const currentNames = listProjectBibFileNames(current.files);
  const removed = previousNames.filter(
    (name) =>
      !currentNames.some((candidate) => sameBibFileName(candidate, name)),
  );
  const added = currentNames.filter(
    (name) =>
      !previousNames.some((candidate) => sameBibFileName(candidate, name)),
  );
  if (removed.length === 1 && added.length === 1 && removed[0] !== added[0]) {
    useZoteroStore
      .getState()
      .renameSyncedBibFile(removed[0], added[0], current.projectRoot);
  }
}

function captureProjectOwner(): ProjectFsOwner | null {
  const state = useDocumentStore.getState();
  if (!state.projectRoot || state.isProjectMutating) return null;
  return {
    projectRoot: state.projectRoot,
    projectGeneration: state.projectGeneration,
  };
}

function makeRequestKey(owner: ProjectFsOwner, sk: string): string {
  return `${canonicalProjectPath(owner.projectRoot)}\0${owner.projectGeneration}\0${sk}`;
}

function beginProjectSyncRequest(
  owner: ProjectFsOwner,
  sk: string,
): ProjectSyncRequest {
  const request: ProjectSyncRequest = {
    id: ++nextSyncRequestId,
    key: makeRequestKey(owner, sk),
    owner,
  };
  latestCollectionRequests.set(request.key, request.id);
  return request;
}

function isLatestProjectRequest(request: ProjectSyncRequest): boolean {
  return latestCollectionRequests.get(request.key) === request.id;
}

function ownsMountedProject(request: ProjectSyncRequest): boolean {
  const state = useDocumentStore.getState();
  return (
    isLatestProjectRequest(request) &&
    !state.isProjectMutating &&
    ownsProjectFsState(request.owner, state)
  );
}

function rootBibFilePath(owner: ProjectFsOwner, bibFileName: string): string {
  const root = canonicalProjectPath(owner.projectRoot);
  return canonicalProjectPath(
    root.endsWith("/") ? `${root}${bibFileName}` : `${root}/${bibFileName}`,
  );
}

function findOwnedBibFile(request: ProjectSyncRequest, bibFileName: string) {
  if (!ownsMountedProject(request)) return null;
  const expectedPath = rootBibFilePath(request.owner, bibFileName);
  const files = useDocumentStore.getState().files;
  const exact = files.find(
    (file) =>
      file.type === "bib" &&
      canonicalProjectPath(file.absolutePath) === expectedPath,
  );
  if (exact) return exact;

  const rootBibs = files.filter((file) => {
    const name = fileBaseName(file);
    const isBib =
      file.type === "bib" ||
      name.toLowerCase().endsWith(".bib") ||
      file.relativePath.toLowerCase().endsWith(".bib");
    const dir = file.relativePath.includes("/")
      ? file.relativePath.substring(0, file.relativePath.lastIndexOf("/"))
      : "";
    return isBib && dir === "";
  });
  if (rootBibs.length !== 1) return null;
  const remapped = rootBibs[0];
  if (sameBibFileName(fileBaseName(remapped), bibFileName)) return remapped;
  useZoteroStore
    .getState()
    .renameSyncedBibFile(
      bibFileName,
      fileBaseName(remapped),
      request.owner.projectRoot,
    );
  return remapped;
}

function sanitizeFileName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_\-\s]/g, "")
    .replace(/\s+/g, "-")
    .toLowerCase();
}

const STARTING_SYNC_PROGRESS = { loaded: 0, total: 0 } as const;

function writingSyncProgress(
  current: { loaded: number; total: number } | null,
): { loaded: number; total: number; writing: true } {
  return {
    loaded: current?.loaded ?? 0,
    total: current?.total ?? 0,
    writing: true,
  };
}

/** Parse a .bib file into a map of citekey → full entry string */
function parseBibEntries(content: string): Map<string, string> {
  const entries = new Map<string, string>();
  const parts = content.split(/\n(?=@)/);
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/@\w+\{([^,\s]+)/);
    if (match) {
      entries.set(match[1], trimmed);
    }
  }
  return entries;
}

export const useZoteroStore = create<ZoteroState>()(
  persist(
    (set, get) => ({
      apiKey: null,
      userID: null,
      username: null,
      syncedCollections: {},

      isAuthenticated: false,
      isValidating: false,
      isSyncing: null,
      syncProgress: null,
      error: null,
      collections: [],
      isLoadingCollections: false,
      activeSyncRequestId: null,
      activeSyncProjectOwner: null,

      connectWithOAuth: async () => {
        const request = beginAccountRequest();
        log.info("Starting OAuth connection");
        set({ isValidating: true, isLoadingCollections: false, error: null });
        try {
          await startOAuth();
          if (!ownsAccountRequest(request)) return false;
          const creds = await completeOAuth();
          if (!ownsAccountRequest(request)) return false;
          log.info(`OAuth connected as ${creds.username}`);
          latestCollectionRequests.clear();
          set({
            apiKey: creds.apiKey,
            userID: creds.userID,
            username: creds.username,
            isAuthenticated: true,
            isValidating: false,
            activeSyncRequestId: null,
            activeSyncProjectOwner: null,
            isSyncing: null,
            syncProgress: null,
          });
          // Auto-load collections after connecting
          void get().loadCollections();
          return true;
        } catch (err) {
          if (!ownsAccountRequest(request)) return false;
          set({
            error: err instanceof Error ? err.message : "Connection failed",
            isValidating: false,
          });
          return false;
        }
      },

      connectWithApiKey: async (apiKey: string) => {
        const request = beginAccountRequest();
        set({ isValidating: true, isLoadingCollections: false, error: null });
        try {
          const creds = await validateApiKey(apiKey);
          if (!ownsAccountRequest(request)) return false;
          latestCollectionRequests.clear();
          set({
            apiKey: creds.apiKey,
            userID: creds.userID,
            username: creds.username,
            isAuthenticated: true,
            isValidating: false,
            activeSyncRequestId: null,
            activeSyncProjectOwner: null,
            isSyncing: null,
            syncProgress: null,
          });
          void get().loadCollections();
          return true;
        } catch (err) {
          if (!ownsAccountRequest(request)) return false;
          set({
            error: err instanceof Error ? err.message : "Connection failed",
            isValidating: false,
          });
          return false;
        }
      },

      cancelConnect: () => {
        beginAccountRequest();
        cancelOAuth().catch(() => {});
        set({
          isValidating: false,
          isLoadingCollections: false,
          error: null,
        });
      },

      disconnect: () => {
        beginAccountRequest();
        latestCollectionsRequestId = ++nextCollectionsRequestId;
        latestCollectionRequests.clear();
        set({
          apiKey: null,
          userID: null,
          username: null,
          syncedCollections: {},
          isAuthenticated: false,
          error: null,
          collections: [],
          isValidating: false,
          isLoadingCollections: false,
          activeSyncRequestId: null,
          activeSyncProjectOwner: null,
          isSyncing: null,
          syncProgress: null,
        });
      },

      revalidate: async () => {
        const account = captureAccountSnapshot();
        if (!account) return;
        try {
          const creds = await validateApiKey(account.apiKey);
          if (!ownsAccountSnapshot(account)) return;
          log.debug(`Revalidated as ${creds.username}`);
          set({
            userID: creds.userID,
            username: creds.username,
            isAuthenticated: true,
          });
          void get().loadCollections();
        } catch (err) {
          if (!ownsAccountSnapshot(account)) return;
          log.warn("Revalidation failed", { error: String(err) });
          set({ isAuthenticated: false });
        }
      },

      loadCollections: async () => {
        const account = captureAccountSnapshot();
        if (!account) return;
        const request = beginCollectionsRequest(account);
        set({ isLoadingCollections: true });
        try {
          const collections = await fetchCollections(
            request.apiKey,
            request.userID,
          );
          if (!ownsCollectionsRequest(request)) return;
          log.debug(`Loaded ${collections.length} collections`);
          set({ collections, isLoadingCollections: false });
        } catch (err) {
          if (!ownsCollectionsRequest(request)) return;
          log.error("Failed to load collections", { error: String(err) });
          set({ isLoadingCollections: false });
        }
      },

      importCollectionToBib: async (collectionKey, name) => {
        const { apiKey, userID } = get();
        if (!apiKey || !userID) return;

        const owner = captureProjectOwner();
        if (!owner) return;
        const sk = storeKey(collectionKey);
        const request = beginProjectSyncRequest(owner, sk);
        set({
          activeSyncRequestId: request.id,
          activeSyncProjectOwner: request.owner,
          isSyncing: sk,
          syncProgress: { ...STARTING_SYNC_PROGRESS },
          error: null,
        });

        try {
          const result = await importCollection(
            apiKey,
            userID,
            collectionKey,
            (loaded, total) => {
              if (!ownsMountedProject(request)) return;
              set((state) =>
                state.activeSyncRequestId === request.id
                  ? { syncProgress: { loaded, total } }
                  : {},
              );
            },
          );

          // The network request is deliberately outside the filesystem
          // registry. Re-authorize its project immediately before committing.
          if (!ownsMountedProject(request)) return;
          set((state) =>
            state.activeSyncRequestId === request.id
              ? { syncProgress: writingSyncProgress(state.syncProgress) }
              : {},
          );

          // Determine .bib file name
          const bibFileName = `${sanitizeFileName(name)}.bib`;

          // Re-read the mounted project after the network await. Never use the
          // document snapshot captured when the request started.
          const existingFile = findOwnedBibFile(request, bibFileName);
          if (existingFile) {
            useDocumentStore
              .getState()
              .updateFileContent(existingFile.id, result.bibtex);
          } else {
            const fullPath = await runProjectFsOperation(request.owner, () =>
              createFileOnDisk(
                request.owner.projectRoot,
                bibFileName,
                result.bibtex,
              ),
            );
            if (
              !ownsMountedProject(request) ||
              canonicalProjectPath(fullPath) !==
                rootBibFilePath(request.owner, bibFileName)
            ) {
              return;
            }
            useDocumentStore.getState().addFile({
              name: bibFileName,
              relativePath: bibFileName,
              absolutePath: fullPath,
              type: "bib",
              content: result.bibtex,
            });
          }

          if (!ownsMountedProject(request)) return;

          // Store sync info scoped to current project
          const syncInfo: CollectionSyncInfo = {
            collectionKey,
            name,
            bibFileName,
            libraryVersion: result.libraryVersion,
            keyMap: result.keyMap,
          };
          set((s) => {
            if (!ownsMountedProject(request)) return {};
            const projectColls = projectCollections(
              s.syncedCollections,
              request.owner.projectRoot,
            );
            return {
              syncedCollections: withProjectCollections(
                s.syncedCollections,
                request.owner.projectRoot,
                { ...projectColls, [sk]: syncInfo },
              ),
            };
          });
          if (ownsMountedProject(request)) {
            void get().loadCollections();
            if (get().activeSyncRequestId === request.id) {
              toast.success(`Imported ${name}`);
            }
          }
        } catch (err) {
          if (ownsMountedProject(request)) {
            const message =
              err instanceof Error ? err.message : "Import failed";
            set((state) =>
              state.activeSyncRequestId === request.id
                ? { error: message }
                : {},
            );
            if (get().activeSyncRequestId === request.id) {
              toast.error(message);
            }
          }
        } finally {
          if (isLatestProjectRequest(request)) {
            latestCollectionRequests.delete(request.key);
          }
          set((state) =>
            state.activeSyncRequestId === request.id
              ? {
                  activeSyncRequestId: null,
                  activeSyncProjectOwner: null,
                  isSyncing: null,
                  syncProgress: null,
                }
              : {},
          );
        }
      },

      syncCollectionBib: async (collectionKey) => {
        const { apiKey, userID, syncedCollections } = get();
        if (!apiKey || !userID) return;

        const owner = captureProjectOwner();
        if (!owner) return;
        const sk = storeKey(collectionKey);
        const projectColls = projectCollections(
          syncedCollections,
          owner.projectRoot,
        );
        const syncInfo = projectColls[sk];
        if (!syncInfo) return;

        const request = beginProjectSyncRequest(owner, sk);
        const bibFile = findOwnedBibFile(request, syncInfo.bibFileName);
        if (!bibFile) {
          if (isLatestProjectRequest(request)) {
            latestCollectionRequests.delete(request.key);
          }
          return;
        }

        set({
          activeSyncRequestId: request.id,
          activeSyncProjectOwner: request.owner,
          isSyncing: sk,
          syncProgress: { ...STARTING_SYNC_PROGRESS },
          error: null,
        });

        try {
          const result = await syncCollection(
            apiKey,
            userID,
            collectionKey,
            syncInfo.libraryVersion,
            (loaded, total) => {
              if (!ownsMountedProject(request)) return;
              set((state) =>
                state.activeSyncRequestId === request.id
                  ? { syncProgress: { loaded, total } }
                  : {},
              );
            },
          );

          if (!ownsMountedProject(request)) return;
          const currentSyncInfo = projectCollections(
            get().syncedCollections,
            request.owner.projectRoot,
          )[sk];
          if (!currentSyncInfo) return;
          const currentBibFile = findOwnedBibFile(
            request,
            currentSyncInfo.bibFileName,
          );
          if (!currentBibFile) return;
          set((state) =>
            state.activeSyncRequestId === request.id
              ? { syncProgress: writingSyncProgress(state.syncProgress) }
              : {},
          );

          if (collectionKey) {
            // For specific collections, syncCollection returns a full re-import
            // Rebuild the .bib content from all entries
            const newKeyMap: Record<string, string> = {};
            const entries: string[] = [];
            for (const entry of result.updatedEntries) {
              if (entry.bibtex.trim()) {
                entries.push(entry.bibtex);
                newKeyMap[entry.key] = entry.citekey;
              }
            }
            const updatedContent = `${entries.join("\n\n")}\n`;
            useDocumentStore
              .getState()
              .updateFileContent(currentBibFile.id, updatedContent);

            set((s) => {
              if (!ownsMountedProject(request)) return {};
              const pColls = projectCollections(
                s.syncedCollections,
                request.owner.projectRoot,
              );
              return {
                syncedCollections: withProjectCollections(
                  s.syncedCollections,
                  request.owner.projectRoot,
                  {
                    ...pColls,
                    [sk]: {
                      ...currentSyncInfo,
                      libraryVersion: result.libraryVersion,
                      keyMap: newKeyMap,
                    },
                  },
                ),
              };
            });
          } else {
            // For "My Library", apply incremental diff
            const currentContent = currentBibFile.content ?? "";
            const entries = parseBibEntries(currentContent);
            const newKeyMap = { ...currentSyncInfo.keyMap };

            for (const entry of result.updatedEntries) {
              const oldCitekey = newKeyMap[entry.key];
              if (oldCitekey && oldCitekey !== entry.citekey) {
                entries.delete(oldCitekey);
              }
              entries.set(entry.citekey, entry.bibtex);
              newKeyMap[entry.key] = entry.citekey;
            }

            for (const deletedKey of result.deletedKeys) {
              const citekey = newKeyMap[deletedKey];
              if (citekey) {
                entries.delete(citekey);
                delete newKeyMap[deletedKey];
              }
            }

            const updatedContent = `${Array.from(entries.values()).join("\n\n")}\n`;
            useDocumentStore
              .getState()
              .updateFileContent(currentBibFile.id, updatedContent);

            set((s) => {
              if (!ownsMountedProject(request)) return {};
              const pColls = projectCollections(
                s.syncedCollections,
                request.owner.projectRoot,
              );
              return {
                syncedCollections: withProjectCollections(
                  s.syncedCollections,
                  request.owner.projectRoot,
                  {
                    ...pColls,
                    [sk]: {
                      ...currentSyncInfo,
                      libraryVersion: result.libraryVersion,
                      keyMap: newKeyMap,
                    },
                  },
                ),
              };
            });
          }
          if (ownsMountedProject(request)) {
            void get().loadCollections();
            if (get().activeSyncRequestId === request.id) {
              toast.success(`Synced ${currentSyncInfo.name}`);
            }
          }
        } catch (err) {
          if (ownsMountedProject(request)) {
            const message = err instanceof Error ? err.message : "Sync failed";
            set((state) =>
              state.activeSyncRequestId === request.id
                ? { error: message }
                : {},
            );
            if (get().activeSyncRequestId === request.id) {
              toast.error(message);
            }
          }
        } finally {
          if (isLatestProjectRequest(request)) {
            latestCollectionRequests.delete(request.key);
          }
          set((state) =>
            state.activeSyncRequestId === request.id
              ? {
                  activeSyncRequestId: null,
                  activeSyncProjectOwner: null,
                  isSyncing: null,
                  syncProgress: null,
                }
              : {},
          );
        }
      },

      removeCollection: (collectionKey) => {
        const owner = captureProjectOwner();
        if (!owner) return;
        const sk = storeKey(collectionKey);
        const requestKey = makeRequestKey(owner, sk);
        const invalidatedRequestId = latestCollectionRequests.get(requestKey);
        latestCollectionRequests.delete(requestKey);
        set((s) => {
          const documentState = useDocumentStore.getState();
          if (
            documentState.isProjectMutating ||
            !ownsProjectFsState(owner, documentState)
          ) {
            return {};
          }
          const projectColls = projectCollections(
            s.syncedCollections,
            owner.projectRoot,
          );
          const { [sk]: _, ...rest } = projectColls;
          return {
            syncedCollections: withProjectCollections(
              s.syncedCollections,
              owner.projectRoot,
              rest,
            ),
            ...(s.activeSyncRequestId === invalidatedRequestId
              ? {
                  activeSyncRequestId: null,
                  activeSyncProjectOwner: null,
                  isSyncing: null,
                  syncProgress: null,
                }
              : {}),
          };
        });
      },

      renameSyncedBibFile: (oldName, newName, projectRoot) => {
        const root =
          projectRoot?.trim() || captureProjectOwner()?.projectRoot || null;
        if (!root) return;
        const from = oldName.trim().split(/[\\/]/).pop() ?? "";
        const to = newName.trim().split(/[\\/]/).pop() ?? "";
        if (!from || !to || from === to) return;
        set((s) => {
          const projectColls = projectCollections(s.syncedCollections, root);
          let changed = false;
          const next: Record<string, CollectionSyncInfo> = {};
          for (const [key, info] of Object.entries(projectColls)) {
            if (sameBibFileName(info.bibFileName, from)) {
              next[key] = { ...info, bibFileName: to };
              changed = true;
            } else {
              next[key] = info;
            }
          }
          if (!changed) return {};
          return {
            syncedCollections: withProjectCollections(
              s.syncedCollections,
              root,
              next,
            ),
          };
        });
      },
    }),
    {
      name: "claude-prism-zotero",
      partialize: (state) => ({
        apiKey: state.apiKey,
        userID: state.userID,
        username: state.username,
        syncedCollections: normalizeProjectCollections(state.syncedCollections),
      }),
      onRehydrateStorage: () => (state) => {
        if (state) {
          state.syncedCollections = normalizeProjectCollections(
            state.syncedCollections ?? {},
          );
        }
        if (state?.apiKey) {
          state.isAuthenticated = true;
        }
      },
    },
  ),
);

useDocumentStore.subscribe((documentState, previousDocumentState) => {
  if (
    documentState.projectRoot === previousDocumentState.projectRoot &&
    documentState.projectGeneration === previousDocumentState.projectGeneration
  ) {
    reconcileRenamedBibFiles(documentState, previousDocumentState);
    return;
  }
  const activeOwner = useZoteroStore.getState().activeSyncProjectOwner;
  if (!activeOwner || ownsProjectFsState(activeOwner, documentState)) return;
  useZoteroStore.setState({
    activeSyncRequestId: null,
    activeSyncProjectOwner: null,
    isSyncing: null,
    syncProgress: null,
  });
});
