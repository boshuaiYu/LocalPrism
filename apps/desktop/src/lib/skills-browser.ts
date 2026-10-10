import {
  DEFAULT_SKILL_PACKS,
  IMPORTED_SKILL_PACK_ID,
  installedSourcePack,
  skillPackDisplayName,
  type DefaultSkillPackId,
  type SkillPackGroupId,
} from "@/lib/default-skill-packs";
import {
  resolveSkillCategory,
  type CatalogSkillCategory,
  type SkillCategorySnapshot,
} from "@/lib/skill-categories";

export interface SkillsBrowserSkill {
  name: string;
  folder: string;
  category?: string | null;
  sourceUrl?: string | null;
  sourceFolder?: string | null;
}

export type SkillsBrowserSourceKind =
  | "default"
  | "url"
  | "folder"
  | "custom"
  | "imported";

export interface SkillsBrowserCategory {
  id: string;
  name: string;
  icon: string;
  skill_count: number;
  skills: SkillsBrowserSkill[];
  sourceUrl?: string;
  sourceFolder?: string;
  defaultPackId?: DefaultSkillPackId;
  sourceKind?: SkillsBrowserSourceKind;
}

export function installedBrowserCategoryId(categoryId: string): string {
  return `installed:${categoryId}`;
}

export function packIdFromBrowserCategoryId(
  categoryId: string,
): SkillPackGroupId | null {
  const prefix = "installed:";
  if (!categoryId.startsWith(prefix)) return null;
  const packId = categoryId.slice(prefix.length);
  if (packId === IMPORTED_SKILL_PACK_ID) return IMPORTED_SKILL_PACK_ID;
  return DEFAULT_SKILL_PACKS.some((pack) => pack.id === packId)
    ? (packId as SkillPackGroupId)
    : null;
}

export function catalogBrowserCategoryId(categoryId: string): string {
  return categoryId.startsWith("catalog:")
    ? categoryId
    : `catalog:${categoryId}`;
}

function iconForPack(id: SkillPackGroupId): string {
  if (id === "paper-spine") return "book-open";
  if (id === "academic-research-skills") return "book-open";
  if (id === "nature-skills") return "flask-conical";
  if (id === "paper-humanizer-skill") return "pen-line";
  return "settings";
}

function browserSkillEntry(skill: SkillsBrowserSkill): SkillsBrowserSkill {
  return {
    name: skill.name,
    folder: skill.folder,
    category: skill.category,
  };
}

export function buildSkillsBrowserCategories(input: {
  installedSkills: SkillsBrowserSkill[];
  snapshot?: SkillCategorySnapshot;
  catalog: Array<
    Omit<CatalogSkillCategory, "skills"> & {
      icon?: string;
      skill_count?: number;
      skills: Array<{ folder: string; name?: string }>;
    }
  >;
  optedOutPackIds?: readonly string[];
}): SkillsBrowserCategory[] {
  const optedOut = new Set(input.optedOutPackIds ?? []);
  const buckets = new Map<SkillPackGroupId, SkillsBrowserSkill[]>();
  for (const pack of DEFAULT_SKILL_PACKS) {
    buckets.set(pack.id, []);
  }
  const urlGroups = new Map<
    string,
    { name: string; refreshUrl?: string; skills: SkillsBrowserSkill[] }
  >();
  const folderGroups = new Map<
    string,
    { name: string; sourceFolder: string; skills: SkillsBrowserSkill[] }
  >();
  const custom = new Map<
    string,
    { name: string; skills: SkillsBrowserSkill[] }
  >();
  for (const skill of input.installedSkills) {
    const entry = browserSkillEntry(skill);
    const resolved = resolveSkillCategory(
      skill,
      input.snapshot ?? { categories: [], assignments: {} },
      input.catalog,
    );
    if (resolved.source === "url") {
      const source = installedSourcePack(skill);
      const group = urlGroups.get(resolved.id) ?? {
        name: resolved.name,
        refreshUrl: source?.refreshUrl,
        skills: [],
      };
      if (!group.refreshUrl && source?.refreshUrl) {
        group.refreshUrl = source.refreshUrl;
      }
      group.skills.push(entry);
      urlGroups.set(resolved.id, group);
      continue;
    }
    if (resolved.source === "folder") {
      const source = installedSourcePack(skill);
      const group = folderGroups.get(resolved.id) ?? {
        name: resolved.name,
        sourceFolder: source?.sourceFolder ?? "",
        skills: [],
      };
      group.skills.push(entry);
      folderGroups.set(resolved.id, group);
      continue;
    }
    if (resolved.source === "custom") {
      const group = custom.get(resolved.id) ?? {
        name: resolved.name,
        skills: [],
      };
      group.skills.push(entry);
      custom.set(resolved.id, group);
      continue;
    }
    const packId = resolved.id as SkillPackGroupId;
    const list = buckets.get(packId) ?? [];
    list.push(entry);
    buckets.set(packId, list);
  }

  const packCategories = DEFAULT_SKILL_PACKS.flatMap((pack) => {
    const skills = buckets.get(pack.id) ?? [];
    if (skills.length === 0 && optedOut.has(pack.id)) return [];
    return [
      {
        id: installedBrowserCategoryId(pack.id),
        name: skillPackDisplayName(pack.id),
        icon: iconForPack(pack.id),
        skill_count: skills.length,
        skills,
        sourceUrl: pack.docsUrl ?? pack.sourceUrl,
        defaultPackId: pack.id,
        sourceKind: "default" as const,
      },
    ];
  });
  const urlCategories = [...urlGroups.entries()]
    .sort((left, right) => left[1].name.localeCompare(right[1].name))
    .map(([id, group]) => ({
      id: installedBrowserCategoryId(id),
      name: group.name,
      icon: "settings",
      skill_count: group.skills.length,
      skills: group.skills,
      sourceUrl: group.refreshUrl,
      sourceKind: "url" as const,
    }));
  const folderCategories = [...folderGroups.entries()]
    .sort((left, right) => left[1].name.localeCompare(right[1].name))
    .map(([id, group]) => ({
      id: installedBrowserCategoryId(id),
      name: group.name,
      icon: "settings",
      skill_count: group.skills.length,
      skills: group.skills,
      sourceFolder: group.sourceFolder,
      sourceKind: "folder" as const,
    }));
  const customCategories = [...custom.entries()]
    .sort((left, right) => left[1].name.localeCompare(right[1].name))
    .map(([id, group]) => ({
      id: installedBrowserCategoryId(id),
      name: group.name,
      icon: "settings",
      skill_count: group.skills.length,
      skills: group.skills,
      sourceKind: "custom" as const,
    }));
  const uncategorized = buckets.get(IMPORTED_SKILL_PACK_ID) ?? [];
  const uncategorizedCategory =
    uncategorized.length === 0
      ? []
      : [
          {
            id: installedBrowserCategoryId(IMPORTED_SKILL_PACK_ID),
            name: skillPackDisplayName(IMPORTED_SKILL_PACK_ID),
            icon: "settings",
            skill_count: uncategorized.length,
            skills: uncategorized,
            sourceKind: "imported" as const,
          },
        ];
  return [
    ...packCategories,
    ...urlCategories,
    ...folderCategories,
    ...customCategories,
    ...uncategorizedCategory,
  ];
}
