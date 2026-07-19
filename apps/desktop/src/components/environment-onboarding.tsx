import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RuntimeSettings } from "@/components/runtime/runtime-settings";
import { useClaudeSetupStore } from "@/stores/claude-setup-store";
import { hasReadyRuntime, useRuntimeStore } from "@/stores/runtime-store";

type RuntimeRefresh = ReturnType<typeof useRuntimeStore.getState>["refresh"];
type ClaudeStatusCheck = ReturnType<
  typeof useClaudeSetupStore.getState
>["checkStatus"];

const initialChecks = new WeakMap<
  RuntimeRefresh,
  WeakMap<ClaudeStatusCheck, Promise<void>>
>();

function initialCheckFor(
  refreshRuntimes: RuntimeRefresh,
  checkClaudeStatus: ClaudeStatusCheck,
): Promise<void> {
  let checksForRefresh = initialChecks.get(refreshRuntimes);
  if (!checksForRefresh) {
    checksForRefresh = new WeakMap();
    initialChecks.set(refreshRuntimes, checksForRefresh);
  }

  let pending = checksForRefresh.get(checkClaudeStatus);
  if (!pending) {
    const operation = Promise.allSettled([
      refreshRuntimes(undefined, { silent: true }),
      checkClaudeStatus(),
    ]).then(() => undefined);
    const cached = operation.finally(() => {
      if (checksForRefresh.get(checkClaudeStatus) === cached) {
        checksForRefresh.delete(checkClaudeStatus);
      }
    });
    pending = cached;
    checksForRefresh.set(checkClaudeStatus, pending);
  }
  return pending;
}

export function EnvironmentOnboarding() {
  const [initialCheckComplete, setInitialCheckComplete] = useState(false);
  const [hasOpenedForSetup, setHasOpenedForSetup] = useState(false);
  const [completedDismissed, setCompletedDismissed] = useState(false);

  const accounts = useRuntimeStore((state) => state.accounts);
  const refreshRuntimes = useRuntimeStore((state) => state.refresh);
  const checkClaudeStatus = useClaudeSetupStore((state) => state.checkStatus);
  const runtimeReady = hasReadyRuntime(accounts);

  useEffect(() => {
    let cancelled = false;

    void initialCheckFor(refreshRuntimes, checkClaudeStatus).then(() => {
      if (!cancelled) setInitialCheckComplete(true);
    });

    return () => {
      cancelled = true;
    };
  }, [checkClaudeStatus, refreshRuntimes]);

  useEffect(() => {
    if (!initialCheckComplete || runtimeReady) return;
    setHasOpenedForSetup(true);
    setCompletedDismissed(false);
  }, [initialCheckComplete, runtimeReady]);

  const setupComplete = initialCheckComplete && runtimeReady;
  const shouldShow =
    initialCheckComplete &&
    !completedDismissed &&
    (!runtimeReady || hasOpenedForSetup);

  const handleDone = () => {
    if (!setupComplete) return;
    setHasOpenedForSetup(false);
    setCompletedDismissed(true);
  };

  return (
    <Dialog open={shouldShow} onOpenChange={() => undefined}>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        className="max-h-[90vh] w-[min(64rem,calc(100vw-2rem))] gap-0 overflow-y-auto overflow-x-hidden rounded-2xl border-border/70 p-0 shadow-xl sm:max-w-none"
      >
        <div className="flex flex-col items-center px-6 pt-6 pb-3 text-center">
          <img
            src="/icon-192.png"
            alt="ClaudePrism"
            className="size-14 object-contain"
          />
          <DialogHeader className="mt-3 items-center gap-1.5 text-center">
            <DialogTitle className="font-semibold text-xl">
              ClaudePrism
            </DialogTitle>
            <DialogDescription className="max-w-xl text-sm leading-relaxed">
              Install and sign in to at least one AI runtime before entering the
              workspace. Claude and Codex can be configured independently.
            </DialogDescription>
          </DialogHeader>
        </div>

        <RuntimeSettings refreshOnMount={false} />

        <div className="flex justify-center px-6 pt-1 pb-5">
          <Button
            disabled={!setupComplete}
            className="h-10 min-w-28 justify-center rounded-full px-7"
            onClick={handleDone}
          >
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
