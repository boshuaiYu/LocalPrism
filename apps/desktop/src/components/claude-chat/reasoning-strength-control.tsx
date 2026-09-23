import type { AdjustableReasoningStrength } from "@/lib/reasoning-strength";
import { cn } from "@/lib/utils";

export function ReasoningStrengthControl({
  control,
  layout,
  disabled = false,
  onChange,
}: {
  control: AdjustableReasoningStrength;
  layout: "wide" | "narrow";
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  if (control.kind === "continuous") {
    return (
      <label
        data-testid="reasoning-strength-control"
        data-kind="continuous"
        className={cn(
          "flex min-w-0 items-center gap-2",
          layout === "narrow" ? "w-full" : "w-40 shrink-0",
        )}
      >
        <span className="shrink-0 text-muted-foreground text-xs">
          {control.value}
        </span>
        <input
          type="range"
          data-testid="reasoning-strength-slider"
          min={control.min}
          max={control.max}
          step={control.step}
          value={control.value}
          disabled={disabled}
          aria-label="Reasoning strength"
          aria-valuemin={control.min}
          aria-valuemax={control.max}
          aria-valuenow={control.value}
          aria-valuetext={String(control.value)}
          className="h-2 min-w-0 flex-1 accent-[#C17A5C] disabled:cursor-not-allowed disabled:opacity-50"
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      </label>
    );
  }

  return (
    <div
      role="radiogroup"
      aria-label="Reasoning strength"
      data-testid="reasoning-strength-control"
      data-kind="discrete"
      className={cn(
        "min-w-0 rounded-full border border-border bg-muted/40 p-0.5",
        layout === "narrow" ? "grid w-full" : "inline-flex max-w-full shrink-0",
      )}
      style={
        layout === "narrow"
          ? {
              gridTemplateColumns: `repeat(${control.options.length}, minmax(0, 1fr))`,
            }
          : undefined
      }
    >
      {control.options.map((option) => {
        const selected = option.value === control.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={`Reasoning strength ${option.label}`}
            title={option.label}
            disabled={disabled}
            className={cn(
              "h-7 min-w-0 truncate rounded-full px-2.5 text-xs transition-colors",
              selected
                ? "bg-background font-medium text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
