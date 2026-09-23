import { describe, expect, it } from "vitest";
import { planUpdaterRelease, type ArtifactFile } from "@/lib/updater-manifest";

const SIG =
  "untrusted comment: signature from tauri secret key\nRWTTESTSIGNATURE=\n";

function file(path: string, text?: string): ArtifactFile {
  return text === undefined ? { path } : { path, text };
}

function signedTree(): ArtifactFile[] {
  return [
    file("desktop-windows/nsis/LocalPrism_1.0.5_x64-setup.exe"),
    file("desktop-windows/nsis/LocalPrism_1.0.5_x64-setup.exe.sig", SIG),
    file("desktop-windows/msi/LocalPrism_1.0.5_x64_en-US.msi"),
    file("desktop-macos/macos/LocalPrism.app.tar.gz"),
    file("desktop-macos/macos/LocalPrism.app.tar.gz.sig", `${SIG}arm`),
    file("desktop-macos/dmg/LocalPrism_1.0.5_aarch64.dmg"),
    file("desktop-macos-intel/macos/LocalPrism.app.tar.gz"),
    file("desktop-macos-intel/macos/LocalPrism.app.tar.gz.sig", `${SIG}intel`),
    file("desktop-linux/appimage/LocalPrism_1.0.5_amd64.AppImage"),
    file(
      "desktop-linux/appimage/LocalPrism_1.0.5_amd64.AppImage.sig",
      `${SIG}linux`,
    ),
    file("desktop-linux/deb/LocalPrism_1.0.5_amd64.deb"),
    file("desktop-linux/rpm/LocalPrism-1.0.5-1.x86_64.rpm"),
  ];
}

describe("planUpdaterRelease", () => {
  it("maps signed artifacts to the updater platform keys and stable urls", () => {
    const result = planUpdaterRelease({
      files: signedTree(),
      tag: "v1.0.5",
      repository: "boshuaiYu/LocalPrism",
      pubDate: "2026-09-23T00:00:00Z",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.manifest.version).toBe("1.0.5");
    expect(result.plan.manifest.platforms["windows-x86_64-nsis"]).toEqual({
      signature: SIG.trim(),
      url: "https://github.com/boshuaiYu/LocalPrism/releases/download/v1.0.5/LocalPrism-Windows-setup.exe",
    });
    expect(result.plan.manifest.platforms["windows-x86_64"]).toEqual(
      result.plan.manifest.platforms["windows-x86_64-nsis"],
    );
    expect(result.plan.manifest.platforms["darwin-aarch64"]?.url).toContain(
      "LocalPrism-macOS.app.tar.gz",
    );
    expect(result.plan.manifest.platforms["darwin-x86_64"]?.url).toContain(
      "LocalPrism-macOS-Intel.app.tar.gz",
    );
    expect(result.plan.manifest.platforms["linux-x86_64"]?.url).toContain(
      "LocalPrism-Linux.AppImage",
    );
    expect(
      result.plan.manifest.platforms["darwin-aarch64"]?.signature,
    ).toContain("arm");
    const names = result.plan.copies.map((copy) => copy.uploadName);
    expect(names).toEqual(
      expect.arrayContaining([
        "LocalPrism-Windows-setup.exe",
        "LocalPrism-Windows-setup.exe.sig",
        "LocalPrism-macOS.app.tar.gz",
        "LocalPrism-macOS.app.tar.gz.sig",
        "LocalPrism-macOS-Intel.app.tar.gz.sig",
        "LocalPrism-Linux.AppImage.sig",
        "LocalPrism-macOS.dmg",
        "LocalPrism-Windows.msi",
        "LocalPrism-Linux.deb",
        "LocalPrism-Linux.rpm",
      ]),
    );
  });

  it("fails instead of publishing an empty platforms object", () => {
    const result = planUpdaterRelease({
      files: [file("desktop-linux/deb/LocalPrism.deb")],
      tag: "v1.0.5",
      repository: "boshuaiYu/LocalPrism",
      pubDate: "2026-09-23T00:00:00Z",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("TAURI_SIGNING_PRIVATE_KEY");
    expect(result.error).toContain("empty");
  });

  it("fails when an updater binary exists without a signature", () => {
    const result = planUpdaterRelease({
      files: [
        file("desktop-windows/nsis/LocalPrism-setup.exe"),
        file("desktop-linux/appimage/LocalPrism.AppImage"),
        file("desktop-linux/appimage/LocalPrism.AppImage.sig", SIG),
      ],
      tag: "v1.0.5",
      repository: "boshuaiYu/LocalPrism",
      pubDate: "2026-09-23T00:00:00Z",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("windows-x86_64-nsis");
    expect(result.error).toContain("without a signature");
  });
});
