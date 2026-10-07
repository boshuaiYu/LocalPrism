import { useState } from "react";
import type { ClaudeStreamMessage } from "@/stores/claude-chat-store";
import { formatTokenCount } from "@/lib/chat-token-usage";
import { useI18n } from "@/lib/use-i18n";

export function CompactNotice({ message }: { message: ClaudeStreamMessage }) {
  const { t } = useI18n();
  const notice = message.compactNotice;
  const [open, setOpen] = useState(false);
  if (!notice) return null;
  const summary = notice.summary?.trim() ?? "";
  const preTokens =
    notice.preTokens && notice.preTokens > 0 ? notice.preTokens : null;

  return (
    <div
      data-testid="compact-notice"
      data-state={notice.pending ? "pending" : "done"}
      className="my-3 flex flex-col items-center gap-1 px-2 text-center"
    >
      <div className="flex w-full items-center gap-3 text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        <span className="shrink-0 text-xs">
          {notice.pending ? t("chat.compacting") : t("chat.compacted")}
        </span>
        <span className="h-px flex-1 bg-border" />
      </div>
      {!notice.pending && preTokens ? (
        <p className="text-[11px] text-muted-foreground">
          {t("chat.compactedBefore", {
            tokens: formatTokenCount(preTokens),
          })}
        </p>
      ) : null}
      {!notice.pending && summary ? (
        <button
          type="button"
          className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          {open ? t("chat.hideCompactSummary") : t("chat.showCompactSummary")}
        </button>
      ) : null}
      {open && summary ? (
        <p
          data-testid="compact-summary"
          className="mt-1 w-full whitespace-pre-wrap text-left text-muted-foreground text-xs leading-5"
        >
          {summary}
        </p>
      ) : null}
    </div>
  );
}
