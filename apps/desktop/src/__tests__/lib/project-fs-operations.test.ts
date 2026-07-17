import { describe, expect, it, vi } from "vitest";
import {
  drainProjectFsOperations,
  projectPathBelongsToRoot,
  runProjectFsOperation,
  runProjectFsOperationAfterDrain,
} from "@/lib/project-fs-operations";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("project filesystem operation registry", () => {
  it.each([
    ["POSIX root", "/main.tex", "/", true],
    ["POSIX child", "/project/main.tex", "/project", true],
    ["POSIX sibling", "/project-copy/main.tex", "/project", false],
    ["drive root", "C:/main.tex", "c:\\", true],
    ["drive child", "c:\\Work\\main.tex", "C:/work", true],
    ["drive sibling", "C:/workspace/main.tex", "C:/work", false],
    [
      "UNC child",
      "\\\\SERVER\\Share\\folder\\main.tex",
      "//server/share",
      true,
    ],
    [
      "UNC sibling share",
      "//server/share-copy/main.tex",
      "\\\\server\\share",
      false,
    ],
  ])("checks %s containment", (_label, path, root, expected) => {
    expect(projectPathBelongsToRoot(path, root)).toBe(expected);
  });

  it("registers synchronously before the operation reaches its first await", async () => {
    const work = deferred<void>();
    let entered = false;
    const running = runProjectFsOperation(
      { projectRoot: "/project", projectGeneration: 1 },
      async () => {
        entered = true;
        await work.promise;
      },
    );

    expect(entered).toBe(true);
    const draining = drainProjectFsOperations(["/project"]);
    expect(draining).not.toBeNull();
    let drained = false;
    void draining?.then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    work.resolve();
    await Promise.all([running, draining]);
    expect(drained).toBe(true);
  });

  it("releases a rejected operation so later drains cannot hang", async () => {
    await expect(
      runProjectFsOperation(
        { projectRoot: "/project", projectGeneration: 1 },
        async () => {
          throw new Error("write failed");
        },
      ),
    ).rejects.toThrow("write failed");

    expect(drainProjectFsOperations(["/project"])).toBeNull();
  });

  it.each([
    ["POSIX root", "/", "/"],
    ["Windows drive root", "C:\\", "c:/"],
    ["UNC share", "\\\\Server\\Share\\", "//server/share"],
  ])("matches equivalent %s spellings", async (_label, ownerRoot, drainRoot) => {
    const work = deferred<void>();
    const running = runProjectFsOperation(
      { projectRoot: ownerRoot, projectGeneration: 1 },
      () => work.promise,
    );

    const draining = drainProjectFsOperations([drainRoot]);
    expect(draining).not.toBeNull();
    work.resolve();
    await Promise.all([running, draining]);
  });

  it("does not make an unrelated project wait", async () => {
    const work = deferred<void>();
    const running = runProjectFsOperation(
      { projectRoot: "/project-a", projectGeneration: 1 },
      () => work.promise,
    );

    expect(drainProjectFsOperations(["/project-b"])).toBeNull();
    work.resolve();
    await running;
  });

  it("keeps draining when an already-active operation registers nested work", async () => {
    const outerGate = deferred<void>();
    const nestedGate = deferred<void>();
    let nested: Promise<void> | undefined;
    const owner = { projectRoot: "/project", projectGeneration: 1 };
    const outer = runProjectFsOperation(owner, async () => {
      await outerGate.promise;
      nested = runProjectFsOperation(owner, () => nestedGate.promise);
    });
    const draining = drainProjectFsOperations(["/project"]);
    expect(draining).not.toBeNull();

    outerGate.resolve();
    await outer;
    let drained = false;
    void draining?.then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    nestedGate.resolve();
    await Promise.all([nested, draining]);
    expect(drained).toBe(true);
  });

  it("drains nested older work without waiting on its own registration", async () => {
    const existingGate = deferred<void>();
    const nestedGate = deferred<void>();
    const owner = { projectRoot: "/project", projectGeneration: 1 };
    let nested: Promise<void> | null = null;
    const existing = runProjectFsOperation(owner, async () => {
      await existingGate.promise;
      nested = runProjectFsOperation(owner, () => nestedGate.promise);
    });

    let mutationEntered = false;
    const mutation = runProjectFsOperationAfterDrain(
      owner,
      ["/project"],
      async () => {
        mutationEntered = true;
      },
    );
    expect(drainProjectFsOperations(["/project"])).not.toBeNull();

    existingGate.resolve();
    await existing;
    await Promise.resolve();
    expect(mutationEntered).toBe(false);

    nestedGate.resolve();
    await Promise.all([nested, mutation]);
    expect(mutationEntered).toBe(true);
  });

  it("serializes concurrent draining mutations without making older and newer barriers wait on each other", async () => {
    const existingGate = deferred<void>();
    const owner = { projectRoot: "/project", projectGeneration: 1 };
    const existing = runProjectFsOperation(owner, () => existingGate.promise);
    const order: string[] = [];

    const first = runProjectFsOperationAfterDrain(
      owner,
      [owner.projectRoot],
      async () => {
        order.push("first");
      },
    );
    const second = runProjectFsOperationAfterDrain(
      owner,
      [owner.projectRoot],
      async () => {
        order.push("second");
      },
    );

    existingGate.resolve();
    await existing;
    await vi.waitFor(() => expect(order).toEqual(["first", "second"]));
    await Promise.all([first, second]);
  });
});
