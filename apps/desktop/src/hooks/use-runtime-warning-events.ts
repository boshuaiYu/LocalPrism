import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { toast } from "sonner";
import { createLogger } from "@/lib/debug/logger";
import type { RuntimeWarningPayload } from "@/runtime/types";

const log = createLogger("runtime-warning-events");

function isRuntimeWarningPayload(
  payload: unknown,
): payload is RuntimeWarningPayload {
  if (payload === null || typeof payload !== "object") return false;
  const candidate = payload as { runtime?: unknown; message?: unknown };
  return (
    (candidate.runtime === "claude" || candidate.runtime === "codex") &&
    typeof candidate.message === "string"
  );
}

export function useRuntimeWarningEvents() {
  useEffect(() => {
    let disposed = false;
    let stop: UnlistenFn | undefined;

    void listen<unknown>("runtime-warning", ({ payload }) => {
      if (disposed || !isRuntimeWarningPayload(payload)) return;
      if (payload.runtime !== "codex") return;
      const message = payload.message.trim();
      if (!message) return;
      toast.warning("Codex runtime warning", { description: message });
    }).then(
      (unlisten) => {
        if (disposed) {
          unlisten();
        } else {
          stop = unlisten;
        }
      },
      (error) => {
        if (!disposed) {
          log.warn("Failed to listen for runtime warnings", {
            error: String(error),
          });
        }
      },
    );

    return () => {
      disposed = true;
      stop?.();
      stop = undefined;
    };
  }, []);
}
