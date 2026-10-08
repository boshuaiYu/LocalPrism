import { describe, expect, it } from "vitest";
import {
  betaCandidatesFromGithub,
  betaManifestUrlForTag,
  chooseUpdateOffer,
  classifyUpdateError,
  compareSemver,
  GITHUB_RELEASES_API,
  installCoversLoadedBetas,
  isAllowedBetaManifestUrl,
  isBetaRelease,
  isNewerVersion,
  isPrereleaseVersion,
  parseSemver,
  STABLE_UPDATER_ENDPOINT,
  stableCheckFailureAction,
  updateApplyMode,
  updateBannerVisible,
} from "@/lib/update-policy";

describe("update apply mode", () => {
  it("keeps deb and rpm on the manual package path", () => {
    expect(updateApplyMode("linux-package")).toBe("manual-package");
  });

  it("restarts into the AppImage, macOS, and Windows builds", () => {
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
    expect(isPrereleaseVersion("1.0.8beta1")).toBe(true);
    expect(isPrereleaseVersion("v1.0.8beta3")).toBe(true);
    expect(isPrereleaseVersion("1.0.8beta")).toBe(false);
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
    expect(compareSemver(beta, stable)).toBeGreaterThan(0);
    expect(compareSemver(newerBeta, olderBeta)).toBeGreaterThan(0);
    expect(compareSemver(betaWordNext, betaWord)).toBeGreaterThan(0);
    expect(compareSemver(stable, betaWord)).toBeGreaterThan(0);
    expect(
      compareSemver(parseSemver("1.0.8-1")!, parseSemver("1.0.7")!),
    ).toBeGreaterThan(0);
    const compactOlder = parseSemver("1.0.8beta2");
    const compactNewer = parseSemver("v1.0.8beta3");
    if (!compactOlder || !compactNewer) {
      throw new Error("compact beta fixtures failed to parse");
    }
    expect(compareSemver(compactNewer, compactOlder)).toBeGreaterThan(0);
    expect(compareSemver(compactOlder, stable)).toBeGreaterThan(0);
    expect(compareSemver(compactOlder, newerBeta)).toBe(0);
    expect(compareSemver(parseSemver("1.0.8beta1")!, newerBeta)).toBeLessThan(
      0,
    );
    expect(compareSemver(compactNewer, newerBeta)).toBeGreaterThan(0);
    expect(compareSemver(newerBeta, stable)).toBeGreaterThan(0);
    expect(compareSemver(stable, newerBeta)).toBeLessThan(0);
    expect(compareSemver(parseSemver("1.0.9")!, compactNewer)).toBeGreaterThan(
      0,
    );
  });

  it("parses a two-digit beta and keeps installer version fields numeric", () => {
    const beta9 = parseSemver("1.0.8-9");
    const beta10 = parseSemver("1.0.8-10");
    const compact10 = parseSemver("1.0.8beta10");
    const tagged10 = parseSemver("v1.0.8beta10");
    if (!beta9 || !beta10 || !compact10 || !tagged10) {
      throw new Error("two-digit beta fixtures failed to parse");
    }
    expect(compact10).toEqual({
      major: 1,
      minor: 0,
      patch: 8,
      prerelease: [],
      compactBeta: 10,
    });
    expect(tagged10.compactBeta).toBe(10);
    expect(beta10.prerelease).toEqual(["10"]);
    expect(compareSemver(beta10, beta9)).toBeGreaterThan(0);
    expect(compareSemver(compact10, beta10)).toBe(0);
    expect(compareSemver(compact10, beta9)).toBeGreaterThan(0);
    expect(isNewerVersion("1.0.8-10", "1.0.8-9")).toBe(true);
    expect(isNewerVersion("1.0.8beta10", "1.0.8-9")).toBe(true);
    expect(isNewerVersion("1.0.8beta9", "1.0.8-10")).toBe(false);
    expect(isNewerVersion("1.0.8beta10", "1.0.8-10")).toBe(false);

    for (const parsed of [beta10, compact10]) {
      const build =
        parsed.compactBeta ??
        (parsed.prerelease.length === 1 &&
        /^\d+$/.test(parsed.prerelease[0] ?? "")
          ? Number(parsed.prerelease[0])
          : null);
      expect(build).toBe(10);
      const fields = [parsed.major, parsed.minor, parsed.patch, build];
      expect(fields.every((field) => Number.isInteger(field))).toBe(true);
      expect(parsed.major).toBeLessThanOrEqual(255);
      expect(parsed.minor).toBeLessThanOrEqual(255);
      expect(parsed.patch).toBeLessThanOrEqual(65535);
      expect(build).toBeLessThanOrEqual(65535);
      expect(fields.join(".")).toBe("1.0.8.10");
    }
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
        allowPrerelease: true,
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
        allowPrerelease: true,
      }),
    ).toMatchObject({
      action: "confirm",
      version: "1.0.8-1",
    });

    expect(
      chooseUpdateOffer({
        currentVersion: "1.0.7",
        stable: { version: "1.0.9" },
        betas: betas.filter((beta) => beta.version === "1.0.8-1"),
        allowPrerelease: true,
      }),
    ).toMatchObject({ action: "download", version: "1.0.9" });

    expect(
      chooseUpdateOffer({
        currentVersion: "1.0.7",
        stable: { version: "1.0.8-1" },
        betas: [],
        allowPrerelease: true,
      }),
    ).toMatchObject({
      action: "confirm",
      manifestUrl:
        "https://github.com/boshuaiYu/LocalPrism/releases/download/v1.0.8-1/latest.json",
      version: "1.0.8-1",
    });

    expect(
      chooseUpdateOffer({
        currentVersion: "1.0.8-1",
        stable: null,
        betas,
        allowPrerelease: true,
      }).action,
    ).toBe("confirm");
  });

  it("keeps prereleases off the stable channel until Beta is joined", () => {
    const betas = betaCandidatesFromGithub([
      { tag_name: "v1.0.8beta2", prerelease: true, draft: false },
      { tag_name: "v1.0.8beta3", prerelease: false, draft: false },
    ]);
    expect(betas.map((beta) => beta.version)).toEqual([
      "1.0.8beta2",
      "1.0.8beta3",
    ]);
    expect(betas[1]?.manifestUrl).toBe(
      "https://github.com/boshuaiYu/LocalPrism/releases/download/v1.0.8beta3/latest.json",
    );

    expect(
      chooseUpdateOffer({
        currentVersion: "1.0.8",
        stable: { version: "1.0.8" },
        betas,
        allowPrerelease: false,
      }).action,
    ).toBe("none");

    expect(
      chooseUpdateOffer({
        currentVersion: "1.0.7",
        stable: { version: "1.0.8beta3" },
        betas,
        allowPrerelease: false,
      }).action,
    ).toBe("none");

    expect(
      chooseUpdateOffer({
        currentVersion: "1.0.7",
        stable: { version: "1.0.8" },
        betas,
        allowPrerelease: false,
      }),
    ).toMatchObject({ action: "download", version: "1.0.8" });

    expect(
      chooseUpdateOffer({
        currentVersion: "1.0.8-2",
        stable: { version: "1.0.8" },
        betas: [],
        allowPrerelease: false,
      }),
    ).toEqual({ action: "none" });

    expect(
      chooseUpdateOffer({
        currentVersion: "1.0.8-4",
        stable: { version: "1.0.8", notes: "stable" },
        betas: [],
        allowPrerelease: false,
      }),
    ).toEqual({ action: "none" });

    expect(
      chooseUpdateOffer({
        currentVersion: "1.0.8beta4",
        stable: { version: "1.0.8" },
        betas: [],
        allowPrerelease: false,
      }),
    ).toEqual({ action: "none" });

    expect(
      chooseUpdateOffer({
        currentVersion: "1.0.8-6",
        stable: { version: "1.0.8" },
        betas: [],
        allowPrerelease: false,
      }),
    ).toEqual({ action: "none" });

    expect(
      chooseUpdateOffer({
        currentVersion: "1.0.8-6",
        stable: { version: "1.0.9", notes: "next stable" },
        betas: [],
        allowPrerelease: false,
      }),
    ).toMatchObject({
      action: "download",
      version: "1.0.9",
      notes: "next stable",
    });

    expect(
      chooseUpdateOffer({
        currentVersion: "1.0.8-beta.2",
        stable: { version: "1.0.8" },
        betas: [],
        allowPrerelease: false,
      }),
    ).toMatchObject({ action: "download", version: "1.0.8" });

    expect(
      chooseUpdateOffer({
        currentVersion: "1.0.8-4",
        stable: { version: "1.0.8" },
        betas: [],
        allowPrerelease: true,
      }).action,
    ).toBe("none");

    expect(
      chooseUpdateOffer({
        currentVersion: "1.0.9-1",
        stable: { version: "1.0.8" },
        betas: [],
        allowPrerelease: false,
      }).action,
    ).toBe("none");

    expect(
      chooseUpdateOffer({
        currentVersion: "1.0.8-2",
        stable: { version: "1.0.8" },
        betas,
        allowPrerelease: true,
      }),
    ).toMatchObject({
      action: "confirm",
      version: "1.0.8beta3",
    });

    expect(
      chooseUpdateOffer({
        currentVersion: "1.0.8-2",
        stable: null,
        betas: betas.filter((beta) => beta.version === "1.0.8beta2"),
        allowPrerelease: true,
      }).action,
    ).toBe("none");

    expect(
      chooseUpdateOffer({
        currentVersion: "1.0.8",
        stable: { version: "1.0.8" },
        betas,
        allowPrerelease: true,
      }),
    ).toMatchObject({
      action: "confirm",
      version: "1.0.8beta3",
      manifestUrl:
        "https://github.com/boshuaiYu/LocalPrism/releases/download/v1.0.8beta3/latest.json",
    });
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
        allowPrerelease: true,
      }).action,
    ).toBe("none");
  });

  it("ignores a plain prerelease and does not downgrade 1.0.8-9", () => {
    expect(isBetaRelease({ prerelease: true, version: "1.9.0" })).toBe(false);
    expect(isBetaRelease({ prerelease: true, version: "v1.9.0" })).toBe(false);
    expect(isBetaRelease({ prerelease: true, version: "1.0.8beta9" })).toBe(
      true,
    );
    expect(isBetaRelease({ prerelease: true, version: "1.0.8-9" })).toBe(true);
    expect(isBetaRelease({ prerelease: true, version: "1.0.8-beta.9" })).toBe(
      true,
    );

    const mistaken = betaCandidatesFromGithub([
      {
        tag_name: "v1.9.0",
        prerelease: true,
        draft: false,
        body: "mistaken stable",
      },
    ]);
    expect(mistaken).toEqual([]);
    expect(
      chooseUpdateOffer({
        currentVersion: "1.0.8-9",
        stable: { version: "1.0.8" },
        betas: mistaken,
        allowPrerelease: true,
      }),
    ).toEqual({ action: "none" });

    const sameBuild = betaCandidatesFromGithub([
      { tag_name: "v1.0.8beta9", prerelease: true, draft: false },
    ]);
    expect(sameBuild.map((beta) => beta.version)).toEqual(["1.0.8beta9"]);
    expect(
      chooseUpdateOffer({
        currentVersion: "1.0.8-9",
        stable: { version: "1.0.8" },
        betas: sameBuild,
        allowPrerelease: true,
      }),
    ).toEqual({ action: "none" });

    const newerBeta = betaCandidatesFromGithub([
      { tag_name: "v1.0.8beta10", prerelease: true, draft: false },
    ]);
    expect(
      chooseUpdateOffer({
        currentVersion: "1.0.8-9",
        stable: { version: "1.0.8" },
        betas: newerBeta,
        allowPrerelease: true,
      }),
    ).toMatchObject({
      action: "confirm",
      version: "1.0.8beta10",
      manifestUrl:
        "https://github.com/boshuaiYu/LocalPrism/releases/download/v1.0.8beta10/latest.json",
    });

    expect(
      chooseUpdateOffer({
        currentVersion: "1.0.8-9",
        stable: { version: "1.0.8" },
        betas: newerBeta,
        allowPrerelease: false,
      }),
    ).toEqual({ action: "none" });
  });
});

describe("update channel offers", () => {
  const betas = betaCandidatesFromGithub([
    {
      tag_name: "v1.2.0beta1",
      prerelease: true,
      draft: false,
      body: "beta notes",
    },
  ]);

  it("offers only a newer stable release when Beta is off", () => {
    expect(
      chooseUpdateOffer({
        currentVersion: "1.0.0",
        stable: { version: "1.1.0", notes: "stable notes" },
        betas,
        allowPrerelease: false,
      }),
    ).toEqual({
      action: "download",
      version: "1.1.0",
      notes: "stable notes",
    });
    expect(
      chooseUpdateOffer({
        currentVersion: "1.0.0",
        stable: null,
        betas,
        allowPrerelease: false,
      }),
    ).toEqual({ action: "none" });
    expect(
      chooseUpdateOffer({
        currentVersion: "1.1.0",
        stable: { version: "1.2.0beta1", notes: "hidden beta" },
        betas,
        allowPrerelease: false,
      }),
    ).toEqual({ action: "none" });
  });

  it("offers the newer of stable and beta when Beta is on", () => {
    expect(
      chooseUpdateOffer({
        currentVersion: "1.0.0",
        stable: { version: "1.1.0", notes: "stable notes" },
        betas,
        allowPrerelease: true,
      }),
    ).toMatchObject({
      action: "confirm",
      version: "1.2.0beta1",
      notes: "beta notes",
    });
    expect(
      chooseUpdateOffer({
        currentVersion: "1.0.0",
        stable: { version: "1.3.0", notes: "newer stable" },
        betas,
        allowPrerelease: true,
      }),
    ).toEqual({
      action: "download",
      version: "1.3.0",
      notes: "newer stable",
    });
  });
});

describe("installCoversLoadedBetas", () => {
  const loaded = betaCandidatesFromGithub([
    { tag_name: "v1.0.8beta11", prerelease: true, draft: false },
    { tag_name: "v1.0.8beta12", prerelease: true, draft: false },
  ]);

  it("is true when every comparable beta is the same build or older", () => {
    expect(installCoversLoadedBetas("1.0.8-12", loaded)).toBe(true);
    expect(installCoversLoadedBetas("1.0.8beta12", loaded)).toBe(true);
  });

  it("is false when a loaded beta is newer, or nothing comparable was loaded", () => {
    expect(installCoversLoadedBetas("1.0.8-11", loaded)).toBe(false);
    expect(installCoversLoadedBetas("1.0.8-12", [])).toBe(false);
    expect(installCoversLoadedBetas("", loaded)).toBe(false);
    expect(
      installCoversLoadedBetas(
        "1.0.8-12",
        betaCandidatesFromGithub([
          { tag_name: "v1.0.8beta13", prerelease: true, draft: true },
        ]),
      ),
    ).toBe(false);
    expect(
      installCoversLoadedBetas("1.0.8-12", [
        {
          version: "1.0.8beta12",
          prerelease: true,
          manifestUrl: "https://example.invalid/latest.json",
        },
      ]),
    ).toBe(false);
  });
});

describe("stableCheckFailureAction", () => {
  it("still confirms v1.0.9beta1 when that release is in the loaded list", () => {
    const betas = betaCandidatesFromGithub([
      { tag_name: "v1.0.9beta1", prerelease: true, draft: false },
    ]);
    expect(
      chooseUpdateOffer({
        currentVersion: "1.0.9",
        stable: { version: "1.0.9" },
        betas,
        allowPrerelease: true,
      }),
    ).toMatchObject({
      action: "confirm",
      version: "1.0.9beta1",
      manifestUrl:
        "https://github.com/boshuaiYu/LocalPrism/releases/download/v1.0.9beta1/latest.json",
    });
  });

  const missingPlatform =
    'None of the fallback platforms ["windows-x86_64-nsis", "windows-x86_64"] were found in the response platforms object';
  const loadedCurrent = betaCandidatesFromGithub([
    { tag_name: "v1.0.9beta1", prerelease: true, draft: false },
  ]);

  it("keeps the GitHub releases list on the native discovery endpoint", () => {
    expect(GITHUB_RELEASES_API).toBe(
      "https://api.github.com/repos/boshuaiYu/LocalPrism/releases?per_page=30",
    );
  });

  it("does not surface a stable check failure when Beta is on and the list is empty or failed", () => {
    expect(
      stableCheckFailureAction({
        allowPrerelease: true,
        explicit: true,
        errorMessage: "signature mismatch",
        betaFeedLoaded: true,
        currentVersion: "1.0.9",
        betas: [],
      }),
    ).toBe("idle");
    expect(
      stableCheckFailureAction({
        allowPrerelease: true,
        explicit: true,
        errorMessage: "signature mismatch",
        betaFeedLoaded: false,
        currentVersion: "1.0.9",
        betas: loadedCurrent,
      }),
    ).toBe("idle");
    expect(
      stableCheckFailureAction({
        allowPrerelease: true,
        explicit: false,
        errorMessage: "signature mismatch",
        betaFeedLoaded: false,
        currentVersion: "1.0.9",
        betas: [],
      }),
    ).toBe("idle");
  });

  it("treats a loaded list that already covers the install as current", () => {
    expect(
      stableCheckFailureAction({
        allowPrerelease: true,
        explicit: true,
        errorMessage: "signature mismatch",
        betaFeedLoaded: true,
        currentVersion: "1.0.9-1",
        betas: loadedCurrent,
      }),
    ).toBe("up-to-date");
    expect(
      stableCheckFailureAction({
        allowPrerelease: true,
        explicit: false,
        errorMessage: "signature mismatch",
        betaFeedLoaded: true,
        currentVersion: "1.0.9beta1",
        betas: loadedCurrent,
      }),
    ).toBe("idle");
  });

  it("still surfaces the stable error when Beta is off", () => {
    expect(
      stableCheckFailureAction({
        allowPrerelease: false,
        explicit: true,
        errorMessage: "signature mismatch",
        betaFeedLoaded: false,
        currentVersion: "1.0.9",
        betas: [],
      }),
    ).toBe("surface-error");
  });

  it("still surfaces a missing-platform error when Beta is on", () => {
    expect(
      stableCheckFailureAction({
        allowPrerelease: true,
        explicit: true,
        errorMessage: missingPlatform,
        betaFeedLoaded: false,
        currentVersion: "1.0.9",
        betas: [],
      }),
    ).toBe("surface-error");
  });
});
