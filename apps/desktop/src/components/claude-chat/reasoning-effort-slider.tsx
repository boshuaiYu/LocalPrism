import { ZapIcon } from "lucide-react";
import {
  formatReasoningEffortLabel,
  formatReasoningEffortShortLabel,
  reasoningEffortSliderIndex,
} from "@/lib/reasoning-effort";
import { cn } from "@/lib/utils";

export interface ReasoningEffortFastToggle {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}

export interface ReasoningEffortSliderProps {
  options: readonly string[];
  value: string | null;
  onChange: (effort: string) => void;
  disabled?: boolean;
  modelName?: string | null;
  fastToggle?: ReasoningEffortFastToggle | null;
}

export function ReasoningEffortSlider({
  options,
  value,
  onChange,
  disabled = false,
  modelName,
  fastToggle = null,
}: ReasoningEffortSliderProps) {
  if (options.length === 0) return null;

  const index = reasoningEffortSliderIndex(value, options);
  const resolved = options[index] ?? options[0];
  const single = options.length === 1;
  const fillPercent =
    options.length <= 1 ? 100 : (index / (options.length - 1)) * 100;

  const emit = (raw: string) => {
    const next = options[Number(raw)];
    if (next) onChange(next);
  };

  return (
    <div
      className="min-w-0 rounded-2xl bg-muted/45 px-3 py-2.5"
      data-testid="reasoning-effort-slider-wrap"
      role="group"
      aria-label="Reasoning effort"
    >
      <div className="flex items-center gap-2">
        {fastToggle ? (
          <button
            type="button"
            data-testid="reasoning-effort-fast-toggle"
            aria-label={
              fastToggle.enabled ? "Disable fast model" : "Enable fast model"
            }
            aria-pressed={fastToggle.enabled}
            disabled={disabled}
            className={cn(
              "flex size-7 shrink-0 items-center justify-center rounded-full transition-colors",
              fastToggle.enabled
                ? "bg-[#C17A5C]/15 text-[#C17A5C]"
                : "text-muted-foreground hover:bg-background/80 hover:text-foreground",
              "disabled:cursor-not-allowed disabled:opacity-40",
            )}
            onClick={() => fastToggle.onChange(!fastToggle.enabled)}
          >
            <ZapIcon className="size-3.5" />
          </button>
        ) : null}
        <div className="min-w-0 flex-1 text-center">
          <p className="font-medium text-[#C17A5C] text-xs leading-4 tracking-wide">
            {formatReasoningEffortLabel(resolved)}
          </p>
          {modelName ? (
            <p className="mt-0.5 truncate text-[10px] text-muted-foreground leading-3">
              {modelName}
            </p>
          ) : null}
        </div>
        {fastToggle ? <span className="size-7 shrink-0" aria-hidden /> : null}
      </div>

      <div className="relative mt-3.5">
        <div className="relative h-5">
          <div className="absolute inset-x-1 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-foreground/10 shadow-[inset_0_1px_1px_rgba(0,0,0,0.06)]">
            <div
              className="h-full rounded-full bg-linear-to-r from-[#D4A08A] to-[#C17A5C]"
              style={{ width: `${fillPercent}%` }}
            />
          </div>
          <div className="pointer-events-none absolute inset-x-2.5 top-1/2 flex -translate-y-1/2 justify-between">
            {options.map((option, optionIndex) => {
              const reached = optionIndex <= index;
              return (
                <span
                  key={option}
                  className={cn(
                    "size-1.5 rounded-full transition-colors",
                    reached ? "bg-[#C17A5C]" : "bg-foreground/20",
                  )}
                  title={formatReasoningEffortLabel(option)}
                />
              );
            })}
          </div>
          <input
            type="range"
            data-testid="reasoning-effort-slider"
            min={0}
            max={options.length - 1}
            step={1}
            value={index}
            disabled={disabled || single}
            aria-label="Reasoning effort"
            aria-valuemin={0}
            aria-valuemax={options.length - 1}
            aria-valuenow={index}
            aria-valuetext={formatReasoningEffortLabel(resolved)}
            className={cn(
              "absolute inset-0 w-full cursor-pointer appearance-none bg-transparent",
              "[&::-webkit-slider-runnable-track]:h-1.5 [&::-webkit-slider-runnable-track]:bg-transparent",
              "[&::-webkit-slider-thumb]:relative [&::-webkit-slider-thumb]:z-10 [&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-[#C17A5C] [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-[0_1px_4px_rgba(193,122,92,0.35)]",
              "[&::-moz-range-track]:h-1.5 [&::-moz-range-track]:bg-transparent",
              "[&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-[#C17A5C] [&::-moz-range-thumb]:bg-white [&::-moz-range-thumb]:shadow-[0_1px_4px_rgba(193,122,92,0.35)]",
              "focus-visible:outline-none",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
            onInput={(event) => emit(event.currentTarget.value)}
          />
        </div>
        {options.length > 1 ? (
          <div className="mt-1 flex justify-between px-1">
            {options.map((option, optionIndex) => (
              <span
                key={option}
                className={cn(
                  "w-8 text-center text-[9px] leading-3 first:w-auto first:text-left last:w-auto last:text-right",
                  optionIndex === index
                    ? "font-medium text-[#C17A5C]"
                    : "text-muted-foreground/70",
                )}
              >
                {formatReasoningEffortShortLabel(option)}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
