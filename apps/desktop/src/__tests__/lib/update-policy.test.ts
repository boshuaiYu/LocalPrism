import { describe, expect, it } from "vitest";
import {
  betaCandidatesFromGithub,
  betaManifestUrlForTag,
  chooseUpdateOffer,
  classifyUpdateError,
  compareSemver,
  isAllowedBetaManifestUrl,
  isPrereleaseVersion,
  parseSemver,
  STABLE_UPDATER_ENDPOINT,
  updateApplyMode,
  updateBannerVisible,
} from "@/lib/update-policy";

describe("update apply mode", () => {
  it("keeps deb and rpm on the manual package path", () => {
    expect(updateApplyMode("linux-package")).toBe("manual-package");
  });

  it("downloads the AppImage, macOS, and Windows builds in the background", () => {
    expect(updateApplyMode("appimage")).toBe("background-restart");
    expect(updateApplyMode("native")).toBe("background-restart");
    expect(updateApplyMode(undefined)).toBe("background-restart");
  });

  it("keeps a ready update visible until the user dismisses it", () => {
    expect(updateBannerVisible({ state: "ready" }, false)).toBe(true);
    expect(updateBannerVisible({ state: "ready" }, true)).toBe(false);
    expect(updateBannerVisible({ state: "downloading" }, true)).toBe(true);
    expect(
      updateBannerVisible({ state: "error", explicit: false }, false),
    ).toBe(false);
    expect(updateBannerVisible({ state: "error", explicit: true }, false)).toBe(
      true,
    );
  });

  it("treats an empty updater manifest as a missing platform, not a generic failure", () => {
    const raw =
      'None of the fallback platforms ["windows-x86_64-nsis", "windows-x86_64"] were found in the response platforms object';
    expect(classifyUpdateError(raw)).toBe("missing-platform");
    expect(
      classifyUpdateError(
        'None of the fallback platforms ["linux-x86_64"] were found in the response platforms object',
      ),
    ).toBe("missing-platform");
    expect(classifyUpdateError("network down")).toBe("generic");
    expect(
      updateBannerVisible(
        { state: "error", explicit: false, message: raw },
        false,
      ),
    ).toBe(true);
    expect(updateBannerVisible({ state: "confirm" }, false)).toBe(true);
    expect(updateBannerVisible({ state: "confirm" }, true)).toBe(false);
  });
});

describe("beta update detection", () => {
  it("treats hyphenated semver identifiers as prereleases", () => {
    expect(isPrereleaseVersion("1.0.8-1")).toBe(true);
    expect(isPrereleaseVersion("v1.0.8-beta.1")).toBe(true);
    expect(isPrereleaseVersion("1.0.8")).toBe(false);
    expect(isPrereleaseVersion("1.0.8beta1")).toBe(false);
    const beta = parseSemver("1.0.8-1");
    const stable = parseSemver("1.0.8");
    const olderBeta = parseSemver("1.0.8-1");
    const newerBeta = parseSemver("1.0.8-2");
    const betaWord = parseSemver("1.0.8-beta.2");
    const betaWordNext = parseSemver("1.0.8-beta.11");
    if (
      !beta ||
      !stable ||
      !olderBeta ||
      !newerBeta ||
      !betaWord ||
      !betaWordNext
    ) {
      throw new Error("semver fixtures failed to parse");
    }
    expect(compareSemver(stable, beta)).toBeGreaterThan(0);
    expect(compareSemver(newerBeta, olderBeta)).toBeGreaterThan(0);
    expect(compareSemver(betaWordNext, betaWord)).toBeGreaterThan(0);
    expect(
      compareSemver(parseSemver("1.0.8-1")!, parseSemver("1.0.7")!),
    ).toBeGreaterThan(0);
  });

  it("does not use releases/latest as a beta manifest", () => {
    expect(isAllowedBetaManifestUrl(STABLE_UPDATER_ENDPOINT)).toBe(false);
    expect(
      isAllowedBetaManifestUrl(
        "https://github.com/boshuaiYu/LocalPrism/releases/download/latest/latest.json",
      ),
    ).toBe(false);
    expect(betaManifestUrlForTag("v1.0.8-1")).toBe(
      "https://github.com/boshuaiYu/LocalPrism/releases/download/v1.0.8-1/latest.json",
    );
    expect(betaManifestUrlForTag("latest")).toBeNull();
  });

  it("asks before a prerelease and still auto-downloads a newer stable", () => {
    const betas = betaCandidatesFromGithub([
      {
        tag_name: "v1.0.8-1",
        prerelease: true,
        draft: false,
        body: "beta notes",
        assets: [
          {
            name: "latest.json",
            browser_download_url: STABLE_UPDATER_ENDPOINT,
          },
        ],
      },
      {
        tag_name: "v1.0.9-1",
        prerelease: false,
        draft: false,
        body: "numeric prerelease",
      },
    ]);
    expect(betas.map((beta) => beta.version)).toEqual(["1.0.8-1", "1.0.9-1"]);
    expect(betas[0]?.manifestUrl).toBe(
      "https://github.com/boshuaiYu/LocalPrism/releases/download/v1.0.8-1/latest.json",
    );

    expect(
      chooseUpdateOffer({
        currentVersion: "1.0.7",
        stable: null,
        betas,
      }),
    ).toMatchObject({
      action: "confirm",
      version: "1.0.9-1",
      manifestUrl:
        "https://github.com/boshuaiYu/LocalPrism/releases/download/v1.0.9-1/latest.json",
    });

    expect(
      chooseUpdateOffer({
        currentVersion: "1.0.7",
        stable: { version: "1.0.8" },
        betas: betas.filter((beta) => beta.version === "1.0.8-1"),
      }).action,
    ).toBe("download");

    expect(
      chooseUpdateOffer({
        currentVersion: "1.0.7",
        stable: { version: "1.0.8-1" },
        betas: [],
      }),
    ).toMatchObject({
      action: "confirm",
      manifestUrl: null,
      version: "1.0.8-1",
    });

    expect(
      chooseUpdateOffer({
        currentVersion: "1.0.8-1",
        stable: null,
        betas,
      }).action,
    ).toBe("confirm");
  });

  it("ignores drafts and github prerelease flags that are not newer", () => {
    const betas = betaCandidatesFromGithub([
      { tag_name: "v1.0.6-1", prerelease: true, draft: false },
      { tag_name: "v1.2.0-1", prerelease: true, draft: true },
      { tag_name: "nightly", prerelease: true, draft: false },
    ]);
    expect(
      chooseUpdateOffer({
        currentVersion: "1.0.7",
        stable: { version: "1.0.7" },
        betas,
      }).action,
    ).toBe("none");
  });
});
