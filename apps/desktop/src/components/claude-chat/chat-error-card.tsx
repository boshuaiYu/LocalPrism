import { useState } from "react";
import { chatErrorSummary } from "@/lib/chat-error-card";

export function ChatErrorCard({
  error,
  retryPrompt,
  busy,
  onRetry,
  onClearConversation,
  onDismiss,
}: {
  error: string;
  retryPrompt: string | null;
  busy: boolean;
  onRetry: (prompt: string) => void;
  onClearConversation: () => void;
  onDismiss: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const summary = chatErrorSummary(error, expanded);

  return (
    <div
      role="alert"
      data-testid="chat-error-card"
      className="mx-2 mt-2 rounded-lg border border-destructive/40 bg-destructive/10 p-2 text-destructive"
    >
      <p className="text-sm leading-5">{summary.text}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {retryPrompt && (
          <button
            type="button"
            className="lp-focus h-8 rounded-lg bg-destructive px-3 font-medium text-white text-xs disabled:opacity-50"
            disabled={busy}
            onClick={() => onRetry(retryPrompt)}
          >
            Retry
          </button>
        )}
        {summary.canExpand && (
          <button
            type="button"
            className="lp-focus h-8 rounded-lg border border-destructive/40 px-3 font-medium text-xs"
            onClick={() => setExpanded((open) => !open)}
          >
            {expanded ? "Hide details" : "Details"}
          </button>
        )}
        <button
          type="button"
          className="lp-focus h-8 rounded-lg border border-destructive/40 px-3 font-medium text-xs"
          onClick={onClearConversation}
        >
          Clear conversation
        </button>
        <button
          type="button"
          className="lp-focus h-8 rounded-lg px-3 font-medium text-xs"
          onClick={onDismiss}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
