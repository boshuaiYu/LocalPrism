import { describe, expect, it, vi } from "vitest";
import { completeProposedChangeAction } from "@/lib/proposed-change-resolution";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("completeProposedChangeAction", () => {
  it("waits for successful persistence before clearing merge state", async () => {
    const action = deferred<boolean>();
    const onResolved = vi.fn();
    const completion = completeProposedChangeAction({
      action: () => action.promise,
      isCurrent: () => true,
      onResolved,
      onRejected: vi.fn(),
    });

    await Promise.resolve();
    expect(onResolved).not.toHaveBeenCalled();

    action.resolve(true);
    await expect(completion).resolves.toBe(true);
    expect(onResolved).toHaveBeenCalledTimes(1);
  });

  it("catches persistence rejection and leaves merge state intact", async () => {
    const action = deferred<boolean>();
    const onResolved = vi.fn();
    const onRejected = vi.fn();
    const completion = completeProposedChangeAction({
      action: () => action.promise,
      isCurrent: () => true,
      onResolved,
      onRejected,
    });

    const failure = new Error("disk full");
    action.reject(failure);
    await expect(completion).resolves.toBe(false);
    expect(onResolved).not.toHaveBeenCalled();
    expect(onRejected).toHaveBeenCalledWith(failure);
  });

  it("does not clear a newer merge after an older action resolves", async () => {
    const action = deferred<boolean>();
    let current = true;
    const onResolved = vi.fn();
    const completion = completeProposedChangeAction({
      action: () => action.promise,
      isCurrent: () => current,
      onResolved,
      onRejected: vi.fn(),
    });

    current = false;
    action.resolve(true);
    await expect(completion).resolves.toBe(false);
    expect(onResolved).not.toHaveBeenCalled();
  });
});
