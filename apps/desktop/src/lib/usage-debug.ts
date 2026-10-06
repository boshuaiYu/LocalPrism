import { invoke } from "@tauri-apps/api/core";

export type PanelUsageNumbers = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  usedTokens: number;
  windowTokens: number;
};

type DebugState = "unknown" | "off" | "on";

let state: DebugState = "unknown";
let probeStarted = false;
let pending: { model: string; usage: PanelUsageNumbers } | null = null;
let lastSignature = "";

function panelHasNumbers(usage: PanelUsageNumbers): boolean {
  return (
    usage.usedTokens > 0 ||
    usage.inputTokens > 0 ||
    usage.outputTokens > 0 ||
    usage.cacheReadTokens > 0 ||
    usage.cacheCreationTokens > 0
  );
}

function signature(model: string, usage: PanelUsageNumbers): string {
  return [
    model,
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadTokens,
    usage.cacheCreationTokens,
    usage.usedTokens,
    usage.windowTokens,
  ].join("\0");
}

function send(model: string, usage: PanelUsageNumbers) {
  if (!panelHasNumbers(usage)) return;
  const next = signature(model, usage);
  if (next === lastSignature) return;
  lastSignature = next;
  void invoke("log_usage_debug_panel", { model, usage }).catch(() => {});
}

/** True after the one-time probe finds the debug switch off. */
export function contextPanelUsageDebugIsOff(): boolean {
  return state === "off";
}

/**
 * Record the numbers the context panel is showing.
 * When debug is off this returns before IPC. Callers should also check
 * {@link contextPanelUsageDebugIsOff} before allocating the usage object.
 */
export function noteContextPanelUsage(
  model: string,
  usage: PanelUsageNumbers,
): void {
  if (state === "off") return;
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    state = "off";
    return;
  }
  if (state === "on") {
    send(model, usage);
    return;
  }
  pending = { model, usage };
  if (probeStarted) return;
  probeStarted = true;
  void invoke<boolean>("usage_debug_enabled")
    .then((on) => {
      state = on ? "on" : "off";
      const queued = pending;
      pending = null;
      if (!on || !queued) return;
      send(queued.model, queued.usage);
    })
    .catch(() => {
      state = "off";
      pending = null;
    });
}

export function resetUsageDebugForTests(): void {
  state = "unknown";
  probeStarted = false;
  pending = null;
  lastSignature = "";
}
