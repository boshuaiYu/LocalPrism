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
import { join, relative } from "node:path";
import {
  planUpdaterRelease,
  type ArtifactFile,
  type LatestManifest,
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

function argValue(name: string): string | undefined {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function signAttestation(canonical: string): string {
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
    return readFileSync(`${file}.sig`, "utf8").trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const artifactsDir = argValue("artifacts") ?? "artifacts";
const uploadDir = argValue("upload") ?? "upload";
const tag = process.env.TAG?.trim() ?? "";
const repository = process.env.GITHUB_REPOSITORY?.trim() ?? "";
const pubDate = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

const result = planUpdaterRelease({
  files: walk(artifactsDir),
  tag,
  repository,
  pubDate,
});

if (!result.ok) {
  console.error(result.error);
  process.exit(1);
}

mkdirSync(uploadDir, { recursive: true });
for (const copy of result.plan.copies) {
  copyFileSync(
    join(artifactsDir, copy.sourcePath),
    join(uploadDir, copy.uploadName),
  );
}

let manifestSignature: string | undefined;
try {
  manifestSignature = signAttestation(result.plan.attestation);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(
    `Attestation signing failed; publishing version/tag/digest binding only: ${message}`,
  );
}
const manifest: LatestManifest = {
  ...result.plan.manifest,
  ...(manifestSignature ? { manifest_signature: manifestSignature } : {}),
};
const manifestPath = join(uploadDir, "latest.json");
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify(manifest, null, 2));
