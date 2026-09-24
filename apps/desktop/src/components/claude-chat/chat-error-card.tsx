import { useState } from "react";
import { chatErrorSummary } from "@/lib/chat-error-card";
import { localizeChatNotice } from "@/lib/chat-empty-reply";
import { useI18n } from "@/lib/use-i18n";

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
  const { t, language } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const summary = chatErrorSummary(
    localizeChatNotice(error, language),
    expanded,
  );

  return (
    <div
      role="alert"
      data-testid="chat-error-card"
      className="lp-error-card mx-2 mt-2 rounded-lg p-2"
    >
      <p className="text-sm leading-5">{summary.text}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {retryPrompt && (
          <button
            type="button"
            className="lp-error-action lp-focus h-8 rounded-lg px-3 font-medium text-xs disabled:opacity-50"
            disabled={busy}
            onClick={() => onRetry(retryPrompt)}
          >
            {t("errors.retry")}
          </button>
        )}
        {summary.canExpand && (
          <button
            type="button"
            className="lp-focus h-8 rounded-lg border border-destructive/45 px-3 font-medium text-xs"
            onClick={() => setExpanded((open) => !open)}
          >
            {expanded ? t("errors.hideDetails") : t("errors.details")}
          </button>
        )}
        <button
          type="button"
          className="lp-focus h-8 rounded-lg border border-destructive/45 px-3 font-medium text-xs"
          onClick={onClearConversation}
        >
          {t("errors.clearConversation")}
        </button>
        <button
          type="button"
          className="lp-focus h-8 rounded-lg px-3 font-medium text-xs"
          onClick={onDismiss}
        >
          {t("errors.dismiss")}
        </button>
      </div>
    </div>
  );
}
