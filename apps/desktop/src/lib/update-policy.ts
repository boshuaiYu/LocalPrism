export const RELEASES_URL =
  "https://github.com/boshuaiYu/LocalPrism/releases/latest";

/**
 * Stable updater manifest. Tauri's configured endpoint.
 * GitHub only serves the newest non-prerelease here, so a beta must not
 * be published as "latest" and this URL must not be reused for betas.
 */
export const STABLE_UPDATER_ENDPOINT =
  "https://github.com/boshuaiYu/LocalPrism/releases/latest/download/latest.json";

export const GITHUB_RELEASES_API =
  "https://api.github.com/repos/boshuaiYu/LocalPrism/releases?per_page=30";

const BETA_MANIFEST_RE =
  /^https:\/\/github\.com\/boshuaiYu\/LocalPrism\/releases\/download\/([^/?#]+)\/latest\.json$/;

const SAFE_TAG_RE = /^[A-Za-z0-9._+-]+$/;

const SEMVER_RE =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** `v1.0.8beta2` / `1.0.8BETA3`. Not `1.0.8-beta.2`. */
const COMPACT_BETA_RE = /^v?(\d+)\.(\d+)\.(\d+)beta(\d+)$/i;

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
  /**
   * Post-release build for tags such as `v1.0.8beta3`.
   * Null for plain releases and hyphenated semver.
   */
  compactBeta: number | null;
}

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
  if (
    status.state === "ready" ||
    status.state === "manual" ||
    status.state === "confirm"
  ) {
    return true;
  }
  if (
    status.state === "error" &&
    (status.explicit ||
      classifyUpdateError(status.message ?? "") === "missing-platform")
  ) {
    return true;
  }
  return false;
}

export function parseSemver(input: string): SemVer | null {
  const compact = COMPACT_BETA_RE.exec(input.trim());
  if (compact) {
    return {
      major: Number(compact[1]),
      minor: Number(compact[2]),
      patch: Number(compact[3]),
      prerelease: [],
      compactBeta: Number(compact[4]),
    };
  }
  const match = SEMVER_RE.exec(input.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
    compactBeta: null,
  };
}

/**
 * Prerelease if the version is hyphenated semver (`1.0.8-1`, `1.0.8-beta.1`)
 * or a compact tag (`1.0.8beta2`, `v1.0.8beta3`).
 */
export function isPrereleaseVersion(version: string): boolean {
  const parsed = parseSemver(version);
  return (
    !!parsed && (parsed.prerelease.length > 0 || parsed.compactBeta !== null)
  );
}

/** `1.0.8beta2` and `1.0.8-2`. Not `1.0.8-beta.2`. */
function msiBuildNumber(version: SemVer): number | null {
  if (version.compactBeta !== null) return version.compactBeta;
  const [only] = version.prerelease;
  if (version.prerelease.length === 1 && only && /^\d+$/.test(only)) {
    return Number(only);
  }
  return null;
}

function compareIdentifier(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) {
    const diff = Number(left) - Number(right);
    if (diff < 0) return -1;
    if (diff > 0) return 1;
    return 0;
  }
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function compareSemver(left: SemVer, right: SemVer): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  if (left.patch !== right.patch) return left.patch - right.patch;
  const leftBuild = msiBuildNumber(left);
  const rightBuild = msiBuildNumber(right);
  // `1.0.8beta2` and the WiX package form `1.0.8-2` are the same
  // post-release build. That class is newer than the plain tag `1.0.8`,
  // so Latest `1.0.8` must not replace an installed `1.0.8-2`.
  // A word prerelease such as `1.0.8-beta.2` stays on ordinary semver.
  if (leftBuild !== null && rightBuild !== null) {
    return leftBuild - rightBuild;
  }
  if (leftBuild !== null) return 1;
  if (rightBuild !== null) return -1;
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftId = left.prerelease[index];
    const rightId = right.prerelease[index];
    if (leftId === undefined) return -1;
    if (rightId === undefined) return 1;
    const diff = compareIdentifier(leftId, rightId);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function isNewerVersion(candidate: string, current: string): boolean {
  const next = parseSemver(candidate);
  const previous = parseSemver(current);
  if (!next || !previous) return false;
  return compareSemver(next, previous) > 0;
}

/**
 * Beta detection:
 * - GitHub release `prerelease: true`, or
 * - a semver prerelease identifier (`1.0.8-1`, `1.0.8-beta.1`).
 * The manifest is `releases/download/<tag>/latest.json` on that tag.
 * It is never `releases/latest`.
 */
export function isBetaRelease(release: {
  prerelease?: boolean;
  version: string;
}): boolean {
  return release.prerelease === true || isPrereleaseVersion(release.version);
}

export function isAllowedBetaManifestUrl(url: string): boolean {
  const match = BETA_MANIFEST_RE.exec(url.trim());
  if (!match) return false;
  let tag = match[1] ?? "";
  try {
    tag = decodeURIComponent(tag);
  } catch {
    return false;
  }
  if (tag === "latest" || tag.includes("..") || tag.includes("/")) return false;
  return SAFE_TAG_RE.test(tag);
}

export function releasePageUrl(version?: string): string {
  const trimmed = version?.trim().replace(/^v(?=\d)/, "") ?? "";
  if (!SAFE_TAG_RE.test(trimmed) || trimmed === "latest") return RELEASES_URL;
  return `https://github.com/boshuaiYu/LocalPrism/releases/tag/v${trimmed}`;
}

export function betaManifestUrlForTag(tag: string): string | null {
  const trimmed = tag.trim();
  if (!SAFE_TAG_RE.test(trimmed) || trimmed === "latest") return null;
  const url = `https://github.com/boshuaiYu/LocalPrism/releases/download/${trimmed}/latest.json`;
  return isAllowedBetaManifestUrl(url) ? url : null;
}

export interface ReleaseCandidate {
  version: string;
  prerelease: boolean;
  draft?: boolean;
  notes?: string;
  manifestUrl?: string;
}

export type UpdateOffer =
  | { action: "none" }
  | { action: "download"; version: string; notes?: string }
  | {
      action: "confirm";
      version: string;
      notes?: string;
      /** Null means the Tauri check() handle is already the beta payload. */
      manifestUrl: string | null;
    };

export function betaCandidatesFromGithub(payload: unknown): ReleaseCandidate[] {
  if (!Array.isArray(payload)) return [];
  const candidates: ReleaseCandidate[] = [];
  for (const item of payload) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const tag =
      typeof record.tag_name === "string" ? record.tag_name.trim() : "";
    if (!tag) continue;
    const version = tag.replace(/^v(?=\d)/, "");
    const prerelease = record.prerelease === true;
    const draft = record.draft === true;
    if (!isBetaRelease({ version, prerelease })) continue;
    const notes =
      typeof record.body === "string" && record.body.trim()
        ? record.body.trim()
        : undefined;
    let manifestUrl = betaManifestUrlForTag(tag);
    const assets = Array.isArray(record.assets) ? record.assets : [];
    for (const asset of assets) {
      if (!asset || typeof asset !== "object") continue;
      const name = (asset as { name?: unknown }).name;
      const download = (asset as { browser_download_url?: unknown })
        .browser_download_url;
      if (
        name === "latest.json" &&
        typeof download === "string" &&
        isAllowedBetaManifestUrl(download)
      ) {
        manifestUrl = download;
      }
    }
    if (!manifestUrl) continue;
    candidates.push({
      version,
      prerelease,
      draft,
      notes,
      manifestUrl,
    });
  }
  return candidates;
}

function releaseVersion(version: string): string {
  return version.trim().replace(/^v(?=\d)/, "");
}

function prereleaseManifestForVersion(version: string): string | null {
  const trimmed = releaseVersion(version);
  if (!isPrereleaseVersion(trimmed)) return null;
  return betaManifestUrlForTag(`v${trimmed}`);
}

/**
 * Stable builds from `releases/latest` may download immediately.
 * Prereleases, including `v1.0.8beta3`, stay hidden unless `allowPrerelease`.
 * A compact beta of the same core is newer than that plain stable tag
 * while Beta stays on. `1.0.8beta2` is the same post-release build as
 * `1.0.8-2`, and both are newer than plain `1.0.8`. `1.0.8beta3` is
 * newer than `1.0.8-2`. A word prerelease such as `1.0.8-beta.2` stays
 * older than `1.0.8`.
 * Turning Beta off does not offer that plain stable tag when the
 * installed post-release build is newer (`1.0.8-6`, `1.0.8beta6`).
 * A newer stable core such as `1.0.9` is still offered. A word
 * prerelease such as `1.0.8-beta.2` stays older than `1.0.8`, so that
 * stable release can still be installed. Beta manifests are
 * `releases/download/<tag>/latest.json`, never `releases/latest`.
 */
export function chooseUpdateOffer(input: {
  currentVersion: string;
  stable: { version: string; notes?: string } | null;
  betas: readonly ReleaseCandidate[];
  /** Default false. Join prerelease / Beta turns this on. */
  allowPrerelease?: boolean;
}): UpdateOffer {
  const allowPrerelease = input.allowPrerelease === true;
  const stable =
    input.stable &&
    (allowPrerelease ||
      !isPrereleaseVersion(releaseVersion(input.stable.version)))
      ? input.stable
      : null;
  const betas = allowPrerelease ? input.betas : [];
  const current = parseSemver(input.currentVersion);
  const stableVersion = stable ? releaseVersion(stable.version) : null;
  const stableParsed = stableVersion ? parseSemver(stableVersion) : null;
  const stableIsBeta = stableVersion
    ? isPrereleaseVersion(stableVersion)
    : false;

  if (!current) {
    if (stable && stableIsBeta && stableVersion) {
      const manifestUrl = prereleaseManifestForVersion(stableVersion);
      if (manifestUrl) {
        return {
          action: "confirm",
          version: stableVersion,
          notes: stable.notes,
          manifestUrl,
        };
      }
    }
    if (stable && stableVersion && !stableIsBeta) {
      return {
        action: "download",
        version: stableVersion,
        notes: stable.notes,
      };
    }
    return { action: "none" };
  }

  let bestBeta: (ReleaseCandidate & { parsed: SemVer }) | null = null;
  for (const beta of betas) {
    if (beta.draft) continue;
    if (!isBetaRelease(beta)) continue;
    const parsed = parseSemver(beta.version);
    if (!parsed || compareSemver(parsed, current) <= 0) continue;
    if (!beta.manifestUrl || !isAllowedBetaManifestUrl(beta.manifestUrl)) {
      continue;
    }
    if (!bestBeta || compareSemver(parsed, bestBeta.parsed) > 0) {
      bestBeta = { ...beta, parsed };
    }
  }

  const stableBetaManifest =
    stable &&
    stableIsBeta &&
    stableParsed &&
    stableVersion &&
    compareSemver(stableParsed, current) > 0
      ? prereleaseManifestForVersion(stableVersion)
      : null;

  if (
    stable &&
    stableIsBeta &&
    stableParsed &&
    stableVersion &&
    stableBetaManifest &&
    (!bestBeta || compareSemver(stableParsed, bestBeta.parsed) >= 0)
  ) {
    return {
      action: "confirm",
      version: stableVersion,
      notes: stable.notes,
      manifestUrl: stableBetaManifest,
    };
  }

  if (
    bestBeta &&
    (!stableParsed ||
      stableIsBeta ||
      compareSemver(bestBeta.parsed, stableParsed) > 0)
  ) {
    return {
      action: "confirm",
      version: bestBeta.version,
      notes: bestBeta.notes,
      manifestUrl: bestBeta.manifestUrl ?? null,
    };
  }

  if (
    stable &&
    stableVersion &&
    !stableIsBeta &&
    stableParsed &&
    compareSemver(stableParsed, current) > 0
  ) {
    return {
      action: "download",
      version: stableVersion,
      notes: stable.notes,
    };
  }

  if (stable && stableVersion && !stableParsed && !stableIsBeta) {
    return {
      action: "download",
      version: stableVersion,
      notes: stable.notes,
    };
  }

  return { action: "none" };
}
