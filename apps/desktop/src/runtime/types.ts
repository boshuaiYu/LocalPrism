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
