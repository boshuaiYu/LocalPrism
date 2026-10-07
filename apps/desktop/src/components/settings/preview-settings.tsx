import { useI18n } from "@/lib/use-i18n";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/stores/settings-store";

/** First ahead-of-the-curve feature on Settings → Preview. */
export function PreviewSettings() {
  const { t } = useI18n();
  const enabled = useSettingsStore((state) => state.latexTeaching);
  const setEnabled = useSettingsStore((state) => state.setLatexTeaching);

  return (
    <section
      aria-label={t("settings.preview")}
      className="px-1"
      data-testid="latex-teaching-settings"
    >
      <div className="flex items-start justify-between gap-4 py-1">
        <div className="min-w-0">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <span className="font-medium text-sm">{t("teach.enable")}</span>
            <span className="inline-flex items-center rounded-full border border-border bg-muted/50 px-2 py-0.5 font-medium text-[11px] text-muted-foreground">
              {t("teach.previewBadge")}
            </span>
          </div>
          <p className="text-muted-foreground text-xs leading-relaxed">
            {t("teach.enableHelp")}
          </p>
        </div>
        <button
          aria-checked={enabled}
          aria-label={t("teach.enable")}
          className={cn(
            "relative mt-0.5 h-7 w-12 shrink-0 rounded-full transition-colors",
            enabled ? "bg-primary" : "bg-muted-foreground/30",
          )}
          data-testid="latex-teaching-toggle"
          onClick={() => setEnabled(!enabled)}
          role="switch"
          type="button"
        >
          <span
            className={cn(
              "absolute top-0.5 left-0.5 size-6 rounded-full bg-background shadow transition-transform",
              enabled && "translate-x-5",
            )}
          />
        </button>
      </div>
    </section>
  );
}
