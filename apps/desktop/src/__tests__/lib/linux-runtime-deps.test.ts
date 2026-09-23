import { describe, expect, it } from "vitest";
import { LINUX_RUNTIME_DEPS, isLinuxDesktop } from "@/lib/linux-runtime-deps";

describe("linux runtime packages", () => {
  it("names the WebKitGTK 4.1 packages the deb and rpm builds need", () => {
    expect(LINUX_RUNTIME_DEPS.debianPackages).toContain("libwebkit2gtk-4.1-0");
    expect(LINUX_RUNTIME_DEPS.debianPackages).toContain("libgtk-3-0");
    expect(LINUX_RUNTIME_DEPS.debianGtkAlternative).toBe("libgtk-3-0t64");
    expect(LINUX_RUNTIME_DEPS.debianInstall).toContain("libwebkit2gtk-4.1-0");
    expect(LINUX_RUNTIME_DEPS.rpmPackages).toEqual(["webkit2gtk4.1", "gtk3"]);
    expect(LINUX_RUNTIME_DEPS.summary).toMatch(/dpkg -i/);
    expect(LINUX_RUNTIME_DEPS.summary).toMatch(/AppImage/);
  });

  it("treats desktop Linux separately from Android", () => {
    expect(isLinuxDesktop("Mozilla/5.0 (X11; Linux x86_64)")).toBe(true);
    expect(isLinuxDesktop("Mozilla/5.0 (Linux; Android 14)")).toBe(false);
    expect(isLinuxDesktop("Mozilla/5.0 (Macintosh; Intel Mac OS X)")).toBe(
      false,
    );
  });
});
