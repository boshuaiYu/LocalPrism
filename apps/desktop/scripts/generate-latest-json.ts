import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import {
  planUpdaterRelease,
  type ArtifactFile,
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
    const file: ArtifactFile = { path };
    if (entry.name.toLowerCase().endsWith(".sig")) {
      file.text = readFileSync(full, "utf8");
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

const manifestPath = join(uploadDir, "latest.json");
writeFileSync(
  manifestPath,
  `${JSON.stringify(result.plan.manifest, null, 2)}\n`,
);
console.log(JSON.stringify(result.plan.manifest, null, 2));
