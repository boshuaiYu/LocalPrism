interface ChatAttachmentContext {
  filePath: string;
  isTemporary?: boolean;
}

export interface ChatAttachmentOwner {
  projectRoot: string;
  projectGeneration: number;
  tabId: string;
}

export function ownsChatAttachmentState(
  owner: ChatAttachmentOwner,
  document: {
    projectRoot: string | null;
    projectGeneration: number;
    isProjectMutating: boolean;
  },
  activeTabId: string,
): boolean {
  return (
    !document.isProjectMutating &&
    document.projectRoot === owner.projectRoot &&
    document.projectGeneration === owner.projectGeneration &&
    activeTabId === owner.tabId
  );
}

type CleanupTemporaryPaths = (paths: string[]) => Promise<void>;

async function cleanupTemporaryContexts(
  contexts: ChatAttachmentContext[],
  cleanup: CleanupTemporaryPaths,
) {
  const paths = contexts
    .filter((context) => context.isTemporary)
    .map((context) => context.filePath);
  if (paths.length > 0) await cleanup(paths);
}

export async function finishTemporaryChatAttachment<
  T extends ChatAttachmentContext,
>({
  temporaryPath,
  buildContext,
  isCurrent,
  cleanup,
}: {
  temporaryPath: string;
  buildContext: () => Promise<T>;
  isCurrent: () => boolean;
  cleanup: CleanupTemporaryPaths;
}): Promise<T | null> {
  if (!isCurrent()) {
    await cleanup([temporaryPath]);
    return null;
  }
  try {
    const context = await buildContext();
    if (isCurrent()) return context;
    await cleanup([temporaryPath]);
    return null;
  } catch (error) {
    await cleanup([temporaryPath]);
    throw error;
  }
}

export async function commitOwnedChatAttachmentContexts<
  T extends ChatAttachmentContext,
>({
  contexts,
  isCurrent,
  beforeCommit,
  commit,
  cleanup,
}: {
  contexts: T[];
  isCurrent: () => boolean;
  beforeCommit?: () => Promise<void>;
  commit: (contexts: T[]) => void;
  cleanup: CleanupTemporaryPaths;
}): Promise<boolean> {
  try {
    if (!isCurrent()) {
      await cleanupTemporaryContexts(contexts, cleanup);
      return false;
    }
    if (beforeCommit) await beforeCommit();
    if (!isCurrent()) {
      await cleanupTemporaryContexts(contexts, cleanup);
      return false;
    }
    commit(contexts);
    return true;
  } catch (error) {
    await cleanupTemporaryContexts(contexts, cleanup);
    throw error;
  }
}
