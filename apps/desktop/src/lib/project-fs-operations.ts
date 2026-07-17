export interface ProjectFsOwner {
  projectRoot: string;
  projectGeneration: number;
}

interface ActiveProjectFsOperation {
  owner: ProjectFsOwner;
  completion: Promise<void>;
  finish: () => void;
  sequence: number;
  drainingMutation: boolean;
}

const activeOperations = new Map<symbol, ActiveProjectFsOperation>();
let nextOperationSequence = 0;

export function canonicalProjectPath(projectPath: string): string {
  const withForwardSlashes = projectPath.trim().replace(/\\/g, "/");
  if (withForwardSlashes === "/") return "/";
  if (withForwardSlashes.startsWith("//")) {
    return `//${withForwardSlashes
      .slice(2)
      .replace(/\/+/g, "/")
      .replace(/\/+$/, "")}`.toLowerCase();
  }
  const collapsed = withForwardSlashes.replace(/\/+/g, "/");
  if (/^[A-Za-z]:\/$/.test(collapsed)) return collapsed.toLowerCase();
  const normalized = collapsed.replace(/\/+$/, "");
  return /^[A-Za-z]:\//.test(normalized)
    ? normalized.toLowerCase()
    : normalized;
}

function sameProjectRoot(left: string, right: string): boolean {
  return canonicalProjectPath(left) === canonicalProjectPath(right);
}

export function projectPathBelongsToRoot(
  absolutePath: string,
  projectRoot: string,
): boolean {
  const path = canonicalProjectPath(absolutePath);
  const root = canonicalProjectPath(projectRoot);
  if (path === root) return true;
  if (root === "/" || /^[a-z]:\/$/.test(root)) {
    return path.startsWith(root);
  }
  return path.startsWith(`${root}/`);
}

/**
 * Registers one current-project filesystem side effect synchronously, before
 * its callback reaches the first await. The completion is always released,
 * including when the callback rejects.
 */
export async function runProjectFsOperation<T>(
  owner: ProjectFsOwner,
  operation: () => Promise<T>,
): Promise<T> {
  return runRegisteredProjectFsOperation(owner, operation);
}

/**
 * Registers a mutation synchronously, drains all older matching operations
 * (including nested work they start), and then runs the mutation. Its own
 * registration is excluded from the drain so it cannot wait on itself.
 */
export async function runProjectFsOperationAfterDrain<T>(
  owner: ProjectFsOwner,
  projectRoots: Array<string | null>,
  operation: () => Promise<T>,
): Promise<T> {
  return runRegisteredProjectFsOperation(owner, operation, projectRoots);
}

async function runRegisteredProjectFsOperation<T>(
  owner: ProjectFsOwner,
  operation: () => Promise<T>,
  drainRoots?: Array<string | null>,
): Promise<T> {
  const token = Symbol("project-fs-operation");
  let finish!: () => void;
  const completion = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const sequence = ++nextOperationSequence;
  activeOperations.set(token, {
    owner,
    completion,
    finish,
    sequence,
    drainingMutation: drainRoots !== undefined,
  });
  try {
    if (drainRoots) {
      const roots = drainRoots.filter((root): root is string => Boolean(root));
      while (true) {
        const pending = Array.from(activeOperations.entries())
          .filter(
            ([candidateToken, candidate]) =>
              candidateToken !== token &&
              (!candidate.drainingMutation || candidate.sequence < sequence) &&
              roots.some((root) =>
                sameProjectRoot(candidate.owner.projectRoot, root),
              ),
          )
          .map(([, candidate]) => candidate.completion);
        if (pending.length === 0) break;
        await Promise.all(pending);
      }
    }
    return await operation();
  } finally {
    const active = activeOperations.get(token);
    if (active) {
      activeOperations.delete(token);
      active.finish();
    }
  }
}

/** Waits for the operations that were registered before a project barrier. */
export function drainProjectFsOperations(
  projectRoots: Array<string | null>,
): Promise<void> | null {
  const roots = projectRoots.filter((root): root is string => Boolean(root));
  const matchingOperations = () =>
    Array.from(activeOperations.values())
      .filter((operation) =>
        roots.some((root) =>
          sameProjectRoot(operation.owner.projectRoot, root),
        ),
      )
      .map((operation) => operation.completion);
  const initial = matchingOperations();
  if (initial.length === 0) return null;
  return (async () => {
    let pending = initial;
    while (pending.length > 0) {
      await Promise.all(pending);
      pending = matchingOperations();
    }
  })();
}

export function ownsProjectFsState(
  owner: ProjectFsOwner,
  state: { projectRoot: string | null; projectGeneration: number },
): boolean {
  return (
    state.projectRoot === owner.projectRoot &&
    state.projectGeneration === owner.projectGeneration
  );
}
