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
import { getProviderIconSrc } from "@/lib/provider-icons";
import { useProviderStore } from "@/stores/provider-store";
import { useI18n } from "@/lib/use-i18n";

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

/**
 * Whole provider · model, the provider name, or nothing.
 * The chip never ellipsizes: a missing string means icon-only.
 */
export function workspaceAccountVisibleLabel(
  providerName: string | null | undefined,
  accountLabel: string | null | undefined,
  fallback: string,
  density: "full" | "provider" | "icon" = "full",
): string {
  if (density === "icon") return "";
  const full = workspaceAccountChipText(providerName, accountLabel, fallback);
  if (density === "provider") {
    return providerName?.trim() || full;
  }
  return full;
}

export function WorkspaceAccountButton({
  density = "full",
}: {
  density?: "full" | "provider" | "icon";
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
  const visibleLabel = workspaceAccountVisibleLabel(
    signedIn ? providerName : "",
    signedIn ? accountLabel : "",
    label,
    density,
  );
  const titleLabel = accountLabel || providerName || label;
  const iconSrc = getProviderIconSrc({
    id: active?.id,
    label: providerName || accountLabel || label,
  });

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-8 w-auto shrink-0 items-center gap-1.5 rounded-md px-2 text-left text-muted-foreground text-xs transition-colors hover:bg-muted hover:text-foreground"
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
        {iconSrc ? (
          <img src={iconSrc} alt="" className="size-3.5 shrink-0" />
        ) : (
          <UserRoundIcon className="size-3.5 shrink-0" />
        )}
        {visibleLabel ? (
          <span className="whitespace-nowrap">{visibleLabel}</span>
        ) : null}
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
