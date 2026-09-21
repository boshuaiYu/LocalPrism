import { type FC, memo, useEffect, useState } from "react";

// ─── Streaming Indicator (isolated to prevent re-render storms) ───

const GENERIC_WORKING_STATUS =
  /^(thinking(\.\.\.|…)|codex is working(\.\.\.|…)|waiting for codex(\.\.\.|…)|writing engine started(\.\.\.|…))$/i;

export const StreamingIndicator: FC<{
  startedAt: number | null;
  status?: string | null;
  runtime?: "claude" | "codex";
}> = memo(({ startedAt, status, runtime = "claude" }) => {
  const calculateElapsed = () =>
    startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0;

  const [elapsed, setElapsed] = useState(calculateElapsed);

  useEffect(() => {
    setElapsed(calculateElapsed());
    const timer = setInterval(() => {
      setElapsed(calculateElapsed());
    }, 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  const normalizedStatus = status?.trim() || "";
  const label = (() => {
    if (normalizedStatus && !GENERIC_WORKING_STATUS.test(normalizedStatus)) {
      return normalizedStatus;
    }
    if (elapsed >= 45) {
      return runtime === "codex"
        ? "Still waiting (reconnects can take 1–2 minutes)…"
        : "Still waiting for the first reply…";
    }
    return normalizedStatus || "Thinking...";
  })();

  return (
    <div className="flex items-center gap-1.5 px-1 py-1.5 text-muted-foreground">
      <div className="flex gap-0.5">
        <span
          className="size-1.5 animate-bounce rounded-full bg-muted-foreground/50"
          style={{ animationDelay: "0ms" }}
        />
        <span
          className="size-1.5 animate-bounce rounded-full bg-muted-foreground/50"
          style={{ animationDelay: "150ms" }}
        />
        <span
          className="size-1.5 animate-bounce rounded-full bg-muted-foreground/50"
          style={{ animationDelay: "300ms" }}
        />
      </div>
      <span className="text-sm">
        {label}
        {elapsed >= 3 && (
          <span className="ml-1 text-muted-foreground/60 text-xs">
            {elapsed}s
          </span>
        )}
      </span>
    </div>
  );
});
