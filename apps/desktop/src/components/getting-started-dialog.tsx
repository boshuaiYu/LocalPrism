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
  const [note, setNote] = useState<string | null>(null);

  const openGuide = async () => {
    if (beforeOpenGuide) {
      const ready = await beforeOpenGuide();
      if (!ready) {
        setNote("Stop the current chat turn before opening the setup guide.");
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
          <DialogTitle className="lp-heading">Getting Started</DialogTitle>
          <DialogDescription className="lp-body">
            A short map of the workspace. You can open the setup guide again any
            time.
          </DialogDescription>
        </DialogHeader>
        <ol className="space-y-2 text-sm">
          <li>Create a project from a template, or open an existing folder.</li>
          <li>
            In Settings, an API key is the recommended way to chat. Official
            login is optional.
          </li>
          <li>
            Drag the pane splitters to resize the file tree, editor, chat, and
            PDF. Reset layout restores the default widths.
          </li>
        </ol>
        {leavesProject && (
          <p className="lp-meta">
            Open setup guide closes this project and returns to the home screen.
          </p>
        )}
        {note && <p className="text-destructive text-sm">{note}</p>}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            className="h-10 rounded-lg"
            onClick={() => onOpenChange(false)}
          >
            Close
          </Button>
          <Button
            type="button"
            className="lp-primary-cta h-10 rounded-lg"
            onClick={() => void openGuide()}
          >
            Open setup guide
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
