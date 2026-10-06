import { invoke } from "@tauri-apps/api/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  contextPanelUsageDebugIsOff,
  noteContextPanelUsage,
  resetUsageDebugForTests,
} from "@/lib/usage-debug";

const sample = {
  inputTokens: 19_600,
  outputTokens: 2_965,
  cacheReadTokens: 170_000,
  cacheCreationTokens: 0,
  usedTokens: 192_565,
  windowTokens: 272_000,
};

afterEach(() => {
  resetUsageDebugForTests();
  vi.mocked(invoke).mockReset();
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("usage debug panel log", () => {
  it("does not call into Tauri when the desktop shell is absent", () => {
    noteContextPanelUsage("gpt-6-luna", sample);
    expect(invoke).not.toHaveBeenCalled();
    expect(contextPanelUsageDebugIsOff()).toBe(true);
    noteContextPanelUsage("gpt-6-luna", sample);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("probes once and skips panel logs when the switch is off", async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    vi.mocked(invoke).mockResolvedValue(false);

    noteContextPanelUsage("gpt-6-luna", sample);
    noteContextPanelUsage("gpt-6-luna", {
      ...sample,
      outputTokens: 3_000,
      usedTokens: 192_600,
    });
    await vi.waitFor(() => {
      expect(contextPanelUsageDebugIsOff()).toBe(true);
    });

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("usage_debug_enabled");
    noteContextPanelUsage("gpt-6-luna", sample);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("appends only panel numbers when the switch is on", async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === "usage_debug_enabled") return true;
      return undefined;
    });

    noteContextPanelUsage("gpt-6-luna", sample);
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("log_usage_debug_panel", {
        model: "gpt-6-luna",
        usage: sample,
      });
    });

    noteContextPanelUsage("gpt-6-luna", sample);
    const panelCalls = vi
      .mocked(invoke)
      .mock.calls.filter((call) => call[0] === "log_usage_debug_panel");
    expect(panelCalls).toHaveLength(1);

    const changed = { ...sample, outputTokens: 3_000, usedTokens: 192_600 };
    noteContextPanelUsage("gpt-6-luna", changed);
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("log_usage_debug_panel", {
        model: "gpt-6-luna",
        usage: changed,
      });
    });
  });
});
