import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { createLogger } from "@/lib/debug/logger";
import {
  canonicalProjectPath,
  runProjectFsOperation,
  runProjectFsOperationAfterDrain,
  type ProjectFsOwner,
} from "@/lib/project-fs-operations";
import { useDocumentStore } from "@/stores/document-store";

const log = createLogger("history");

export interface SnapshotInfo {
  id: string;
  message: string;
  timestamp: number;
  labels: string[];
  changed_files: string[];
}

export interface FileDiff {
  file_path: string;
  status: "added" | "modified" | "deleted";
  old_content: string | null;
  new_content: string | null;
}

interface HistoryRequestOwner extends ProjectFsOwner {
  requestId: number;
}

interface HistoryState {
  projectRoot: string | null;
  projectGeneration: number;
  isProjectMutating: boolean;
  snapshots: SnapshotInfo[];
  isLoading: boolean;
  listRequestId: number;
  selectedSnapshotId: string | null;
  diffResult: FileDiff[] | null;
  isDiffLoading: boolean;
  diffRequestId: number;
  isRestoring: boolean;
  restoreRequestId: number;
  reviewingSnapshot: SnapshotInfo | null;

  bindProject: (
    projectRoot: string | null,
    projectGeneration: number,
    isProjectMutating: boolean,
  ) => void;
  init: (projectRoot: string) => Promise<void>;
  createSnapshot: (
    projectRoot: string,
    message: string,
  ) => Promise<SnapshotInfo | null>;
  loadSnapshots: (projectRoot: string) => Promise<void>;
  loadMoreSnapshots: (projectRoot: string) => Promise<void>;
  selectSnapshot: (id: string | null) => void;
  loadDiff: (
    projectRoot: string,
    fromId: string,
    toId: string,
  ) => Promise<void>;
  getFileAt: (
    projectRoot: string,
    snapshotId: string,
    filePath: string,
  ) => Promise<string>;
  restoreSnapshot: (
    projectRoot: string,
    snapshotId: string,
  ) => Promise<SnapshotInfo>;
  addLabel: (
    projectRoot: string,
    snapshotId: string,
    label: string,
  ) => Promise<void>;
  removeLabel: (projectRoot: string, label: string) => Promise<void>;
  startReview: (snapshot: SnapshotInfo) => void;
  stopReview: () => void;
  reset: () => void;
}

const PAGE_SIZE = 50;
let nextRequestId = 0;
const initRequests = new Map<string, Promise<void>>();
const mutationQueues = new Map<string, Promise<void>>();
let activeRestoreBarrier: HistoryRequestOwner | null = null;

function nextHistoryRequestId(): number {
  nextRequestId += 1;
  return nextRequestId;
}

function sameOwner(
  state: Pick<HistoryState, "projectRoot" | "projectGeneration">,
  owner: ProjectFsOwner,
): boolean {
  return (
    state.projectRoot === owner.projectRoot &&
    state.projectGeneration === owner.projectGeneration
  );
}

function documentOwnsProject(
  owner: ProjectFsOwner,
  allowMutation = false,
): boolean {
  const document = useDocumentStore.getState();
  return (
    document.projectRoot === owner.projectRoot &&
    document.projectGeneration === owner.projectGeneration &&
    (allowMutation || !document.isProjectMutating)
  );
}

function captureOwner(
  state: HistoryState,
  projectRoot: string,
): ProjectFsOwner | null {
  if (
    state.projectRoot !== projectRoot ||
    state.isProjectMutating ||
    !documentOwnsProject({
      projectRoot,
      projectGeneration: state.projectGeneration,
    })
  ) {
    return null;
  }
  return { projectRoot, projectGeneration: state.projectGeneration };
}

function ownsRequest(
  state: HistoryState,
  request: HistoryRequestOwner,
  requestKind: "list" | "diff" | "restore",
  allowMutation = false,
): boolean {
  const requestId =
    requestKind === "list"
      ? state.listRequestId
      : requestKind === "diff"
        ? state.diffRequestId
        : state.restoreRequestId;
  if (!sameOwner(state, request) || requestId !== request.requestId) {
    return false;
  }
  if (requestKind !== "restore") {
    // A short same-owner filesystem barrier does not invalidate immutable Git
    // reads. Let the latest request settle so its loading flag cannot stick.
    return documentOwnsProject(request, true);
  }
  return (
    (allowMutation || !state.isProjectMutating) &&
    documentOwnsProject(request, allowMutation)
  );
}

function inactiveProjectError(): Error {
  return new Error("History operation belongs to an inactive project mutation");
}

function initKey(owner: ProjectFsOwner): string {
  return `${owner.projectGeneration}\0${owner.projectRoot}`;
}

function runHistoryMutation<T>(
  owner: ProjectFsOwner,
  operation: () => Promise<T>,
  drainRoots?: Array<string | null>,
): Promise<T> {
  const enqueue = () => {
    const key = canonicalProjectPath(owner.projectRoot);
    const previous = mutationQueues.get(key);
    let queued: Promise<T>;
    if (previous) {
      queued = previous.then(operation);
    } else {
      try {
        queued = operation();
      } catch (error) {
        queued = Promise.reject(error);
      }
    }
    const settled = queued.then(
      () => undefined,
      () => undefined,
    );
    mutationQueues.set(key, settled);
    void settled.then(() => {
      if (mutationQueues.get(key) === settled) {
        mutationQueues.delete(key);
      }
    });
    return queued;
  };
  return drainRoots
    ? runProjectFsOperationAfterDrain(owner, drainRoots, enqueue)
    : runProjectFsOperation(owner, enqueue);
}

export const useHistoryStore = create<HistoryState>()((set, get) => ({
  projectRoot: null,
  projectGeneration: 0,
  isProjectMutating: false,
  snapshots: [],
  isLoading: false,
  listRequestId: 0,
  selectedSnapshotId: null,
  diffResult: null,
  isDiffLoading: false,
  diffRequestId: 0,
  isRestoring: false,
  restoreRequestId: 0,
  reviewingSnapshot: null,

  bindProject: (projectRoot, projectGeneration, isProjectMutating) => {
    set((state) => {
      if (
        state.projectRoot === projectRoot &&
        state.projectGeneration === projectGeneration
      ) {
        return { isProjectMutating };
      }
      return {
        projectRoot,
        projectGeneration,
        isProjectMutating,
        snapshots: [],
        isLoading: false,
        listRequestId: nextHistoryRequestId(),
        selectedSnapshotId: null,
        diffResult: null,
        isDiffLoading: false,
        diffRequestId: nextHistoryRequestId(),
        isRestoring: false,
        restoreRequestId: nextHistoryRequestId(),
        reviewingSnapshot: null,
      };
    });
  },

  startReview: (snapshot) => {
    set({ reviewingSnapshot: snapshot });
  },

  stopReview: () => {
    set({ reviewingSnapshot: null, diffResult: null });
  },

  init: async (projectRoot) => {
    const owner = captureOwner(get(), projectRoot);
    if (!owner) return;
    const key = initKey(owner);
    const existing = initRequests.get(key);
    if (existing) return existing;

    log.debug(`Initializing history for ${projectRoot}`);
    const initialization = runHistoryMutation(owner, () =>
      invoke<void>("history_init", { projectRoot }),
    );
    initRequests.set(key, initialization);
    try {
      await initialization;
    } finally {
      if (initRequests.get(key) === initialization) {
        initRequests.delete(key);
      }
    }
  },

  createSnapshot: async (projectRoot, message) => {
    const owner = captureOwner(get(), projectRoot);
    if (!owner) return null;
    log.debug(`Creating snapshot: ${message}`);
    const result = await runHistoryMutation(owner, () =>
      invoke<SnapshotInfo | null>("history_snapshot", {
        projectRoot,
        message,
      }),
    );
    if (result && sameOwner(get(), owner) && documentOwnsProject(owner)) {
      log.info(`Snapshot created: ${result.id.slice(0, 8)}`);
      set((state) =>
        sameOwner(state, owner) && !state.isProjectMutating
          ? {
              snapshots: state.snapshots.some(
                (snapshot) => snapshot.id === result.id,
              )
                ? state.snapshots
                : [result, ...state.snapshots],
            }
          : {},
      );
    }
    return result;
  },

  loadSnapshots: async (projectRoot) => {
    const owner = captureOwner(get(), projectRoot);
    if (!owner) return;
    const request: HistoryRequestOwner = {
      ...owner,
      requestId: nextHistoryRequestId(),
    };
    set((state) =>
      sameOwner(state, owner)
        ? { isLoading: true, listRequestId: request.requestId }
        : {},
    );
    try {
      const snapshots = await invoke<SnapshotInfo[]>("history_list", {
        projectRoot,
        limit: PAGE_SIZE,
        offset: 0,
      });
      set((state) =>
        ownsRequest(state, request, "list") ? { snapshots } : {},
      );
    } finally {
      set((state) =>
        ownsRequest(state, request, "list") ? { isLoading: false } : {},
      );
    }
  },

  loadMoreSnapshots: async (projectRoot) => {
    const state = get();
    const owner = captureOwner(state, projectRoot);
    if (!owner || state.isLoading) return;
    const offset = state.snapshots.length;
    const request: HistoryRequestOwner = {
      ...owner,
      requestId: nextHistoryRequestId(),
    };
    set((current) =>
      sameOwner(current, owner)
        ? { isLoading: true, listRequestId: request.requestId }
        : {},
    );
    try {
      const more = await invoke<SnapshotInfo[]>("history_list", {
        projectRoot,
        limit: PAGE_SIZE,
        offset,
      });
      if (more.length > 0) {
        set((current) =>
          ownsRequest(current, request, "list")
            ? {
                snapshots: [
                  ...current.snapshots,
                  ...more.filter(
                    (snapshot) =>
                      !current.snapshots.some(
                        (existing) => existing.id === snapshot.id,
                      ),
                  ),
                ],
              }
            : {},
        );
      }
    } finally {
      set((current) =>
        ownsRequest(current, request, "list") ? { isLoading: false } : {},
      );
    }
  },

  selectSnapshot: (id) => {
    set({ selectedSnapshotId: id, diffResult: null });
  },

  loadDiff: async (projectRoot, fromId, toId) => {
    const owner = captureOwner(get(), projectRoot);
    if (!owner) return;
    const request: HistoryRequestOwner = {
      ...owner,
      requestId: nextHistoryRequestId(),
    };
    set((state) =>
      sameOwner(state, owner)
        ? {
            isDiffLoading: true,
            diffResult: null,
            diffRequestId: request.requestId,
          }
        : {},
    );
    try {
      const diffResult = await invoke<FileDiff[]>("history_diff", {
        projectRoot,
        fromId,
        toId,
      });
      set((state) =>
        ownsRequest(state, request, "diff") ? { diffResult } : {},
      );
    } finally {
      set((state) =>
        ownsRequest(state, request, "diff") ? { isDiffLoading: false } : {},
      );
    }
  },

  getFileAt: async (projectRoot, snapshotId, filePath) => {
    const owner = captureOwner(get(), projectRoot);
    if (!owner) throw inactiveProjectError();
    const content = await invoke<string>("history_file_at", {
      projectRoot,
      snapshotId,
      filePath,
    });
    if (!sameOwner(get(), owner) || !documentOwnsProject(owner)) {
      throw inactiveProjectError();
    }
    return content;
  },

  restoreSnapshot: async (projectRoot, snapshotId) => {
    const owner = captureOwner(get(), projectRoot);
    if (!owner || activeRestoreBarrier) throw inactiveProjectError();
    const request: HistoryRequestOwner = {
      ...owner,
      requestId: nextHistoryRequestId(),
    };

    let acquiredDocumentBarrier = false;
    useDocumentStore.setState((document) => {
      if (
        document.projectRoot !== owner.projectRoot ||
        document.projectGeneration !== owner.projectGeneration ||
        document.isProjectMutating
      ) {
        return {};
      }
      acquiredDocumentBarrier = true;
      return { isProjectMutating: true };
    });
    if (!acquiredDocumentBarrier) throw inactiveProjectError();

    let acquiredHistoryBarrier = false;
    set((state) => {
      if (!sameOwner(state, owner) || state.isProjectMutating) return {};
      acquiredHistoryBarrier = true;
      return {
        isProjectMutating: true,
        isRestoring: true,
        restoreRequestId: request.requestId,
      };
    });
    if (!acquiredHistoryBarrier) {
      useDocumentStore.setState((document) =>
        document.projectRoot === owner.projectRoot &&
        document.projectGeneration === owner.projectGeneration &&
        document.isProjectMutating
          ? { isProjectMutating: false }
          : {},
      );
      throw inactiveProjectError();
    }
    activeRestoreBarrier = request;

    try {
      const result = await runHistoryMutation(owner, async () => {
        if (
          !ownsRequest(get(), request, "restore", true) ||
          activeRestoreBarrier !== request
        ) {
          throw inactiveProjectError();
        }
        log.info(`Restoring snapshot: ${snapshotId.slice(0, 8)}`);
        return invoke<SnapshotInfo>("history_restore", {
          projectRoot,
          snapshotId,
        });
      }, [projectRoot]);
      if (ownsRequest(get(), request, "restore", true)) {
        log.info(`Restored snapshot, new snapshot: ${result.id.slice(0, 8)}`);
        set((state) =>
          ownsRequest(state, request, "restore", true)
            ? { snapshots: [result, ...state.snapshots] }
            : {},
        );
      }
      return result;
    } finally {
      if (activeRestoreBarrier === request) {
        activeRestoreBarrier = null;
        set((state) =>
          ownsRequest(state, request, "restore", true)
            ? { isRestoring: false, isProjectMutating: false }
            : {},
        );
        useDocumentStore.setState((document) =>
          document.projectRoot === owner.projectRoot &&
          document.projectGeneration === owner.projectGeneration &&
          document.isProjectMutating
            ? { isProjectMutating: false }
            : {},
        );
      }
    }
  },

  addLabel: async (projectRoot, snapshotId, label) => {
    const owner = captureOwner(get(), projectRoot);
    if (!owner) throw inactiveProjectError();
    await runHistoryMutation(owner, () =>
      invoke("history_add_label", { projectRoot, snapshotId, label }),
    );
    set((state) =>
      sameOwner(state, owner) &&
      !state.isProjectMutating &&
      documentOwnsProject(owner)
        ? {
            snapshots: state.snapshots.map((snapshot) =>
              snapshot.id === snapshotId && !snapshot.labels.includes(label)
                ? { ...snapshot, labels: [...snapshot.labels, label] }
                : snapshot,
            ),
          }
        : {},
    );
  },

  removeLabel: async (projectRoot, label) => {
    const owner = captureOwner(get(), projectRoot);
    if (!owner) throw inactiveProjectError();
    await runHistoryMutation(owner, () =>
      invoke("history_remove_label", { projectRoot, label }),
    );
    set((state) =>
      sameOwner(state, owner) &&
      !state.isProjectMutating &&
      documentOwnsProject(owner)
        ? {
            snapshots: state.snapshots.map((snapshot) => ({
              ...snapshot,
              labels: snapshot.labels.filter(
                (existingLabel) => existingLabel !== label,
              ),
            })),
          }
        : {},
    );
  },

  reset: () => {
    set((state) => ({
      projectRoot: null,
      projectGeneration: state.projectGeneration + 1,
      isProjectMutating: false,
      snapshots: [],
      isLoading: false,
      listRequestId: nextHistoryRequestId(),
      selectedSnapshotId: null,
      diffResult: null,
      isDiffLoading: false,
      diffRequestId: nextHistoryRequestId(),
      isRestoring: false,
      restoreRequestId: nextHistoryRequestId(),
      reviewingSnapshot: null,
    }));
  },
}));
