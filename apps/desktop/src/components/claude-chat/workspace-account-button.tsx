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
import { useI18n } from "@/lib/use-i18n";

export function WorkspaceAccountButton() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const cards = useProviderStore((state) => state.cards);
  const active =
    cards.find((card) => card.isActive) ??
    cards.find((card) => card.authenticated);
  const signedIn = Boolean(active?.authenticated);
  const label = signedIn
    ? active?.accountLabel || active?.name || t("chat.signedIn")
    : t("chat.signIn");

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-8 max-w-[10.5rem] items-center gap-1.5 rounded-md px-2 text-muted-foreground text-xs transition-colors hover:bg-muted hover:text-foreground"
        aria-label={
          signedIn ? t("chat.accountLabel", { label }) : t("chat.signIn")
        }
        title={
          signedIn
            ? t("chat.accountTitle", {
                name: active?.name ?? t("chat.account"),
                label,
              })
            : t("chat.signInTitle")
        }
      >
        <UserRoundIcon className="size-3.5 shrink-0" />
        <span className="truncate">{label}</span>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[85vh] w-[min(48rem,calc(100vw-2rem))] flex-col overflow-hidden sm:max-w-none">
          <DialogHeader>
            <DialogTitle>{t("chat.account")}</DialogTitle>
            <DialogDescription>{t("chat.accountHelp")}</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <RuntimeSettings officialOpenDefault />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
