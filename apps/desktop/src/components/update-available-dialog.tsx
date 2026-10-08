import type { ReactNode } from "react";
import { XIcon } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { isOpenableChatHref, transformChatUrl } from "@/lib/chat-citations";
import { isPrereleaseVersion } from "@/lib/update-policy";
import { useI18n } from "@/lib/use-i18n";
import { cn } from "@/lib/utils";
import { useUpdateStore, type UpdateStatus } from "@/stores/update-store";

const REMARK_PLUGINS = [remarkGfm];

/** Release-note links leave the webview and open in the system browser. */
function ReleaseNoteLink({
  href,
  children,
}: {
  href?: string;
  children?: ReactNode;
}) {
  const url = transformChatUrl(typeof href === "string" ? href : "");
  const openable = isOpenableChatHref(url);
  const openLink = (event: { preventDefault: () => void }) => {
    event.preventDefault();
    if (!openable) return;
    void shellOpen(url).catch(() => undefined);
  };
  if (!openable) {
    return <span className="break-all">{children}</span>;
  }
  return (
    <button
      type="button"
      data-testid="update-release-link"
      className="inline cursor-pointer break-all border-0 bg-transparent p-0 text-left font-inherit text-primary underline underline-offset-2"
      onClick={openLink}
      onAuxClick={openLink}
    >
      {children}
    </button>
  );
}

const RELEASE_NOTE_COMPONENTS = {
  a: ReleaseNoteLink,
  h1: ({ children }: { children?: ReactNode }) => (
    <h2 className="mt-3 mb-2 font-semibold text-sm first:mt-0">{children}</h2>
  ),
  h2: ({ children }: { children?: ReactNode }) => (
    <h2 className="mt-3 mb-2 font-semibold text-sm first:mt-0">{children}</h2>
  ),
  h3: ({ children }: { children?: ReactNode }) => (
    <h3 className="mt-3 mb-2 font-semibold text-sm first:mt-0">{children}</h3>
  ),
  p: ({ children }: { children?: ReactNode }) => (
    <p className="mb-2 last:mb-0">{children}</p>
  ),
  ul: ({ children }: { children?: ReactNode }) => (
    <ul className="mb-2 list-disc space-y-1 pl-5 last:mb-0">{children}</ul>
  ),
  ol: ({ children }: { children?: ReactNode }) => (
    <ol className="mb-2 list-decimal space-y-1 pl-5 last:mb-0">{children}</ol>
  ),
  li: ({ children }: { children?: ReactNode }) => <li>{children}</li>,
  code: ({ children }: { children?: ReactNode }) => (
    <code className="rounded bg-muted px-1 py-px text-[0.85em]">
      {children}
    </code>
  ),
  pre: ({ children }: { children?: ReactNode }) => (
    <pre className="mb-2 overflow-x-auto rounded-md bg-muted p-2 text-xs last:mb-0">
      {children}
    </pre>
  ),
  table: ({ children }: { children?: ReactNode }) => (
    <div
      data-testid="update-notes-table"
      className="my-2 max-w-full overflow-x-auto"
    >
      <table className="w-max min-w-full border-collapse text-left">
        {children}
      </table>
    </div>
  ),
  th: ({ children }: { children?: ReactNode }) => (
    <th className="break-words border-border border-b px-2 py-1 font-medium">
      {children}
    </th>
  ),
  td: ({ children }: { children?: ReactNode }) => (
    <td className="break-words border-border border-t px-2 py-1 align-top">
      {children}
    </td>
  ),
};

function offerDialogOpen(status: UpdateStatus, hidden: boolean): boolean {
  if (hidden) return false;
  return (
    status.state === "confirm" ||
    status.state === "manual" ||
    status.state === "downloading" ||
    status.state === "ready" ||
    status.state === "installing"
  );
}

export function UpdateAvailableDialog() {
  const status = useUpdateStore((state) => state.status);
  const hidden = useUpdateStore((state) => state.offerDialogHidden);
  const dismiss = useUpdateStore((state) => state.dismissOfferDialog);
  const confirmDownload = useUpdateStore((state) => state.confirmDownload);
  const applyUpdate = useUpdateStore((state) => state.applyUpdate);
  const openReleases = useUpdateStore((state) => state.openReleases);
  const { t } = useI18n();
  const open = offerDialogOpen(status, hidden);
  const version = "version" in status ? status.version : "";
  const currentVersion =
    "currentVersion" in status ? status.currentVersion : "";
  const notes = "notes" in status ? status.notes?.trim() : "";
  const notesState = "notesState" in status ? status.notesState : undefined;
  const channel = "channel" in status ? status.channel : "stable";
  const beta = channel === "beta" || isPrereleaseVersion(version);
  const percent = status.state === "downloading" ? status.percent : null;
  const awaitingChoice =
    status.state === "confirm" || status.state === "manual";

  let summary = t("updates.availableLine", {
    version,
    current: currentVersion,
  });
  if (status.state === "downloading") {
    summary =
      percent == null
        ? t("updates.downloading", { version })
        : t("updates.downloadingPercent", { version, percent });
  } else if (status.state === "ready") {
    summary = t("updates.ready", { version });
  } else if (status.state === "installing") {
    summary = t("updates.installing", { version });
  }

  let primary: ReactNode = null;
  if (status.state === "ready") {
    primary = (
      <Button
        type="button"
        data-testid="update-dialog-restart"
        onClick={() => void applyUpdate()}
      >
        {t("updates.restart")}
      </Button>
    );
  } else if (status.state === "installing") {
    primary = (
      <Button type="button" data-testid="update-dialog-installing" disabled>
        {t("updates.flashInstalling")}
      </Button>
    );
  } else if (status.state === "downloading") {
    primary = (
      <Button type="button" data-testid="update-dialog-download" disabled>
        {percent == null
          ? t("updates.dialogDownloading")
          : t("updates.dialogDownloadingPercent", { percent })}
      </Button>
    );
  } else if (status.state === "confirm") {
    primary = (
      <Button
        type="button"
        data-testid="update-dialog-download"
        onClick={() => void confirmDownload()}
      >
        {t("updates.downloadAndInstall")}
      </Button>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) dismiss();
      }}
    >
      <DialogContent
        showCloseButton={false}
        data-testid="update-available-dialog"
        data-channel={channel}
        data-phase={open ? status.state : undefined}
        className="gap-3 sm:max-w-lg"
      >
        <DialogHeader className="gap-1.5 pr-6 text-left">
          <DialogTitle>{t("updates.availableTitle")}</DialogTitle>
          <DialogDescription className="text-foreground text-sm">
            {summary}
            {beta ? (
              <span
                data-testid="update-beta-badge"
                className="ml-2 inline-flex items-center rounded-md border border-border bg-muted px-1.5 py-px align-middle font-medium text-[10px] text-muted-foreground leading-none"
              >
                {t("updates.beta")}
              </span>
            ) : null}
          </DialogDescription>
        </DialogHeader>
        {status.state === "manual" ? (
          <p
            data-testid="update-manual-note"
            className="text-muted-foreground text-sm"
          >
            {t("updates.manual", { version })}
          </p>
        ) : null}
        {notesState === "loading" ? (
          <div
            data-testid="update-notes-loading"
            aria-busy="true"
            className="max-h-60 min-h-16 rounded-md border bg-muted/40"
          />
        ) : notesState === "unavailable" ? (
          <p
            data-testid="update-notes-unavailable"
            className="text-muted-foreground text-sm"
          >
            {t("updates.notesSeeDownloadPage")}
          </p>
        ) : notes ? (
          <div
            data-testid="update-release-notes"
            className="max-h-60 overflow-x-auto overflow-y-auto overscroll-contain break-words rounded-md border bg-muted/40 px-3 py-2.5 text-sm [overflow-wrap:anywhere]"
          >
            <ReactMarkdown
              remarkPlugins={REMARK_PLUGINS}
              urlTransform={transformChatUrl}
              disallowedElements={["img"]}
              unwrapDisallowed
              components={RELEASE_NOTE_COMPONENTS}
            >
              {notes}
            </ReactMarkdown>
          </div>
        ) : (
          <p
            data-testid="update-notes-empty"
            className="text-muted-foreground text-sm"
          >
            {t("updates.notesEmpty")}
          </p>
        )}
        {status.state === "downloading" ? (
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent ?? undefined}
            data-testid="update-download-progress"
            className="h-1.5 overflow-hidden rounded-full bg-muted"
          >
            <div
              className={cn(
                "h-full bg-primary",
                percent == null ? "w-1/3 animate-pulse" : "transition-[width]",
              )}
              style={percent == null ? undefined : { width: `${percent}%` }}
            />
          </div>
        ) : null}
        <DialogFooter className="flex-row justify-end gap-2">
          {awaitingChoice ? (
            <Button
              type="button"
              variant="outline"
              data-testid="update-dialog-cancel"
              onClick={() => dismiss()}
            >
              {t("chrome.cancel")}
            </Button>
          ) : null}
          <Button
            type="button"
            variant={status.state === "manual" ? "default" : "outline"}
            data-testid="update-dialog-open-page"
            onClick={() => void openReleases()}
          >
            {t("updates.openDownloadPage")}
          </Button>
          {primary}
        </DialogFooter>
        <DialogClose
          data-testid="update-dialog-close"
          aria-label={t("chrome.cancel")}
          className="absolute top-4 right-4 rounded-xs opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-hidden focus:ring-2 focus:ring-ring focus:ring-offset-2"
        >
          <XIcon className="size-4" />
          <span className="sr-only">{t("chrome.cancel")}</span>
        </DialogClose>
      </DialogContent>
    </Dialog>
  );
}
