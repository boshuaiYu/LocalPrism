import { describe, expect, it } from "vitest";
import { updateApplyMode, updateBannerVisible } from "@/lib/update-policy";

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
});
