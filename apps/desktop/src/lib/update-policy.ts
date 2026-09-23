export const RELEASES_URL =
  "https://github.com/boshuaiYu/LocalPrism/releases/latest";

export type UpdateApplyMode = "background-restart" | "manual-package";

/**
 * GitHub's updater manifest points Linux at the AppImage only.
 * deb/rpm installs must not be replaced by that payload.
 */
export function updateApplyMode(
  channel: string | null | undefined,
): UpdateApplyMode {
  return channel === "linux-package" ? "manual-package" : "background-restart";
}

export function updateBannerVisible(
  status: { state: string; explicit?: boolean },
  dismissed: boolean,
): boolean {
  if (status.state === "downloading" || status.state === "installing") {
    return true;
  }
  if (dismissed) return false;
  if (status.state === "ready" || status.state === "manual") return true;
  if (status.state === "error" && status.explicit) return true;
  return false;
}
