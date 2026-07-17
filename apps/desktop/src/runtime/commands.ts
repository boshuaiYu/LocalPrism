import { invoke } from "@tauri-apps/api/core";
import type {
  ConversationRef,
  RuntimeAccount,
  RuntimeConversationHistory,
  RuntimeKind,
  RuntimeLoginStartResult,
  RuntimeModel,
  RuntimeStopMode,
  RuntimeTurnRequest,
} from "@/runtime/types";

type RuntimeLoginMode = "browser" | "device-code" | "api-key";

export function runtimeStatus(runtime: RuntimeKind): Promise<RuntimeAccount> {
  return invoke<RuntimeAccount>("runtime_status", { runtime });
}

export function runtimeInstall(runtime: RuntimeKind): Promise<boolean> {
  return invoke<boolean>("runtime_install", { runtime });
}

export async function runtimeLoginStart(
  runtime: RuntimeKind,
  mode: RuntimeLoginMode,
  apiKey?: string,
): Promise<RuntimeLoginStartResult> {
  const payload =
    mode === "api-key" ? { runtime, mode, apiKey } : { runtime, mode };
  if (mode === "api-key") {
    try {
      const result = await invoke<unknown>("runtime_login_start", payload);
      if (!isTaggedObject(result, "apiKey")) {
        throw new Error("Invalid runtime login response");
      }
      return { type: "apiKey" };
    } catch {
      throw new Error("API key login failed");
    }
  }

  const result = await invoke<unknown>("runtime_login_start", payload);
  if (mode === "browser") {
    if (
      !isTaggedObject(result, "chatgpt") ||
      typeof result.authUrl !== "string" ||
      typeof result.loginId !== "string"
    ) {
      throw new Error("Invalid runtime login response");
    }
    return {
      type: "chatgpt",
      authUrl: result.authUrl,
      loginId: result.loginId,
    };
  }

  if (
    !isTaggedObject(result, "chatgptDeviceCode") ||
    typeof result.verificationUrl !== "string" ||
    typeof result.userCode !== "string" ||
    typeof result.loginId !== "string"
  ) {
    throw new Error("Invalid runtime login response");
  }
  return {
    type: "chatgptDeviceCode",
    verificationUrl: result.verificationUrl,
    userCode: result.userCode,
    loginId: result.loginId,
  };
}

function isTaggedObject(
  value: unknown,
  type: RuntimeLoginStartResult["type"],
): value is Record<string, unknown> & { type: typeof type } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === type
  );
}

export function runtimeLoginCancel(
  runtime: RuntimeKind,
  loginId: string,
): Promise<void> {
  return invoke<void>("runtime_login_cancel", { runtime, loginId });
}

export function runtimeLogout(runtime: RuntimeKind): Promise<void> {
  return invoke<void>("runtime_logout", { runtime });
}

export function runtimeListModels(
  runtime: RuntimeKind,
): Promise<RuntimeModel[]> {
  return invoke<RuntimeModel[]>("runtime_list_models", { runtime });
}

export function runtimeReadConversation(
  reference: ConversationRef,
): Promise<RuntimeConversationHistory> {
  return invoke<RuntimeConversationHistory>("runtime_read_conversation", {
    reference,
  });
}

export function startRuntimeTurn(request: RuntimeTurnRequest): Promise<void> {
  return invoke<void>("runtime_start_turn", { request });
}

export function interruptRuntimeTurn(
  runtime: RuntimeKind,
  tabId: string,
  attemptId: string,
  mode: RuntimeStopMode,
): Promise<boolean> {
  return invoke<boolean>("runtime_interrupt_turn", {
    runtime,
    tabId,
    attemptId,
    mode,
  });
}
