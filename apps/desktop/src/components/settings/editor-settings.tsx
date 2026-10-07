import { BookOpenIcon } from "lucide-react";
import { useI18n } from "@/lib/use-i18n";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/stores/settings-store";

export function EditorSettings() {
  const { t } = useI18n();
  const enabled = useSettingsStore((state) => state.latexTeaching);
  const setEnabled = useSettingsStore((state) => state.setLatexTeaching);

  return (
    <section
      aria-label={t("teach.section")}
      className="shrink-0 rounded-lg border border-border bg-card px-4 py-3"
      data-testid="latex-teaching-settings"
    >
      <h2 className="mb-3 flex items-center gap-2 font-medium text-sm">
        <span className="grid size-7 place-items-center rounded-md bg-primary/10 text-primary">
          <BookOpenIcon className="size-3.5" />
        </span>
        {t("teach.section")}
      </h2>
      <div className="flex items-start justify-between gap-4 rounded-md border border-border bg-muted/30 px-3 py-3">
        <div className="min-w-0">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <span className="font-medium text-sm">{t("teach.enable")}</span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 font-medium text-[11px] text-primary">
              <span aria-hidden className="size-1.5 rounded-full bg-primary" />
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
      <p className="mt-3 rounded-md border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-amber-800 text-xs leading-relaxed dark:text-amber-200">
        {t("teach.callout")}
      </p>
    </section>
  );
}
