import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  describeImportOutcome,
  type SkillImportOutcome,
  type SkillReplacePreview,
} from "@/lib/skill-import-flow";
import { useI18n } from "@/lib/use-i18n";

export const SKILL_ARCHIVE_FILTERS = [
  { name: "Skill archive", extensions: ["zip", "tar.gz", "tgz"] },
];

export function toastImportOutcome(
  outcome: SkillImportOutcome,
  t: ReturnType<typeof useI18n>["t"],
) {
  const feedback = describeImportOutcome(outcome);
  if (feedback.kind === "error") {
    toast.error(t("skills.toastImportFailed"), {
      description: feedback.errors.join("\n"),
    });
    return;
  }
  if (feedback.kind === "latest") {
    toast.message(t("skills.alreadyLatest"));
    return;
  }
  if (feedback.kind === "updated") {
    const names = feedback.names.filter((name) => name.trim().length > 0);
    toast.success(
      names.length > 0
        ? t("skills.updatedNames", { names: names.join(", ") })
        : t("skills.updatedCount", { count: outcome.updated.length }),
    );
    return;
  }
  toast.success(t("skills.toastImported"), {
    description: t("skills.toastImportedBody"),
  });
}

export function SkillReplaceDialog({
  conflicts,
  busy,
  onCancel,
  onReplace,
}: {
  conflicts: SkillReplacePreview[];
  busy: boolean;
  onCancel: () => void;
  onReplace: () => void;
}) {
  const { t } = useI18n();
  return (
    <Dialog
      open={conflicts.length > 0}
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <div data-testid="skill-replace-dialog">
          <DialogHeader>
            <DialogTitle>{t("skills.replaceTitle")}</DialogTitle>
            <DialogDescription>{t("skills.replaceBody")}</DialogDescription>
          </DialogHeader>
          <ul className="max-h-64 space-y-3 overflow-auto">
            {conflicts.map((conflict) => (
              <li
                key={conflict.folder}
                className="rounded-lg border border-border/70 px-3 py-2 text-xs"
              >
                <p className="font-medium text-foreground">{conflict.folder}</p>
                <p className="mt-1 text-muted-foreground">
                  {t("skills.replaceOld")}: {conflict.oldName}
                </p>
                {conflict.oldDescription ? (
                  <p className="text-muted-foreground">
                    {conflict.oldDescription}
                  </p>
                ) : null}
                <p className="mt-1 text-foreground">
                  {t("skills.replaceNew")}: {conflict.newName}
                </p>
                {conflict.newDescription ? (
                  <p className="text-muted-foreground">
                    {conflict.newDescription}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
          <div className="mt-4 flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={onCancel}
            >
              {t("chrome.cancel")}
            </Button>
            <Button
              type="button"
              size="sm"
              data-testid="skill-replace-confirm"
              disabled={busy}
              onClick={onReplace}
            >
              {t("skills.replaceAction")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
