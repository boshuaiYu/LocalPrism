/**
 * Maps Tauri updater artifacts to the platform keys
 * `@tauri-apps/plugin-updater` requests.
 *
 * GitHub Actions job outputs drop multiline values, and a minisign `.sig`
 * file is multiline. Publishing must read the signature files from the
 * downloaded artifacts instead of passing them through job outputs.
 */

export const UPDATER_SIGNING_SECRET = "TAURI_SIGNING_PRIVATE_KEY";

export interface ArtifactFile {
  /** Path relative to the artifacts directory, using `/` separators. */
  path: string;
  /** UTF-8 contents. Required for `.sig` files. */
  text?: string;
}

export interface ReleaseFileCopy {
  sourcePath: string;
  uploadName: string;
}

export interface UpdaterPlatformEntry {
  signature: string;
  url: string;
}

export interface LatestManifest {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, UpdaterPlatformEntry>;
}

export interface UpdaterReleasePlan {
  manifest: LatestManifest;
  copies: ReleaseFileCopy[];
}

export type UpdaterReleaseResult =
  | { ok: true; plan: UpdaterReleasePlan }
  | { ok: false; error: string };

interface UpdaterTarget {
  dir: string;
  kind: "nsis" | "tar" | "appimage";
  platform: string;
  aliases: string[];
  uploadName: string;
}

const UPDATER_TARGETS: readonly UpdaterTarget[] = [
  {
    dir: "desktop-windows",
    kind: "nsis",
    platform: "windows-x86_64-nsis",
    aliases: ["windows-x86_64"],
    uploadName: "LocalPrism-Windows-setup.exe",
  },
  {
    dir: "desktop-macos",
    kind: "tar",
    platform: "darwin-aarch64",
    aliases: [],
    uploadName: "LocalPrism-macOS.app.tar.gz",
  },
  {
    dir: "desktop-macos-intel",
    kind: "tar",
    platform: "darwin-x86_64",
    aliases: [],
    uploadName: "LocalPrism-macOS-Intel.app.tar.gz",
  },
  {
    dir: "desktop-linux",
    kind: "appimage",
    platform: "linux-x86_64",
    aliases: [],
    uploadName: "LocalPrism-Linux.AppImage",
  },
];

const OPTIONAL_INSTALLERS: ReadonlyArray<{
  dir: string;
  uploadName: string;
  match: (name: string) => boolean;
}> = [
  {
    dir: "desktop-macos",
    uploadName: "LocalPrism-macOS.dmg",
    match: (name) => name.toLowerCase().endsWith(".dmg"),
  },
  {
    dir: "desktop-macos-intel",
    uploadName: "LocalPrism-macOS-Intel.dmg",
    match: (name) => name.toLowerCase().endsWith(".dmg"),
  },
  {
    dir: "desktop-windows",
    uploadName: "LocalPrism-Windows.msi",
    match: (name) => name.toLowerCase().endsWith(".msi"),
  },
  {
    dir: "desktop-linux",
    uploadName: "LocalPrism-Linux.deb",
    match: (name) => name.toLowerCase().endsWith(".deb"),
  },
  {
    dir: "desktop-linux",
    uploadName: "LocalPrism-Linux.rpm",
    match: (name) => name.toLowerCase().endsWith(".rpm"),
  },
];

function baseName(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}

function artifactDir(path: string): string {
  return path.split("/")[0] ?? "";
}

function isUpdaterBinary(name: string, kind: UpdaterTarget["kind"]): boolean {
  const lower = name.toLowerCase();
  if (lower.endsWith(".sig")) return false;
  if (kind === "nsis") return lower.endsWith("-setup.exe");
  if (kind === "tar") return lower.endsWith(".app.tar.gz");
  return lower.endsWith(".appimage");
}

function normalizeSignature(text: string | undefined): string {
  return (text ?? "").trim();
}

function signingHint(detail: string): string {
  return [
    detail,
    `Refusing to publish latest.json with an empty or incomplete platforms object.`,
    `Set the ${UPDATER_SIGNING_SECRET} secret (and TAURI_SIGNING_PRIVATE_KEY_PASSWORD when the key is encrypted) so tauri build writes updater bundles and .sig files.`,
    "Expected signatures: desktop-windows/*-setup.exe.sig, desktop-macos/*.app.tar.gz.sig, desktop-macos-intel/*.app.tar.gz.sig, desktop-linux/*.AppImage.sig.",
  ].join(" ");
}

export function planUpdaterRelease(input: {
  files: readonly ArtifactFile[];
  tag: string;
  repository: string;
  pubDate: string;
}): UpdaterReleaseResult {
  const tag = input.tag.trim();
  const repository = input.repository.trim();
  if (!tag || !repository) {
    return {
      ok: false,
      error: "TAG and GITHUB_REPOSITORY are required to build latest.json.",
    };
  }

  const files = input.files.map((file) => ({
    ...file,
    path: file.path.replace(/\\/g, "/").replace(/^\.\//, ""),
  }));
  const byPath = new Map(files.map((file) => [file.path, file]));
  const platforms: Record<string, UpdaterPlatformEntry> = {};
  const copies: ReleaseFileCopy[] = [];
  const version = tag.replace(/^v/, "");
  const baseUrl = `https://github.com/${repository}/releases/download/${tag}`;

  for (const target of UPDATER_TARGETS) {
    const binaries = files
      .filter(
        (file) =>
          artifactDir(file.path) === target.dir &&
          isUpdaterBinary(baseName(file.path), target.kind),
      )
      .sort((a, b) => a.path.localeCompare(b.path));
    if (binaries.length === 0) continue;

    const signed = binaries.find((file) =>
      normalizeSignature(byPath.get(`${file.path}.sig`)?.text),
    );
    if (!signed) {
      return {
        ok: false,
        error: signingHint(
          `Found ${target.platform} updater binary without a signature: ${binaries[0]?.path}.`,
        ),
      };
    }
    const signature = normalizeSignature(
      byPath.get(`${signed.path}.sig`)?.text,
    );
    const entry = {
      signature,
      url: `${baseUrl}/${target.uploadName}`,
    };
    platforms[target.platform] = entry;
    for (const alias of target.aliases) {
      platforms[alias] = entry;
    }
    copies.push(
      { sourcePath: signed.path, uploadName: target.uploadName },
      {
        sourcePath: `${signed.path}.sig`,
        uploadName: `${target.uploadName}.sig`,
      },
    );
  }

  if (Object.keys(platforms).length === 0) {
    return {
      ok: false,
      error: signingHint(
        "No signed updater artifacts were found (Windows NSIS, macOS app.tar.gz, Linux AppImage).",
      ),
    };
  }

  for (const extra of OPTIONAL_INSTALLERS) {
    const match = files
      .filter(
        (file) =>
          artifactDir(file.path) === extra.dir &&
          extra.match(baseName(file.path)) &&
          !baseName(file.path).toLowerCase().endsWith(".sig"),
      )
      .sort((a, b) => a.path.localeCompare(b.path))[0];
    if (!match) continue;
    copies.push({ sourcePath: match.path, uploadName: extra.uploadName });
  }

  return {
    ok: true,
    plan: {
      manifest: {
        version,
        notes: `LocalPrism ${tag}`,
        pub_date: input.pubDate,
        platforms,
      },
      copies,
    },
  };
}
