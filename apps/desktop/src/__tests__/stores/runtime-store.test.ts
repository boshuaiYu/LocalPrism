import { readFileSync } from "node:fs";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type {
  RuntimeAccount,
  RuntimeKind,
  RuntimeLoginStartResult,
  RuntimeModel,
} from "@/runtime/types";

type RuntimeEventHandler = (event: { payload: unknown }) => void;
type RuntimeListen = (
  eventName: string,
  handler: RuntimeEventHandler,
) => Promise<() => void>;

const commandMocks = vi.hoisted(() => ({
  runtimeStatus: vi.fn(),
  runtimeInstall: vi.fn(),
  runtimeLoginStart: vi.fn(),
  runtimeLoginCancel: vi.fn(),
  runtimeLogout: vi.fn(),
  runtimeListModels: vi.fn(),
}));

const eventMocks = vi.hoisted(() => ({
  listen: vi.fn<RuntimeListen>(async () => vi.fn<() => void>()),
}));

vi.mock("@/runtime/commands", () => commandMocks);
vi.mock("@tauri-apps/api/event", () => ({ listen: eventMocks.listen }));

import {
  disposeRuntimeStore,
  ensureRuntimeAccountListener,
  hasReadyRuntime,
  resetRuntimeStoreForTests,
  useRuntimeStore,
} from "@/stores/runtime-store";

const CAPABILITIES = {
  models: true,
  skills: false,
  customAgents: false,
  subagents: false,
  approvals: false,
};

function account(
  runtime: RuntimeKind,
  overrides: Partial<RuntimeAccount> = {},
): RuntimeAccount {
  return {
    runtime,
    installed: true,
    authenticated: false,
    version: "1.0.0",
    accountLabel: null,
    authMode: null,
    capabilities: { ...CAPABILITIES },
    error: null,
    ...overrides,
  };
}

function model(runtime: RuntimeKind, id: string): RuntimeModel {
  return {
    runtime,
    id,
    displayName: id,
    description: null,
    reasoningEfforts: [],
    defaultReasoningEffort: null,
    inputModalities: ["text"],
    isDefault: false,
  };
}

describe("hasReadyRuntime", () => {
  it.each([
    [
      "Claude only",
      account("claude", { authenticated: true }),
      account("codex", { installed: false }),
      true,
    ],
    [
      "Codex only",
      account("claude", { installed: false }),
      account("codex", { authenticated: true }),
      true,
    ],
    [
      "both runtimes",
      account("claude", { authenticated: true }),
      account("codex", { authenticated: true }),
      true,
    ],
    [
      "neither runtime",
      account("claude", { authenticated: false }),
      account("codex", { installed: false, authenticated: true }),
      false,
    ],
    [
      "a ready Claude runtime despite a Codex error",
      account("claude", { authenticated: true }),
      account("codex", { authenticated: false, error: "Codex unavailable" }),
      true,
    ],
    [
      "a ready Codex runtime despite an unauthenticated Claude runtime",
      account("claude", { authenticated: false }),
      account("codex", { authenticated: true }),
      true,
    ],
  ])("returns the readiness of %s", (_label, claude, codex, expected) => {
    expect(hasReadyRuntime({ claude, codex })).toBe(expected);
  });
});

beforeAll(async () => {
  await ensureRuntimeAccountListener();
  disposeRuntimeStore();
});

beforeEach(() => {
  disposeRuntimeStore();
  resetRuntimeStoreForTests();
  vi.clearAllMocks();
  eventMocks.listen.mockResolvedValue(vi.fn<() => void>());
});

afterEach(() => {
  disposeRuntimeStore();
  vi.useRealTimers();
});

describe("runtime account listener lifecycle", () => {
  it("loads the runtime listener from the desktop entrypoint", () => {
    const entrypoint = readFileSync("src/main.tsx", "utf8");

    expect(entrypoint).toContain('import "@/stores/runtime-store";');
  });

  it("deduplicates a pending module-level listener registration", async () => {
    let resolveListen: ((unlisten: () => void) => void) | undefined;
    const unlisten = vi.fn<() => void>();
    eventMocks.listen.mockReturnValue(
      new Promise((resolve) => {
        resolveListen = resolve;
      }),
    );

    const first = ensureRuntimeAccountListener();
    const second = ensureRuntimeAccountListener();

    expect(first).toBe(second);
    expect(eventMocks.listen).toHaveBeenCalledTimes(1);
    expect(eventMocks.listen).toHaveBeenCalledWith(
      "runtime-account-updated",
      expect.any(Function),
    );

    resolveListen?.(unlisten);
    await first;
    disposeRuntimeStore();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("automatically retries a failed listener registration until it succeeds", async () => {
    vi.useFakeTimers();
    eventMocks.listen
      .mockRejectedValueOnce(new Error("listener unavailable 1"))
      .mockRejectedValueOnce(new Error("listener unavailable 2"))
      .mockResolvedValueOnce(vi.fn<() => void>());

    const registration = ensureRuntimeAccountListener();
    const settled = expect(registration).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);
    await settled;

    expect(eventMocks.listen).toHaveBeenCalledTimes(3);
  });

  it("bounds automatic listener registration retries", async () => {
    vi.useFakeTimers();
    eventMocks.listen.mockRejectedValue(new Error("listener unavailable"));

    const registration = ensureRuntimeAccountListener();
    const settled = expect(registration).rejects.toThrow(
      "listener unavailable",
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await settled;

    expect(eventMocks.listen).toHaveBeenCalledTimes(3);
  });

  it("disposal clears a pending listener retry and settles registration", async () => {
    vi.useFakeTimers();
    eventMocks.listen.mockRejectedValue(new Error("listener unavailable"));

    const registration = ensureRuntimeAccountListener();
    const settled = expect(registration).resolves.toBeUndefined();
    await Promise.resolve();
    disposeRuntimeStore();
    await settled;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(eventMocks.listen).toHaveBeenCalledTimes(1);
  });

  it("unlistens a registration that resolves after disposal", async () => {
    let resolveListen: ((unlisten: () => void) => void) | undefined;
    const unlisten = vi.fn<() => void>();
    eventMocks.listen.mockReturnValue(
      new Promise((resolve) => {
        resolveListen = resolve;
      }),
    );
    const pending = ensureRuntimeAccountListener();

    disposeRuntimeStore();
    resolveListen?.(unlisten);
    await pending;

    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("ignores a queued event from a listener disposed before registration resolves", async () => {
    let handler: RuntimeEventHandler | undefined;
    let resolveListen: ((unlisten: () => void) => void) | undefined;
    eventMocks.listen.mockImplementation(
      (_event, callback) =>
        new Promise((resolve) => {
          handler = callback;
          resolveListen = resolve;
        }),
    );
    const originalCodex = account("codex");
    useRuntimeStore.setState((state) => ({
      accounts: { ...state.accounts, codex: originalCodex },
    }));
    const pending = ensureRuntimeAccountListener();

    disposeRuntimeStore();
    handler?.({
      payload: account("codex", {
        authenticated: true,
        accountLabel: "late@example.com",
      }),
    });
    resolveListen?.(vi.fn<() => void>());
    await pending;

    expect(useRuntimeStore.getState().accounts.codex).toBe(originalCodex);
  });

  it("ignores malformed events without changing either runtime", async () => {
    let handler: ((event: { payload: unknown }) => void) | undefined;
    eventMocks.listen.mockImplementation(async (_event, callback) => {
      handler = callback as (event: { payload: unknown }) => void;
      return vi.fn<() => void>();
    });
    const claude = account("claude", { authenticated: true });
    const codex = account("codex");
    useRuntimeStore.setState({ accounts: { claude, codex } });
    await ensureRuntimeAccountListener();

    handler?.({ payload: null });
    handler?.({ payload: { runtime: "future", authenticated: true } });
    handler?.({ payload: { runtime: "codex", authenticated: "yes" } });

    expect(useRuntimeStore.getState().accounts.claude).toBe(claude);
    expect(useRuntimeStore.getState().accounts.codex).toBe(codex);
  });

  it("updates only the runtime named by a valid account event", async () => {
    let handler: ((event: { payload: unknown }) => void) | undefined;
    eventMocks.listen.mockImplementation(async (_event, callback) => {
      handler = callback as (event: { payload: unknown }) => void;
      return vi.fn<() => void>();
    });
    const claude = account("claude", {
      authenticated: true,
      accountLabel: "claude@example.com",
    });
    const oldCodex = account("codex");
    const authenticatedCodex = account("codex", {
      authenticated: true,
      accountLabel: "codex@example.com",
      authMode: "chatgpt",
    });
    useRuntimeStore.setState({ accounts: { claude, codex: oldCodex } });
    await ensureRuntimeAccountListener();

    handler?.({ payload: authenticatedCodex });

    expect(useRuntimeStore.getState().accounts.codex).toEqual(
      authenticatedCodex,
    );
    expect(useRuntimeStore.getState().accounts.claude).toBe(claude);
  });
});

describe("isolated runtime actions", () => {
  it("refreshes both runtimes with allSettled semantics", async () => {
    const authenticatedClaude = account("claude", {
      authenticated: true,
      accountLabel: "claude@example.com",
    });
    commandMocks.runtimeStatus.mockImplementation(async (runtime) => {
      if (runtime === "claude") return authenticatedClaude;
      throw new Error("Codex status failed");
    });

    await expect(useRuntimeStore.getState().refresh()).resolves.toBeUndefined();

    expect(commandMocks.runtimeStatus).toHaveBeenCalledTimes(2);
    expect(useRuntimeStore.getState().accounts.claude).toEqual(
      authenticatedClaude,
    );
    expect(useRuntimeStore.getState().accounts.codex.error).toBe(
      "Codex status failed",
    );
    expect(useRuntimeStore.getState().loading).toEqual({
      claude: false,
      codex: false,
    });
  });

  it("keeps Claude byte-for-byte unchanged when Codex authenticates", async () => {
    const claude = account("claude", {
      authenticated: true,
      accountLabel: "original@example.com",
      authMode: "claude-code",
    });
    const codex = account("codex");
    const authenticatedCodex = account("codex", {
      authenticated: true,
      accountLabel: "codex@example.com",
      authMode: "chatgpt",
    });
    useRuntimeStore.setState({ accounts: { claude, codex } });
    commandMocks.runtimeStatus.mockResolvedValue(authenticatedCodex);

    await useRuntimeStore.getState().refresh("codex");

    expect(useRuntimeStore.getState().accounts.claude).toBe(claude);
    expect(useRuntimeStore.getState().accounts.claude).toEqual(claude);
    expect(useRuntimeStore.getState().accounts.codex).toEqual(
      authenticatedCodex,
    );
  });

  it("keeps Codex byte-for-byte unchanged when Claude refreshes", async () => {
    const claude = account("claude");
    const codex = account("codex", {
      authenticated: true,
      accountLabel: "codex@example.com",
    });
    const authenticatedClaude = account("claude", {
      authenticated: true,
      accountLabel: "claude@example.com",
    });
    useRuntimeStore.setState({ accounts: { claude, codex } });
    commandMocks.runtimeStatus.mockResolvedValue(authenticatedClaude);

    await useRuntimeStore.getState().refresh("claude");

    expect(useRuntimeStore.getState().accounts.codex).toBe(codex);
    expect(useRuntimeStore.getState().accounts.claude).toEqual(
      authenticatedClaude,
    );
  });

  it("keeps a runtime loading until every concurrent operation settles", async () => {
    let resolveFirst: ((value: RuntimeAccount) => void) | undefined;
    let resolveSecond: ((value: RuntimeAccount) => void) | undefined;
    commandMocks.runtimeStatus
      .mockReturnValueOnce(
        new Promise<RuntimeAccount>((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise<RuntimeAccount>((resolve) => {
          resolveSecond = resolve;
        }),
      );

    const first = useRuntimeStore.getState().refresh("codex");
    const second = useRuntimeStore.getState().refresh("codex");
    expect(useRuntimeStore.getState().loading.codex).toBe(true);

    resolveFirst?.(account("codex", { version: "stale" }));
    await first;
    expect(useRuntimeStore.getState().loading.codex).toBe(true);

    resolveSecond?.(account("codex", { version: "current" }));
    await second;
    expect(useRuntimeStore.getState().loading.codex).toBe(false);
  });

  it("installs and refreshes only the requested runtime", async () => {
    const claude = account("claude", { authenticated: true });
    const installedCodex = account("codex", { version: "2.0.0" });
    useRuntimeStore.setState({
      accounts: { claude, codex: account("codex", { installed: false }) },
    });
    commandMocks.runtimeInstall.mockResolvedValue(true);
    commandMocks.runtimeStatus.mockResolvedValue(installedCodex);

    await expect(useRuntimeStore.getState().install("codex")).resolves.toBe(
      true,
    );

    expect(commandMocks.runtimeInstall).toHaveBeenCalledWith("codex");
    expect(commandMocks.runtimeStatus).toHaveBeenCalledWith("codex");
    expect(useRuntimeStore.getState().accounts.claude).toBe(claude);
    expect(useRuntimeStore.getState().accounts.codex).toEqual(installedCodex);
    expect(useRuntimeStore.getState().loading.codex).toBe(false);
  });

  it("stores a false installation result only on the requested runtime", async () => {
    const claude = account("claude", { authenticated: true });
    useRuntimeStore.setState({
      accounts: { claude, codex: account("codex", { installed: false }) },
    });
    commandMocks.runtimeInstall.mockResolvedValue(false);

    await expect(useRuntimeStore.getState().install("codex")).resolves.toBe(
      false,
    );

    expect(commandMocks.runtimeStatus).not.toHaveBeenCalled();
    expect(useRuntimeStore.getState().accounts.codex.error).toBe(
      "Runtime installation failed",
    );
    expect(useRuntimeStore.getState().accounts.claude).toBe(claude);
    expect(useRuntimeStore.getState().loading.codex).toBe(false);
  });

  it("does not let an old false installation overwrite a newer refresh", async () => {
    let resolveInstall: ((installed: boolean) => void) | undefined;
    commandMocks.runtimeInstall.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveInstall = resolve;
      }),
    );
    const latest = account("codex", {
      authenticated: true,
      version: "latest-after-install",
    });
    commandMocks.runtimeStatus.mockResolvedValue(latest);

    const installation = useRuntimeStore.getState().install("codex");
    await useRuntimeStore.getState().refresh("codex");
    resolveInstall?.(false);

    await expect(installation).resolves.toBe(false);
    expect(useRuntimeStore.getState().accounts.codex).toBe(latest);
    expect(useRuntimeStore.getState().accounts.codex.error).toBeNull();
    expect(useRuntimeStore.getState().loading.codex).toBe(false);
  });

  it("does not let an old installation error overwrite a newer refresh", async () => {
    let rejectInstall: ((error: Error) => void) | undefined;
    commandMocks.runtimeInstall.mockReturnValue(
      new Promise<boolean>((_resolve, reject) => {
        rejectInstall = reject;
      }),
    );
    const latest = account("codex", {
      authenticated: true,
      version: "latest-after-install-error",
    });
    commandMocks.runtimeStatus.mockResolvedValue(latest);

    const installation = useRuntimeStore.getState().install("codex");
    await useRuntimeStore.getState().refresh("codex");
    rejectInstall?.(new Error("stale installation failure"));

    await expect(installation).resolves.toBe(false);
    expect(useRuntimeStore.getState().accounts.codex).toBe(latest);
    expect(useRuntimeStore.getState().accounts.codex.error).toBeNull();
    expect(useRuntimeStore.getState().loading.codex).toBe(false);
  });

  it("does not let an old successful installation refresh over a newer refresh", async () => {
    let resolveInstall: ((installed: boolean) => void) | undefined;
    commandMocks.runtimeInstall.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveInstall = resolve;
      }),
    );
    const latest = account("codex", {
      authenticated: true,
      version: "latest-before-old-install",
    });
    const staleInstalled = account("codex", {
      authenticated: false,
      version: "stale-old-install",
    });
    commandMocks.runtimeStatus.mockResolvedValue(latest);

    const installation = useRuntimeStore.getState().install("codex");
    await useRuntimeStore.getState().refresh("codex");
    commandMocks.runtimeStatus.mockResolvedValue(staleInstalled);
    resolveInstall?.(true);

    await expect(installation).resolves.toBe(true);
    expect(commandMocks.runtimeStatus).toHaveBeenCalledTimes(1);
    expect(useRuntimeStore.getState().accounts.codex).toBe(latest);
    expect(useRuntimeStore.getState().loading.codex).toBe(false);
  });

  it("stores browser login metadata without touching the other runtime", async () => {
    const claude = account("claude", { authenticated: true });
    useRuntimeStore.setState({
      accounts: { claude, codex: account("codex") },
    });
    commandMocks.runtimeLoginStart.mockResolvedValue({
      type: "chatgpt",
      authUrl: "https://auth.example/browser",
      loginId: "browser-1",
    });

    await useRuntimeStore.getState().startLogin("codex", "browser");

    expect(commandMocks.runtimeLoginStart).toHaveBeenCalledWith(
      "codex",
      "browser",
    );
    expect(useRuntimeStore.getState().login.codex).toEqual({
      mode: "browser",
      status: "waiting",
      loginId: "browser-1",
      authUrl: "https://auth.example/browser",
    });
    expect(useRuntimeStore.getState().login.claude).toBeUndefined();
    expect(useRuntimeStore.getState().accounts.claude).toBe(claude);
  });

  it("clears a stale account error when a new login begins", async () => {
    useRuntimeStore.setState((state) => ({
      accounts: {
        ...state.accounts,
        codex: account("codex", { error: "old status failure" }),
      },
    }));
    commandMocks.runtimeLoginStart.mockResolvedValue({
      type: "chatgpt",
      authUrl: "https://auth.example/fresh",
      loginId: "fresh-login",
    });

    await useRuntimeStore.getState().startLogin("codex", "browser");

    expect(useRuntimeStore.getState().accounts.codex.error).toBeNull();
    expect(useRuntimeStore.getState().login.codex).toMatchObject({
      status: "waiting",
      loginId: "fresh-login",
    });
  });

  it("stores device-code metadata for device login", async () => {
    commandMocks.runtimeLoginStart.mockResolvedValue({
      type: "chatgptDeviceCode",
      verificationUrl: "https://auth.example/device",
      userCode: "ABCD-EFGH",
      loginId: "device-1",
    });

    await useRuntimeStore.getState().startLogin("codex", "device-code");

    expect(commandMocks.runtimeLoginStart).toHaveBeenCalledWith(
      "codex",
      "device-code",
    );
    expect(useRuntimeStore.getState().login.codex).toEqual({
      mode: "device-code",
      status: "waiting",
      loginId: "device-1",
      verificationUrl: "https://auth.example/device",
      userCode: "ABCD-EFGH",
    });
  });

  it("never stores, persists, or logs an API key", async () => {
    const secret = "sk-test-super-secret";
    const authenticated = account("codex", {
      authenticated: true,
      authMode: "api-key",
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    commandMocks.runtimeLoginStart.mockResolvedValue({ type: "apiKey" });
    commandMocks.runtimeStatus.mockResolvedValue(authenticated);

    await useRuntimeStore.getState().startLogin("codex", "api-key", secret);

    expect(commandMocks.runtimeLoginStart).toHaveBeenCalledWith(
      "codex",
      "api-key",
      secret,
    );
    expect(useRuntimeStore.getState().login.codex).toEqual({
      mode: "api-key",
      status: "complete",
      loginId: null,
    });
    expect(JSON.stringify(useRuntimeStore.getState())).not.toContain(secret);
    expect(localStorage.setItem).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining(secret),
    );
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("redacts every intermediate state when post-login status echoes the API key", async () => {
    const secret = "sk-status-echo-secret";
    commandMocks.runtimeLoginStart.mockResolvedValue({ type: "apiKey" });
    commandMocks.runtimeStatus.mockResolvedValue(
      account("codex", {
        authenticated: true,
        authMode: "api-key",
        error: `status rejected ${secret}`,
      }),
    );
    const snapshots: string[] = [];
    const unsubscribe = useRuntimeStore.subscribe((state) => {
      snapshots.push(JSON.stringify(state));
    });

    try {
      await useRuntimeStore.getState().startLogin("codex", "api-key", secret);
    } finally {
      unsubscribe();
    }

    expect(snapshots.join("\n")).not.toContain(secret);
    expect(JSON.stringify(useRuntimeStore.getState())).not.toContain(secret);
    expect(useRuntimeStore.getState().accounts.codex.error).toBe(
      "Runtime status failed",
    );
  });

  it("redacts an API key even when the login error echoes it", async () => {
    const secret = "sk-test-rejected-secret";
    commandMocks.runtimeLoginStart.mockRejectedValue(
      new Error(`rejected ${secret}`),
    );

    await useRuntimeStore.getState().startLogin("codex", "api-key", secret);

    expect(JSON.stringify(useRuntimeStore.getState())).not.toContain(secret);
    expect(useRuntimeStore.getState().login.codex).toEqual({
      mode: "api-key",
      status: "error",
      loginId: null,
      message: "API key login failed",
    });
  });

  it("cancels the active login by its loginId and clears only that runtime", async () => {
    useRuntimeStore.setState({
      login: {
        claude: {
          mode: "browser",
          status: "waiting",
          loginId: "claude-login",
          authUrl: "https://claude.example",
        },
        codex: {
          mode: "browser",
          status: "waiting",
          loginId: "codex-login",
          authUrl: "https://codex.example",
        },
      },
    });
    commandMocks.runtimeLoginCancel.mockResolvedValue(undefined);

    await useRuntimeStore.getState().cancelLogin("codex");

    expect(commandMocks.runtimeLoginCancel).toHaveBeenCalledWith(
      "codex",
      "codex-login",
    );
    expect(useRuntimeStore.getState().login.codex).toBeNull();
    expect(useRuntimeStore.getState().login.claude).toEqual({
      mode: "browser",
      status: "waiting",
      loginId: "claude-login",
      authUrl: "https://claude.example",
    });
  });

  it("logout clears login state and refreshes only the requested account", async () => {
    const claude = account("claude", { authenticated: true });
    const loggedOutCodex = account("codex", { authenticated: false });
    useRuntimeStore.setState({
      accounts: {
        claude,
        codex: account("codex", { authenticated: true }),
      },
      login: {
        codex: {
          mode: "device-code",
          status: "waiting",
          loginId: "device-1",
          verificationUrl: "https://auth.example/device",
          userCode: "ABCD-EFGH",
        },
      },
    });
    commandMocks.runtimeLogout.mockResolvedValue(undefined);
    commandMocks.runtimeStatus.mockResolvedValue(loggedOutCodex);

    await useRuntimeStore.getState().logout("codex");

    expect(commandMocks.runtimeLogout).toHaveBeenCalledWith("codex");
    expect(commandMocks.runtimeStatus).toHaveBeenCalledWith("codex");
    expect(useRuntimeStore.getState().login.codex).toBeNull();
    expect(useRuntimeStore.getState().accounts.codex).toEqual(loggedOutCodex);
    expect(useRuntimeStore.getState().accounts.claude).toBe(claude);
  });

  it("isolates a logout failure and preserves its rejection", async () => {
    const claude = account("claude", { authenticated: true });
    useRuntimeStore.setState({
      accounts: {
        claude,
        codex: account("codex", { authenticated: true }),
      },
    });
    commandMocks.runtimeLogout.mockRejectedValue(
      new Error("Runtime logout unavailable"),
    );

    await expect(useRuntimeStore.getState().logout("codex")).rejects.toThrow(
      "Runtime logout unavailable",
    );

    expect(commandMocks.runtimeStatus).not.toHaveBeenCalled();
    expect(useRuntimeStore.getState().accounts.codex.error).toBe(
      "Runtime logout unavailable",
    );
    expect(useRuntimeStore.getState().accounts.claude).toBe(claude);
    expect(useRuntimeStore.getState().loading.codex).toBe(false);
  });

  it("rethrows an old logout failure without overwriting a newer account event", async () => {
    let handler: RuntimeEventHandler | undefined;
    eventMocks.listen.mockImplementation(async (_event, callback) => {
      handler = callback;
      return vi.fn<() => void>();
    });
    await ensureRuntimeAccountListener();
    let rejectLogout: ((error: Error) => void) | undefined;
    commandMocks.runtimeLogout.mockReturnValue(
      new Promise<void>((_resolve, reject) => {
        rejectLogout = reject;
      }),
    );
    const latest = account("codex", {
      authenticated: true,
      version: "latest-event-account",
    });

    const logout = useRuntimeStore.getState().logout("codex");
    handler?.({ payload: latest });
    rejectLogout?.(new Error("stale logout failure"));

    await expect(logout).rejects.toThrow("stale logout failure");
    expect(useRuntimeStore.getState().accounts.codex).toBe(latest);
    expect(useRuntimeStore.getState().accounts.codex.error).toBeNull();
    expect(useRuntimeStore.getState().loading.codex).toBe(false);
  });

  it("does not let an old successful logout refresh over a newer refresh", async () => {
    let resolveLogout: (() => void) | undefined;
    commandMocks.runtimeLogout.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveLogout = resolve;
      }),
    );
    const latest = account("codex", {
      authenticated: true,
      version: "latest-before-old-logout",
    });
    const staleLoggedOut = account("codex", {
      authenticated: false,
      version: "stale-old-logout",
    });
    commandMocks.runtimeStatus.mockResolvedValue(latest);

    const logout = useRuntimeStore.getState().logout("codex");
    await useRuntimeStore.getState().refresh("codex");
    commandMocks.runtimeStatus.mockResolvedValue(staleLoggedOut);
    resolveLogout?.();
    await logout;

    expect(commandMocks.runtimeStatus).toHaveBeenCalledTimes(1);
    expect(useRuntimeStore.getState().accounts.codex).toBe(latest);
    expect(useRuntimeStore.getState().loading.codex).toBe(false);
  });

  it("ignores a generic status response that began before logout", async () => {
    let resolveStaleStatus: ((value: RuntimeAccount) => void) | undefined;
    const staleStatus = new Promise<RuntimeAccount>((resolve) => {
      resolveStaleStatus = resolve;
    });
    const staleAuthenticated = account("codex", {
      authenticated: true,
      accountLabel: "stale@example.com",
    });
    const loggedOutCodex = account("codex", { authenticated: false });
    commandMocks.runtimeStatus
      .mockReturnValueOnce(staleStatus)
      .mockResolvedValueOnce(loggedOutCodex);
    commandMocks.runtimeLogout.mockResolvedValue(undefined);

    const staleRefresh = useRuntimeStore.getState().refresh("codex");
    await useRuntimeStore.getState().logout("codex");
    resolveStaleStatus?.(staleAuthenticated);
    await staleRefresh;

    expect(useRuntimeStore.getState().accounts.codex).toEqual(loggedOutCodex);
    expect(useRuntimeStore.getState().login.codex).toBeNull();
  });

  it("does not let a generic stale refresh complete a newer login", async () => {
    let resolveStaleStatus: ((value: RuntimeAccount) => void) | undefined;
    commandMocks.runtimeStatus.mockReturnValueOnce(
      new Promise<RuntimeAccount>((resolve) => {
        resolveStaleStatus = resolve;
      }),
    );
    commandMocks.runtimeLoginStart.mockResolvedValue({
      type: "chatgpt",
      authUrl: "https://auth.example/new-login",
      loginId: "new-login",
    });

    const staleRefresh = useRuntimeStore.getState().refresh("codex");
    await useRuntimeStore.getState().startLogin("codex", "browser");
    resolveStaleStatus?.(
      account("codex", {
        authenticated: true,
        accountLabel: "stale@example.com",
      }),
    );
    await staleRefresh;

    expect(useRuntimeStore.getState().accounts.codex.authenticated).toBe(false);
    expect(useRuntimeStore.getState().login.codex).toMatchObject({
      status: "waiting",
      loginId: "new-login",
    });
  });

  it("uses only dynamically returned models and preserves reverse isolation", async () => {
    const claudeModels = [model("claude", "claude-sonnet")];
    const codexModels = [
      model("codex", "gpt-5.3-codex"),
      model("codex", "gpt-5.4"),
    ];
    useRuntimeStore.setState({
      models: { claude: claudeModels, codex: [] },
    });
    commandMocks.runtimeListModels.mockResolvedValue(codexModels);

    await useRuntimeStore.getState().refreshModels("codex");

    expect(commandMocks.runtimeListModels).toHaveBeenCalledWith("codex");
    expect(useRuntimeStore.getState().models.codex).toEqual(codexModels);
    expect(useRuntimeStore.getState().models.codex).toHaveLength(2);
    expect(useRuntimeStore.getState().models.claude).toBe(claudeModels);
    expect(useRuntimeStore.getState().models.codex.map(({ id }) => id)).toEqual(
      ["gpt-5.3-codex", "gpt-5.4"],
    );
  });

  it("keeps the newest model refresh when an older request resolves last", async () => {
    let resolveOlder: ((value: RuntimeModel[]) => void) | undefined;
    const olderModels = [model("codex", "gpt-older")];
    const newerModels = [model("codex", "gpt-newer")];
    commandMocks.runtimeListModels
      .mockReturnValueOnce(
        new Promise<RuntimeModel[]>((resolve) => {
          resolveOlder = resolve;
        }),
      )
      .mockResolvedValueOnce(newerModels);

    const olderRefresh = useRuntimeStore.getState().refreshModels("codex");
    await useRuntimeStore.getState().refreshModels("codex");
    resolveOlder?.(olderModels);
    await olderRefresh;

    expect(useRuntimeStore.getState().models.codex).toEqual(newerModels);
  });

  it("does not write an older model refresh error after a newer request succeeds", async () => {
    let rejectOlder: ((reason: Error) => void) | undefined;
    const newerModels = [model("codex", "gpt-newer")];
    commandMocks.runtimeListModels
      .mockReturnValueOnce(
        new Promise<RuntimeModel[]>((_resolve, reject) => {
          rejectOlder = reject;
        }),
      )
      .mockResolvedValueOnce(newerModels);

    const olderRefresh = useRuntimeStore.getState().refreshModels("codex");
    await useRuntimeStore.getState().refreshModels("codex");
    rejectOlder?.(new Error("stale model failure"));
    await expect(olderRefresh).rejects.toThrow("stale model failure");

    expect(useRuntimeStore.getState().models.codex).toEqual(newerModels);
    expect(useRuntimeStore.getState().accounts.codex.error).toBeNull();
  });
});

describe("bounded login polling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  async function startBrowserLogin(loginId = "browser-1") {
    commandMocks.runtimeLoginStart.mockResolvedValue({
      type: "chatgpt",
      authUrl: `https://auth.example/${loginId}`,
      loginId,
    });
    await useRuntimeStore.getState().startLogin("codex", "browser");
  }

  async function startDeviceLogin(loginId = "device-1") {
    commandMocks.runtimeLoginStart.mockResolvedValue({
      type: "chatgptDeviceCode",
      verificationUrl: "https://auth.example/device",
      userCode: "ABCD-EFGH",
      loginId,
    });
    await useRuntimeStore.getState().startLogin("codex", "device-code");
  }

  const completionBeforeResponseCases = [
    {
      mode: "browser" as const,
      result: {
        type: "chatgpt" as const,
        authUrl: "https://auth.example/browser",
        loginId: "early-browser",
      },
    },
    {
      mode: "device-code" as const,
      result: {
        type: "chatgptDeviceCode" as const,
        verificationUrl: "https://auth.example/device",
        userCode: "EARLY-CODE",
        loginId: "early-device",
      },
    },
  ] satisfies Array<{
    mode: "browser" | "device-code";
    result: RuntimeLoginStartResult;
  }>;

  it.each(
    completionBeforeResponseCases,
  )("keeps an early authenticated $mode completion complete after the start response", async ({
    mode,
    result,
  }) => {
    let handler: RuntimeEventHandler | undefined;
    eventMocks.listen.mockImplementation(async (_event, callback) => {
      handler = callback;
      return vi.fn<() => void>();
    });
    await ensureRuntimeAccountListener();
    let resolveStart: ((value: RuntimeLoginStartResult) => void) | undefined;
    commandMocks.runtimeLoginStart.mockReturnValue(
      new Promise<RuntimeLoginStartResult>((resolve) => {
        resolveStart = resolve;
      }),
    );

    const login = useRuntimeStore.getState().startLogin("codex", mode);
    handler?.({
      payload: account("codex", {
        authenticated: true,
        accountLabel: "early@example.com",
      }),
    });
    resolveStart?.(result);
    await login;
    await vi.advanceTimersByTimeAsync(30_000);

    expect(useRuntimeStore.getState().accounts.codex.authenticated).toBe(true);
    expect(useRuntimeStore.getState().login.codex).toBeNull();
    expect(commandMocks.runtimeStatus).not.toHaveBeenCalled();
  });

  it.each(
    completionBeforeResponseCases,
  )("keeps an early failed $mode completion terminal after the start response", async ({
    mode,
    result,
  }) => {
    let handler: RuntimeEventHandler | undefined;
    eventMocks.listen.mockImplementation(async (_event, callback) => {
      handler = callback;
      return vi.fn<() => void>();
    });
    await ensureRuntimeAccountListener();
    let resolveStart: ((value: RuntimeLoginStartResult) => void) | undefined;
    commandMocks.runtimeLoginStart.mockReturnValue(
      new Promise<RuntimeLoginStartResult>((resolve) => {
        resolveStart = resolve;
      }),
    );

    const login = useRuntimeStore.getState().startLogin("codex", mode);
    handler?.({
      payload: account("codex", {
        authenticated: false,
        error: "Codex login failed",
      }),
    });
    resolveStart?.(result);
    await login;
    await vi.advanceTimersByTimeAsync(30_000);

    expect(useRuntimeStore.getState().login.codex).toEqual({
      mode,
      status: "error",
      loginId: result.loginId,
      message: "Codex login failed",
    });
    expect(commandMocks.runtimeStatus).not.toHaveBeenCalled();
  });

  it.each([
    ["browser", startBrowserLogin],
    ["device-code", startDeviceLogin],
  ] as const)("polls %s login after one second and stops when authenticated", async (_mode, startLogin) => {
    const waiting = account("codex", { authenticated: false });
    const authenticated = account("codex", {
      authenticated: true,
      accountLabel: "codex@example.com",
    });
    commandMocks.runtimeStatus
      .mockResolvedValueOnce(waiting)
      .mockResolvedValueOnce(authenticated);
    await startLogin();

    await vi.advanceTimersByTimeAsync(999);
    expect(commandMocks.runtimeStatus).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(commandMocks.runtimeStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(commandMocks.runtimeStatus).toHaveBeenCalledTimes(2);
    expect(useRuntimeStore.getState().accounts.codex).toEqual(authenticated);
    expect(useRuntimeStore.getState().login.codex).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(commandMocks.runtimeStatus).toHaveBeenCalledTimes(2);
  });

  it("times out after exactly thirty status attempts", async () => {
    commandMocks.runtimeStatus.mockResolvedValue(
      account("codex", { authenticated: false }),
    );
    await startBrowserLogin("timeout-login");

    await vi.advanceTimersByTimeAsync(30_000);

    expect(commandMocks.runtimeStatus).toHaveBeenCalledTimes(30);
    expect(useRuntimeStore.getState().login.codex).toEqual({
      mode: "browser",
      status: "error",
      loginId: "timeout-login",
      message: "Login timed out",
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(commandMocks.runtimeStatus).toHaveBeenCalledTimes(30);
  });

  it("stops polling immediately when login is cancelled", async () => {
    commandMocks.runtimeLoginCancel.mockResolvedValue(undefined);
    await startBrowserLogin("cancelled-login");

    await useRuntimeStore.getState().cancelLogin("codex");
    await vi.advanceTimersByTimeAsync(30_000);

    expect(commandMocks.runtimeLoginCancel).toHaveBeenCalledWith(
      "codex",
      "cancelled-login",
    );
    expect(commandMocks.runtimeStatus).not.toHaveBeenCalled();
    expect(useRuntimeStore.getState().login.codex).toBeNull();
  });

  it("keeps a failed cancellation retryable while polling remains stopped", async () => {
    commandMocks.runtimeLoginCancel
      .mockRejectedValueOnce(new Error("cancel unavailable"))
      .mockResolvedValueOnce(undefined);
    await startBrowserLogin("retry-cancel-login");

    await expect(
      useRuntimeStore.getState().cancelLogin("codex"),
    ).rejects.toThrow("cancel unavailable");
    expect(useRuntimeStore.getState().login.codex).toEqual({
      mode: "browser",
      status: "error",
      loginId: "retry-cancel-login",
      message: "cancel unavailable",
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(commandMocks.runtimeStatus).not.toHaveBeenCalled();

    await expect(
      useRuntimeStore.getState().cancelLogin("codex"),
    ).resolves.toBeUndefined();
    expect(commandMocks.runtimeLoginCancel).toHaveBeenCalledTimes(2);
    expect(commandMocks.runtimeLoginCancel).toHaveBeenLastCalledWith(
      "codex",
      "retry-cancel-login",
    );
    expect(useRuntimeStore.getState().login.codex).toBeNull();
  });

  it("clears a failed interactive cancellation when authentication later completes", async () => {
    let handler: RuntimeEventHandler | undefined;
    eventMocks.listen.mockImplementation(async (_event, callback) => {
      handler = callback;
      return vi.fn<() => void>();
    });
    await ensureRuntimeAccountListener();
    commandMocks.runtimeLoginCancel.mockRejectedValue(
      new Error("cancel unavailable"),
    );
    await startBrowserLogin("late-success-login");

    await expect(
      useRuntimeStore.getState().cancelLogin("codex"),
    ).rejects.toThrow("cancel unavailable");
    expect(useRuntimeStore.getState().login.codex).toMatchObject({
      mode: "browser",
      status: "error",
      loginId: "late-success-login",
    });

    const authenticated = account("codex", { authenticated: true });
    handler?.({ payload: authenticated });

    expect(useRuntimeStore.getState().accounts.codex).toEqual(authenticated);
    expect(useRuntimeStore.getState().login.codex).toBeNull();
  });

  it("stops the previous poll when a new login starts", async () => {
    await startBrowserLogin("old-login");
    commandMocks.runtimeLoginStart.mockResolvedValue({
      type: "chatgpt",
      authUrl: "https://auth.example/new-login",
      loginId: "new-login",
    });
    commandMocks.runtimeStatus.mockResolvedValue(
      account("codex", { authenticated: false }),
    );

    await useRuntimeStore.getState().startLogin("codex", "browser");
    await vi.advanceTimersByTimeAsync(1_000);

    expect(commandMocks.runtimeStatus).toHaveBeenCalledTimes(1);
    expect(useRuntimeStore.getState().login.codex).toMatchObject({
      status: "waiting",
      loginId: "new-login",
    });
  });

  it("ignores a stale start response after a newer login", async () => {
    let resolveOld:
      | ((value: { type: "chatgpt"; authUrl: string; loginId: string }) => void)
      | undefined;
    commandMocks.runtimeLoginStart
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
      )
      .mockResolvedValueOnce({
        type: "chatgpt",
        authUrl: "https://auth.example/new",
        loginId: "new-login",
      });

    const oldLogin = useRuntimeStore.getState().startLogin("codex", "browser");
    const newLogin = useRuntimeStore.getState().startLogin("codex", "browser");
    await newLogin;
    resolveOld?.({
      type: "chatgpt",
      authUrl: "https://auth.example/old",
      loginId: "old-login",
    });
    await oldLogin;

    expect(useRuntimeStore.getState().login.codex).toMatchObject({
      status: "waiting",
      loginId: "new-login",
    });
  });

  it("ignores a stale in-flight poll result after a newer login", async () => {
    let resolveStatus: ((value: RuntimeAccount) => void) | undefined;
    commandMocks.runtimeStatus.mockReturnValue(
      new Promise((resolve) => {
        resolveStatus = resolve;
      }),
    );
    await startBrowserLogin("old-login");
    vi.advanceTimersByTime(1_000);
    await Promise.resolve();
    expect(commandMocks.runtimeStatus).toHaveBeenCalledOnce();

    commandMocks.runtimeLoginStart.mockResolvedValue({
      type: "chatgpt",
      authUrl: "https://auth.example/new",
      loginId: "new-login",
    });
    await useRuntimeStore.getState().startLogin("codex", "browser");
    resolveStatus?.(
      account("codex", {
        authenticated: true,
        accountLabel: "stale@example.com",
      }),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(useRuntimeStore.getState().accounts.codex.authenticated).toBe(false);
    expect(useRuntimeStore.getState().login.codex).toMatchObject({
      status: "waiting",
      loginId: "new-login",
    });
  });

  it("an authenticated event stops polling before the next attempt", async () => {
    let handler: ((event: { payload: unknown }) => void) | undefined;
    eventMocks.listen.mockImplementation(async (_event, callback) => {
      handler = callback as (event: { payload: unknown }) => void;
      return vi.fn<() => void>();
    });
    await ensureRuntimeAccountListener();
    await startBrowserLogin("event-login");
    const authenticated = account("codex", { authenticated: true });

    handler?.({ payload: authenticated });
    await vi.advanceTimersByTimeAsync(30_000);

    expect(commandMocks.runtimeStatus).not.toHaveBeenCalled();
    expect(useRuntimeStore.getState().accounts.codex).toEqual(authenticated);
    expect(useRuntimeStore.getState().login.codex).toBeNull();
  });

  it("a failed login-completion account event stops polling with its redacted error", async () => {
    let handler: ((event: { payload: unknown }) => void) | undefined;
    eventMocks.listen.mockImplementation(async (_event, callback) => {
      handler = callback as (event: { payload: unknown }) => void;
      return vi.fn<() => void>();
    });
    await ensureRuntimeAccountListener();
    await startBrowserLogin("failed-event-login");
    const failed = account("codex", {
      authenticated: false,
      error: "Codex login failed",
    });

    handler?.({ payload: failed });
    await vi.advanceTimersByTimeAsync(30_000);

    expect(commandMocks.runtimeStatus).not.toHaveBeenCalled();
    expect(useRuntimeStore.getState().accounts.codex).toEqual(failed);
    expect(useRuntimeStore.getState().login.codex).toEqual({
      mode: "browser",
      status: "error",
      loginId: "failed-event-login",
      message: "Codex login failed",
    });
  });

  it("logout invalidates polling and permits only its explicit refresh", async () => {
    const loggedOut = account("codex", { authenticated: false });
    commandMocks.runtimeLogout.mockResolvedValue(undefined);
    commandMocks.runtimeStatus.mockResolvedValue(loggedOut);
    await startBrowserLogin("logout-login");

    await useRuntimeStore.getState().logout("codex");
    await vi.advanceTimersByTimeAsync(30_000);

    expect(commandMocks.runtimeStatus).toHaveBeenCalledTimes(1);
    expect(useRuntimeStore.getState().login.codex).toBeNull();
  });

  it("dispose stops timers and makes in-flight polling stale", async () => {
    await startBrowserLogin("disposed-login");

    disposeRuntimeStore();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(commandMocks.runtimeStatus).not.toHaveBeenCalled();
  });
});
