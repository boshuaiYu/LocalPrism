import { CheckCircle2Icon, Loader2Icon } from "lucide-react";
import { useHomepageEnvironment } from "@/hooks/use-homepage-environment";
import { skillPaperWorkflowGuidance } from "@/lib/skill-workflow-copy";
import { cn } from "@/lib/utils";

function StatusChip({
  ok,
  busy,
  label,
  detail,
}: {
  ok: boolean;
  busy: boolean;
  label: string;
  detail: string;
}) {
  return (
    <div
      className="flex min-w-0 items-center gap-2 rounded-full border border-border/70 bg-background/80 px-3 py-1.5 text-xs"
      title={detail}
      role="status"
      aria-label={`${label}: ${detail}`}
    >
      {busy ? (
        <Loader2Icon className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
      ) : (
        <CheckCircle2Icon
          className={cn(
            "size-3.5 shrink-0",
            ok ? "text-green-600" : "text-muted-foreground",
          )}
        />
      )}
      <span className="shrink-0 font-medium">{label}</span>
      <span className="min-w-0 truncate text-muted-foreground">{detail}</span>
    </div>
  );
}

export function HomepageEnvironmentStatus() {
  const {
    uvStatus,
    uvInstalling,
    uvVersion,
    uvError,
    paperSpine,
    paperSpineError,
    paperSpineInstalled,
  } = useHomepageEnvironment();

  const uvBusy = uvInstalling || uvStatus === "checking";
  const uvOk = uvStatus === "ready";
  const paperBusy = paperSpine === "checking" || paperSpine === "installing";

  return (
    <div className="mt-6">
      <div className="flex flex-wrap justify-center gap-2">
        <StatusChip
          ok={uvOk}
          busy={uvBusy}
          label="Python (uv)"
          detail={
            uvBusy
              ? "Installing…"
              : uvOk
                ? (uvVersion ?? "Ready")
                : (uvError ?? "Not installed")
          }
        />
        <StatusChip
          ok={paperSpineInstalled}
          busy={paperBusy}
          label="PaperSpine + default skills"
          detail={
            paperBusy
              ? "Installing PaperSpine, academic-research, nature, and scientific skills…"
              : paperSpineInstalled
                ? "Default skill packs ready"
                : (paperSpineError ?? "Not installed")
          }
        />
      </div>
      <p className="mx-auto mt-3 max-w-xl text-center text-muted-foreground text-xs leading-relaxed">
        {skillPaperWorkflowGuidance()}
      </p>
    </div>
  );
}
