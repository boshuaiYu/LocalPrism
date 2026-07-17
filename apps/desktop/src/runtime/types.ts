export type RuntimeKind = "claude" | "codex";

export interface RuntimeWarningPayload {
  runtime: RuntimeKind;
  message: string;
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface RuntimeCapabilities {
  models: boolean;
  skills: boolean;
  customAgents: boolean;
  subagents: boolean;
  approvals: boolean;
}

export interface RuntimeAccount {
  runtime: RuntimeKind;
  installed: boolean;
  authenticated: boolean;
  version: string | null;
  accountLabel: string | null;
  authMode: string | null;
  capabilities: RuntimeCapabilities;
  error: string | null;
}

export interface RuntimeModel {
  runtime: RuntimeKind;
  id: string;
  displayName: string;
  description: string | null;
  reasoningEfforts: string[];
  defaultReasoningEffort: string | null;
  inputModalities: string[];
  isDefault: boolean;
}

export interface RuntimeTurnRequest {
  runtime: RuntimeKind;
  projectPath: string;
  tabId: string;
  /** Opaque identity shared by start, stop, and terminal events. */
  attemptId: string;
  sessionId: string | null;
  prompt: string;
  model: string;
  reasoningEffort: string | null;
  agentId: string | null;
  providerCredentialId: string | null;
  providerModelOverride: string | null;
}

export type ChangeTabRuntimeResult =
  | "changed"
  | "unchanged"
  | "blocked-streaming"
  | "blocked-stopping"
  | "confirmation-required"
  | "not-found";

export type RuntimeStopMode = "terminate" | "interrupt";

export interface RuntimeEventEnvelope {
  runtime: RuntimeKind;
  windowLabel: string;
  tabId: string;
  attemptId: string;
  sessionId: string | null;
  turnId: string | null;
  sequence: number;
  event: RuntimeEvent;
}

export type RuntimeEvent =
  | { type: "sessionStarted"; sessionId: string }
  | { type: "turnStarted"; turnId: string }
  | { type: "turnCompleted"; turnId: string }
  | { type: "turnInterrupted"; turnId: string }
  | { type: "turnFailed"; turnId: string | null; message: string }
  | { type: "assistantDelta"; itemId: string; delta: string }
  | { type: "assistantCompleted"; itemId: string; content: string }
  | { type: "reasoningSummaryDelta"; itemId: string; delta: string }
  | { type: "toolStarted"; itemId: string; name: string; input: JsonValue }
  | { type: "toolOutput"; itemId: string; output: string }
  | {
      type: "toolCompleted";
      itemId: string;
      success: boolean;
      output: string | null;
    }
  | { type: "fileChange"; itemId: string; path: string; diff: string | null }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | {
      type: "approvalRequested";
      requestId: JsonValue;
      method: string;
      details: JsonValue;
    }
  | {
      type: "userInputRequested";
      requestId: JsonValue;
      prompt: string;
      details: JsonValue;
    }
  | {
      type: "subagentDiscovered";
      agentId: string;
      name: string | null;
      details: JsonValue;
    }
  | {
      type: "subagentStatusChanged";
      agentId: string;
      status: string;
      details: JsonValue;
    }
  | { type: "warning"; message: string }
  | { type: "unknown"; nativeType: string };

export type RuntimeLoginStartResult =
  | { type: "apiKey" }
  | { type: "chatgpt"; authUrl: string; loginId: string }
  | {
      type: "chatgptDeviceCode";
      verificationUrl: string;
      userCode: string;
      loginId: string;
    };

export type RuntimeLoginState =
  | {
      mode: "browser";
      status: "waiting";
      loginId: string;
      authUrl: string;
    }
  | {
      mode: "device-code";
      status: "waiting";
      loginId: string;
      verificationUrl: string;
      userCode: string;
    }
  | { mode: "api-key"; status: "complete"; loginId: null }
  | {
      mode: "browser" | "device-code" | "api-key";
      status: "error";
      loginId: string | null;
      message: string;
    };

export interface ConversationRef {
  runtime: RuntimeKind;
  sessionId: string;
  projectPath: string;
}

export interface RuntimeConversation {
  reference: ConversationRef;
  title: string;
  status: string;
  updatedAt: number;
}

export interface RuntimeConversationHistory {
  reference: ConversationRef;
  items: JsonValue[];
}
