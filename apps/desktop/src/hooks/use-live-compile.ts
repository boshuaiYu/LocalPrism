import { useEffect, useRef } from "react";
import { LIVE_COMPILE_DEBOUNCE_MS } from "@/lib/live-compile";

export function useLiveCompile({
  enabled,
  contentGeneration,
  projectGeneration,
  activeRootId,
  compile,
  debounceMs = LIVE_COMPILE_DEBOUNCE_MS,
}: {
  enabled: boolean;
  contentGeneration: number;
  projectGeneration: number;
  activeRootId?: string | null;
  compile: () => void;
  debounceMs?: number;
}): void {
  const baselineGenRef = useRef<number | null>(null);
  const baselineProjectRef = useRef<number | null>(null);
  const baselineRootRef = useRef<string | null | undefined>(undefined);
  const pendingOpenSettleRef = useRef(false);
  const wasEnabledRef = useRef(enabled);

  useEffect(() => {
    const projectChanged = baselineProjectRef.current !== projectGeneration;
    if (projectChanged) {
      pendingOpenSettleRef.current =
        baselineProjectRef.current !== null &&
        baselineGenRef.current === contentGeneration;
      baselineProjectRef.current = projectGeneration;
      baselineGenRef.current = contentGeneration;
      baselineRootRef.current = activeRootId;
      wasEnabledRef.current = enabled;
      return;
    }

    if (pendingOpenSettleRef.current) {
      pendingOpenSettleRef.current = false;
      baselineGenRef.current = contentGeneration;
      baselineRootRef.current = activeRootId;
      wasEnabledRef.current = enabled;
      return;
    }

    const justEnabled = enabled && !wasEnabledRef.current;
    wasEnabledRef.current = enabled;
    const genChanged = baselineGenRef.current !== contentGeneration;
    baselineGenRef.current = contentGeneration;
    const rootChanged = baselineRootRef.current !== activeRootId;
    baselineRootRef.current = activeRootId;

    if (!enabled || (!genChanged && !justEnabled && !rootChanged)) {
      return;
    }

    const timer = window.setTimeout(compile, debounceMs);
    return () => window.clearTimeout(timer);
  }, [
    contentGeneration,
    projectGeneration,
    activeRootId,
    enabled,
    compile,
    debounceMs,
  ]);
}
