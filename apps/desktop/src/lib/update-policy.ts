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

export type UpdateErrorKind = "missing-platform" | "generic";

/**
 * Tauri's updater throws this when latest.json has no entry for the
 * running target (including an empty platforms object).
 */
export function classifyUpdateError(message: string): UpdateErrorKind {
  const text = message.toLowerCase();
  if (
    text.includes("were found in the response platforms") ||
    text.includes("platforms object") ||
    text.includes("fallback platforms") ||
    /no (?:compatible|matching) platform/.test(text)
  ) {
    return "missing-platform";
  }
  return "generic";
}

export function updateBannerVisible(
  status: { state: string; explicit?: boolean; message?: string },
  dismissed: boolean,
): boolean {
  if (status.state === "downloading" || status.state === "installing") {
    return true;
  }
  if (dismissed) return false;
  if (status.state === "ready" || status.state === "manual") return true;
  if (
    status.state === "error" &&
    (status.explicit ||
      classifyUpdateError(status.message ?? "") === "missing-platform")
  ) {
    return true;
  }
  return false;
}
