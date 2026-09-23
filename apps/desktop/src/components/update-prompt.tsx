import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { classifyUpdateError, updateBannerVisible } from "@/lib/update-policy";
import { useI18n } from "@/lib/use-i18n";
import {
  ensureUpdateCheck,
  useUpdateStore,
  type UpdateStatus,
} from "@/stores/update-store";

function statusCopy(
  status: UpdateStatus,
  t: (
    key:
      | "updates.missingPlatform"
      | "updates.betaAvailable"
      | "updates.checking"
      | "updates.upToDate"
      | "updates.idle"
      | "updates.downloading"
      | "updates.downloadingPercent"
      | "updates.ready"
      | "updates.manual"
      | "updates.installing",
    vars?: Record<string, string | number>,
  ) => string,
): string {
  switch (status.state) {
    case "checking":
      return t("updates.checking");
    case "up-to-date":
      return t("updates.upToDate");
    case "confirm":
      return t("updates.betaAvailable", { version: status.version });
    case "downloading":
      return status.percent == null
        ? t("updates.downloading", { version: status.version })
        : t("updates.downloadingPercent", {
            version: status.version,
            percent: status.percent,
          });
    case "ready":
      return t("updates.ready", { version: status.version });
    case "manual":
      return t("updates.manual", { version: status.version });
    case "installing":
      return t("updates.installing", { version: status.version });
    case "error":
      return classifyUpdateError(status.message) === "missing-platform"
        ? t("updates.missingPlatform")
        : status.message;
    default:
      return t("updates.idle");
  }
}

export function UpdatePrompt() {
  const { t } = useI18n();
  const status = useUpdateStore((state) => state.status);
  const dismissed = useUpdateStore((state) => state.bannerDismissed);
  const dismissBanner = useUpdateStore((state) => state.dismissBanner);
  const confirmDownload = useUpdateStore((state) => state.confirmDownload);
  const applyUpdate = useUpdateStore((state) => state.applyUpdate);
  const openReleases = useUpdateStore((state) => state.openReleases);

  useEffect(() => {
    ensureUpdateCheck();
  }, []);

  if (!updateBannerVisible(status, dismissed)) return null;

  return (
    <div
      data-testid="update-prompt"
      role="region"
      aria-label={t("updates.bannerLabel")}
      className="lp-chrome flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b px-4 py-2"
    >
      <p className="min-w-0 flex-1 text-sm leading-relaxed">
        {statusCopy(status, t)}
      </p>
      <div className="flex shrink-0 flex-wrap justify-end gap-2">
        {status.state === "confirm" && (
          <Button
            type="button"
            className="h-8 rounded-lg"
            data-testid="update-download"
            onClick={() => void confirmDownload()}
          >
            {t("updates.download")}
          </Button>
        )}
        {status.state === "ready" && (
          <Button
            type="button"
            className="h-8 rounded-lg"
            onClick={() => void applyUpdate()}
          >
            {t("updates.restart")}
          </Button>
        )}
        {status.state === "manual" && (
          <Button
            type="button"
            className="h-8 rounded-lg"
            onClick={() => void openReleases()}
          >
            {t("updates.viewReleases")}
          </Button>
        )}
        {status.state === "error" &&
          classifyUpdateError(status.message) === "missing-platform" && (
            <Button
              type="button"
              className="h-8 rounded-lg"
              onClick={() => void openReleases()}
            >
              {t("updates.viewReleases")}
            </Button>
          )}
        {status.state !== "installing" && status.state !== "downloading" && (
          <Button
            type="button"
            variant="outline"
            className="h-8 rounded-lg"
            data-testid="update-later"
            onClick={dismissBanner}
          >
            {t("updates.later")}
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
  const confirmDownload = useUpdateStore((state) => state.confirmDownload);
  const applyUpdate = useUpdateStore((state) => state.applyUpdate);
  const openReleases = useUpdateStore((state) => state.openReleases);
  const busy =
    status.state === "checking" ||
    status.state === "downloading" ||
    status.state === "installing";

  return (
    <section
      data-testid="update-settings"
      className="lp-panel shrink-0 rounded-xl border p-4"
    >
      <h3 className="font-medium text-sm">{t("settings.updates")}</h3>
      <p className="mt-1 text-lp-meta text-sm leading-relaxed">
        {statusCopy(status, t)} {t("updates.settingsBody")}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          className="h-9 rounded-lg"
          disabled={busy}
          onClick={() => void checkForUpdate({ explicit: true })}
        >
          {t("updates.check")}
        </Button>
        {status.state === "confirm" && (
          <Button
            type="button"
            className="h-9 rounded-lg"
            onClick={() => void confirmDownload()}
          >
            {t("updates.download")}
          </Button>
        )}
        {status.state === "ready" && (
          <Button
            type="button"
            className="h-9 rounded-lg"
            onClick={() => void applyUpdate()}
          >
            {t("updates.restart")}
          </Button>
        )}
        {status.state === "manual" && (
          <Button
            type="button"
            variant="outline"
            className="h-9 rounded-lg"
            onClick={() => void openReleases()}
          >
            {t("updates.viewReleases")}
          </Button>
        )}
      </div>
    </section>
  );
}
