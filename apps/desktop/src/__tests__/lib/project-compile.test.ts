import { beforeEach, describe, expect, it, vi } from "vitest";

const { compileLatexMock } = vi.hoisted(() => ({
  compileLatexMock: vi.fn(),
}));

vi.mock("@/lib/latex-compiler", () => ({
  compileLatex: compileLatexMock,
  formatCompileError: (error: unknown) => String(error),
}));

import { runOwnedProjectCompile } from "@/lib/project-compile";
import { useDocumentStore } from "@/stores/document-store";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("runOwnedProjectCompile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDocumentStore.setState({
      projectRoot: "/project",
      projectGeneration: 1,
      files: [
        {
          id: "main.tex",
          name: "main.tex",
          relativePath: "main.tex",
          absolutePath: "/project/main.tex",
          type: "tex",
          content: "\\documentclass{article}",
          isDirty: false,
        },
      ],
      activeFileId: "main.tex",
      contentGeneration: 1,
      isProjectMutating: false,
      isCompiling: false,
      pendingRecompile: false,
      compileError: null,
      pdfRevision: 0,
    });
  });

  it("clears the old busy flag without committing after rename invalidates its owner", async () => {
    const compile = deferred<Uint8Array>();
    compileLatexMock.mockReturnValue(compile.promise);

    const running = runOwnedProjectCompile({
      owner: { projectRoot: "/project", projectGeneration: 1 },
      rootFileId: "main.tex",
      targetPath: "/project/main.tex",
      useTexlive: false,
      minimumBusyMs: 0,
    });
    await vi.waitFor(() => expect(compileLatexMock).toHaveBeenCalledTimes(1));
    useDocumentStore.setState({
      projectGeneration: 2,
      isProjectMutating: true,
    });

    compile.resolve(new Uint8Array([1, 2, 3]));
    await expect(running).resolves.toBe("stale");

    expect(useDocumentStore.getState().isCompiling).toBe(false);
    expect(useDocumentStore.getState().pdfRevision).toBe(0);
  });

  it("does not publish after an external completion owner becomes stale", async () => {
    const compile = deferred<Uint8Array>();
    compileLatexMock.mockReturnValue(compile.promise);
    let isStillValid = true;

    const running = runOwnedProjectCompile({
      owner: { projectRoot: "/project", projectGeneration: 1 },
      rootFileId: "main.tex",
      targetPath: "/project/main.tex",
      useTexlive: false,
      minimumBusyMs: 0,
      isStillValid: () => isStillValid,
    });
    await vi.waitFor(() => expect(compileLatexMock).toHaveBeenCalledTimes(1));

    isStillValid = false;
    compile.resolve(new Uint8Array([1, 2, 3]));
    await expect(running).resolves.toBe("stale");

    expect(useDocumentStore.getState().isCompiling).toBe(false);
    expect(useDocumentStore.getState().pdfRevision).toBe(0);
  });

  it("runs the latest queued compile once after the active request releases", async () => {
    const firstCompile = deferred<Uint8Array>();
    compileLatexMock
      .mockReturnValueOnce(firstCompile.promise)
      .mockResolvedValueOnce(new Uint8Array([2]));
    let firstValid = true;
    const owner = { projectRoot: "/project", projectGeneration: 1 };

    const first = runOwnedProjectCompile({
      owner,
      rootFileId: "main.tex",
      targetPath: "/project/main.tex",
      useTexlive: false,
      minimumBusyMs: 0,
      isStillValid: () => firstValid,
    });
    await vi.waitFor(() => expect(compileLatexMock).toHaveBeenCalledTimes(1));

    firstValid = false;
    await expect(
      runOwnedProjectCompile({
        owner,
        rootFileId: "main.tex",
        targetPath: "/project/main.tex",
        useTexlive: false,
        minimumBusyMs: 0,
        isStillValid: () => true,
      }),
    ).resolves.toBe("queued");

    firstCompile.resolve(new Uint8Array([1]));
    await expect(first).resolves.toBe("stale");
    await vi.waitFor(() => expect(compileLatexMock).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => {
      expect(useDocumentStore.getState().isCompiling).toBe(false);
      expect(useDocumentStore.getState().pdfRevision).toBe(1);
    });
    expect(compileLatexMock).toHaveBeenCalledTimes(2);
  });

  it("never drops external validity when considering an implicit follow-up", async () => {
    const compile = deferred<Uint8Array>();
    compileLatexMock
      .mockReturnValueOnce(compile.promise)
      .mockResolvedValueOnce(new Uint8Array([2]));
    let valid = true;

    const running = runOwnedProjectCompile({
      owner: { projectRoot: "/project", projectGeneration: 1 },
      rootFileId: "main.tex",
      targetPath: "/project/main.tex",
      useTexlive: false,
      minimumBusyMs: 0,
      isStillValid: () => valid,
    });
    await vi.waitFor(() => expect(compileLatexMock).toHaveBeenCalledTimes(1));

    useDocumentStore.getState().setPendingRecompile(true);
    valid = false;
    compile.resolve(new Uint8Array([1]));

    await expect(running).resolves.toBe("stale");
    await vi.waitFor(() =>
      expect(useDocumentStore.getState().isCompiling).toBe(false),
    );
    expect(compileLatexMock).toHaveBeenCalledTimes(1);
  });
});
