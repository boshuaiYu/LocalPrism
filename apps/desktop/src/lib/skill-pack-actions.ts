import {
  DEFAULT_SKILL_PACKS,
  skillPackDisplayName,
  type DefaultSkillPackId,
} from "@/lib/default-skill-packs";
import type { SkillsBrowserCategory } from "@/lib/skills-browser";

export interface SkillPackUpdateReport {
  id: string;
  name: string;
  added: string[];
  updated: string[];
  removed: string[];
  unchanged: string[];
  /** Skills present upstream that this pack did not install. */
  available?: string[];
  error?: string | null;
  errorCode?: string | null;
  detail?: string | null;
}

export interface PackRefreshTarget {
  id: string;
  name: string;
  sourceUrl?: string;
  sourceFolder?: string;
  defaultPackId?: string;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

export function normalizePackUpdateReport(
  value: unknown,
): SkillPackUpdateReport {
  const record =
    value && typeof value === "object"
      ? (value as Partial<SkillPackUpdateReport>)
      : {};
  return {
    id: typeof record.id === "string" ? record.id : "",
    name: typeof record.name === "string" ? record.name : "",
    added: stringList(record.added),
    updated: stringList(record.updated),
    removed: stringList(record.removed),
    unchanged: stringList(record.unchanged),
    available: stringList(record.available),
    error: typeof record.error === "string" ? record.error : null,
    errorCode: typeof record.errorCode === "string" ? record.errorCode : null,
    detail: typeof record.detail === "string" ? record.detail : null,
  };
}

export type PackUpdateSummaryView =
  | { kind: "error"; name: string; error: string }
  | { kind: "latest"; name: string }
  | {
      kind: "counts";
      name: string;
      added: number;
      updated: number;
      removed: number;
    };

/** One-line result for a pack. Errors stay a name-and-message row. */
export function packUpdateSummary(
  report: SkillPackUpdateReport,
): PackUpdateSummaryView {
  if (report.error) {
    return { kind: "error", name: report.name, error: report.error };
  }
  const added = report.added.length;
  const updated = report.updated.length;
  const removed = report.removed.length;
  if (added === 0 && updated === 0 && removed === 0) {
    return { kind: "latest", name: report.name };
  }
  return { kind: "counts", name: report.name, added, updated, removed };
}

/** Use the pack-list name. Refresh reports may lowercase a GitHub repo. */
export function withPackListName(
  report: SkillPackUpdateReport,
  packListName: string,
): SkillPackUpdateReport {
  const name = packListName.trim();
  if (!name || report.name === name) return report;
  return { ...report, name };
}

/**
 * Open the only pack so its skill names are visible. Keep a multi-pack
 * result collapsed, and keep a failed pack open.
 */
export function packUpdateRowOpen(
  packCount: number,
  report: Pick<SkillPackUpdateReport, "error">,
): boolean {
  return Boolean(report.error) || packCount === 1;
}

export function categoryRefreshTarget(
  category: SkillsBrowserCategory,
): PackRefreshTarget | null {
  if (category.defaultPackId) {
    const pack = DEFAULT_SKILL_PACKS.find(
      (item) => item.id === category.defaultPackId,
    );
    if (!pack) return null;
    return {
      id: pack.id,
      name: skillPackDisplayName(pack.id),
      sourceUrl: pack.sourceUrl,
      defaultPackId: pack.id,
    };
  }
  if (category.sourceFolder?.trim()) {
    return {
      id: category.id,
      name: category.name,
      sourceFolder: category.sourceFolder,
    };
  }
  if (category.sourceUrl?.trim()) {
    return {
      id: category.id,
      name: category.name,
      sourceUrl: category.sourceUrl,
    };
  }
  return null;
}

export function isRemoteRefresh(target: PackRefreshTarget): boolean {
  return Boolean(target.sourceUrl?.trim()) && !target.sourceFolder?.trim();
}

export function updateAllTargets(
  categories: SkillsBrowserCategory[],
  optedOutPackIds: ReadonlySet<string>,
): PackRefreshTarget[] {
  const targets: PackRefreshTarget[] = [];
  for (const category of categories) {
    const target = categoryRefreshTarget(category);
    if (!target) continue;
    if (target.defaultPackId && optedOutPackIds.has(target.defaultPackId)) {
      continue;
    }
    targets.push(target);
  }
  return targets;
}

export function remoteRefreshTargets(
  targets: PackRefreshTarget[],
): PackRefreshTarget[] {
  return targets.filter(isRemoteRefresh);
}

export function optedOutPackIdSet(value: unknown): Set<DefaultSkillPackId> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return new Set();
  }
  const ids = (value as { optedOutPackIds?: unknown }).optedOutPackIds;
  if (!Array.isArray(ids)) return new Set();
  const known = new Set(DEFAULT_SKILL_PACKS.map((pack) => pack.id));
  return new Set(
    ids.filter(
      (id): id is DefaultSkillPackId =>
        typeof id === "string" && known.has(id as DefaultSkillPackId),
    ),
  );
}
