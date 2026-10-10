import { useEffect, useRef } from "react";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  DownloadIcon,
  Loader2Icon,
  Trash2Icon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useNodeRuntimeInstallListener } from "@/hooks/use-node-runtime-install";
import { useI18n } from "@/lib/use-i18n";
import { cn } from "@/lib/utils";
import { useNodeRuntimeStore } from "@/stores/node-runtime-store";

interface NodeRuntimeDialogProps {
  open: boolean;
  onClose: () => void;
}

export function NodeRuntimeDialog({ open, onClose }: NodeRuntimeDialogProps) {
  const { t } = useI18n();
  const status = useNodeRuntimeStore((state) => state.status);
  const source = useNodeRuntimeStore((state) => state.source);
  const version = useNodeRuntimeStore((state) => state.version);
  const nodePath = useNodeRuntimeStore((state) => state.nodePath);
  const managedDir = useNodeRuntimeStore((state) => state.managedDir);
  const isInstalling = useNodeRuntimeStore((state) => state.isInstalling);
  const isRemoving = useNodeRuntimeStore((state) => state.isRemoving);
  const progress = useNodeRuntimeStore((state) => state.progress);
  const error = useNodeRuntimeStore((state) => state.error);
  const checkStatus = useNodeRuntimeStore((state) => state.checkStatus);
  const install = useNodeRuntimeStore((state) => state.install);
  const remove = useNodeRuntimeStore((state) => state.remove);
  const hasCheckedRef = useRef(false);
  useNodeRuntimeInstallListener();

  useEffect(() => {
    if (open && !hasCheckedRef.current) {
      hasCheckedRef.current = true;
      void checkStatus();
    }
    if (!open) {
      hasCheckedRef.current = false;
    }
  }, [checkStatus, open]);

  const busy = isInstalling || isRemoving;
  const showReinstall = Boolean(managedDir) && !busy;
  const showRemove = Boolean(managedDir) && !busy;
  const showInstall = !managedDir && !busy && status !== "checking";

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        className="w-full max-w-[34rem] overflow-hidden sm:max-w-[34rem]"
        data-testid="node-runtime-dialog"
      >
        <DialogHeader>
          <DialogTitle className="flex min-w-0 items-center gap-2 pr-8">
            <span className="min-w-0 truncate">{t("env.nodeEnvironment")}</span>
          </DialogTitle>
          <DialogDescription>{t("env.manageNode")}</DialogDescription>
        </DialogHeader>

        <div className="min-w-0 space-y-4 py-2">
          <div className="flex min-w-0 items-center gap-3 overflow-hidden rounded-lg border p-3">
            <StatusIcon busy={busy || status === "checking"} status={status} />
            <div className="min-w-0 flex-1 overflow-hidden">
              <div className="font-medium text-sm">
                {status === "checking"
                  ? t("env.checkingNode")
                  : status === "missing"
                    ? t("env.nodeMissing")
                    : status === "ready"
                      ? t("env.nodeReady")
                      : t("env.error")}
              </div>
              {version && (
                <div
                  className="truncate text-muted-foreground text-xs"
                  data-testid="node-runtime-version"
                >
                  {version}
                </div>
              )}
              {source && (
                <div
                  className="truncate text-muted-foreground text-xs"
                  data-testid="node-runtime-source"
                >
                  {source === "managed"
                    ? t("env.nodeManaged")
                    : t("env.nodeSystem")}
                </div>
              )}
              {nodePath && (
                <div
                  className="max-w-full break-all text-muted-foreground text-xs leading-snug"
                  data-testid="node-runtime-path"
                  title={nodePath}
                >
                  {t("env.nodePath", { path: nodePath })}
                </div>
              )}
              {isInstalling && progress && (
                <div
                  className="mt-1 break-words text-muted-foreground text-xs"
                  data-testid="node-runtime-progress"
                >
                  {progress}
                </div>
              )}
              {error && (
                <div className="mt-1 break-words text-destructive text-xs">
                  {error}
                </div>
              )}
            </div>
            <div className="flex shrink-0 flex-col gap-2">
              {showInstall && (
                <Button
                  data-testid="node-runtime-install"
                  size="sm"
                  onClick={() => void install()}
                >
                  <DownloadIcon className="mr-1.5 size-3.5" />
                  {status === "ready"
                    ? t("env.nodeInstallPrivate")
                    : t("env.install")}
                </Button>
              )}
              {showReinstall && (
                <Button
                  data-testid="node-runtime-reinstall"
                  size="sm"
                  variant="outline"
                  onClick={() => void install()}
                >
                  <DownloadIcon className="mr-1.5 size-3.5" />
                  {t("env.nodeReinstall")}
                </Button>
              )}
              {showRemove && (
                <Button
                  data-testid="node-runtime-remove"
                  size="sm"
                  variant="outline"
                  onClick={() => void remove()}
                >
                  <Trash2Icon className="mr-1.5 size-3.5" />
                  {t("env.nodeRemove")}
                </Button>
              )}
              {busy && (
                <Button size="sm" disabled>
                  <Loader2Icon className="mr-1.5 size-3.5 animate-spin" />
                  {isRemoving ? t("env.nodeRemove") : t("env.installing")}
                </Button>
              )}
            </div>
          </div>
          <p className="max-w-full break-words text-muted-foreground text-xs leading-relaxed">
            {t("env.nodeHelp")}
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function StatusIcon({ busy, status }: { busy: boolean; status: string }) {
  if (busy) {
    return (
      <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted">
        <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (status === "ready") {
    return (
      <div
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-accent-foreground",
        )}
      >
        <CheckCircle2Icon className="size-4" />
      </div>
    );
  }
  if (status === "error") {
    return (
      <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <AlertCircleIcon className="size-4" />
      </div>
    );
  }
  return (
    <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
      <DownloadIcon className="size-4" />
    </div>
  );
}
