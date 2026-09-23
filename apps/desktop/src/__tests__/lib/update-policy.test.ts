import { describe, expect, it } from "vitest";
import {
  classifyUpdateError,
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
  });
});
