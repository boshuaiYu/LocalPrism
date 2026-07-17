import { describe, expect, it, vi } from "vitest";
import {
  commitOwnedChatAttachmentContexts,
  finishTemporaryChatAttachment,
  ownsChatAttachmentState,
} from "@/lib/chat-attachment-commit";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("chat attachment ownership commits", () => {
  it("requires both the initiating project incarnation and chat tab", () => {
    const owner = {
      projectRoot: "/project",
      projectGeneration: 1,
      tabId: "tab-a",
    };
    const document = {
      projectRoot: "/project",
      projectGeneration: 1,
      isProjectMutating: false,
    };

    expect(ownsChatAttachmentState(owner, document, "tab-a")).toBe(true);
    expect(ownsChatAttachmentState(owner, document, "tab-b")).toBe(false);
    expect(
      ownsChatAttachmentState(
        owner,
        { ...document, projectGeneration: 2 },
        "tab-a",
      ),
    ).toBe(false);
  });

  it("removes a pasted temporary file when its deferred data read finishes after a tab switch", async () => {
    const dataRead = deferred<string>();
    const cleanup = vi.fn(() => Promise.resolve());
    const owner = {
      projectRoot: "/project",
      projectGeneration: 1,
      tabId: "tab-a",
    };
    const document = {
      projectRoot: "/project",
      projectGeneration: 1,
      isProjectMutating: false,
    };
    let activeTabId = "tab-a";
    const finishing = finishTemporaryChatAttachment({
      temporaryPath: "/tmp/paste.png",
      buildContext: async () => ({
        filePath: "/tmp/paste.png",
        isTemporary: true,
        imageDataUrl: await dataRead.promise,
      }),
      isCurrent: () => ownsChatAttachmentState(owner, document, activeTabId),
      cleanup,
    });

    activeTabId = "tab-b";
    dataRead.resolve("data:image/png;base64,AA==");

    await expect(finishing).resolves.toBeNull();
    expect(cleanup).toHaveBeenCalledWith(["/tmp/paste.png"]);
  });

  it("removes a pasted temporary file when context construction rejects", async () => {
    const cleanup = vi.fn(() => Promise.resolve());
    const failure = new Error("read failed");

    await expect(
      finishTemporaryChatAttachment({
        temporaryPath: "/tmp/paste.png",
        buildContext: () => Promise.reject(failure),
        isCurrent: () => true,
        cleanup,
      }),
    ).rejects.toThrow("read failed");
    expect(cleanup).toHaveBeenCalledWith(["/tmp/paste.png"]);
  });

  it("does not commit dropped contexts after refresh crosses a tab switch", async () => {
    const refresh = deferred<void>();
    const commit = vi.fn();
    const cleanup = vi.fn(() => Promise.resolve());
    const owner = {
      projectRoot: "/project",
      projectGeneration: 1,
      tabId: "tab-a",
    };
    const document = {
      projectRoot: "/project",
      projectGeneration: 1,
      isProjectMutating: false,
    };
    let activeTabId = "tab-a";
    const committing = commitOwnedChatAttachmentContexts({
      contexts: [{ filePath: "attachments/paper.pdf" }],
      isCurrent: () => ownsChatAttachmentState(owner, document, activeTabId),
      beforeCommit: () => refresh.promise,
      commit,
      cleanup,
    });

    activeTabId = "tab-b";
    refresh.resolve();

    await expect(committing).resolves.toBe(false);
    expect(commit).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("cleans collected temporary contexts when the project changes before commit", async () => {
    const commit = vi.fn();
    const cleanup = vi.fn(() => Promise.resolve());

    await expect(
      commitOwnedChatAttachmentContexts({
        contexts: [
          { filePath: "/tmp/one.png", isTemporary: true },
          { filePath: "attachments/paper.pdf" },
        ],
        isCurrent: () => false,
        commit,
        cleanup,
      }),
    ).resolves.toBe(false);
    expect(commit).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledWith(["/tmp/one.png"]);
  });
});
