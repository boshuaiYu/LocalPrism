import { useState } from "react";
import { UserRoundIcon } from "lucide-react";
import { RuntimeSettings } from "@/components/runtime/runtime-settings";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useProviderStore } from "@/stores/provider-store";

export function WorkspaceAccountButton() {
  const [open, setOpen] = useState(false);
  const cards = useProviderStore((state) => state.cards);
  const active =
    cards.find((card) => card.isActive) ??
    cards.find((card) => card.authenticated);
  const signedIn = Boolean(active?.authenticated);
  const label = signedIn
    ? active?.accountLabel || active?.name || "Signed in"
    : "Sign in";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-8 max-w-[10.5rem] items-center gap-1.5 rounded-md px-2 text-muted-foreground text-xs transition-colors hover:bg-muted hover:text-foreground"
        aria-label={signedIn ? `Account: ${label}` : "Sign in"}
        title={
          signedIn
            ? `${active?.name ?? "Account"} · ${label}`
            : "Sign in or switch accounts without leaving this project"
        }
      >
        <UserRoundIcon className="size-3.5 shrink-0" />
        <span className="truncate">{label}</span>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[85vh] w-[min(48rem,calc(100vw-2rem))] flex-col overflow-hidden sm:max-w-none">
          <DialogHeader>
            <DialogTitle>Account</DialogTitle>
            <DialogDescription>
              Sign in or switch providers without leaving this project.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <RuntimeSettings officialOpenDefault />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
