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
import { cn } from "@/lib/utils";

/** Visible chip text. Long model ids stay in the string so CSS can ellipsize them. */
export function workspaceAccountChipText(
  providerName: string | null | undefined,
  accountLabel: string | null | undefined,
  fallback: string,
): string {
  const provider = providerName?.trim() ?? "";
  const account = accountLabel?.trim() ?? "";
  if (provider && account && provider !== account) {
    return `${provider} · ${account}`;
  }
  return account || provider || fallback;
}

/** Full provider · model, or just the provider when the header is very narrow. */
export function workspaceAccountVisibleLabel(
  providerName: string | null | undefined,
  accountLabel: string | null | undefined,
  fallback: string,
  density: "full" | "provider" = "full",
): string {
  const full = workspaceAccountChipText(providerName, accountLabel, fallback);
  if (density === "provider") {
    return providerName?.trim() || full;
  }
  return full;
}

export function WorkspaceAccountButton({
  density = "full",
}: {
  density?: "full" | "provider";
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const cards = useProviderStore((state) => state.cards);
  const active =
    cards.find((card) => card.isActive) ??
    cards.find((card) => card.authenticated);
  const signedIn = Boolean(active?.authenticated);
  const providerName = active?.name?.trim() || "";
  const accountLabel = active?.accountLabel?.trim() || "";
  const label = signedIn
    ? workspaceAccountChipText(providerName, accountLabel, t("chat.signedIn"))
    : t("chat.signIn");
  const visibleLabel = signedIn
    ? workspaceAccountVisibleLabel(
        providerName,
        accountLabel,
        t("chat.signedIn"),
        density,
      )
    : label;
  const titleLabel = accountLabel || providerName || label;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "flex h-8 w-full max-w-[14rem] items-center gap-1.5 overflow-hidden rounded-md px-2 text-left text-muted-foreground text-xs transition-colors hover:bg-muted hover:text-foreground",
          density === "full" ? "min-w-[4.5rem]" : "min-w-0",
        )}
        aria-label={
          signedIn ? t("chat.accountLabel", { label }) : t("chat.signIn")
        }
        title={
          signedIn
            ? providerName && titleLabel && providerName !== titleLabel
              ? t("chat.accountTitle", {
                  name: providerName,
                  label: titleLabel,
                })
              : label
            : t("chat.signInTitle")
        }
      >
        <UserRoundIcon className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{visibleLabel}</span>
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
