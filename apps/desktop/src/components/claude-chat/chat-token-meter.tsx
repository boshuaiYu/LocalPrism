import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useClaudeChatStore } from "@/stores/claude-chat-store";
import { useProviderStore } from "@/stores/provider-store";
import {
  buildTokenMeterModel,
  catalogContextWindow,
  formatTokenCount,
} from "@/lib/chat-token-usage";
import { cn } from "@/lib/utils";

function meterTone(percent: number): string {
  if (percent >= 95) return "stroke-destructive";
  if (percent >= 80) return "stroke-amber-500";
  return "stroke-foreground/80";
}

function ContextRing({ percent }: { percent: number }) {
  const radius = 5.5;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.min(100, Math.max(0, percent));
  return (
    <svg
      viewBox="0 0 16 16"
      className="size-3.5"
      aria-hidden
      data-testid="chat-token-meter-ring"
    >
      <circle
        cx="8"
        cy="8"
        r={radius}
        fill="none"
        className="stroke-muted-foreground/40"
        strokeWidth="2"
      />
      <circle
        cx="8"
        cy="8"
        r={radius}
        fill="none"
        className={meterTone(clamped)}
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - clamped / 100)}
        transform="rotate(-90 8 8)"
      />
    </svg>
  );
}

function panelPosition(trigger: HTMLElement): {
  left: number;
  bottom: number;
  maxHeight: number;
} {
  const shell = trigger.closest("[data-composer-shell]");
  const triggerRect = trigger.getBoundingClientRect();
  const shellRect = (shell ?? trigger).getBoundingClientRect();
  const width = 256;
  const left = Math.min(
    Math.max(8, triggerRect.right - width),
    window.innerWidth - width - 8,
  );
  const spaceAboveShell = shellRect.top - 8;
  const useShell = spaceAboveShell >= 160;
  const anchorTop = useShell ? shellRect.top : triggerRect.top;
  const space = Math.max(96, useShell ? spaceAboveShell : triggerRect.top - 8);
  return {
    left,
    bottom: Math.max(8, window.innerHeight - anchorTop + 8),
    maxHeight: Math.min(280, space),
  };
}

export function ChatTokenMeter() {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ left: 0, bottom: 0, maxHeight: 280 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const selectedModel = useClaudeChatStore((state) => state.selectedModel);
  const activeTab = useClaudeChatStore((state) =>
    state.tabs.find((tab) => tab.id === state.activeTabId),
  );
  const providerModels = useProviderStore((state) => state.models);

  const modelLabel = activeTab?.runtimeModel || selectedModel || "";
  const windowTokens = catalogContextWindow(providerModels, modelLabel);
  const messages = activeTab?.messages ?? [];
  const lastUsage = activeTab?.lastTurnUsage ?? null;

  const meter = useMemo(
    () =>
      buildTokenMeterModel({
        modelLabel,
        messages,
        lastUsage,
        windowTokens,
      }),
    [lastUsage, messages, modelLabel, windowTokens],
  );

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const place = () => {
      if (buttonRef.current) setPos(panelPosition(buttonRef.current));
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        buttonRef.current?.contains(target) ||
        panelRef.current?.contains(target)
      ) {
        return;
      }
      setOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        data-testid="chat-token-meter-trigger"
        aria-label={`Context ${meter.percent}%`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls="chat-token-meter-panel"
        title={`Context ${meter.percent}%`}
        className="flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        onClick={() => setOpen((value) => !value)}
      >
        <ContextRing percent={meter.percent} />
      </button>
      {open
        ? createPortal(
            <aside
              ref={panelRef}
              id="chat-token-meter-panel"
              data-testid="chat-token-meter"
              role="dialog"
              aria-label="Token usage"
              className="fixed w-64 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-lg"
              style={{
                left: pos.left,
                bottom: pos.bottom,
                maxHeight: pos.maxHeight,
                zIndex: 9999,
              }}
            >
              <div className="flex items-baseline justify-between gap-3">
                <p className="font-medium text-foreground text-xs">Context</p>
                <p className="font-medium text-foreground text-sm tabular-nums">
                  {meter.percent}%
                </p>
              </div>
              <p className="mt-0.5 truncate text-muted-foreground text-xs">
                {meter.modelLabel}
              </p>
              <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
                <div
                  className={cn(
                    "h-full rounded-full transition-[width]",
                    meter.percent >= 95
                      ? "bg-destructive"
                      : meter.percent >= 80
                        ? "bg-amber-500"
                        : "bg-foreground/70",
                  )}
                  style={{ width: `${meter.percent}%` }}
                />
              </div>
              <dl className="mt-2.5 space-y-1.5 text-xs">
                <div className="grid grid-cols-2 gap-x-4">
                  <div>
                    <dt className="text-muted-foreground">Used</dt>
                    <dd className="font-medium tabular-nums">
                      {formatTokenCount(meter.usedTokens)}
                    </dd>
                  </div>
                  <div className="text-right">
                    <dt className="text-muted-foreground">Remaining</dt>
                    <dd className="font-medium tabular-nums">
                      {formatTokenCount(meter.remainingTokens)}
                    </dd>
                  </div>
                </div>
                <div>
                  <dt className="text-muted-foreground">Window</dt>
                  <dd className="tabular-nums">
                    {formatTokenCount(meter.windowTokens)}
                  </dd>
                </div>
                <MeterRow label="Cache read" value={meter.cacheReadTokens} />
                <MeterRow
                  label="Cache write"
                  value={meter.cacheCreationTokens}
                />
                <MeterRow label="Input tokens" value={meter.inputTokens} />
                <MeterRow label="Output tokens" value={meter.outputTokens} />
              </dl>
              <p className="mt-2 text-[11px] text-muted-foreground">
                {meter.estimated
                  ? "Waiting for usage · model window"
                  : "This conversation · model window"}
              </p>
            </aside>,
            document.body,
          )
        : null}
    </>
  );
}

function MeterRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="tabular-nums">{formatTokenCount(value)}</dd>
    </div>
  );
}
