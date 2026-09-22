export type ProjectPreviewKind = "pdf" | "tex" | "empty" | "loading" | "error";

export function formatRelativeUpdated(updatedAt: number, now: number): string {
  if (!Number.isFinite(updatedAt) || !Number.isFinite(now)) {
    return "Updated recently";
  }
  const delta = Math.max(0, now - updatedAt);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (delta < minute) return "Updated just now";
  if (delta < hour) return `Updated ${Math.floor(delta / minute)}m ago`;
  if (delta < day) return `Updated ${Math.floor(delta / hour)}h ago`;
  if (delta < 7 * day) return `Updated ${Math.floor(delta / day)}d ago`;
  return `Updated ${new Date(updatedAt).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  })}`;
}

export function projectPathSubtitle(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  if (parts.length <= 2) return path;
  return `…/${parts.slice(-2).join("/")}`;
}

export function projectPreviewStatus(
  kind: ProjectPreviewKind | null,
): string | null {
  if (kind === "pdf") return "PDF ready";
  if (kind === "tex") return "Source";
  return null;
}

export function projectCardMetaLine(input: {
  path: string;
  updatedAt: number;
  now: number;
  preview: ProjectPreviewKind | null;
}): string {
  const parts = [
    projectPathSubtitle(input.path),
    formatRelativeUpdated(input.updatedAt, input.now),
  ];
  const status = projectPreviewStatus(input.preview);
  if (status) parts.push(status);
  return parts.join(" · ");
}
