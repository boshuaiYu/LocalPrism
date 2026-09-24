import {
  DEFAULT_SKILL_PACKS,
  IMPORTED_SKILL_PACK_ID,
  skillPackDisplayName,
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
  const buckets = new Map<SkillPackGroupId, SkillsBrowserSkill[]>();
  for (const pack of DEFAULT_SKILL_PACKS) {
    buckets.set(pack.id, []);
  }
  const custom = new Map<
    string,
    { name: string; skills: SkillsBrowserSkill[] }
  >();
  for (const skill of input.installedSkills) {
    const entry = {
      name: skill.name,
      folder: skill.folder,
      category: skill.category,
    };
    const resolved = resolveSkillCategory(
      skill,
      input.snapshot ?? { categories: [], assignments: {} },
      input.catalog,
    );
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

  const packCategories = DEFAULT_SKILL_PACKS.map((pack) => {
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
  const customCategories = [...custom.entries()]
    .sort((left, right) => left[1].name.localeCompare(right[1].name))
    .map(([id, group]) => ({
      id: installedBrowserCategoryId(id),
      name: group.name,
      icon: "settings",
      skill_count: group.skills.length,
      skills: group.skills,
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
          },
        ];
  return [...packCategories, ...customCategories, ...uncategorizedCategory];
}
