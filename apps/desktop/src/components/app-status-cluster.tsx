import { RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LanguageSwitch } from "@/components/language-switch";
import { useI18n } from "@/lib/use-i18n";
import { useUpdateStore } from "@/stores/update-store";

export function AppStatusCluster({
  version,
  compact = false,
}: {
  version: string;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const status = useUpdateStore((state) => state.status);
  const checkForUpdate = useUpdateStore((state) => state.checkForUpdate);
  const busy =
    status.state === "checking" ||
    status.state === "downloading" ||
    status.state === "installing";

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <span className="truncate">
        LocalPrism{version ? ` v${version}` : ""}
      </span>
      <LanguageSwitch compact />
      <Button
        type="button"
        variant="ghost"
        size={compact ? "icon" : "sm"}
        className={compact ? "size-6" : "h-7 gap-1 px-2 text-xs"}
        data-testid="check-for-updates"
        title={t("updates.check")}
        aria-label={t("updates.check")}
        disabled={busy}
        onClick={() => void checkForUpdate({ explicit: true })}
      >
        <RefreshCwIcon
          className={busy ? "size-3.5 animate-spin" : "size-3.5"}
        />
        {compact ? null : t("updates.check")}
      </Button>
    </div>
  );
}
