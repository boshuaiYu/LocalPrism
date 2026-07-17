import { useEffect } from "react";
import { useClaudeSetupStore } from "@/stores/claude-setup-store";
import { useRuntimeStore } from "@/stores/runtime-store";

export function useClaudeRuntimeSync(): void {
  useEffect(
    () =>
      useClaudeSetupStore.subscribe((state, previousState) => {
        if (
          previousState.status !== state.status &&
          state.status !== "checking" &&
          state.status !== "error"
        ) {
          void useRuntimeStore
            .getState()
            .refresh("claude")
            .catch(() => undefined);
        }
      }),
    [],
  );
}
