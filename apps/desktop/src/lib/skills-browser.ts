import {
  DEFAULT_SKILL_PACKS,
  IMPORTED_SKILL_PACK_ID,
  resolveSkillPackId,
  skillPackDisplayName,
  type SkillPackGroupId,
} from "@/lib/default-skill-packs";
import type {
  CatalogSkillCategory,
  SkillCategorySnapshot,
} from "@/lib/skill-categories";

export interface SkillsBrowserSkill {
  name: string;
  folder: string;
}

export interface SkillsBrowserCategory {
  id: string;
  name: string;
  icon: string;
  skill_count: number;
  skills: SkillsBrowserSkill[];
  sourceUrl?: string;
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
  if (id === "scientific-agent-skills") return "flask-conical";
  if (id === "paper-humanizer-skill") return "pen-line";
  return "settings";
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
}): SkillsBrowserCategory[] {
  const scientificFolders = new Set(
    input.catalog.flatMap((category) =>
      category.skills.map((skill) => skill.folder.trim().toLowerCase()),
    ),
  );
  const buckets = new Map<SkillPackGroupId, SkillsBrowserSkill[]>();
  for (const pack of DEFAULT_SKILL_PACKS) {
    buckets.set(pack.id, []);
  }
  for (const skill of input.installedSkills) {
    const packId = resolveSkillPackId(skill, scientificFolders);
    if (packId === IMPORTED_SKILL_PACK_ID) continue;
    buckets.get(packId)?.push({
      name: skill.name,
      folder: skill.folder,
    });
  }

  return DEFAULT_SKILL_PACKS.map((pack) => {
    const skills = buckets.get(pack.id) ?? [];
    return {
      id: installedBrowserCategoryId(pack.id),
      name: skillPackDisplayName(pack.id),
      icon: iconForPack(pack.id),
      skill_count: skills.length,
      skills,
      sourceUrl: pack.docsUrl ?? pack.sourceUrl,
    };
  });
}
