import type {
  AgentRun,
  AgentRunStatus,
  JsonValue,
  RuntimeEvent,
  RuntimeEventEnvelope,
  RuntimeKind,
  RuntimeRequest,
} from "@/runtime/types";

export type NormalizeResult =
  | { ok: true; value: RuntimeEventEnvelope }
  | { ok: false; error: string };

export interface NormalizedItem {
  itemId: string;
  text: string;
  completed: boolean;
}

export class RuntimeEventReducer {
  private lastSequence = new Map<string, number>();
  readonly items: Record<string, NormalizedItem> = {};

  apply(envelope: RuntimeEventEnvelope): void {
    const routeKey = `${envelope.runtime}:${envelope.tabId}`;
    const previous = this.lastSequence.get(routeKey);
    if (previous !== undefined && envelope.sequence <= previous) {
      return;
    }
    this.lastSequence.set(routeKey, envelope.sequence);

    const sessionId = envelope.sessionId ?? "";
    const event = envelope.event;
    switch (event.type) {
      case "assistantDelta": {
        const key = itemKey(envelope.runtime, sessionId, event.itemId);
        const existing = this.items[key];
        if (existing?.completed) return;
        this.items[key] = {
          itemId: event.itemId,
          text: `${existing?.text ?? ""}${event.delta}`,
          completed: false,
        };
        break;
      }
      case "assistantCompleted": {
        const key = itemKey(envelope.runtime, sessionId, event.itemId);
        this.items[key] = {
          itemId: event.itemId,
          text: event.content,
          completed: true,
        };
        break;
      }
      default:
        break;
    }
  }
}

export function requestKey(id: number | string): string {
  return typeof id === "number" ? `n:${id}` : `s:${id}`;
}

export function normalizeRuntimeEnvelope(value: unknown): NormalizeResult {
  try {
    if (!isRecord(value)) {
      return { ok: false, error: "Runtime envelope must be an object" };
    }
    const runtime = value.runtime;
    if (runtime !== "claude" && runtime !== "codex") {
      return { ok: false, error: "Missing or invalid runtime" };
    }
    if (typeof value.tabId !== "string" || value.tabId.trim() === "") {
      return { ok: false, error: "Missing or empty tabId" };
    }
    if (
      typeof value.sequence !== "number" ||
      !Number.isFinite(value.sequence)
    ) {
      return { ok: false, error: "Missing or invalid sequence" };
    }
    if (typeof value.windowLabel !== "string") {
      return { ok: false, error: "Missing windowLabel" };
    }
    if (typeof value.attemptId !== "string" || value.attemptId.trim() === "") {
      return { ok: false, error: "Missing or empty attemptId" };
    }

    const eventResult = normalizeRuntimeEvent(value.event, runtime);
    if (!eventResult.ok) {
      return eventResult;
    }

    return {
      ok: true,
      value: {
        runtime,
        windowLabel: value.windowLabel,
        tabId: value.tabId,
        attemptId: value.attemptId,
        sessionId:
          value.sessionId === null || value.sessionId === undefined
            ? null
            : typeof value.sessionId === "string"
              ? value.sessionId
              : null,
        turnId:
          value.turnId === null || value.turnId === undefined
            ? null
            : typeof value.turnId === "string"
              ? value.turnId
              : null,
        sequence: value.sequence,
        event: eventResult.value,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function normalizeRuntimeEvent(
  value: unknown,
  runtime: RuntimeKind,
): { ok: true; value: RuntimeEvent } | { ok: false; error: string } {
  if (!isRecord(value) || typeof value.type !== "string") {
    return { ok: false, error: "Runtime event must include a type" };
  }

  switch (value.type) {
    case "sessionStarted":
      return requireString(value, "sessionId", (sessionId) => ({
        type: "sessionStarted",
        sessionId,
      }));
    case "turnStarted":
      return requireString(value, "turnId", (turnId) => ({
        type: "turnStarted",
        turnId,
      }));
    case "turnCompleted":
      return requireString(value, "turnId", (turnId) => ({
        type: "turnCompleted",
        turnId,
      }));
    case "turnInterrupted":
      return requireString(value, "turnId", (turnId) => ({
        type: "turnInterrupted",
        turnId,
      }));
    case "turnFailed":
      if (typeof value.message !== "string") {
        return { ok: false, error: "turnFailed requires message" };
      }
      return {
        ok: true,
        value: {
          type: "turnFailed",
          turnId: typeof value.turnId === "string" ? value.turnId : null,
          message: value.message,
        },
      };
    case "assistantDelta":
      return requireItemDelta(value, "assistantDelta");
    case "assistantCompleted":
      if (
        typeof value.itemId !== "string" ||
        typeof value.content !== "string"
      ) {
        return {
          ok: false,
          error: "assistantCompleted requires itemId and content",
        };
      }
      return {
        ok: true,
        value: {
          type: "assistantCompleted",
          itemId: value.itemId,
          content: value.content,
        },
      };
    case "reasoningSummaryDelta":
      return requireItemDelta(value, "reasoningSummaryDelta");
    case "toolStarted":
      if (typeof value.itemId !== "string" || typeof value.name !== "string") {
        return { ok: false, error: "toolStarted requires itemId and name" };
      }
      return {
        ok: true,
        value: {
          type: "toolStarted",
          itemId: value.itemId,
          name: value.name,
          input: (value.input as JsonValue) ?? null,
        },
      };
    case "toolOutput":
      if (
        typeof value.itemId !== "string" ||
        typeof value.output !== "string"
      ) {
        return { ok: false, error: "toolOutput requires itemId and output" };
      }
      return {
        ok: true,
        value: {
          type: "toolOutput",
          itemId: value.itemId,
          output: value.output,
        },
      };
    case "toolCompleted":
      if (
        typeof value.itemId !== "string" ||
        typeof value.success !== "boolean"
      ) {
        return {
          ok: false,
          error: "toolCompleted requires itemId and success",
        };
      }
      return {
        ok: true,
        value: {
          type: "toolCompleted",
          itemId: value.itemId,
          success: value.success,
          output: typeof value.output === "string" ? value.output : null,
        },
      };
    case "fileChange":
      if (typeof value.itemId !== "string" || typeof value.path !== "string") {
        return { ok: false, error: "fileChange requires itemId and path" };
      }
      return {
        ok: true,
        value: {
          type: "fileChange",
          itemId: value.itemId,
          path: value.path,
          diff: typeof value.diff === "string" ? value.diff : null,
        },
      };
    case "usage":
      if (
        typeof value.inputTokens !== "number" ||
        typeof value.outputTokens !== "number"
      ) {
        return {
          ok: false,
          error: "usage requires inputTokens and outputTokens",
        };
      }
      return {
        ok: true,
        value: {
          type: "usage",
          inputTokens: value.inputTokens,
          outputTokens: value.outputTokens,
          cacheReadTokens:
            typeof value.cacheReadTokens === "number"
              ? value.cacheReadTokens
              : 0,
          contextWindow:
            typeof value.contextWindow === "number" && value.contextWindow > 0
              ? value.contextWindow
              : null,
        },
      };
    case "approvalRequested": {
      const request = normalizeRuntimeRequest(
        flattenRuntimeRequestEvent(value),
        runtime,
      );
      if (!request.ok) return request;
      return {
        ok: true,
        value: { type: "approvalRequested", request: request.value },
      };
    }
    case "approvalResolved":
      if (
        typeof value.requestId !== "string" ||
        value.requestId.trim() === ""
      ) {
        return { ok: false, error: "approvalResolved requires requestId" };
      }
      return {
        ok: true,
        value: { type: "approvalResolved", requestId: value.requestId },
      };
    case "userInputRequested": {
      const request = normalizeRuntimeRequest(
        flattenRuntimeRequestEvent(value),
        runtime,
      );
      if (!request.ok) return request;
      return {
        ok: true,
        value: { type: "userInputRequested", request: request.value },
      };
    }
    case "subagentDiscovered":
    case "subagentStatusChanged": {
      const run = normalizeAgentRun(value.run ?? value);
      if (!run.ok) {
        return { ok: false, error: `${value.type} requires a valid AgentRun` };
      }
      return {
        ok: true,
        value:
          value.type === "subagentDiscovered"
            ? { type: "subagentDiscovered", run: run.value }
            : { type: "subagentStatusChanged", run: run.value },
      };
    }
    case "warning":
      if (typeof value.message !== "string") {
        return { ok: false, error: "warning requires message" };
      }
      return { ok: true, value: { type: "warning", message: value.message } };
    case "unknown":
      if (typeof value.nativeType !== "string") {
        return { ok: false, error: "unknown requires nativeType" };
      }
      return {
        ok: true,
        value: { type: "unknown", nativeType: value.nativeType },
      };
    default:
      return {
        ok: true,
        value: {
          type: "warning",
          message: `Unsupported runtime event type: ${safeNativeType(value.type)}`,
        },
      };
  }
}

function flattenRuntimeRequestEvent(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return isRecord(value.request) ? { ...value, ...value.request } : value;
}

function normalizeRuntimeRequest(
  value: Record<string, unknown>,
  runtime: RuntimeKind,
): { ok: true; value: RuntimeRequest } | { ok: false; error: string } {
  const requestId = value.requestId;
  if (typeof requestId !== "number" && typeof requestId !== "string") {
    return { ok: false, error: "request requires requestId" };
  }
  if (typeof value.method !== "string" || value.method.trim() === "") {
    return { ok: false, error: "request requires method" };
  }
  const requestRuntime =
    value.runtime === "claude" || value.runtime === "codex"
      ? value.runtime
      : runtime;
  const questions = Array.isArray(value.questions)
    ? value.questions
        .filter(isRecord)
        .map((question) => ({
          id: typeof question.id === "string" ? question.id : "",
          prompt: typeof question.prompt === "string" ? question.prompt : "",
          options: Array.isArray(question.options)
            ? question.options.filter(
                (option): option is string => typeof option === "string",
              )
            : [],
        }))
        .filter((question) => question.id && question.prompt)
    : [];

  return {
    ok: true,
    value: {
      requestId,
      method: value.method,
      runtime: requestRuntime,
      threadId: typeof value.threadId === "string" ? value.threadId : null,
      turnId: typeof value.turnId === "string" ? value.turnId : null,
      tabId: typeof value.tabId === "string" ? value.tabId : "",
      agentRunId:
        typeof value.agentRunId === "string" ? value.agentRunId : null,
      title:
        typeof value.title === "string" && value.title.trim()
          ? value.title
          : value.method,
      command: typeof value.command === "string" ? value.command : null,
      cwd: typeof value.cwd === "string" ? value.cwd : null,
      diff: typeof value.diff === "string" ? value.diff : null,
      permissions: isRecord(value.permissions)
        ? (value.permissions as Record<string, unknown>)
        : null,
      questions,
      details: (value.details as JsonValue) ?? null,
    },
  };
}

export function normalizeAgentRun(value: unknown):
  | {
      ok: true;
      value: AgentRun;
    }
  | { ok: false; error: string } {
  if (!isRecord(value)) {
    return { ok: false, error: "AgentRun must be an object" };
  }
  if (typeof value.id !== "string" || value.id.trim() === "") {
    return { ok: false, error: "AgentRun requires id" };
  }
  if (value.runtime !== "claude" && value.runtime !== "codex") {
    return { ok: false, error: "AgentRun requires runtime" };
  }
  if (typeof value.rootConversationId !== "string") {
    return { ok: false, error: "AgentRun requires rootConversationId" };
  }
  if (typeof value.agentName !== "string") {
    return { ok: false, error: "AgentRun requires agentName" };
  }
  if (typeof value.startedAt !== "number") {
    return { ok: false, error: "AgentRun requires startedAt" };
  }
  const status = normalizeAgentStatus(value.status);
  if (!status) {
    return { ok: false, error: "AgentRun requires a valid status" };
  }

  return {
    ok: true,
    value: {
      id: value.id,
      parentId: typeof value.parentId === "string" ? value.parentId : null,
      rootConversationId: value.rootConversationId,
      runtime: value.runtime,
      agentName: value.agentName,
      agentRole: typeof value.agentRole === "string" ? value.agentRole : null,
      model: typeof value.model === "string" ? value.model : null,
      status,
      startedAt: value.startedAt,
      completedAt:
        typeof value.completedAt === "number" ? value.completedAt : null,
      activity: typeof value.activity === "string" ? value.activity : null,
      summary: typeof value.summary === "string" ? value.summary : null,
      error: typeof value.error === "string" ? value.error : null,
      transcriptAvailable: value.transcriptAvailable === true,
    },
  };
}

function normalizeAgentStatus(value: unknown): AgentRunStatus | null {
  switch (value) {
    case "queued":
    case "running":
    case "completed":
    case "failed":
    case "cancelled":
      return value;
    default:
      return null;
  }
}

function requireString(
  value: Record<string, unknown>,
  field: string,
  build: (value: string) => RuntimeEvent,
): { ok: true; value: RuntimeEvent } | { ok: false; error: string } {
  const raw = value[field];
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: false, error: `${field} is required` };
  }
  return { ok: true, value: build(raw) };
}

function requireItemDelta(
  value: Record<string, unknown>,
  type: "assistantDelta" | "reasoningSummaryDelta",
): { ok: true; value: RuntimeEvent } | { ok: false; error: string } {
  if (typeof value.itemId !== "string" || typeof value.delta !== "string") {
    return { ok: false, error: `${type} requires itemId and delta` };
  }
  return {
    ok: true,
    value: { type, itemId: value.itemId, delta: value.delta },
  };
}

function itemKey(
  runtime: RuntimeKind,
  sessionId: string,
  itemId: string,
): string {
  return `${runtime}:${sessionId}:${itemId}`;
}

function safeNativeType(value: string): string {
  return value.replace(/[\r\n]+/g, " ").slice(0, 120);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
