export type RuntimeKind = "claude" | "codex";

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
