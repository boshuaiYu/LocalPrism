import { StrictMode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  listen,
  type Event as TauriEvent,
  type EventCallback,
  type UnlistenFn,
} from "@tauri-apps/api/event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRuntimeWarningEvents } from "@/hooks/use-runtime-warning-events";

const { warningToast } = vi.hoisted(() => ({ warningToast: vi.fn() }));

vi.mock("sonner", () => ({
  toast: { warning: warningToast },
}));

function Probe() {
  useRuntimeWarningEvents();
  return null;
}

function warningEvent(payload: unknown): TauriEvent<unknown> {
  return {
    event: "runtime-warning",
    id: 1,
    payload,
  };
}

describe("useRuntimeWarningEvents", () => {
  let container: HTMLDivElement;
  let root: Root | undefined;
  const listenMock = vi.mocked(listen);

  beforeEach(() => {
    warningToast.mockReset();
    listenMock.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount());
      root = undefined;
    }
    container.remove();
  });

  it("keeps one live listener across StrictMode async registration races", async () => {
    const callbacks: EventCallback<unknown>[] = [];
    const active = new Set<EventCallback<unknown>>();
    const resolveRegistrations: Array<() => void> = [];
    listenMock.mockImplementation((_event, callback) => {
      const typedCallback = callback as EventCallback<unknown>;
      callbacks.push(typedCallback);
      active.add(typedCallback);
      return new Promise<UnlistenFn>((resolve) => {
        resolveRegistrations.push(() => {
          resolve(() => {
            active.delete(typedCallback);
          });
        });
      });
    });

    root = createRoot(container);
    await act(async () => {
      root?.render(
        <StrictMode>
          <Probe />
        </StrictMode>,
      );
    });

    expect(callbacks).toHaveLength(2);
    for (const callback of callbacks) {
      callback(warningEvent({ runtime: "codex", message: "restart warning" }));
    }
    expect(warningToast).toHaveBeenCalledTimes(1);

    await act(async () => {
      for (const resolve of resolveRegistrations) resolve();
      await Promise.resolve();
    });
    expect(active.size).toBe(1);

    await act(async () => root?.unmount());
    root = undefined;
    expect(active.size).toBe(0);
  });

  it("shows valid Codex warnings and rejects malformed or non-Codex payloads", async () => {
    let callback: EventCallback<unknown> | undefined;
    const unlisten = vi.fn();
    listenMock.mockImplementation((_event, handler) => {
      callback = handler as EventCallback<unknown>;
      return Promise.resolve(unlisten);
    });

    root = createRoot(container);
    await act(async () => {
      root?.render(<Probe />);
      await Promise.resolve();
    });
    const emit = (payload: unknown) => callback?.(warningEvent(payload));

    emit({ runtime: "codex", message: "  supervisor restarted  " });
    expect(warningToast).toHaveBeenCalledWith("Codex runtime warning", {
      description: "supervisor restarted",
    });

    for (const payload of [
      { runtime: "claude", message: "leave Claude untouched" },
      { runtime: "future", message: "unknown provider" },
      { runtime: "codex", message: "   " },
      { runtime: "codex" },
      null,
    ]) {
      emit(payload);
    }
    expect(warningToast).toHaveBeenCalledTimes(1);

    await act(async () => root?.unmount());
    root = undefined;
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
