import type { ClaudeStreamMessage } from "@/stores/claude-chat-store";
import {
  snapshotHasTokens,
  type TokenUsageSnapshot,
} from "@/lib/chat-token-usage";

/** Streaming-status sentinel. The indicator translates it. */
export const COMPACTING_STATUS = "compact:compacting";

export type CompactTrigger = "auto" | "manual" | "unknown";

export type CompactNoticeState = {
  pending: boolean;
  trigger: CompactTrigger;
  preTokens: number | null;
  postTokens: number | null;
  summary: string | null;
};

export type CompactStreamEvent =
  | { kind: "compacting" }
  | { kind: "compact-idle" }
  | {
      kind: "boundary";
      trigger: CompactTrigger;
      preTokens: number | null;
      postTokens: number | null;
    }
  | { kind: "summary"; text: string };

const SUMMARY_PREFIX =
  "This session is being continued from a previous conversation";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function numberField(
  record: Record<string, unknown>,
  keys: readonly string[],
): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.round(value);
    }
  }
  return null;
}

function messageText(record: Record<string, unknown>): string {
  const inner = asRecord(record.message);
  const content = inner?.content ?? record.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const item = asRecord(block);
      if (!item || item.type !== "text" || typeof item.text !== "string") {
        return "";
      }
      return item.text;
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function parseTrigger(value: unknown): CompactTrigger {
  if (value === "auto" || value === "manual") return value;
  return "unknown";
}

function isCompactSummary(record: Record<string, unknown>): boolean {
  if (record.type !== "user") return false;
  if (record.isCompactSummary === true || record.is_compact_summary === true) {
    return true;
  }
  const transcriptOnly =
    record.isVisibleInTranscriptOnly === true ||
    record.is_visible_in_transcript_only === true;
  return transcriptOnly && messageText(record).startsWith(SUMMARY_PREFIX);
}

/**
 * Claude Code stream-json compact signals.
 *
 * In progress: `{type:"system", subtype:"status", status:"compacting"}`.
 * Done: `{type:"system", subtype:"compact_boundary", compact_metadata:{trigger, pre_tokens, post_tokens}}`.
 * The summary is the following user message with `isCompactSummary: true`.
 * Field names are accepted in both the SDK's snake_case and the CLI's camelCase.
 */
export function parseCompactStreamMessage(
  message: unknown,
): CompactStreamEvent | null {
  const record = asRecord(message);
  if (!record || (record.type !== "system" && record.type !== "user")) {
    return null;
  }
  if (record.type === "system" && record.subtype === "status") {
    if (record.status === "compacting") return { kind: "compacting" };
    if (record.status == null || record.status === "") {
      return { kind: "compact-idle" };
    }
    return null;
  }
  if (record.type === "system" && record.subtype === "compact_boundary") {
    const metadata =
      asRecord(record.compact_metadata) ?? asRecord(record.compactMetadata);
    return {
      kind: "boundary",
      trigger: parseTrigger(metadata?.trigger ?? record.trigger),
      preTokens: metadata
        ? numberField(metadata, ["pre_tokens", "preTokens"])
        : null,
      postTokens: metadata
        ? numberField(metadata, ["post_tokens", "postTokens"])
        : null,
    };
  }
  if (!isCompactSummary(record)) return null;
  const text = messageText(record);
  if (!text) return null;
  return { kind: "summary", text };
}

function noticeMessage(notice: CompactNoticeState): ClaudeStreamMessage {
  return {
    type: "system",
    subtype: "compact-notice",
    compactNotice: notice,
  };
}

function lastNoticeIndex(messages: readonly ClaudeStreamMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.subtype === "compact-notice") return index;
  }
  return -1;
}

/**
 * True when this event still belongs to the open compact divider.
 * A finished divider is left alone so the next compact appends its own row.
 * The summary that follows a boundary may still fill the divider it just closed
 * when that divider is the last message and has no summary yet.
 */
function belongsToOpenNotice(
  messages: readonly ClaudeStreamMessage[],
  index: number,
  notice: CompactNoticeState | undefined,
  event: CompactStreamEvent,
): notice is CompactNoticeState {
  if (!notice || index < 0) return false;
  if (notice.pending) return true;
  return (
    event.kind === "summary" && !notice.summary && index === messages.length - 1
  );
}

/** Insert or update the compact divider. Does not append the raw CLI event. */
export function applyCompactEvent(
  messages: readonly ClaudeStreamMessage[],
  event: CompactStreamEvent,
): ClaudeStreamMessage[] {
  const next = [...messages];
  const index = lastNoticeIndex(next);
  const current = index >= 0 ? next[index]?.compactNotice : undefined;

  if (event.kind === "compacting") {
    if (current?.pending) return messages as ClaudeStreamMessage[];
    next.push(
      noticeMessage({
        pending: true,
        trigger: "unknown",
        preTokens: null,
        postTokens: null,
        summary: null,
      }),
    );
    return next;
  }

  if (event.kind === "compact-idle") return messages as ClaudeStreamMessage[];

  if (event.kind === "summary") {
    const text = event.text.trim();
    if (!text) return messages as ClaudeStreamMessage[];
    if (belongsToOpenNotice(next, index, current, event)) {
      next[index] = noticeMessage({
        ...current,
        pending: false,
        summary: text,
      });
      return next;
    }
    next.push(
      noticeMessage({
        pending: false,
        trigger: "unknown",
        preTokens: null,
        postTokens: null,
        summary: text,
      }),
    );
    return next;
  }

  if (belongsToOpenNotice(next, index, current, event)) {
    next[index] = noticeMessage({
      pending: false,
      trigger: event.trigger === "unknown" ? current.trigger : event.trigger,
      preTokens: event.preTokens ?? current.preTokens,
      postTokens: event.postTokens ?? current.postTokens,
      summary: current.summary,
    });
    return next;
  }
  next.push(
    noticeMessage({
      pending: false,
      trigger: event.trigger,
      preTokens: event.preTokens,
      postTokens: event.postTokens,
      summary: null,
    }),
  );
  return next;
}

export function dropPendingCompactNotices(
  messages: readonly ClaudeStreamMessage[],
): ClaudeStreamMessage[] {
  if (
    !messages.some(
      (message) =>
        message.subtype === "compact-notice" && message.compactNotice?.pending,
    )
  ) {
    return messages as ClaudeStreamMessage[];
  }
  return messages.filter(
    (message) =>
      !(message.subtype === "compact-notice" && message.compactNotice?.pending),
  );
}

function occupancy(snapshot: TokenUsageSnapshot): number {
  return (
    snapshot.inputTokens +
    snapshot.outputTokens +
    snapshot.cacheReadTokens +
    snapshot.cacheCreationTokens
  );
}

function positive(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.round(value);
}

function estimateSummaryTokens(text: string | null | undefined): number | null {
  const trimmed = text?.trim() ?? "";
  if (!trimmed) return null;
  return Math.max(1, Math.ceil(trimmed.length / 4));
}

/**
 * Occupancy to show once compact finishes.
 *
 * Prefer `post_tokens` from the boundary. Otherwise estimate from the summary
 * so the ring leaves the pre-compact total without flashing 0. A later request
 * usage replaces this. An estimate must not overwrite a snapshot that is
 * already far below the pre-compact size.
 */
export function usageAfterCompact(
  current: TokenUsageSnapshot | null | undefined,
  info: {
    preTokens?: number | null;
    postTokens?: number | null;
    summaryText?: string | null;
  },
): TokenUsageSnapshot | null {
  const authoritative = positive(info.postTokens);
  const estimated = authoritative ?? estimateSummaryTokens(info.summaryText);
  if (!estimated) return null;
  const next: TokenUsageSnapshot = {
    inputTokens: estimated,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  if (!current || !snapshotHasTokens(current)) return next;
  const currentUsed = occupancy(current);
  if (estimated >= currentUsed) return null;
  const pre = positive(info.preTokens);
  if (!authoritative && pre && currentUsed < pre * 0.8) return null;
  if (!authoritative && !pre && currentUsed < estimated * 4) return null;
  return next;
}

export function compactUsageUpdate(
  current: TokenUsageSnapshot | null | undefined,
  event: CompactStreamEvent,
  messages: readonly ClaudeStreamMessage[],
): TokenUsageSnapshot | null {
  if (event.kind !== "boundary" && event.kind !== "summary") return null;
  const notice = [...messages]
    .reverse()
    .find((message) => message.subtype === "compact-notice")?.compactNotice;
  return usageAfterCompact(current, {
    preTokens:
      notice?.preTokens ?? (event.kind === "boundary" ? event.preTokens : null),
    postTokens:
      notice?.postTokens ??
      (event.kind === "boundary" ? event.postTokens : null),
    summaryText:
      notice?.summary ?? (event.kind === "summary" ? event.text : null),
  });
}
