import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { requestWelcomeGuide } from "@/lib/welcome";
import { useI18n } from "@/lib/use-i18n";

export function GettingStartedDialog({
  open,
  onOpenChange,
  beforeOpenGuide,
  leavesProject = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  beforeOpenGuide?: () => boolean | Promise<boolean>;
  leavesProject?: boolean;
}) {
  const { t } = useI18n();
  const [note, setNote] = useState<string | null>(null);

  const openGuide = async () => {
    if (beforeOpenGuide) {
      const ready = await beforeOpenGuide();
      if (!ready) {
        setNote(t("onboarding.stopFirst"));
        return;
      }
    }
    setNote(null);
    onOpenChange(false);
    requestWelcomeGuide();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setNote(null);
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="lp-heading">
            {t("onboarding.gettingStartedTitle")}
          </DialogTitle>
          <DialogDescription className="lp-body">
            {t("onboarding.gettingStartedBody")}
          </DialogDescription>
        </DialogHeader>
        <ol className="space-y-2 text-sm">
          <li>{t("onboarding.stepCreate")}</li>
          <li>{t("onboarding.stepSettings")}</li>
          <li>{t("onboarding.stepPanes")}</li>
        </ol>
        {leavesProject && (
          <p className="lp-meta">{t("onboarding.leavesProject")}</p>
        )}
        {note && <p className="text-destructive text-sm">{note}</p>}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            className="h-10 rounded-lg"
            onClick={() => onOpenChange(false)}
          >
            {t("onboarding.close")}
          </Button>
          <Button
            type="button"
            className="lp-primary-cta h-10 rounded-lg"
            onClick={() => void openGuide()}
          >
            {t("onboarding.openGuide")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
