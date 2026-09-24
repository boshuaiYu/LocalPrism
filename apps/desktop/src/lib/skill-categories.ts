import {
  DEFAULT_SKILL_PACKS,
  IMPORTED_SKILL_PACK_ID,
  resolveSkillPackId,
  skillPackDisplayName,
  type SkillPackGroupId,
} from "@/lib/default-skill-packs";

export const SKILL_CATEGORY_STORAGE_KEY = "localprism-skill-packs-v1";

export interface UserSkillCategory {
  id: string;
  name: string;
}

export interface SkillCategorySnapshot {
  categories: UserSkillCategory[];
  assignments: Record<string, string>;
}

export interface CatalogSkillCategory {
  id: string;
  name: string;
  skills: Array<{ folder: string }>;
}

export type SkillCategorySource = SkillPackGroupId | "custom";

export interface ResolvedSkillCategory {
  id: string;
  name: string;
  source: SkillCategorySource;
}

export interface SkillCategoryGroup<T> {
  id: string;
  name: string;
  source: SkillCategorySource;
  defaultExpanded: boolean;
  items: T[];
}

export const DEFAULT_USER_CATEGORIES: UserSkillCategory[] = [];

export const PAPERSPINE_CATEGORY_ID = "paper-spine";
export const UNCATEGORIZED_CATEGORY_ID = IMPORTED_SKILL_PACK_ID;

export function emptySkillCategorySnapshot(): SkillCategorySnapshot {
  return {
    categories: [],
    assignments: {},
  };
}

export function parseSkillCategorySnapshot(
  raw: string | null | undefined,
): SkillCategorySnapshot {
  if (!raw) return emptySkillCategorySnapshot();
  try {
    const parsed = JSON.parse(raw) as Partial<SkillCategorySnapshot>;
    const categories = Array.isArray(parsed.categories)
      ? parsed.categories.filter(
          (category): category is UserSkillCategory =>
            !!category &&
            typeof category.id === "string" &&
            typeof category.name === "string" &&
            category.id.trim().length > 0 &&
            category.name.trim().length > 0,
        )
      : [];
    const assignments =
      parsed.assignments && typeof parsed.assignments === "object"
        ? Object.fromEntries(
            Object.entries(parsed.assignments).filter(
              ([folder, categoryId]) =>
                folder.trim().length > 0 && typeof categoryId === "string",
            ),
          )
        : {};
    return { categories, assignments };
  } catch {
    return emptySkillCategorySnapshot();
  }
}

export function loadSkillCategorySnapshot(): SkillCategorySnapshot {
  if (typeof localStorage === "undefined") {
    return emptySkillCategorySnapshot();
  }
  try {
    return parseSkillCategorySnapshot(
      localStorage.getItem(SKILL_CATEGORY_STORAGE_KEY),
    );
  } catch {
    return emptySkillCategorySnapshot();
  }
}

export function saveSkillCategorySnapshot(
  snapshot: SkillCategorySnapshot,
): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(SKILL_CATEGORY_STORAGE_KEY, JSON.stringify(snapshot));
}

export function sanitizeCategoryName(name: string): string {
  return name.trim().replace(/\s+/g, " ").slice(0, 40);
}

export function categoryIdFromName(name: string): string {
  const slug = sanitizeCategoryName(name)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "custom";
}

function uniqueCategoryId(
  snapshot: SkillCategorySnapshot,
  baseId: string,
): string {
  if (!snapshot.categories.some((category) => category.id === baseId)) {
    return baseId;
  }
  let index = 2;
  while (
    snapshot.categories.some((category) => category.id === `${baseId}-${index}`)
  ) {
    index += 1;
  }
  return `${baseId}-${index}`;
}

export function upsertUserCategory(
  snapshot: SkillCategorySnapshot,
  name: string,
): { snapshot: SkillCategorySnapshot; category: UserSkillCategory } | null {
  const trimmed = sanitizeCategoryName(name);
  if (!trimmed) return null;
  const existing = snapshot.categories.find(
    (category) =>
      category.name.toLowerCase() === trimmed.toLowerCase() ||
      category.id === categoryIdFromName(trimmed),
  );
  if (existing) {
    return { snapshot, category: existing };
  }
  const category = {
    id: uniqueCategoryId(snapshot, categoryIdFromName(trimmed)),
    name: trimmed,
  };
  return {
    snapshot: {
      ...snapshot,
      categories: [...snapshot.categories, category],
    },
    category,
  };
}

export function assignSkillFolders(
  snapshot: SkillCategorySnapshot,
  folders: string[],
  categoryId: string,
): SkillCategorySnapshot {
  const assignments = { ...snapshot.assignments };
  for (const folder of folders) {
    const key = folder.trim();
    if (key) assignments[key] = categoryId;
  }
  return { ...snapshot, assignments };
}

export function catalogFolderMap(
  catalog: CatalogSkillCategory[],
): Map<string, CatalogSkillCategory> {
  const map = new Map<string, CatalogSkillCategory>();
  for (const category of catalog) {
    for (const skill of category.skills) {
      if (!map.has(skill.folder)) {
        map.set(skill.folder, category);
      }
    }
  }
  return map;
}

function explicitCategoryLabel(category?: string | null): string | null {
  const label = category?.trim().replace(/\s+/g, " ") ?? "";
  if (!label) return null;
  const lower = label.toLowerCase();
  if (
    lower === "none" ||
    lower === "n/a" ||
    lower === "na" ||
    lower === "null" ||
    lower === "uncategorized" ||
    lower === "imported"
  ) {
    return null;
  }
  return label.slice(0, 80);
}

function packIdFromCategoryLabel(label: string): SkillPackGroupId | null {
  const key = label.trim().toLowerCase();
  if (key === IMPORTED_SKILL_PACK_ID || key === "uncategorized") {
    return IMPORTED_SKILL_PACK_ID;
  }
  const pack = DEFAULT_SKILL_PACKS.find(
    (item) =>
      item.id === key || skillPackDisplayName(item.id).toLowerCase() === key,
  );
  return pack?.id ?? null;
}

function packCategory(packId: SkillPackGroupId): ResolvedSkillCategory {
  return {
    id: packId,
    name: skillPackDisplayName(packId),
    source: packId,
  };
}

export function resolveSkillCategory(
  input: {
    folder: string;
    name?: string;
    category?: string | null;
    sourceUrl?: string | null;
  },
  _snapshot: SkillCategorySnapshot,
  catalog: CatalogSkillCategory[],
  catalogMap = catalogFolderMap(catalog),
): ResolvedSkillCategory {
  // A recorded install URL decides the pack. The scientific catalog is only
  // a fallback for skills that have no sourceUrl.
  const scientificFolders = input.sourceUrl?.trim()
    ? undefined
    : new Set([...catalogMap.keys()].map((folder) => folder.toLowerCase()));
  const packId = resolveSkillPackId(input, scientificFolders);
  if (packId !== IMPORTED_SKILL_PACK_ID) {
    return packCategory(packId);
  }
  const explicit = explicitCategoryLabel(input.category);
  if (explicit) {
    const labeledPack = packIdFromCategoryLabel(explicit);
    if (labeledPack && labeledPack !== IMPORTED_SKILL_PACK_ID) {
      return packCategory(labeledPack);
    }
    return {
      id: `category:${categoryIdFromName(explicit)}`,
      name: explicit,
      source: "custom",
    };
  }
  // Flat `skills/<name>/SKILL.md` installs have no frontmatter or parent folder.
  // The folder name is the category; built-in packs are already resolved above.
  const folderLabel = explicitCategoryLabel(input.folder);
  if (folderLabel) {
    return {
      id: `category:${categoryIdFromName(folderLabel)}`,
      name: folderLabel,
      source: "custom",
    };
  }
  return packCategory(IMPORTED_SKILL_PACK_ID);
}

export function groupItemsBySkillCategory<T>(
  items: T[],
  getSkill: (item: T) => {
    folder: string;
    name: string;
    category?: string | null;
    sourceUrl?: string | null;
  },
  snapshot: SkillCategorySnapshot,
  catalog: CatalogSkillCategory[],
): SkillCategoryGroup<T>[] {
  const catalogMap = catalogFolderMap(catalog);
  const groups = new Map<string, SkillCategoryGroup<T>>();

  const ensure = (resolved: ResolvedSkillCategory): SkillCategoryGroup<T> => {
    const existing = groups.get(resolved.id);
    if (existing) return existing;
    const created: SkillCategoryGroup<T> = {
      id: resolved.id,
      name: resolved.name,
      source: resolved.source,
      defaultExpanded: true,
      items: [],
    };
    groups.set(resolved.id, created);
    return created;
  };

  for (const item of items) {
    const skill = getSkill(item);
    const resolved = resolveSkillCategory(skill, snapshot, catalog, catalogMap);
    ensure(resolved).items.push(item);
  }

  const sourceOrder: SkillCategorySource[] = [
    ...DEFAULT_SKILL_PACKS.map((pack) => pack.id),
    "custom",
    "imported",
  ];
  return [...groups.values()].sort((left, right) => {
    const sourceDelta =
      sourceOrder.indexOf(left.source) - sourceOrder.indexOf(right.source);
    if (sourceDelta !== 0) return sourceDelta;
    return left.name.localeCompare(right.name);
  });
}

export function skillFolderFromSlashCommand(fullCommand: string): string {
  return fullCommand.replace(/^\//, "");
}
