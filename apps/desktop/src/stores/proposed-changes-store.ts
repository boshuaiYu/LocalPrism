import { create } from "zustand";
import { useDocumentStore } from "./document-store";
import { createLogger } from "@/lib/debug/logger";
import { writeProjectTextFileInOrder } from "@/lib/project-file-writes";
import {
  ownsProjectFsState,
  projectPathBelongsToRoot,
  type ProjectFsOwner,
} from "@/lib/project-fs-operations";

const log = createLogger("proposed-changes");

export interface ProposedChange {
  id: string; // tool_use_id
  filePath: string; // relativePath
  absolutePath: string;
  projectRoot: string;
  projectGeneration: number;
  oldContent: string; // content before Claude's edit
  newContent: string; // content after Claude's edit (from disk)
  toolName: string; // "Edit" | "Write" | "MultiEdit"
  timestamp: number;
}

interface ProposedChangesState {
  changes: ProposedChange[];

  // Actions
  addChange: (
    change: Omit<
      ProposedChange,
      "timestamp" | "projectRoot" | "projectGeneration"
    >,
  ) => void;
  resolveChange: (id: string) => void;
  keepChange: (id: string, acceptedContent?: string) => Promise<boolean>;
  undoChange: (id: string) => Promise<boolean>;
  keepAll: () => void;
  undoAll: () => Promise<void>;
  getChangeForFile: (relativePath: string) => ProposedChange | undefined;
}

function ownerForChange(change: ProposedChange): ProjectFsOwner {
  return {
    projectRoot: change.projectRoot,
    projectGeneration: change.projectGeneration,
  };
}

function currentFileForChange(
  change: ProposedChange,
  state: ReturnType<typeof useDocumentStore.getState>,
) {
  return state.files.find(
    (file) =>
      file.id === change.filePath && file.relativePath === change.filePath,
  );
}

function ownsChange(
  change: ProposedChange,
  state: ReturnType<typeof useDocumentStore.getState>,
) {
  return ownsProjectFsState(ownerForChange(change), state);
}

function isSameChange(left: ProposedChange, right: ProposedChange) {
  return (
    left.id === right.id &&
    left.filePath === right.filePath &&
    left.projectRoot === right.projectRoot &&
    left.projectGeneration === right.projectGeneration &&
    left.timestamp === right.timestamp
  );
}

export const useProposedChangesStore = create<ProposedChangesState>()(
  (set, get) => ({
    changes: [],

    addChange: (change) => {
      const documentState = useDocumentStore.getState();
      if (
        !documentState.projectRoot ||
        documentState.isProjectMutating ||
        !projectPathBelongsToRoot(
          change.absolutePath,
          documentState.projectRoot,
        )
      ) {
        return;
      }
      const owner: ProjectFsOwner = {
        projectRoot: documentState.projectRoot,
        projectGeneration: documentState.projectGeneration,
      };
      log.debug(`Adding change: ${change.toolName} on ${change.filePath}`);
      set((state) => {
        const currentChanges = state.changes.filter(
          (candidate) =>
            candidate.projectRoot === owner.projectRoot &&
            candidate.projectGeneration === owner.projectGeneration,
        );
        // If there's already a pending change for the same file, merge them:
        // keep the original oldContent (true baseline), use the new newContent and id
        const existingIdx = currentChanges.findIndex(
          (c) => c.filePath === change.filePath,
        );
        if (existingIdx >= 0) {
          const existing = currentChanges[existingIdx];
          const merged: ProposedChange = {
            ...change,
            ...owner,
            oldContent: existing.oldContent, // preserve original baseline
            timestamp: Date.now(),
          };
          const newChanges = [...currentChanges];
          newChanges[existingIdx] = merged;
          return { changes: newChanges };
        }
        return {
          changes: [
            ...currentChanges,
            { ...change, ...owner, timestamp: Date.now() },
          ],
        };
      });
    },

    resolveChange: (id) => {
      set((state) => ({
        changes: state.changes.filter((c) => c.id !== id),
      }));
    },

    keepChange: async (id, acceptedContent) => {
      const change = get().changes.find((c) => c.id === id);
      if (!change) return false;

      const documentState = useDocumentStore.getState();
      if (!ownsChange(change, documentState)) {
        set((state) => ({
          changes: state.changes.filter(
            (candidate) => !isSameChange(candidate, change),
          ),
        }));
        return true;
      }
      if (documentState.isProjectMutating) return false;

      // The caller (editor) already set the correct content via setContent().
      // Write the document store content to disk to stay in sync
      // (handles partial chunk resolution where finalContent differs from disk).
      const file = currentFileForChange(change, documentState);
      if (!file) {
        set((state) => ({
          changes: state.changes.filter(
            (candidate) => !isSameChange(candidate, change),
          ),
        }));
        return true;
      }
      if (file.content == null) return false;
      const owner = ownerForChange(change);
      const initialContent = file.content;
      const content = acceptedContent ?? initialContent;
      const absolutePath = file.absolutePath;

      await writeProjectTextFileInOrder(owner, absolutePath, content);

      const beforeReload = useDocumentStore.getState();
      const currentFile = currentFileForChange(change, beforeReload);
      if (
        beforeReload.isProjectMutating ||
        !ownsChange(change, beforeReload) ||
        currentFile?.absolutePath !== absolutePath ||
        currentFile.content !== initialContent
      ) {
        return false;
      }
      await beforeReload.reloadFile(change.filePath);

      const afterReload = useDocumentStore.getState();
      const reloadedFile = currentFileForChange(change, afterReload);
      if (
        !afterReload.isProjectMutating &&
        ownsChange(change, afterReload) &&
        reloadedFile?.absolutePath === absolutePath
      ) {
        let resolved = false;
        set((state) => ({
          changes: state.changes.filter((candidate) => {
            if (!isSameChange(candidate, change)) return true;
            resolved = true;
            return false;
          }),
        }));
        return resolved;
      }
      return false;
    },

    undoChange: async (id) => {
      const change = get().changes.find((c) => c.id === id);
      if (!change) return false;

      const documentState = useDocumentStore.getState();
      if (!ownsChange(change, documentState)) {
        set((state) => ({
          changes: state.changes.filter(
            (candidate) => !isSameChange(candidate, change),
          ),
        }));
        return true;
      }
      if (documentState.isProjectMutating) return false;
      const file = currentFileForChange(change, documentState);
      if (!file) {
        set((state) => ({
          changes: state.changes.filter(
            (candidate) => !isSameChange(candidate, change),
          ),
        }));
        return true;
      }
      const owner = ownerForChange(change);
      const absolutePath = file.absolutePath;
      const initialContent = file.content;

      log.info(`Undoing change on ${change.filePath}`);
      // Restore oldContent to disk
      await writeProjectTextFileInOrder(owner, absolutePath, change.oldContent);

      const beforeReload = useDocumentStore.getState();
      const currentFile = currentFileForChange(change, beforeReload);
      if (
        beforeReload.isProjectMutating ||
        !ownsChange(change, beforeReload) ||
        currentFile?.absolutePath !== absolutePath ||
        currentFile.content !== initialContent
      ) {
        return false;
      }

      // Reload the file in document store (will pick up oldContent from disk)
      await beforeReload.reloadFile(change.filePath);

      const afterReload = useDocumentStore.getState();
      const reloadedFile = currentFileForChange(change, afterReload);
      if (
        !afterReload.isProjectMutating &&
        ownsChange(change, afterReload) &&
        reloadedFile?.absolutePath === absolutePath
      ) {
        let resolved = false;
        set((state) => ({
          changes: state.changes.filter((candidate) => {
            if (!isSameChange(candidate, change)) return true;
            resolved = true;
            return false;
          }),
        }));
        return resolved;
      }
      return false;
    },

    keepAll: () => {
      const { changes } = get();
      const documentState = useDocumentStore.getState();
      if (documentState.isProjectMutating) return;
      for (const change of changes) {
        if (
          ownsChange(change, documentState) &&
          currentFileForChange(change, documentState)
        ) {
          documentState.reloadFile(change.filePath);
        }
      }
      set({ changes: [] });
    },

    undoAll: async () => {
      const { changes } = get();
      log.info(`Undoing all ${changes.length} changes`);
      for (const change of changes) {
        await get().undoChange(change.id);
      }
    },

    getChangeForFile: (relativePath) => {
      const documentState = useDocumentStore.getState();
      if (documentState.isProjectMutating) return undefined;
      return get().changes.find(
        (change) =>
          change.filePath === relativePath &&
          ownsChange(change, documentState) &&
          currentFileForChange(change, documentState),
      );
    },
  }),
);
