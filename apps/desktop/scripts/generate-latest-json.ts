import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  planUpdaterRelease,
  type ArtifactFile,
  type LatestManifest,
  type UpdaterReleasePlan,
} from "../src/lib/updater-manifest.ts";

function walk(root: string, dir = root): ArtifactFile[] {
  const files: ArtifactFile[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(root, full));
      continue;
    }
    const path = relative(root, full).split("\\").join("/");
    const bytes = readFileSync(full);
    const file: ArtifactFile = {
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    if (entry.name.toLowerCase().endsWith(".sig")) {
      file.text = bytes.toString("utf8");
    }
    files.push(file);
  }
  return files;
}

function argValue(argv: string[], name: string): string | undefined {
  const flag = `--${name}`;
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  return argv[index + 1];
}

export function signAttestation(canonical: string): string {
  if (!process.env.TAURI_SIGNING_PRIVATE_KEY?.trim()) {
    throw new Error(
      "TAURI_SIGNING_PRIVATE_KEY is required to sign latest.json in the sign-updater job.",
    );
  }
  const dir = mkdtempSync(join(tmpdir(), "localprism-attestation-"));
  const file = join(dir, "attestation");
  try {
    writeFileSync(file, canonical);
    const signed = spawnSync("tauri", ["signer", "sign", file], {
      encoding: "utf8",
      env: process.env,
    });
    if (signed.status !== 0) {
      throw new Error(
        `tauri signer sign failed: ${signed.stderr || signed.stdout || "unknown error"}`,
      );
    }
    const signature = readFileSync(`${file}.sig`, "utf8").trim();
    if (!signature) {
      throw new Error(
        "tauri signer sign produced an empty manifest_signature.",
      );
    }
    return signature;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function writeSignedLatestManifest(input: {
  plan: UpdaterReleasePlan;
  artifactsDir: string;
  uploadDir: string;
  signAttestation?: (canonical: string) => string;
}): LatestManifest {
  const sign = input.signAttestation ?? signAttestation;
  const manifestSignature = sign(input.plan.attestation).trim();
  if (!manifestSignature) {
    throw new Error(
      "Attestation signing produced an empty manifest_signature.",
    );
  }
  const manifest: LatestManifest = {
    ...input.plan.manifest,
    manifest_signature: manifestSignature,
  };
  mkdirSync(input.uploadDir, { recursive: true });
  for (const copy of input.plan.copies) {
    copyFileSync(
      join(input.artifactsDir, copy.sourcePath),
      join(input.uploadDir, copy.uploadName),
    );
  }
  writeFileSync(
    join(input.uploadDir, "latest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

export function readUpdaterReleaseNotes(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const file = env.UPDATER_RELEASE_NOTES_FILE?.trim();
  if (file) {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
  }
  const inline = env.UPDATER_RELEASE_NOTES;
  if (typeof inline !== "string") return undefined;
  return inline.trim() ? inline : undefined;
}

export function generateLatestJson(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): LatestManifest {
  const artifactsDir = argValue(argv, "artifacts") ?? "artifacts";
  const uploadDir = argValue(argv, "upload") ?? "upload";
  const tag = env.TAG?.trim() ?? "";
  const repository = env.GITHUB_REPOSITORY?.trim() ?? "";
  const pubDate = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  const result = planUpdaterRelease({
    files: walk(artifactsDir),
    tag,
    repository,
    pubDate,
    notes: readUpdaterReleaseNotes(env),
  });

  if (!result.ok) {
    throw new Error(result.error);
  }

  return writeSignedLatestManifest({
    plan: result.plan,
    artifactsDir,
    uploadDir,
  });
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return fileURLToPath(import.meta.url) === resolve(entry);
}

if (isDirectRun()) {
  const manifest = generateLatestJson();
  console.log(JSON.stringify(manifest, null, 2));
}
