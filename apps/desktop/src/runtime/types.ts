import type { StepInfo } from "@/lib/runtime-flow-steps";

export type RuntimeKind = "claude" | "codex";

/**
 * UI-level chat peer. The wire protocol only ever speaks `RuntimeKind`
 * ("claude" | "codex"); "api" is a Claude-backed peer that additionally
 * carries a `providerCredentialId` pointing at an OpenAI-compatible
 * provider. Do NOT add a Rust-side `RuntimeKind::Api` — the distinction
 * lives entirely in the desktop UI/store layer.
 */
export type ChatRuntimePeer = "claude" | "api" | "codex";

/** Maps a UI peer to the wire runtime used for `RuntimeTurnRequest.runtime`. */
export function wireRuntimeFromPeer(peer: ChatRuntimePeer): RuntimeKind {
  return peer === "codex" ? "codex" : "claude";
}

/**
 * Derives the peer for a tab that has no explicit `chatPeer` stored yet
 * (e.g. persisted data from before this field existed). Codex tabs are
 * always the Codex peer; a Claude-runtime tab with an OpenAI-compatible
 * provider credential selected is the API peer; otherwise it's Claude.
 */
export function peerFromTab(input: {
  runtime: RuntimeKind;
  providerKey?: string | null;
}): ChatRuntimePeer {
  if (input.runtime === "codex") return "codex";
  return input.providerKey?.startsWith("openai-compatible:") ? "api" : "claude";
}

export type SkillScope = "user" | "project";

export interface SkillTarget {
  runtime: RuntimeKind;
  scope: SkillScope;
}

export interface RuntimeSkill {
  id: string;
  name: string;
  description: string;
  folder: string;
  sourcePath: string;
  sourceUrl?: string | null;
  targets: SkillTarget[];
  managed: boolean;
  compatibleRuntimes: RuntimeKind[];
  enabled: boolean;
  discoveryError: string | null;
  /** Frontmatter category/group, or the parent folder when the skill is nested. */
  category?: string | null;
}

export interface AgentProfile {
  id: string;
  runtime: RuntimeKind;
  scope: SkillScope;
  name: string;
  description: string;
  instructions: string;
  model: string | null;
  reasoningEffort: string | null;
  sandboxMode: string | null;
  permissionMode: string | null;
  tools: string[];
  nicknameCandidates: string[];
  skillIds: string[];
  sourcePath: string;
  unknownFields?: Record<string, string>;
}

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
  permissionMode?: string | null;
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

export type AgentRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface AgentRun {
  id: string;
  parentId: string | null;
  rootConversationId: string;
  runtime: RuntimeKind;
  agentName: string;
  agentRole: string | null;
  model: string | null;
  status: AgentRunStatus;
  startedAt: number;
  completedAt: number | null;
  activity: string | null;
  summary: string | null;
  error: string | null;
  transcriptAvailable: boolean;
}

export interface AgentRunNode extends AgentRun {
  children: AgentRunNode[];
}

export interface RuntimeRequestQuestion {
  id: string;
  prompt: string;
  options: string[];
}

export interface RuntimeRequest {
  requestId: number | string;
  method: string;
  runtime: RuntimeKind;
  threadId: string | null;
  turnId: string | null;
  tabId: string;
  agentRunId: string | null;
  title: string;
  command: string | null;
  cwd: string | null;
  diff: string | null;
  permissions: Record<string, unknown> | null;
  questions: RuntimeRequestQuestion[];
  details: JsonValue;
}

export type RuntimeRequestDecision =
  | "allow"
  | "allowForSession"
  | "deny"
  | "cancel"
  | "unsupported";

export interface RuntimeRequestResponse {
  decision: RuntimeRequestDecision;
  persistence: "turn" | "session" | null;
  answers: Record<string, string[]>;
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
  | {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      contextWindow?: number | null;
    }
  | { type: "approvalRequested"; request: RuntimeRequest }
  | { type: "approvalResolved"; requestId: string }
  | { type: "userInputRequested"; request: RuntimeRequest }
  | { type: "subagentDiscovered"; run: AgentRun }
  | { type: "subagentStatusChanged"; run: AgentRun }
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

export type RuntimeInstallOutputEvent = {
  runtime: RuntimeKind;
  stream: "stdout" | "stderr" | "status";
  line: string;
};

export type RuntimeInstallCompleteEvent = {
  runtime: RuntimeKind;
  success: boolean;
};

export type CodexSetupFlowPhase =
  | "idle"
  | "installing"
  | "logging-in"
  | "complete"
  | "error";

export type CodexSetupFlowState = {
  phase: CodexSetupFlowPhase;
  installSteps: StepInfo[];
  loginSteps: StepInfo[];
  installLogs: string[];
  error: string | null;
  /** When true, browser login should auto-open authUrl once. */
  autoOpenBrowser: boolean;
};
