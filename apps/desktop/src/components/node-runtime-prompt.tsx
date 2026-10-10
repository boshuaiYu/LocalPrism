import { useEffect, useState } from "react";
import { DownloadIcon, Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useNodeRuntimeInstallListener } from "@/hooks/use-node-runtime-install";
import { useI18n } from "@/lib/use-i18n";
import { useNodeRuntimeStore } from "@/stores/node-runtime-store";

export function NodeRuntimePrompt() {
  const { t } = useI18n();
  const status = useNodeRuntimeStore((state) => state.status);
  const isInstalling = useNodeRuntimeStore((state) => state.isInstalling);
  const progress = useNodeRuntimeStore((state) => state.progress);
  const error = useNodeRuntimeStore((state) => state.error);
  const promptDeclined = useNodeRuntimeStore((state) => state.promptDeclined);
  const checkStatus = useNodeRuntimeStore((state) => state.checkStatus);
  const install = useNodeRuntimeStore((state) => state.install);
  const declinePrompt = useNodeRuntimeStore((state) => state.declinePrompt);
  const [confirmed, setConfirmed] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  useNodeRuntimeInstallListener();

  useEffect(() => {
    void checkStatus();
  }, [checkStatus]);

  const open =
    !dismissed &&
    !promptDeclined &&
    (status === "missing" ||
      (confirmed && (isInstalling || status === "error")));

  return (
    <Dialog open={open} onOpenChange={() => undefined}>
      <DialogContent
        showCloseButton={false}
        data-testid="node-runtime-prompt"
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{t("env.nodePromptTitle")}</DialogTitle>
          <DialogDescription className="leading-relaxed">
            {t("env.nodePromptBody")}
          </DialogDescription>
        </DialogHeader>
        {isInstalling && progress && (
          <p
            className="break-words text-muted-foreground text-xs"
            data-testid="node-runtime-progress"
          >
            {progress}
          </p>
        )}
        {error && confirmed && (
          <p className="break-words text-destructive text-xs">{error}</p>
        )}
        <DialogFooter>
          <Button
            data-testid="node-runtime-decline"
            variant="outline"
            disabled={isInstalling}
            onClick={() => {
              declinePrompt();
              setDismissed(true);
            }}
          >
            {t("env.nodeNotNow")}
          </Button>
          <Button
            data-testid="node-runtime-install"
            disabled={isInstalling}
            onClick={() => {
              setConfirmed(true);
              void install();
            }}
          >
            {isInstalling ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <DownloadIcon className="size-3.5" />
            )}
            {isInstalling ? t("env.installing") : t("env.install")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
