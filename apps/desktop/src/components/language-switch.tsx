import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/use-i18n";
import type { UiLanguage } from "@/lib/i18n";

export function LanguageSwitch({
  compact = false,
  className,
}: {
  compact?: boolean;
  className?: string;
}) {
  const { language, setLanguage, t } = useI18n();
  const options: Array<{ id: UiLanguage; label: string }> = [
    { id: "zh", label: compact ? "中" : t("language.zh") },
    { id: "en", label: compact ? "EN" : t("language.en") },
  ];

  return (
    <div
      role="group"
      aria-label={t("language.label")}
      data-testid="language-switch"
      className={cn(
        "inline-flex items-center rounded-md border border-border/70 bg-background p-0.5",
        className,
      )}
    >
      {options.map((option) => {
        const selected = language === option.id;
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={selected}
            className={cn(
              "rounded-[5px] font-medium transition-colors",
              compact ? "h-6 px-1.5 text-[11px]" : "h-7 px-2.5 text-xs",
              selected
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => setLanguage(option.id)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
