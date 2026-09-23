import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  interruptRuntimeTurn,
  runtimeArchiveConversation,
  runtimeReadConversation,
  runtimeRewindConversation,
  runtimeInstall,
  runtimeListConversations,
  runtimeListModels,
  runtimeLoginCancel,
  runtimeLoginStart,
  runtimeLogout,
  runtimeStatus,
  startRuntimeTurn,
} from "@/runtime/commands";
import type {
  ConversationRef,
  RuntimeAccount,
  RuntimeConversation,
  RuntimeLoginStartResult,
  RuntimeLoginState,
  RuntimeModel,
  RuntimeTurnRequest,
} from "@/runtime/types";

const account: RuntimeAccount = {
  runtime: "claude",
  installed: true,
  authenticated: true,
  version: "1.0.0",
  accountLabel: "writer@example.test",
  authMode: "browser",
  capabilities: {
    models: true,
    skills: true,
    customAgents: true,
    subagents: true,
    approvals: true,
  },
  error: null,
};

const model: RuntimeModel = {
  runtime: "codex",
  id: "gpt-5.4",
  displayName: "GPT-5.4",
  description: null,
  reasoningEfforts: ["medium", "high"],
  defaultReasoningEffort: "medium",
  inputModalities: ["text", "image"],
  isDefault: true,
};

const loginStates = [
  {
    mode: "browser",
    status: "waiting",
    loginId: "browser-login",
    authUrl: "https://example.test/browser",
  },
  {
    mode: "device-code",
    status: "waiting",
    loginId: "device-login",
    verificationUrl: "https://example.test/device",
    userCode: "ABCD-EFGH",
  },
  { mode: "api-key", status: "complete", loginId: null },
  {
    mode: "api-key",
    status: "error",
    loginId: null,
    message: "Authentication failed",
  },
] satisfies RuntimeLoginState[];

describe("runtime command wrappers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requests status with only the selected runtime", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(account);

    const result = await runtimeStatus("claude");

    expect(invoke).toHaveBeenCalledWith("runtime_status", {
      runtime: "claude",
    });
    expect(result).toBe(account);
  });

  it("requests installation with only the selected runtime", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(true);

    await expect(runtimeInstall("codex")).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith("runtime_install", {
      runtime: "codex",
    });
  });

  it("starts browser login without an apiKey property", async () => {
    const response = {
      type: "chatgpt",
      authUrl: "https://example.test/auth",
      loginId: "login-browser",
    } satisfies RuntimeLoginStartResult;
    vi.mocked(invoke).mockResolvedValueOnce(response);

    const result = await runtimeLoginStart(
      "codex",
      "browser",
      "must-not-be-forwarded",
    );

    expect(invoke).toHaveBeenCalledWith("runtime_login_start", {
      runtime: "codex",
      mode: "browser",
    });
    const payload = vi.mocked(invoke).mock.calls[0]?.[1];
    expect(Object.prototype.hasOwnProperty.call(payload, "apiKey")).toBe(false);
    expect(result).toEqual(response);
    expect(result).not.toBe(response);
  });

  it("starts device-code login without an apiKey property", async () => {
    const response = {
      type: "chatgptDeviceCode",
      verificationUrl: "https://example.test/device",
      userCode: "ABCD-EFGH",
      loginId: "login-device",
    } satisfies RuntimeLoginStartResult;
    vi.mocked(invoke).mockResolvedValueOnce(response);

    const result = await runtimeLoginStart(
      "codex",
      "device-code",
      "must-not-be-forwarded",
    );

    expect(invoke).toHaveBeenCalledWith("runtime_login_start", {
      runtime: "codex",
      mode: "device-code",
    });
    const payload = vi.mocked(invoke).mock.calls[0]?.[1];
    expect(Object.prototype.hasOwnProperty.call(payload, "apiKey")).toBe(false);
    expect(result).toEqual(response);
    expect(result).not.toBe(response);
  });

  it("sends an API key only for api-key login and projects secret-free results", async () => {
    const apiKey = "sk-secret-value";
    const response = {
      type: "apiKey",
      apiKey,
      diagnostic: `accepted ${apiKey}`,
    } as unknown as RuntimeLoginStartResult;
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});
    const consoleDebug = vi
      .spyOn(console, "debug")
      .mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    vi.mocked(invoke).mockResolvedValueOnce(response);

    const result = await runtimeLoginStart("codex", "api-key", apiKey);

    expect(invoke).toHaveBeenCalledWith("runtime_login_start", {
      runtime: "codex",
      mode: "api-key",
      apiKey,
    });
    expect(result).toEqual({ type: "apiKey" });
    expect(result).not.toBe(response);
    expect(JSON.stringify(result)).not.toContain(apiKey);
    expect(localStorage.setItem).not.toHaveBeenCalled();
    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleInfo).not.toHaveBeenCalled();
    expect(consoleDebug).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("does not expose an API key contained in a rejected login error", async () => {
    const apiKey = "sk-rejected-secret";
    vi.mocked(invoke).mockRejectedValueOnce(
      new Error(`backend rejected ${apiKey}`),
    );

    let caught: unknown;
    try {
      await runtimeLoginStart("codex", "api-key", apiKey);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("API key login failed");
    expect(String(caught)).not.toContain(apiKey);
  });

  it("cancels login with the runtime and loginId", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(undefined);

    await runtimeLoginCancel("codex", "login-123");

    expect(invoke).toHaveBeenCalledWith("runtime_login_cancel", {
      runtime: "codex",
      loginId: "login-123",
    });
  });

  it("logs out with only the selected runtime", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(undefined);

    await runtimeLogout("codex");

    expect(invoke).toHaveBeenCalledWith("runtime_logout", {
      runtime: "codex",
    });
  });

  it("returns only the models supplied by the runtime", async () => {
    const models = [model];
    vi.mocked(invoke).mockResolvedValueOnce(models);

    const result = await runtimeListModels("codex");

    expect(invoke).toHaveBeenCalledWith("runtime_list_models", {
      runtime: "codex",
    });
    expect(result).toBe(models);
    expect(result).toHaveLength(1);
  });

  it("preserves an empty runtime model list without adding a fallback", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([]);

    await expect(runtimeListModels("codex")).resolves.toEqual([]);
  });

  it("starts a turn through the typed runtime request wrapper", async () => {
    const request: RuntimeTurnRequest = {
      runtime: "codex",
      projectPath: "C:/work/paper",
      tabId: "tab-7",
      attemptId: "attempt-7",
      sessionId: "thread-3",
      prompt: "Continue",
      model: "gpt-5.4",
      reasoningEffort: "high",
      agentId: "reviewer",
      providerCredentialId: null,
      providerModelOverride: null,
    };
    vi.mocked(invoke).mockResolvedValueOnce(undefined);

    await startRuntimeTurn(request);

    expect(invoke).toHaveBeenCalledWith("runtime_start_turn", { request });
  });

  it("reads a conversation through its complete typed reference", async () => {
    const reference: ConversationRef = {
      runtime: "codex",
      sessionId: "thread-3",
      projectPath: "C:/work/paper",
    };
    const history = {
      reference,
      items: [{ type: "agentMessage", text: "Done" }],
    };
    vi.mocked(invoke).mockResolvedValueOnce(history);

    await expect(runtimeReadConversation(reference)).resolves.toBe(history);
    expect(invoke).toHaveBeenCalledWith("runtime_read_conversation", {
      reference,
    });
  });

  it("lists conversations with exactly the selected runtime and project path", async () => {
    const conversations: RuntimeConversation[] = [
      {
        reference: {
          runtime: "codex",
          sessionId: "thread-3",
          projectPath: "C:/work/paper",
        },
        title: "Paper review",
        status: "idle",
        updatedAt: 42,
      },
    ];
    vi.mocked(invoke).mockResolvedValueOnce(conversations);

    await expect(
      runtimeListConversations("codex", "C:/work/paper"),
    ).resolves.toBe(conversations);
    expect(invoke).toHaveBeenCalledWith("runtime_list_conversations", {
      runtime: "codex",
      projectPath: "C:/work/paper",
    });
  });

  it("rewinds a conversation with the selected anchor", async () => {
    const reference: ConversationRef = {
      runtime: "claude",
      sessionId: "session-9",
      projectPath: "C:/work/notes",
    };
    vi.mocked(invoke).mockResolvedValueOnce(reference);

    await expect(
      runtimeRewindConversation({
        reference,
        role: "user",
        text: "Rewrite the abstract",
        ordinal: 1,
        userTurnOrdinal: 1,
      }),
    ).resolves.toBe(reference);
    expect(invoke).toHaveBeenCalledWith("runtime_rewind_conversation", {
      request: {
        reference,
        role: "user",
        text: "Rewrite the abstract",
        ordinal: 1,
        userTurnOrdinal: 1,
      },
    });
  });

  it("archives a conversation with exactly its complete reference", async () => {
    const reference: ConversationRef = {
      runtime: "claude",
      sessionId: "session-9",
      projectPath: "C:/work/notes",
    };
    vi.mocked(invoke).mockResolvedValueOnce(undefined);

    await expect(
      runtimeArchiveConversation(reference),
    ).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("runtime_archive_conversation", {
      reference,
    });
  });

  it("interrupts a turn with its explicit runtime and tab id", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(true);

    await expect(
      interruptRuntimeTurn("codex", "tab-7", "attempt-7", "interrupt"),
    ).resolves.toBe(true);

    expect(invoke).toHaveBeenCalledWith("runtime_interrupt_turn", {
      runtime: "codex",
      tabId: "tab-7",
      attemptId: "attempt-7",
      mode: "interrupt",
    });
  });

  it("passes invoke errors through unchanged", async () => {
    const error = "runtime unavailable";
    vi.mocked(invoke).mockRejectedValueOnce(error);

    await expect(runtimeStatus("codex")).rejects.toBe(error);
  });

  it("exports the planned secret-free login state variants", () => {
    expect(loginStates).toHaveLength(4);
    expect(JSON.stringify(loginStates)).not.toContain("apiKey");
  });
});
