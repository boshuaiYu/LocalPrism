/** Default first-run skill packs (user/global `claude-home/skills`, never project scope). */

import { isPaperSpineSkill, PAPERSPINE_SKILLS_URL } from "@/lib/paperspine";

export type DefaultSkillPackId =
  | "paper-spine"
  | "academic-research-skills"
  | "nature-skills"
  | "scientific-agent-skills";

export type SkillPackGroupId = DefaultSkillPackId | "imported";

export const IMPORTED_SKILL_PACK_ID = "imported" as const;

export interface DefaultSkillPack {
  id: DefaultSkillPackId;
  sourceUrl: string;
  /** Skip the download when any of these folders already exist. */
  markerFolders: string[];
  /** Official slash names from the upstream pack (`ars-plan.md` → `/ars-plan`). */
  markerCommands?: string[];
  /**
   * GitHub tree used for “view on GitHub”. Defaults to sourceUrl.
   * Use this when skills live under a subdirectory the install URL does not name.
   */
  docsUrl?: string;
}

export const ACADEMIC_RESEARCH_SKILLS_URL =
  "https://github.com/Imbad0202/academic-research-skills";

export const NATURE_SKILLS_URL =
  "https://github.com/Yuan1z0825/nature-skills/tree/main/skills";

export const SCIENTIFIC_AGENT_SKILLS_URL =
  "https://github.com/K-Dense-AI/scientific-agent-skills";

export const DEFAULT_SKILL_PACKS: DefaultSkillPack[] = [
  {
    id: "paper-spine",
    sourceUrl: PAPERSPINE_SKILLS_URL,
    markerFolders: ["paper-spine", "paperspine", "paper-spine-intake"],
    markerCommands: ["paperspine"],
  },
  {
    id: "academic-research-skills",
    sourceUrl: ACADEMIC_RESEARCH_SKILLS_URL,
    markerFolders: [
      "deep-research",
      "academic-paper",
      "academic-paper-reviewer",
      "academic-pipeline",
      "academic-research-suite",
      "literature-review",
      "peer-review",
      "reference-checker",
    ],
    markerCommands: ["ars-plan", "ars-lit-review"],
  },
  {
    id: "nature-skills",
    sourceUrl: NATURE_SKILLS_URL,
    markerFolders: [
      "nature-polishing",
      "nature-figure",
      "nature-writing",
      "nature-citation",
    ],
  },
  {
    id: "scientific-agent-skills",
    sourceUrl: SCIENTIFIC_AGENT_SKILLS_URL,
    markerFolders: ["scanpy", "biopython", "rdkit"],
    docsUrl:
      "https://github.com/K-Dense-AI/scientific-agent-skills/tree/main/skills",
  },
];

export function isDefaultSkillPackPresent(
  skills: Array<{ folder: string }>,
  pack: DefaultSkillPack,
): boolean {
  const folders = new Set(
    skills.map((skill) => skill.folder.trim().toLowerCase()),
  );
  return pack.markerFolders.some((folder) => folders.has(folder.toLowerCase()));
}

export function isOfficialUserSlashCommand(command: {
  scope?: string;
}): boolean {
  const scope = command.scope?.trim().toLowerCase();
  return scope !== "skill" && scope !== "default";
}

export function isDefaultSlashPackPresent(
  commands: Array<{ name?: string; full_command?: string; scope?: string }>,
  pack: DefaultSkillPack,
): boolean {
  if (!pack.markerCommands?.length) return true;
  const names = new Set<string>();
  for (const command of commands) {
    if (!isOfficialUserSlashCommand(command)) {
      continue;
    }
    if (command.name) {
      names.add(command.name.replace(/^\//, "").toLowerCase());
    }
    if (command.full_command) {
      names.add(command.full_command.replace(/^\//, "").toLowerCase());
    }
  }
  return pack.markerCommands.every((name) => names.has(name.toLowerCase()));
}

export function shouldInstallDefaultPack(
  skills: Array<{ folder: string }>,
  _agents: Array<{ id: string }>,
  pack: DefaultSkillPack,
  commands: Array<{
    name?: string;
    full_command?: string;
    scope?: string;
  }> = [],
  slashKnown = true,
): boolean {
  if (!isDefaultSkillPackPresent(skills, pack)) {
    return true;
  }
  if (!slashKnown) {
    return false;
  }
  return !isDefaultSlashPackPresent(commands, pack);
}

export function areDefaultSkillPacksReady(
  skills: Array<{ folder: string }>,
  _agents: Array<{ id: string }>,
): boolean {
  return DEFAULT_SKILL_PACKS.every((pack) =>
    isDefaultSkillPackPresent(skills, pack),
  );
}

export function githubRepoHome(url: string): string {
  const match = url.trim().match(/^(https:\/\/github\.com\/[^/]+\/[^/]+)/i);
  return match?.[1] ?? url.trim();
}

export function githubRepoLabel(url: string): string {
  const match = url.trim().match(/github\.com\/([^/]+\/[^/]+)/i);
  return match?.[1] ?? url.trim();
}

export function skillPackSourceUrl(id: SkillPackGroupId): string | null {
  if (id === IMPORTED_SKILL_PACK_ID) return null;
  return DEFAULT_SKILL_PACKS.find((pack) => pack.id === id)?.sourceUrl ?? null;
}

export function skillPackDocsUrl(id: SkillPackGroupId): string | null {
  if (id === IMPORTED_SKILL_PACK_ID) return null;
  const pack = DEFAULT_SKILL_PACKS.find((item) => item.id === id);
  return pack?.docsUrl ?? pack?.sourceUrl ?? null;
}

/** Official pack page, or a specific skill folder inside that GitHub tree. */
export function skillGithubUrl(sourceUrl: string, folder?: string): string {
  const trimmed = sourceUrl.trim();
  if (!folder?.trim()) {
    return githubRepoHome(trimmed);
  }
  const slug = folder.trim().replace(/^\/+|\/+$/g, "");
  const tree = trimmed.match(
    /^(https:\/\/github\.com\/[^/]+\/[^/]+)\/tree\/([^/]+)\/(.+)$/i,
  );
  if (tree) {
    const [, repo, ref, subpath] = tree;
    return `${repo}/tree/${ref}/${subpath.replace(/\/+$/, "")}/${slug}`;
  }
  return `${githubRepoHome(trimmed)}/tree/main/${slug}`;
}

export function skillPackDisplayName(id: SkillPackGroupId): string {
  switch (id) {
    case "paper-spine":
      return "PaperSpine";
    case "academic-research-skills":
      return "academic-research-skills";
    case "nature-skills":
      return "nature-skills";
    case "scientific-agent-skills":
      return "scientific-agent-skills";
    case "imported":
      return "Imported";
  }
}

function folderMatchesPack(folder: string, pack: DefaultSkillPack): boolean {
  const key = folder.trim().toLowerCase();
  if (pack.markerFolders.some((marker) => marker.toLowerCase() === key)) {
    return true;
  }
  if (pack.id === "academic-research-skills") {
    return key.startsWith("academic-") || key.startsWith("academic_");
  }
  if (pack.id === "nature-skills") {
    return key.startsWith("nature-") || key.startsWith("nature_");
  }
  return false;
}

export function resolveSkillPackId(
  skill: { folder: string; name?: string },
  scientificFolders?: ReadonlySet<string>,
): SkillPackGroupId {
  if (
    isPaperSpineSkill({
      folder: skill.folder,
      name: skill.name ?? skill.folder,
    })
  ) {
    return "paper-spine";
  }
  const folder = skill.folder.trim();
  const academic = DEFAULT_SKILL_PACKS.find(
    (pack) => pack.id === "academic-research-skills",
  );
  const nature = DEFAULT_SKILL_PACKS.find(
    (pack) => pack.id === "nature-skills",
  );
  const scientific = DEFAULT_SKILL_PACKS.find(
    (pack) => pack.id === "scientific-agent-skills",
  );
  if (academic && folderMatchesPack(folder, academic)) {
    return "academic-research-skills";
  }
  if (nature && folderMatchesPack(folder, nature)) {
    return "nature-skills";
  }
  if (
    (scientific && folderMatchesPack(folder, scientific)) ||
    scientificFolders?.has(folder) ||
    scientificFolders?.has(folder.toLowerCase())
  ) {
    return "scientific-agent-skills";
  }
  return "imported";
}

export function isDefaultPackSkill(
  skill: { folder: string; name?: string },
  scientificFolders?: ReadonlySet<string>,
): boolean {
  return (
    resolveSkillPackId(skill, scientificFolders) !== IMPORTED_SKILL_PACK_ID
  );
}

export function anyDefaultSkillPackPresent(
  skills: Array<{ folder: string }>,
): boolean {
  return DEFAULT_SKILL_PACKS.some((pack) =>
    isDefaultSkillPackPresent(skills, pack),
  );
}
