import { describe, expect, it } from "vitest";
import {
  canonicalUpdaterAttestation,
  planUpdaterRelease,
  type ArtifactFile,
} from "@/lib/updater-manifest";

const SIG =
  "untrusted comment: signature from tauri secret key\nRWTTESTSIGNATURE=\n";
const SHA =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function file(path: string, text?: string, sha256 = SHA): ArtifactFile {
  return text === undefined ? { path, sha256 } : { path, text, sha256 };
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
    expect(result.plan.manifest.channel).toBe("stable");
    expect(result.plan.manifest.tag).toBe("v1.0.5");
    expect(result.plan.manifest.platforms["windows-x86_64-nsis"]).toEqual({
      signature: SIG.trim(),
      url: "https://github.com/boshuaiYu/LocalPrism/releases/download/v1.0.5/LocalPrism-Windows-setup.exe",
      digest: `sha256:${SHA}`,
    });
    expect(result.plan.attestation).toContain("localprism-updater-manifest-v1");
    expect(result.plan.attestation).toContain("channel=stable");
    expect(result.plan.attestation).toContain(
      `windows-x86_64-nsis digest=sha256:${SHA} url=https://github.com/boshuaiYu/LocalPrism/releases/download/v1.0.5/LocalPrism-Windows-setup.exe`,
    );
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

  it("fails when a signed updater binary has no digest", () => {
    const result = planUpdaterRelease({
      files: [
        { path: "desktop-linux/appimage/LocalPrism.AppImage" },
        file("desktop-linux/appimage/LocalPrism.AppImage.sig", SIG),
      ],
      tag: "v1.0.5",
      repository: "boshuaiYu/LocalPrism",
      pubDate: "2026-09-23T00:00:00Z",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("without a SHA-256 digest");
  });

  it("emits the same attestation bytes as the Rust binder", () => {
    const attestation = canonicalUpdaterAttestation({
      version: "1.0.8",
      channel: "stable",
      tag: "v1.0.8",
      platforms: {
        "linux-x86_64": {
          digest:
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          url: "https://github.com/boshuaiYu/LocalPrism/releases/download/v1.0.8/LocalPrism-Linux.AppImage",
        },
        "darwin-aarch64": {
          digest:
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          url: "https://github.com/boshuaiYu/LocalPrism/releases/download/v1.0.8/LocalPrism-macOS.app.tar.gz",
        },
      },
    });
    expect(attestation).toBe(`localprism-updater-manifest-v1
channel=stable
tag=v1.0.8
version=1.0.8
darwin-aarch64 digest=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa url=https://github.com/boshuaiYu/LocalPrism/releases/download/v1.0.8/LocalPrism-macOS.app.tar.gz
linux-x86_64 digest=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb url=https://github.com/boshuaiYu/LocalPrism/releases/download/v1.0.8/LocalPrism-Linux.AppImage
`);
  });

  it("marks compact and hyphenated versions as the beta channel", () => {
    const compact = planUpdaterRelease({
      files: signedTree(),
      tag: "v1.0.8beta3",
      repository: "boshuaiYu/LocalPrism",
      pubDate: "2026-09-23T00:00:00Z",
    });
    expect(compact.ok).toBe(true);
    if (!compact.ok) return;
    expect(compact.plan.manifest.channel).toBe("beta");
    expect(compact.plan.attestation).toContain("version=1.0.8beta3");
  });
});
