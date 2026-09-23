import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/use-i18n";
import { classifyUpdateError, updateBannerVisible } from "@/lib/update-policy";
import {
  ensureUpdateCheck,
  useUpdateStore,
  type UpdateStatus,
} from "@/stores/update-store";

function statusCopy(status: UpdateStatus, missingPlatform: string): string {
  switch (status.state) {
    case "checking":
      return "Checking for updates…";
    case "up-to-date":
      return "You're on the latest version.";
    case "downloading":
      return status.percent == null
        ? `Downloading ${status.version} in the background. LocalPrism asks before restarting.`
        : `Downloading ${status.version} (${status.percent}%). LocalPrism asks before restarting.`;
    case "ready":
      return `${status.version} is downloaded. Restart to install it.`;
    case "manual":
      return `${status.version} is available. This Linux install is a .deb or .rpm, so LocalPrism will not replace it with the AppImage. Download the new package from Releases.`;
    case "installing":
      return `Installing ${status.version} and restarting…`;
    case "error":
      return classifyUpdateError(status.message) === "missing-platform"
        ? missingPlatform
        : status.message;
    default:
      return "Updates download in the background. Restart only after you confirm.";
  }
}

export function UpdatePrompt() {
  const { t } = useI18n();
  const status = useUpdateStore((state) => state.status);
  const dismissed = useUpdateStore((state) => state.bannerDismissed);
  const dismissBanner = useUpdateStore((state) => state.dismissBanner);
  const applyUpdate = useUpdateStore((state) => state.applyUpdate);
  const openReleases = useUpdateStore((state) => state.openReleases);

  useEffect(() => {
    ensureUpdateCheck();
  }, []);

  if (!updateBannerVisible(status, dismissed)) return null;

  return (
    <div
      data-testid="update-prompt"
      className="lp-chrome fixed inset-x-0 bottom-4 z-40 mx-auto flex w-[min(40rem,calc(100vw-2rem))] flex-col gap-3 rounded-xl border px-4 py-3 shadow-lg"
    >
      <p className="text-sm leading-relaxed">
        {statusCopy(status, t("updates.missingPlatform"))}
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        {status.state === "ready" && (
          <Button
            type="button"
            className="h-9 rounded-lg"
            onClick={() => void applyUpdate()}
          >
            Restart to update
          </Button>
        )}
        {status.state === "manual" && (
          <Button
            type="button"
            className="h-9 rounded-lg"
            onClick={() => void openReleases()}
          >
            View releases
          </Button>
        )}
        {status.state === "error" &&
          classifyUpdateError(status.message) === "missing-platform" && (
            <Button
              type="button"
              className="h-9 rounded-lg"
              onClick={() => void openReleases()}
            >
              {t("updates.viewReleases")}
            </Button>
          )}
        {status.state !== "installing" && status.state !== "downloading" && (
          <Button
            type="button"
            variant="outline"
            className="h-9 rounded-lg"
            onClick={dismissBanner}
          >
            Later
          </Button>
        )}
      </div>
    </div>
  );
}

export function UpdateSettings() {
  const { t } = useI18n();
  const status = useUpdateStore((state) => state.status);
  const checkForUpdate = useUpdateStore((state) => state.checkForUpdate);
  const applyUpdate = useUpdateStore((state) => state.applyUpdate);
  const openReleases = useUpdateStore((state) => state.openReleases);
  const busy = status.state === "checking" || status.state === "downloading";

  return (
    <section
      data-testid="update-settings"
      className="lp-panel shrink-0 rounded-xl border p-4"
    >
      <h3 className="font-medium text-sm">{t("settings.updates")}</h3>
      <p className="mt-1 text-lp-meta text-sm leading-relaxed">
        {statusCopy(status, t("updates.missingPlatform"))} In-app install
        applies to the AppImage, macOS, and Windows. Debian and RPM installs
        stay on the package from Releases. Downloads are checked with the
        existing updater signature.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          className="h-9 rounded-lg"
          disabled={busy || status.state === "installing"}
          onClick={() => void checkForUpdate({ explicit: true })}
        >
          {t("updates.check")}
        </Button>
        {status.state === "ready" && (
          <Button
            type="button"
            className="h-9 rounded-lg"
            onClick={() => void applyUpdate()}
          >
            Restart to update
          </Button>
        )}
        {status.state === "manual" && (
          <Button
            type="button"
            variant="outline"
            className="h-9 rounded-lg"
            onClick={() => void openReleases()}
          >
            View releases
          </Button>
        )}
      </div>
    </section>
  );
}
