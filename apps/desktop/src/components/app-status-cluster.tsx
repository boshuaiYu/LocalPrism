import { useEffect, useState, type ReactNode } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { RefreshCwIcon } from "lucide-react";
import { LanguageSwitch } from "@/components/language-switch";
import { Button } from "@/components/ui/button";
import { classifyUpdateError } from "@/lib/update-policy";
import { useI18n } from "@/lib/use-i18n";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/stores/settings-store";
import {
  ensureUpdateCheck,
  useUpdateStore,
  type UpdateStatus,
} from "@/stores/update-store";

let cachedAppVersion = "";

export function useAppVersion(): string {
  const [version, setVersion] = useState(cachedAppVersion);
  useEffect(() => {
    if (version) return;
    void getVersion()
      .then((next) => {
        if (typeof next !== "string" || !next.trim()) return;
        cachedAppVersion = next;
        setVersion(next);
      })
      .catch(() => undefined);
  }, [version]);
  return version;
}

function noticeMode(status: UpdateStatus): "blink" | "steady" | "hidden" {
  switch (status.state) {
    case "confirm":
    case "ready":
    case "manual":
      return "blink";
    case "downloading":
    case "installing":
    case "up-to-date":
      return "steady";
    case "error":
      return status.explicit ||
        classifyUpdateError(status.message) === "missing-platform"
        ? "steady"
        : "hidden";
    default:
      return "hidden";
  }
}

export function AppStatusBar({
  className,
  trailing,
}: {
  className?: string;
  trailing?: ReactNode;
}) {
  const version = useAppVersion();
  const { t } = useI18n();
  const status = useUpdateStore((state) => state.status);
  const checkForUpdate = useUpdateStore((state) => state.checkForUpdate);
  const confirmDownload = useUpdateStore((state) => state.confirmDownload);
  const applyUpdate = useUpdateStore((state) => state.applyUpdate);
  const openReleases = useUpdateStore((state) => state.openReleases);
  const joinBeta = useSettingsStore((state) => state.joinBetaChannel);
  const setJoinBetaChannel = useSettingsStore(
    (state) => state.setJoinBetaChannel,
  );
  const betaChannelLabel = t(
    joinBeta ? "updates.betaJoined" : "updates.betaJoin",
  );
  const busy =
    status.state === "checking" ||
    status.state === "downloading" ||
    status.state === "installing";

  useEffect(() => {
    ensureUpdateCheck();
  }, []);

  const mode = noticeMode(status);
  const notice = mode === "hidden" ? null : flashCopy(status, t);
  const blink = mode === "blink";
  const onNotice = () => {
    if (status.state === "confirm") {
      void confirmDownload();
      return;
    }
    if (status.state === "ready") {
      void applyUpdate();
      return;
    }
    if (
      status.state === "manual" ||
      (status.state === "error" &&
        classifyUpdateError(status.message) === "missing-platform")
    ) {
      void openReleases();
    }
  };
  const noticeInteractive =
    status.state === "confirm" ||
    status.state === "ready" ||
    status.state === "manual" ||
    (status.state === "error" &&
      classifyUpdateError(status.message) === "missing-platform");

  const versionLabel = `LocalPrism${version ? ` v${version}` : ""}`;

  return (
    <div
      data-testid="app-status-bar"
      data-layout="inline"
      className={cn(
        "@container/status w-full min-w-0 shrink-0 border-t text-muted-foreground text-xs",
        className,
      )}
    >
      {/* One row until the pane is narrower than the fixed controls
          (language, Beta, refresh, trailing chrome ≈ 13.75rem). Version
          text truncates. Stacking only below that keeps those controls
          from being clipped on a narrow sidebar. */}
      <div
        data-testid="app-status-bar-row"
        className={cn(
          "flex min-h-9 w-full min-w-0 items-center gap-1.5 overflow-x-hidden px-2 py-1",
          "@max-[13.75rem]/status:flex-col @max-[13.75rem]/status:items-stretch @max-[13.75rem]/status:gap-1 @max-[13.75rem]/status:px-1.5",
        )}
      >
        <div
          className={cn(
            "flex min-w-0 flex-1 items-center gap-1.5",
            "@max-[13.75rem]/status:w-full @max-[13.75rem]/status:flex-none",
          )}
        >
          <span
            className="min-w-0 truncate"
            data-testid="app-version"
            title={versionLabel}
          >
            {versionLabel}
          </span>
          {notice ? (
            noticeInteractive ? (
              <button
                type="button"
                data-testid="update-flash"
                className={cn(
                  "min-w-0 truncate rounded px-1 text-left text-foreground hover:bg-muted/70",
                  blink && "lp-update-flash",
                )}
                title={notice.title}
                onClick={onNotice}
              >
                {notice.label}
              </button>
            ) : (
              <span
                data-testid="update-flash"
                className="min-w-0 truncate text-foreground"
                title={notice.title}
              >
                {notice.label}
              </span>
            )
          ) : null}
        </div>
        <div
          data-testid="app-status-actions"
          className={cn(
            "ml-auto flex shrink-0 items-center gap-0.5 [&>*]:shrink-0",
            "@max-[13.75rem]/status:ml-0 @max-[13.75rem]/status:w-full @max-[13.75rem]/status:flex-wrap",
          )}
        >
          <LanguageSwitch compact />
          <button
            type="button"
            role="switch"
            aria-checked={joinBeta}
            aria-label={betaChannelLabel}
            title={betaChannelLabel}
            data-testid="beta-channel-toggle"
            disabled={busy}
            className={cn(
              "h-6 rounded-md px-1.5 font-medium text-[11px] disabled:cursor-not-allowed disabled:opacity-40",
              joinBeta
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
            )}
            onClick={() => {
              setJoinBetaChannel(!joinBeta);
              void checkForUpdate({ explicit: true });
            }}
          >
            {t("updates.beta")}
          </button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-6"
            data-testid="check-for-updates"
            data-tour="tour-updates"
            title={t("updates.check")}
            aria-label={t("updates.check")}
            disabled={busy}
            onClick={() => void checkForUpdate({ explicit: true })}
          >
            <RefreshCwIcon
              className={busy ? "size-3.5 animate-spin" : "size-3.5"}
            />
          </Button>
          {trailing}
        </div>
      </div>
    </div>
  );
}

function flashCopy(
  status: UpdateStatus,
  t: (
    key:
      | "updates.flashBeta"
      | "updates.flashReady"
      | "updates.flashManual"
      | "updates.flashDownloading"
      | "updates.flashDownloadingPercent"
      | "updates.flashInstalling"
      | "updates.flashMissing"
      | "updates.flashError"
      | "updates.flashCurrent"
      | "updates.betaAvailable"
      | "updates.ready"
      | "updates.manual"
      | "updates.missingPlatform",
    vars?: Record<string, string | number>,
  ) => string,
): { label: string; title: string } {
  switch (status.state) {
    case "confirm":
      return {
        label: t("updates.flashBeta", { version: status.version }),
        title: t("updates.betaAvailable", { version: status.version }),
      };
    case "ready":
      return {
        label: t("updates.flashReady", { version: status.version }),
        title: t("updates.ready", { version: status.version }),
      };
    case "manual":
      return {
        label: t("updates.flashManual", { version: status.version }),
        title: t("updates.manual", { version: status.version }),
      };
    case "downloading":
      return {
        label:
          status.percent == null
            ? t("updates.flashDownloading", { version: status.version })
            : t("updates.flashDownloadingPercent", {
                version: status.version,
                percent: status.percent,
              }),
        title: t("updates.flashDownloading", { version: status.version }),
      };
    case "installing":
      return {
        label: t("updates.flashInstalling"),
        title: t("updates.flashInstalling"),
      };
    case "up-to-date":
      return {
        label: t("updates.flashCurrent"),
        title: t("updates.flashCurrent"),
      };
    case "error":
      if (status.phase === "install" && status.message.trim()) {
        return { label: status.message, title: status.message };
      }
      return classifyUpdateError(status.message) === "missing-platform"
        ? {
            label: t("updates.flashMissing"),
            title: t("updates.missingPlatform"),
          }
        : {
            label: t("updates.flashError"),
            title: status.message,
          };
    default:
      return { label: "", title: "" };
  }
}
