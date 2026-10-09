import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { getVersion } from "@tauri-apps/api/app";
import { RefreshCwIcon } from "lucide-react";
import { LanguageSwitch } from "@/components/language-switch";
import { Button } from "@/components/ui/button";
import { classifyUpdateError } from "@/lib/update-policy";
import {
  STATUS_NOTICE_BUTTON_PAD_PX,
  measuredLabelPx,
  planStatusVersionNotice,
  rememberMeasuredLabel,
  statusLabelMeasurementPx,
  type MeasuredLabelWidth,
} from "@/lib/status-bar-layout";
import { UpdateAvailableDialog } from "@/components/update-available-dialog";
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
  const dismissedOffer = useUpdateStore((state) => state.dismissedOffer);
  const checkForUpdate = useUpdateStore((state) => state.checkForUpdate);
  const applyUpdate = useUpdateStore((state) => state.applyUpdate);
  const openReleases = useUpdateStore((state) => state.openReleases);
  const reopenDismissedOffer = useUpdateStore(
    (state) => state.reopenDismissedOffer,
  );
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

  const dismissedHint = status.state === "idle" ? dismissedOffer : null;
  const mode = dismissedHint ? "blink" : noticeMode(status);
  const notice = dismissedHint
    ? flashCopy(
        {
          state: dismissedHint.kind,
          version: dismissedHint.version,
          currentVersion: dismissedHint.currentVersion,
          notes: dismissedHint.notes,
          notesState: dismissedHint.notesState,
          channel: dismissedHint.channel,
        },
        t,
      )
    : mode === "hidden"
      ? null
      : flashCopy(status, t);
  const blink = mode === "blink";
  const onNotice = () => {
    if (dismissedHint) {
      reopenDismissedOffer();
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
    dismissedHint !== null ||
    status.state === "ready" ||
    status.state === "manual" ||
    (status.state === "error" &&
      classifyUpdateError(status.message) === "missing-platform");

  const versionLabel = `LocalPrism${version ? ` v${version}` : ""}`;
  const noticeLabel = notice?.label ?? "";
  const noticeChromePx = noticeInteractive ? STATUS_NOTICE_BUTTON_PAD_PX : 0;
  const clusterRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [clusterPx, setClusterPx] = useState(0);
  const [measuredVersion, setMeasuredVersion] = useState<
    MeasuredLabelWidth | undefined
  >();
  const [measuredNotice, setMeasuredNotice] = useState<
    MeasuredLabelWidth | undefined
  >();

  useLayoutEffect(() => {
    const cluster = clusterRef.current;
    let cancelled = false;
    const read = () => {
      if (cancelled) return;
      const nextWidth = elementContentWidth(cluster);
      setClusterPx((prev) => (prev === nextWidth ? prev : nextWidth));
      const root = measureRef.current;
      const versionNode = root?.querySelector<HTMLElement>(
        '[data-status-measure="version"]',
      );
      const noticeNode = root?.querySelector<HTMLElement>(
        '[data-status-measure="notice"]',
      );
      const nextVersion = statusLabelMeasurementPx(
        versionLabel,
        renderedLabelPx(versionNode),
      );
      const nextNotice = noticeLabel
        ? statusLabelMeasurementPx(noticeLabel, renderedLabelPx(noticeNode))
        : undefined;
      setMeasuredVersion((prev) =>
        rememberMeasuredLabel(prev, versionLabel, nextVersion),
      );
      setMeasuredNotice((prev) =>
        rememberMeasuredLabel(prev, noticeLabel, nextNotice),
      );
    };
    read();
    const fonts = document.fonts;
    const onFonts = () => read();
    if (fonts?.ready) void fonts.ready.then(onFonts);
    fonts?.addEventListener?.("loadingdone", onFonts);
    let observer: ResizeObserver | null = null;
    if (cluster && typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(read);
      observer.observe(cluster);
    }
    return () => {
      cancelled = true;
      fonts?.removeEventListener?.("loadingdone", onFonts);
      observer?.disconnect();
    };
  }, [noticeLabel, versionLabel]);

  const versionPlan = planStatusVersionNotice({
    availablePx: clusterPx,
    versionLabel,
    noticeLabel,
    noticeChromePx,
    measuredVersionPx: measuredLabelPx(measuredVersion, versionLabel),
    measuredNoticePx: measuredLabelPx(measuredNotice, noticeLabel),
  });
  const stacked = versionPlan.layout === "stacked";

  return (
    <div
      data-testid="app-status-bar"
      data-layout="inline"
      className={cn(
        "@container/status w-full min-w-0 shrink-0 border-t text-muted-foreground text-xs",
        className,
      )}
    >
      {/* Controls stay on one row until the pane is narrower than the
          fixed actions (language, Beta, refresh, trailing chrome ≈
          13.75rem). The version and the update hint share the text row
          only when both strings fit; otherwise the hint takes the next
          line. Neither label is ellipsized. */}
      <div
        data-testid="app-status-bar-row"
        className={cn(
          "relative flex min-h-9 w-full min-w-0 items-center gap-1.5 overflow-x-hidden px-2 py-1",
          "@max-[13.75rem]/status:flex-col @max-[13.75rem]/status:items-stretch @max-[13.75rem]/status:gap-1 @max-[13.75rem]/status:px-1.5",
        )}
      >
        <div
          ref={measureRef}
          data-testid="app-status-measure"
          aria-hidden="true"
          className={cn(
            "pointer-events-none invisible absolute top-0 left-0 -z-10",
            "whitespace-nowrap",
          )}
        >
          <span
            className="inline-block"
            data-status-measure="version"
            style={{ width: "max-content" }}
          >
            {versionLabel}
          </span>
          {noticeLabel ? (
            <span
              className="inline-block"
              data-status-measure="notice"
              style={{ width: "max-content" }}
            >
              {noticeLabel}
            </span>
          ) : null}
        </div>
        <div
          ref={clusterRef}
          data-testid="app-status-version"
          data-layout={versionPlan.layout}
          className={cn(
            "flex min-w-0 flex-1",
            stacked ? "flex-col items-stretch gap-0.5" : "items-center gap-1.5",
            "@max-[13.75rem]/status:w-full @max-[13.75rem]/status:flex-none",
          )}
        >
          <span
            className={footerLabelClass(versionPlan.versionFits, stacked)}
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
                  "lp-focus",
                  footerLabelClass(versionPlan.noticeFits, stacked),
                  "rounded px-1 text-left text-foreground hover:bg-muted/70",
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
                className={cn(
                  footerLabelClass(versionPlan.noticeFits, stacked),
                  "text-foreground",
                  blink && "lp-update-flash",
                )}
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
              "lp-focus h-6 rounded-md px-1.5 font-medium text-[11px] disabled:cursor-not-allowed disabled:opacity-40",
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
      <UpdateAvailableDialog />
    </div>
  );
}

function elementContentWidth(node: HTMLElement | null): number {
  if (!node) return 0;
  const width = node.clientWidth || node.getBoundingClientRect().width || 0;
  if (!Number.isFinite(width) || width <= 0) return 0;
  return Math.round(width);
}

function renderedLabelPx(
  node: HTMLElement | null | undefined,
): number | undefined {
  if (!node) return undefined;
  const width = Math.max(node.scrollWidth, node.getBoundingClientRect().width);
  if (!Number.isFinite(width) || width <= 0) return undefined;
  return width;
}

/** One line when the string fits the cluster. Otherwise wrap the whole label. */
function footerLabelClass(fitsLine: boolean, stacked: boolean): string {
  if (!fitsLine) return "min-w-0 max-w-full break-words";
  return stacked
    ? "shrink-0 self-start whitespace-nowrap"
    : "shrink-0 whitespace-nowrap";
}

function flashCopy(
  status: UpdateStatus,
  t: (
    key:
      | "updates.flashBeta"
      | "updates.flashAvailable"
      | "updates.flashReady"
      | "updates.flashManual"
      | "updates.flashDownloading"
      | "updates.flashDownloadingPercent"
      | "updates.flashInstalling"
      | "updates.flashMissing"
      | "updates.flashError"
      | "updates.flashCurrent"
      | "updates.betaAvailable"
      | "updates.availableLine"
      | "updates.ready"
      | "updates.manual"
      | "updates.missingPlatform",
    vars?: Record<string, string | number>,
  ) => string,
): { label: string; title: string } {
  switch (status.state) {
    case "confirm":
      if (status.channel === "beta") {
        return {
          label: t("updates.flashBeta", { version: status.version }),
          title: t("updates.betaAvailable", { version: status.version }),
        };
      }
      return {
        label: t("updates.flashAvailable", { version: status.version }),
        title: t("updates.availableLine", {
          version: status.version,
          current: status.currentVersion,
        }),
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
      if (
        (status.phase === "install" || status.phase === "download") &&
        status.message.trim()
      ) {
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
