import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { create } from "zustand";
import {
  runtimeInstall,
  runtimeListModels,
  runtimeLoginCancel,
  runtimeLoginStart,
  runtimeLogout,
  runtimeStatus,
} from "@/runtime/commands";
import type {
  RuntimeAccount,
  RuntimeKind,
  RuntimeLoginState,
  RuntimeModel,
} from "@/runtime/types";

const RUNTIMES: RuntimeKind[] = ["claude", "codex"];
const ACCOUNT_EVENT = "runtime-account-updated";
const LOGIN_POLL_INTERVAL_MS = 1_000;
const LOGIN_POLL_LIMIT = 180;

type InteractiveLoginMode = "browser" | "device-code";

interface LoginPoll {
  runtime: RuntimeKind;
  mode: InteractiveLoginMode;
  loginId: string;
  epoch: number;
  attempts: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const loginEpochs: Record<RuntimeKind, number> = { claude: 0, codex: 0 };
const loginPolls: Partial<Record<RuntimeKind, LoginPoll>> = {};
const accountEpochs: Record<RuntimeKind, number> = { claude: 0, codex: 0 };
const modelEpochs: Record<RuntimeKind, number> = { claude: 0, codex: 0 };
const loadingCounts: Record<RuntimeKind, number> = { claude: 0, codex: 0 };

export interface RuntimeState {
  accounts: Record<RuntimeKind, RuntimeAccount>;
  models: Record<RuntimeKind, RuntimeModel[]>;
  loading: Partial<Record<RuntimeKind, boolean>>;
  login: Partial<Record<RuntimeKind, RuntimeLoginState | null>>;
  refresh(runtime?: RuntimeKind): Promise<void>;
  install(runtime: RuntimeKind): Promise<boolean>;
  startLogin(
    runtime: RuntimeKind,
    mode: "browser" | "device-code" | "api-key",
    apiKey?: string,
  ): Promise<void>;
  cancelLogin(runtime: RuntimeKind): Promise<void>;
  logout(runtime: RuntimeKind): Promise<void>;
  refreshModels(runtime: RuntimeKind): Promise<void>;
}

function emptyAccount(runtime: RuntimeKind): RuntimeAccount {
  return {
    runtime,
    installed: false,
    authenticated: false,
    version: null,
    accountLabel: null,
    authMode: null,
    capabilities: {
      models: false,
      skills: false,
      customAgents: false,
      subagents: false,
      approvals: false,
    },
    error: null,
  };
}

function initialData() {
  return {
    accounts: {
      claude: emptyAccount("claude"),
      codex: emptyAccount("codex"),
    },
    models: { claude: [], codex: [] },
    loading: {},
    login: {},
  } satisfies Pick<RuntimeState, "accounts" | "models" | "loading" | "login">;
}

export function hasReadyRuntime(
  accounts: Record<RuntimeKind, RuntimeAccount>,
): boolean {
  return Object.values(accounts).some(
    (account) => account.installed && account.authenticated,
  );
}

function messageFrom(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return fallback;
}

function isCodexLoginFailureMessage(message: string): boolean {
  return (
    message === "Codex login failed" ||
    message.startsWith("Codex login failed:")
  );
}

function isRuntimeKind(value: unknown): value is RuntimeKind {
  return value === "claude" || value === "codex";
}

function isRuntimeAccount(value: unknown): value is RuntimeAccount {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RuntimeAccount>;
  const capabilities = candidate.capabilities;
  return (
    isRuntimeKind(candidate.runtime) &&
    typeof candidate.installed === "boolean" &&
    typeof candidate.authenticated === "boolean" &&
    (candidate.version === null || typeof candidate.version === "string") &&
    (candidate.accountLabel === null ||
      typeof candidate.accountLabel === "string") &&
    (candidate.authMode === null || typeof candidate.authMode === "string") &&
    (candidate.error === null || typeof candidate.error === "string") &&
    !!capabilities &&
    typeof capabilities.models === "boolean" &&
    typeof capabilities.skills === "boolean" &&
    typeof capabilities.customAgents === "boolean" &&
    typeof capabilities.subagents === "boolean" &&
    typeof capabilities.approvals === "boolean"
  );
}

function setLoading(runtime: RuntimeKind, loading: boolean): void {
  const count = loading
    ? loadingCounts[runtime] + 1
    : Math.max(0, loadingCounts[runtime] - 1);
  loadingCounts[runtime] = count;
  useRuntimeStore.setState((state) => ({
    loading: { ...state.loading, [runtime]: count > 0 },
  }));
}

function setAccountError(runtime: RuntimeKind, message: string): void {
  useRuntimeStore.setState((state) => ({
    accounts: {
      ...state.accounts,
      [runtime]: { ...state.accounts[runtime], error: message },
    },
  }));
}

function invalidateLogin(runtime: RuntimeKind): number {
  const poll = loginPolls[runtime];
  if (poll?.timer !== null && poll?.timer !== undefined) {
    clearTimeout(poll.timer);
  }
  delete loginPolls[runtime];
  const epoch = loginEpochs[runtime] + 1;
  loginEpochs[runtime] = epoch;
  return epoch;
}

function isCurrentLogin(runtime: RuntimeKind, epoch: number): boolean {
  return loginEpochs[runtime] === epoch;
}

function invalidateAccount(runtime: RuntimeKind): number {
  const epoch = accountEpochs[runtime] + 1;
  accountEpochs[runtime] = epoch;
  return epoch;
}

function isCurrentAccount(runtime: RuntimeKind, epoch: number): boolean {
  return accountEpochs[runtime] === epoch;
}

function invalidateModels(runtime: RuntimeKind): number {
  const epoch = modelEpochs[runtime] + 1;
  modelEpochs[runtime] = epoch;
  return epoch;
}

function isCurrentModels(runtime: RuntimeKind, epoch: number): boolean {
  return modelEpochs[runtime] === epoch;
}

function isCurrentPoll(poll: LoginPoll): boolean {
  if (loginPolls[poll.runtime] !== poll) return false;
  if (!isCurrentLogin(poll.runtime, poll.epoch)) return false;
  const login = useRuntimeStore.getState().login[poll.runtime];
  return login?.status === "waiting" && login.loginId === poll.loginId;
}

function completeAuthenticatedLogin(runtime: RuntimeKind): void {
  invalidateLogin(runtime);
  useRuntimeStore.setState((state) => ({
    login:
      typeof state.login[runtime]?.loginId === "string"
        ? { ...state.login, [runtime]: null }
        : state.login,
  }));
}

function schedulePoll(poll: LoginPoll): void {
  if (!isCurrentPoll(poll)) return;
  poll.timer = setTimeout(() => {
    poll.timer = null;
    void runPoll(poll);
  }, LOGIN_POLL_INTERVAL_MS);
}

function timeOutPoll(poll: LoginPoll): void {
  if (!isCurrentPoll(poll)) return;
  delete loginPolls[poll.runtime];
  loginEpochs[poll.runtime] += 1;
  useRuntimeStore.setState((state) => ({
    login: {
      ...state.login,
      [poll.runtime]: {
        mode: poll.mode,
        status: "error",
        loginId: poll.loginId,
        message: "Login timed out",
      },
    },
  }));
}

async function runPoll(poll: LoginPoll): Promise<void> {
  if (!isCurrentPoll(poll)) return;
  poll.attempts += 1;
  let nextAccount: RuntimeAccount | null = null;
  try {
    nextAccount = await runtimeStatus(poll.runtime);
  } catch {
    nextAccount = null;
  }
  if (!isCurrentPoll(poll)) return;

  if (nextAccount) {
    useRuntimeStore.setState((state) => ({
      accounts: { ...state.accounts, [poll.runtime]: nextAccount },
    }));
    if (nextAccount.authenticated) {
      completeAuthenticatedLogin(poll.runtime);
      return;
    }
  }

  if (poll.attempts >= LOGIN_POLL_LIMIT) {
    timeOutPoll(poll);
    return;
  }
  schedulePoll(poll);
}

function startLoginPolling(
  runtime: RuntimeKind,
  mode: InteractiveLoginMode,
  loginId: string,
  epoch: number,
): void {
  if (!isCurrentLogin(runtime, epoch)) return;
  const poll: LoginPoll = {
    runtime,
    mode,
    loginId,
    epoch,
    attempts: 0,
    timer: null,
  };
  loginPolls[runtime] = poll;
  schedulePoll(poll);
}

export const useRuntimeStore = create<RuntimeState>((set, get) => ({
  ...initialData(),

  refresh: async (runtime) => {
    if (runtime === undefined) {
      await Promise.allSettled(RUNTIMES.map((kind) => get().refresh(kind)));
      return;
    }

    const accountEpoch = invalidateAccount(runtime);
    setLoading(runtime, true);
    try {
      const nextAccount = await runtimeStatus(runtime);
      if (!isCurrentAccount(runtime, accountEpoch)) return;
      set((state) => ({
        accounts: { ...state.accounts, [runtime]: nextAccount },
      }));
      if (nextAccount.authenticated) completeAuthenticatedLogin(runtime);
    } catch (error) {
      if (isCurrentAccount(runtime, accountEpoch)) {
        setAccountError(runtime, messageFrom(error, "Runtime status failed"));
      }
      throw error;
    } finally {
      setLoading(runtime, false);
    }
  },

  install: async (runtime) => {
    const accountEpoch = invalidateAccount(runtime);
    setLoading(runtime, true);
    try {
      const installed = await runtimeInstall(runtime);
      if (!installed) {
        if (isCurrentAccount(runtime, accountEpoch)) {
          setAccountError(runtime, "Runtime installation failed");
        }
        return false;
      }
      if (!isCurrentAccount(runtime, accountEpoch)) return true;
      await get().refresh(runtime);
      return true;
    } catch (error) {
      if (isCurrentAccount(runtime, accountEpoch)) {
        setAccountError(
          runtime,
          messageFrom(error, "Runtime installation failed"),
        );
      }
      return false;
    } finally {
      setLoading(runtime, false);
    }
  },

  startLogin: async (runtime, mode, apiKey) => {
    const epoch = invalidateLogin(runtime);
    const accountEpoch = invalidateAccount(runtime);
    setLoading(runtime, true);
    set((state) => ({
      accounts: {
        ...state.accounts,
        [runtime]: { ...state.accounts[runtime], error: null },
      },
      login: { ...state.login, [runtime]: null },
    }));
    let credential = apiKey;
    try {
      const result =
        mode === "api-key"
          ? await runtimeLoginStart(runtime, mode, credential)
          : await runtimeLoginStart(runtime, mode);
      if (!isCurrentLogin(runtime, epoch)) return;

      if (result.type !== "apiKey") {
        const currentAccount = get().accounts[runtime];
        if (currentAccount.authenticated) {
          completeAuthenticatedLogin(runtime);
          return;
        }
        if (
          typeof currentAccount.error === "string" &&
          isCodexLoginFailureMessage(currentAccount.error)
        ) {
          const resultMode =
            result.type === "chatgpt" ? "browser" : "device-code";
          set((state) => ({
            login: {
              ...state.login,
              [runtime]: {
                mode: resultMode,
                status: "error",
                loginId: result.loginId,
                message: currentAccount.error as string,
              },
            },
          }));
          return;
        }
      }

      if (result.type === "chatgpt") {
        set((state) => ({
          login: {
            ...state.login,
            [runtime]: {
              mode: "browser",
              status: "waiting",
              loginId: result.loginId,
              authUrl: result.authUrl,
            },
          },
        }));
        startLoginPolling(runtime, "browser", result.loginId, epoch);
      } else if (result.type === "chatgptDeviceCode") {
        set((state) => ({
          login: {
            ...state.login,
            [runtime]: {
              mode: "device-code",
              status: "waiting",
              loginId: result.loginId,
              verificationUrl: result.verificationUrl,
              userCode: result.userCode,
            },
          },
        }));
        startLoginPolling(runtime, "device-code", result.loginId, epoch);
      } else {
        set((state) => ({
          login: {
            ...state.login,
            [runtime]: {
              mode: "api-key",
              status: "complete",
              loginId: null,
            },
          },
        }));
        try {
          const nextAccount = await runtimeStatus(runtime);
          if (!isCurrentAccount(runtime, accountEpoch)) return;
          const safeAccount = nextAccount.error
            ? { ...nextAccount, error: "Runtime status failed" }
            : nextAccount;
          set((state) => ({
            accounts: { ...state.accounts, [runtime]: safeAccount },
          }));
          if (safeAccount.authenticated) completeAuthenticatedLogin(runtime);
        } catch (error) {
          if (isCurrentAccount(runtime, accountEpoch)) {
            setAccountError(runtime, "Runtime status failed");
          }
          throw error;
        }
      }
    } catch (error) {
      if (!isCurrentLogin(runtime, epoch)) return;
      const message =
        mode === "api-key"
          ? "API key login failed"
          : messageFrom(error, "Runtime login failed");
      set((state) => ({
        login: {
          ...state.login,
          [runtime]: { mode, status: "error", loginId: null, message },
        },
      }));
    } finally {
      credential = undefined;
      apiKey = undefined;
      setLoading(runtime, false);
    }
  },

  cancelLogin: async (runtime) => {
    const current = get().login[runtime];
    const epoch = invalidateLogin(runtime);
    if (!current?.loginId) {
      set((state) => ({ login: { ...state.login, [runtime]: null } }));
      return;
    }
    const { loginId, mode } = current;
    setLoading(runtime, true);
    try {
      await runtimeLoginCancel(runtime, loginId);
      if (!isCurrentLogin(runtime, epoch)) return;
      set((state) => ({ login: { ...state.login, [runtime]: null } }));
    } catch (error) {
      if (isCurrentLogin(runtime, epoch)) {
        set((state) => ({
          login: {
            ...state.login,
            [runtime]: {
              mode,
              status: "error",
              loginId,
              message: messageFrom(error, "Runtime login cancellation failed"),
            },
          },
        }));
      }
      throw error;
    } finally {
      setLoading(runtime, false);
    }
  },

  logout: async (runtime) => {
    invalidateLogin(runtime);
    const accountEpoch = invalidateAccount(runtime);
    setLoading(runtime, true);
    set((state) => ({ login: { ...state.login, [runtime]: null } }));
    try {
      await runtimeLogout(runtime);
      if (!isCurrentAccount(runtime, accountEpoch)) return;
      await get().refresh(runtime);
    } catch (error) {
      if (isCurrentAccount(runtime, accountEpoch)) {
        setAccountError(runtime, messageFrom(error, "Runtime logout failed"));
      }
      throw error;
    } finally {
      setLoading(runtime, false);
    }
  },

  refreshModels: async (runtime) => {
    const modelEpoch = invalidateModels(runtime);
    setLoading(runtime, true);
    try {
      const nextModels = await runtimeListModels(runtime);
      if (!isCurrentModels(runtime, modelEpoch)) return;
      set((state) => ({
        models: { ...state.models, [runtime]: nextModels },
      }));
    } catch (error) {
      if (isCurrentModels(runtime, modelEpoch)) {
        setAccountError(
          runtime,
          messageFrom(error, "Runtime model refresh failed"),
        );
      }
      throw error;
    } finally {
      setLoading(runtime, false);
    }
  },
}));

let listenerEpoch = 0;
let listenerPending: Promise<void> | null = null;
let listenerUnlisten: UnlistenFn | null = null;
let listenerRetryTimer: ReturnType<typeof setTimeout> | null = null;
let listenerCancelPending: (() => void) | null = null;
const LISTENER_RETRY_INTERVAL_MS = 1_000;
const LISTENER_RETRY_LIMIT = 3;

function handleAccountEvent(payload: unknown): void {
  if (!isRuntimeAccount(payload)) return;
  invalidateAccount(payload.runtime);
  const currentLogin = useRuntimeStore.getState().login[payload.runtime];
  if (payload.authenticated) {
    completeAuthenticatedLogin(payload.runtime);
  } else if (payload.error && currentLogin?.status === "waiting") {
    invalidateLogin(payload.runtime);
    useRuntimeStore.setState((state) => ({
      login: {
        ...state.login,
        [payload.runtime]: {
          mode: currentLogin.mode,
          status: "error",
          loginId: currentLogin.loginId,
          message: payload.error as string,
        },
      },
    }));
  }
  useRuntimeStore.setState((state) => ({
    accounts: { ...state.accounts, [payload.runtime]: payload },
  }));
}

export function ensureRuntimeAccountListener(): Promise<void> {
  if (listenerUnlisten) return Promise.resolve();
  if (listenerPending) return listenerPending;

  const epoch = listenerEpoch;
  let resolvePending: (() => void) | undefined;
  let rejectPending: ((error: unknown) => void) | undefined;
  let finished = false;
  const pending = new Promise<void>((resolve, reject) => {
    resolvePending = resolve;
    rejectPending = reject;
  });
  listenerPending = pending;
  let attempts = 0;

  const finish = (error?: unknown) => {
    if (finished) return;
    finished = true;
    if (listenerRetryTimer) {
      clearTimeout(listenerRetryTimer);
      listenerRetryTimer = null;
    }
    if (listenerPending === pending) listenerPending = null;
    if (listenerCancelPending === cancelPending) {
      listenerCancelPending = null;
    }
    if (error === undefined) resolvePending?.();
    else rejectPending?.(error);
  };
  const cancelPending = () => finish();
  listenerCancelPending = cancelPending;

  const handleFailure = (error: unknown) => {
    if (epoch !== listenerEpoch) {
      finish();
      return;
    }
    if (attempts >= LISTENER_RETRY_LIMIT) {
      finish(error);
      return;
    }
    const timer = setTimeout(() => {
      if (listenerRetryTimer === timer) listenerRetryTimer = null;
      attempt();
    }, LISTENER_RETRY_INTERVAL_MS);
    listenerRetryTimer = timer;
  };

  const attempt = () => {
    if (epoch !== listenerEpoch) {
      finish();
      return;
    }
    attempts += 1;
    let registration: Promise<UnlistenFn>;
    try {
      registration = listen<unknown>(ACCOUNT_EVENT, (event) => {
        if (epoch === listenerEpoch) handleAccountEvent(event.payload);
      });
    } catch (error) {
      handleFailure(error);
      return;
    }
    void registration.then((unlisten) => {
      if (epoch !== listenerEpoch) {
        unlisten();
        finish();
        return;
      }
      listenerUnlisten = unlisten;
      finish();
    }, handleFailure);
  };

  attempt();
  return pending;
}

export function disposeRuntimeStore(): void {
  for (const runtime of RUNTIMES) {
    invalidateLogin(runtime);
    invalidateAccount(runtime);
    invalidateModels(runtime);
    loadingCounts[runtime] = 0;
  }
  listenerEpoch += 1;
  if (listenerRetryTimer) {
    clearTimeout(listenerRetryTimer);
    listenerRetryTimer = null;
  }
  const cancelPending = listenerCancelPending;
  listenerCancelPending = null;
  cancelPending?.();
  listenerPending = null;
  const unlisten = listenerUnlisten;
  listenerUnlisten = null;
  if (unlisten) unlisten();
}

export function resetRuntimeStoreForTests(): void {
  disposeRuntimeStore();
  useRuntimeStore.setState(initialData());
}

void ensureRuntimeAccountListener().catch(() => undefined);

if (import.meta.hot) {
  import.meta.hot.dispose(disposeRuntimeStore);
}
