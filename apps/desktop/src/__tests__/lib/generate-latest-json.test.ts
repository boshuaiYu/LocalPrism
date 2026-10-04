import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { planUpdaterRelease } from "@/lib/updater-manifest";
import { writeSignedLatestManifest } from "../../../scripts/generate-latest-json.ts";

const script = resolve(__dirname, "../../../scripts/generate-latest-json.ts");

function writeLinuxArtifacts(root: string): {
  artifacts: string;
  upload: string;
} {
  const artifacts = join(root, "artifacts");
  const upload = join(root, "upload");
  mkdirSync(join(artifacts, "desktop-linux", "appimage"), { recursive: true });
  writeFileSync(
    join(artifacts, "desktop-linux", "appimage", "LocalPrism.AppImage"),
    "appimage-bytes",
  );
  writeFileSync(
    join(artifacts, "desktop-linux", "appimage", "LocalPrism.AppImage.sig"),
    "untrusted comment: signature from tauri secret key\nRWTTEST=\n",
  );
  return { artifacts, upload };
}

describe("generate-latest-json", () => {
  it("does not write latest.json when the sign command fails", () => {
    const root = mkdtempSync(join(tmpdir(), "localprism-latest-"));
    try {
      const { artifacts, upload } = writeLinuxArtifacts(root);
      const bin = join(root, "bin");
      mkdirSync(bin, { recursive: true });
      const tauri = join(bin, "tauri");
      writeFileSync(
        tauri,
        "#!/bin/sh\necho 'tauri signer sign failed on purpose' >&2\nexit 1\n",
      );
      chmodSync(tauri, 0o755);

      const result = spawnSync(
        process.execPath,
        [
          "--experimental-strip-types",
          "--disable-warning=ExperimentalWarning",
          script,
          "--artifacts",
          artifacts,
          "--upload",
          upload,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ""}`,
            TAG: "v1.0.9",
            GITHUB_REPOSITORY: "boshuaiYu/LocalPrism",
            TAURI_SIGNING_PRIVATE_KEY: "test-key",
            TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "test",
          },
        },
      );

      expect(result.status, result.stderr || result.stdout).not.toBe(0);
      expect(existsSync(join(upload, "latest.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not write latest.json when injected signing throws", () => {
    const root = mkdtempSync(join(tmpdir(), "localprism-latest-unit-"));
    try {
      const { artifacts, upload } = writeLinuxArtifacts(root);
      const planned = planUpdaterRelease({
        files: [
          {
            path: "desktop-linux/appimage/LocalPrism.AppImage",
            sha256:
              "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          },
          {
            path: "desktop-linux/appimage/LocalPrism.AppImage.sig",
            text: "untrusted comment: signature from tauri secret key\nRWTTEST=\n",
            sha256:
              "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          },
        ],
        tag: "v1.0.9",
        repository: "boshuaiYu/LocalPrism",
        pubDate: "2026-10-04T00:00:00Z",
      });
      expect(planned.ok).toBe(true);
      if (!planned.ok) return;

      expect(() =>
        writeSignedLatestManifest({
          plan: planned.plan,
          artifactsDir: artifacts,
          uploadDir: upload,
          signAttestation: () => {
            throw new Error("tauri signer sign failed on purpose");
          },
        }),
      ).toThrow(/tauri signer sign failed/);
      expect(existsSync(join(upload, "latest.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
