import type { FallbackProps } from "react-error-boundary";
import { useI18n } from "@/lib/use-i18n";

export function ErrorFallback({ error, resetErrorBoundary }: FallbackProps) {
  const { t } = useI18n();
  return (
    <div className="flex h-screen w-screen items-center justify-center bg-background p-8">
      <div className="w-full max-w-2xl space-y-4">
        <div className="lp-error-card space-y-2 rounded-lg p-4">
          <h1 className="font-bold text-2xl">{t("errors.somethingWrong")}</h1>
          <p className="text-sm">{t("errors.unexpected")}</p>
        </div>

        <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border bg-muted p-4 text-xs">
          {error instanceof Error
            ? `${error.message}${error.stack ? `\n\n${error.stack}` : ""}`
            : String(error)}
        </pre>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={resetErrorBoundary}
            className="lp-error-action rounded-md px-4 py-2 font-medium text-sm hover:opacity-90"
          >
            {t("errors.tryAgain")}
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-md border px-4 py-2 font-medium text-sm hover:bg-accent"
          >
            {t("errors.reload")}
          </button>
        </div>
      </div>
    </div>
  );
}
