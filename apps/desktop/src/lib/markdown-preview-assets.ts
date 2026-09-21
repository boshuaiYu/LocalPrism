import { getAssetUrl } from "@/lib/tauri/fs";

const PASSTHROUGH_SRC = /^(https?:|data:|blob:|asset:|tauri:|file:|mailto:|#)/i;

export function parentDirectory(absolutePath: string): string {
  const normalized = absolutePath.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return absolutePath;
  const parent = normalized.slice(0, index);
  if (absolutePath.includes("\\") && !absolutePath.includes("/")) {
    return parent.replace(/\//g, "\\");
  }
  return parent;
}

export function resolveRelativePath(fromDir: string, relative: string): string {
  const trimmed = relative.trim();
  if (
    /^[a-zA-Z]:[\\/]/.test(trimmed) ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("\\\\")
  ) {
    return trimmed;
  }

  const useWin = fromDir.includes("\\") && !fromDir.includes("/");
  const sep = useWin ? "\\" : "/";
  const normalizedDir = fromDir.replace(/\\/g, "/");
  const driveMatch = normalizedDir.match(/^([a-zA-Z]:)(\/|$)/);
  const isPosixRoot = !driveMatch && normalizedDir.startsWith("/");
  const rest = driveMatch
    ? normalizedDir.slice(driveMatch[1].length)
    : isPosixRoot
      ? normalizedDir.slice(1)
      : normalizedDir;
  const stack = rest.split("/").filter((part) => part && part !== ".");

  for (const part of trimmed.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }

  if (driveMatch) return `${driveMatch[1]}${sep}${stack.join(sep)}`;
  if (isPosixRoot) return `/${stack.join("/")}`;
  return stack.join(sep);
}

export function resolveMarkdownAssetUrl(
  src: string | undefined,
  markdownAbsolutePath: string | undefined,
): string | undefined {
  if (!src) return src;
  const trimmed = src.trim();
  if (!trimmed || PASSTHROUGH_SRC.test(trimmed)) return trimmed;
  if (!markdownAbsolutePath) return trimmed;
  return getAssetUrl(
    resolveRelativePath(parentDirectory(markdownAbsolutePath), trimmed),
  );
}
