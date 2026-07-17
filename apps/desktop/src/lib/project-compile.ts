import { compileLatex, formatCompileError } from "@/lib/latex-compiler";
import {
  ownsProjectFsState,
  type ProjectFsOwner,
  runProjectFsOperation,
} from "@/lib/project-fs-operations";
import { useDocumentStore } from "@/stores/document-store";

export type ProjectCompileOutcome =
  | "completed"
  | "failed"
  | "queued"
  | "stale"
  | "blocked";

interface ProjectCompileRequest {
  owner: ProjectFsOwner;
  rootFileId: string;
  targetPath: string;
  useTexlive: boolean;
  beforeCompile?: () => Promise<void>;
  minimumBusyMs?: number;
  isStillValid?: () => boolean;
}

let nextCompileRequestId = 0;
let activeCompileRequest:
  | { id: number; owner: ProjectFsOwner; contentGeneration: number }
  | undefined;
let queuedCompileRequest: ProjectCompileRequest | undefined;

function isExternallyValid(request: ProjectCompileRequest): boolean {
  try {
    return request.isStillValid?.() ?? true;
  } catch {
    return false;
  }
}

/** Runs a current-project compile with project, request, and content ownership. */
export async function runOwnedProjectCompile({
  owner,
  rootFileId,
  targetPath,
  useTexlive,
  beforeCompile,
  minimumBusyMs = 500,
  isStillValid,
}: ProjectCompileRequest): Promise<ProjectCompileOutcome> {
  const compileOptions: ProjectCompileRequest = {
    owner,
    rootFileId,
    targetPath,
    useTexlive,
    beforeCompile,
    minimumBusyMs,
    isStillValid,
  };
  const initial = useDocumentStore.getState();
  if (
    initial.isProjectMutating ||
    !ownsProjectFsState(owner, initial) ||
    !isExternallyValid(compileOptions)
  ) {
    return "blocked";
  }
  if (initial.isCompiling) {
    queuedCompileRequest = compileOptions;
    initial.setPendingRecompile(true);
    return "queued";
  }

  const request = {
    id: ++nextCompileRequestId,
    owner,
    contentGeneration: initial.contentGeneration,
  };
  activeCompileRequest = request;
  initial.setIsCompiling(true);
  initial.setPendingRecompile(false);
  const startedAt = Date.now();
  let outcome: ProjectCompileOutcome = "stale";

  const ownsRequest = () => {
    const current = useDocumentStore.getState();
    return (
      activeCompileRequest?.id === request.id &&
      ownsProjectFsState(owner, current)
    );
  };
  const ownsValidRequest = () =>
    ownsRequest() && isExternallyValid(compileOptions);
  const ownsContent = () =>
    ownsValidRequest() &&
    useDocumentStore.getState().contentGeneration === request.contentGeneration;

  try {
    await runProjectFsOperation(owner, async () => {
      if (!ownsContent()) return;
      await useDocumentStore.getState().saveAllFiles();
      const afterSave = useDocumentStore.getState();
      if (!ownsContent() || afterSave.files.some((file) => file.isDirty)) {
        if (ownsValidRequest()) afterSave.setPendingRecompile(true);
        return;
      }

      if (beforeCompile) {
        await beforeCompile();
        if (!ownsContent()) return;
      }

      const data = await compileLatex(
        owner.projectRoot,
        targetPath,
        useTexlive,
      );
      if (!ownsContent()) {
        if (ownsValidRequest()) {
          useDocumentStore.getState().setPendingRecompile(true);
        }
        return;
      }
      useDocumentStore.getState().setPdfData(data, rootFileId);
      outcome = "completed";
    });
  } catch (error) {
    if (ownsValidRequest()) {
      useDocumentStore
        .getState()
        .setCompileError(formatCompileError(error), rootFileId);
      outcome = "failed";
    }
  } finally {
    const remaining = minimumBusyMs - (Date.now() - startedAt);
    if (remaining > 0) {
      await new Promise((resolve) => setTimeout(resolve, remaining));
    }
    if (activeCompileRequest?.id === request.id) {
      const current = useDocumentStore.getState();
      current.setIsCompiling(false);
      activeCompileRequest = undefined;
      const queued = queuedCompileRequest;
      queuedCompileRequest = undefined;
      const needsFollowUp = current.pendingRecompile;
      const queuedIsRunnable =
        queued != null &&
        ownsProjectFsState(queued.owner, current) &&
        isExternallyValid(queued);
      const followUp =
        (queuedIsRunnable ? queued : undefined) ??
        (needsFollowUp ? compileOptions : undefined);
      if (ownsProjectFsState(owner, current) && !current.isProjectMutating) {
        current.setPendingRecompile(false);
      }
      if (
        followUp &&
        !current.isProjectMutating &&
        ownsProjectFsState(followUp.owner, current) &&
        isExternallyValid(followUp)
      ) {
        void runOwnedProjectCompile(followUp);
      }
    }
  }

  return outcome;
}
