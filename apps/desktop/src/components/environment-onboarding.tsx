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
import { isWelcomeCompleted } from "@/lib/welcome";
import { useClaudeSetupStore } from "@/stores/claude-setup-store";
import { useDocumentStore } from "@/stores/document-store";
import { useProviderStore } from "@/stores/provider-store";
import { useSkillStore } from "@/stores/skill-store";
import { useI18n } from "@/lib/use-i18n";

type ProviderRefresh = ReturnType<typeof useProviderStore.getState>["refresh"];
type ClaudeStatusCheck = ReturnType<
  typeof useClaudeSetupStore.getState
>["checkStatus"];

const initialChecks = new WeakMap<
  ProviderRefresh,
  WeakMap<ClaudeStatusCheck, Promise<void>>
>();

function initialCheckFor(
  refreshProviders: ProviderRefresh,
  checkClaudeStatus: ClaudeStatusCheck,
): Promise<void> {
  let checksForRefresh = initialChecks.get(refreshProviders);
  if (!checksForRefresh) {
    checksForRefresh = new WeakMap();
    initialChecks.set(refreshProviders, checksForRefresh);
  }

  let pending = checksForRefresh.get(checkClaudeStatus);
  if (!pending) {
    const operation = Promise.allSettled([
      refreshProviders(),
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
  const { t } = useI18n();
  const [initialCheckComplete, setInitialCheckComplete] = useState(false);
  const [hasOpenedForSetup, setHasOpenedForSetup] = useState(false);
  const [completedDismissed, setCompletedDismissed] = useState(false);

  const refreshProviders = useProviderStore((state) => state.refresh);
  const runtimeReady = useProviderStore((state) => state.ready);
  const checkClaudeStatus = useClaudeSetupStore((state) => state.checkStatus);
  const projectOpen = Boolean(useDocumentStore((state) => state.projectRoot));

  useEffect(() => {
    let cancelled = false;

    void initialCheckFor(refreshProviders, checkClaudeStatus).then(() => {
      if (cancelled) return;
      setInitialCheckComplete(true);
      void useClaudeSetupStore.getState().ensureEngine();
      void useSkillStore.getState().ensureDefaultSkillPacks();
    });

    return () => {
      cancelled = true;
    };
  }, [checkClaudeStatus, refreshProviders]);

  useEffect(() => {
    if (
      projectOpen ||
      !initialCheckComplete ||
      runtimeReady ||
      completedDismissed
    ) {
      return;
    }
    setHasOpenedForSetup(true);
  }, [completedDismissed, initialCheckComplete, projectOpen, runtimeReady]);

  const setupComplete = initialCheckComplete && runtimeReady;
  const welcomeCompleted = isWelcomeCompleted();
  const shouldShow =
    welcomeCompleted &&
    !projectOpen &&
    initialCheckComplete &&
    !completedDismissed &&
    (!runtimeReady || hasOpenedForSetup);

  const handleDone = () => {
    if (!initialCheckComplete) return;
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
            alt="LocalPrism"
            className="size-14 object-contain"
          />
          <DialogHeader className="mt-3 items-center gap-1.5 text-center">
            <DialogTitle className="font-semibold text-xl">
              LocalPrism
            </DialogTitle>
            <DialogDescription className="max-w-xl text-lp-meta text-sm leading-relaxed">
              {t("onboarding.envBody")}
            </DialogDescription>
          </DialogHeader>
        </div>

        <RuntimeSettings refreshOnMount={false} showEngine={false} />

        <div className="flex justify-center px-6 pt-1 pb-5">
          <Button
            className="h-10 min-w-28 justify-center rounded-full px-7"
            variant={setupComplete ? "default" : "outline"}
            onClick={handleDone}
          >
            {setupComplete ? t("onboarding.done") : t("onboarding.skipModel")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
