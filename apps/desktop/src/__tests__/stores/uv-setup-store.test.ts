import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { drainProjectFsOperations } from "@/lib/project-fs-operations";
import { useUvSetupStore } from "@/stores/uv-setup-store";

const { documentState, documentStore } = vi.hoisted(() => {
  const state = {
    projectRoot: "/project-a" as string | null,
    projectGeneration: 1,
    isProjectMutating: false,
  };
  return {
    documentState: state,
    documentStore: {
      getState: vi.fn(() => state),
    },
  };
});

vi.mock("@/stores/document-store", () => ({
  useDocumentStore: documentStore,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("useUvSetupStore project ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(documentState, {
      projectRoot: "/project-a",
      projectGeneration: 1,
      isProjectMutating: false,
    });
    useUvSetupStore.setState({
      status: "checking",
      isInstalling: false,
      error: null,
      version: null,
      binaryPath: null,
      venvReady: false,
      venvPath: null,
      pythonPath: null,
      venvError: null,
      isSettingUpVenv: false,
      venvOwner: null,
      activeVenvRequestId: null,
    });
  });

  it("lets only the latest project request commit its venv result", async () => {
    const setupA = deferred<{
      venv_path: string;
      python_path: string;
      created: boolean;
    }>();
    const setupB = deferred<{
      venv_path: string;
      python_path: string;
      created: boolean;
    }>();
    vi.mocked(invoke).mockImplementation((_command, args) => {
      return (
        (args as { projectPath: string }).projectPath === "/project-a"
          ? setupA.promise
          : setupB.promise
      ) as ReturnType<typeof invoke>;
    });

    const requestA = useUvSetupStore
      .getState()
      .beginVenvSetup({ projectRoot: "/project-a", projectGeneration: 1 });
    const runningA = useUvSetupStore.getState().setupVenv(requestA);
    expect(drainProjectFsOperations(["/project-a"])).not.toBeNull();

    Object.assign(documentState, {
      projectRoot: "/project-b",
      projectGeneration: 2,
    });
    const requestB = useUvSetupStore
      .getState()
      .beginVenvSetup({ projectRoot: "/project-b", projectGeneration: 2 });
    const runningB = useUvSetupStore.getState().setupVenv(requestB);

    setupA.resolve({
      venv_path: "/project-a/.venv",
      python_path: "/project-a/.venv/bin/python",
      created: true,
    });
    await runningA;
    expect(useUvSetupStore.getState()).toMatchObject({
      venvReady: false,
      venvPath: null,
      venvOwner: { projectRoot: "/project-b", projectGeneration: 2 },
      isSettingUpVenv: true,
      activeVenvRequestId: requestB.requestId,
    });

    setupB.resolve({
      venv_path: "/project-b/.venv",
      python_path: "/project-b/.venv/bin/python",
      created: true,
    });
    await runningB;
    expect(useUvSetupStore.getState()).toMatchObject({
      venvReady: true,
      venvPath: "/project-b/.venv",
      pythonPath: "/project-b/.venv/bin/python",
      venvError: null,
      isSettingUpVenv: false,
      activeVenvRequestId: null,
    });
  });

  it("releases the project operation and records only a current setup failure", async () => {
    const setup = deferred<never>();
    vi.mocked(invoke).mockReturnValue(
      setup.promise as ReturnType<typeof invoke>,
    );
    const request = useUvSetupStore
      .getState()
      .beginVenvSetup({ projectRoot: "/project-a", projectGeneration: 1 });
    const running = useUvSetupStore.getState().setupVenv(request);

    const draining = drainProjectFsOperations(["/project-a"]);
    expect(draining).not.toBeNull();
    setup.reject(new Error("venv failed"));
    await running;
    await draining;

    expect(useUvSetupStore.getState()).toMatchObject({
      venvReady: false,
      venvPath: null,
      pythonPath: null,
      venvError: "venv failed",
      isSettingUpVenv: false,
      activeVenvRequestId: null,
    });
    expect(drainProjectFsOperations(["/project-a"])).toBeNull();
  });

  it("cancels a request without allowing its late completion to commit", async () => {
    const setup = deferred<{
      venv_path: string;
      python_path: string;
      created: boolean;
    }>();
    vi.mocked(invoke).mockReturnValue(
      setup.promise as ReturnType<typeof invoke>,
    );
    const request = useUvSetupStore
      .getState()
      .beginVenvSetup({ projectRoot: "/project-a", projectGeneration: 1 });
    const running = useUvSetupStore.getState().setupVenv(request);

    useUvSetupStore.getState().cancelVenvSetup(request);
    setup.resolve({
      venv_path: "/project-a/.venv",
      python_path: "/project-a/.venv/bin/python",
      created: true,
    });
    await running;

    expect(useUvSetupStore.getState()).toMatchObject({
      venvReady: false,
      venvPath: null,
      isSettingUpVenv: false,
      activeVenvRequestId: null,
    });
  });

  it("does not start setup after its project owner becomes stale", async () => {
    vi.mocked(invoke).mockResolvedValue({
      venv_path: "/project-a/.venv",
      python_path: "/project-a/.venv/bin/python",
      created: true,
    } as never);
    const request = useUvSetupStore
      .getState()
      .beginVenvSetup({ projectRoot: "/project-a", projectGeneration: 1 });
    Object.assign(documentState, {
      projectRoot: "/project-b",
      projectGeneration: 2,
    });

    await useUvSetupStore.getState().setupVenv(request);

    expect(invoke).not.toHaveBeenCalled();
    expect(useUvSetupStore.getState()).toMatchObject({
      venvReady: false,
      isSettingUpVenv: false,
      activeVenvRequestId: null,
    });
    expect(drainProjectFsOperations(["/project-a"])).toBeNull();
  });

  it("does not let an older uv status check overwrite a newer check", async () => {
    const first = deferred<{
      installed: boolean;
      binary_path: string | null;
      version: string | null;
    }>();
    const second = deferred<{
      installed: boolean;
      binary_path: string | null;
      version: string | null;
    }>();
    vi.mocked(invoke)
      .mockReturnValueOnce(first.promise as ReturnType<typeof invoke>)
      .mockReturnValueOnce(second.promise as ReturnType<typeof invoke>);

    const firstCheck = useUvSetupStore.getState().checkStatus();
    const secondCheck = useUvSetupStore.getState().checkStatus();
    second.resolve({ installed: true, binary_path: "uv", version: "1.0.0" });
    await secondCheck;
    first.resolve({ installed: false, binary_path: null, version: null });
    await firstCheck;

    expect(useUvSetupStore.getState()).toMatchObject({
      status: "ready",
      version: "1.0.0",
      binaryPath: "uv",
    });
  });
});
