/** Default first-run skill packs (user/global `claude-home/skills`, never project scope). */

import { isPaperSpineSkill, PAPERSPINE_SKILLS_URL } from "@/lib/paperspine";

export type DefaultSkillPackId =
  | "paper-spine"
  | "academic-research-skills"
  | "nature-skills"
  | "paper-humanizer-skill";

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

export const PAPER_HUMANIZER_SKILLS_URL =
  "https://github.com/crabin/paper-humanizer-skill";

export const PAPER_HUMANIZER_SKILL_SUMMARY =
  "中英文学术文本润色与人性化 skill，用于去除 AI 生成的痕迹，同时严格保持事实准确性。";

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
    id: "paper-humanizer-skill",
    sourceUrl: PAPER_HUMANIZER_SKILLS_URL,
    markerFolders: ["paper-humanizer", "paper-humanizer-skill"],
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
    case "paper-humanizer-skill":
      return "paper-humanizer-skill";
    case "imported":
      return "Uncategorized";
  }
}

export function skillCatalogDescription(folder: string): string | null {
  const key = folder.trim().toLowerCase();
  if (
    key === "paper-humanizer" ||
    key === "paper-humanizer-skill" ||
    key.startsWith("paper-humanizer-")
  ) {
    return PAPER_HUMANIZER_SKILL_SUMMARY;
  }
  return null;
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
  if (pack.id === "paper-humanizer-skill") {
    return key === "paper-humanizer" || key.startsWith("paper-humanizer");
  }
  return false;
}

function skillKeys(skill: { folder: string; name?: string }): string[] {
  const keys = [skill.folder, skill.name ?? ""]
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return [...new Set(keys)];
}

function githubRepoPath(url: string): { owner: string; repo: string } | null {
  const trimmed = url.trim();
  const match =
    trimmed.match(/raw\.githubusercontent\.com\/([^/]+)\/([^/#?]+)/i) ??
    trimmed.match(/github\.com\/([^/]+)\/([^/#?]+)/i);
  if (!match?.[1] || !match[2]) return null;
  return {
    owner: match[1].toLowerCase(),
    repo: match[2].replace(/\.git$/i, "").toLowerCase(),
  };
}

/** True when the install URL is an official K-Dense-AI scientific skills repo. */
export function isScientificAgentSkillsSource(
  sourceUrl?: string | null,
): boolean {
  const parsed = sourceUrl ? githubRepoPath(sourceUrl) : null;
  return (
    parsed?.owner === "k-dense-ai" &&
    (parsed.repo === "scientific-agent-skills" ||
      parsed.repo === "claude-scientific-skills")
  );
}

/** Map an install URL onto one of the default packs. */
export function defaultPackIdFromSourceUrl(
  sourceUrl?: string | null,
): DefaultSkillPackId | null {
  const trimmed = sourceUrl?.trim();
  if (!trimmed) return null;
  const parsed = githubRepoPath(trimmed);
  if (!parsed) return null;
  for (const pack of DEFAULT_SKILL_PACKS) {
    const packRepo = githubRepoPath(pack.sourceUrl);
    if (
      packRepo &&
      packRepo.owner === parsed.owner &&
      packRepo.repo === parsed.repo
    ) {
      return pack.id;
    }
  }
  return null;
}

export const SCIENTIFIC_URL_PACK_ID = "url:scientific-agent-skills";

export interface InstalledSourcePack {
  id: string;
  name: string;
  kind: "url" | "folder";
  refreshUrl?: string;
  sourceFolder?: string;
}

/** Slash-normalize a recorded folder path without changing case. */
export function normalizeSkillSourceFolder(path: string): string {
  let value = path.trim().replace(/\\/g, "/");
  while (value.endsWith("/")) value = value.slice(0, -1);
  return value;
}

export function folderPackId(path: string): string {
  return `folder:${normalizeSkillSourceFolder(path)}`;
}

export function folderPackName(path: string): string {
  const normalized = normalizeSkillSourceFolder(path);
  const parts = normalized.split("/").filter((part) => part.length > 0);
  return parts[parts.length - 1] || normalized || path.trim();
}

/**
 * Group a non-default import by GitHub repository or recorded folder.
 * scientific-agent-skills stays one URL pack so an existing install can be
 * removed, but it is not a default pack.
 */
export function installedSourcePack(skill: {
  sourceUrl?: string | null;
  sourceFolder?: string | null;
}): InstalledSourcePack | null {
  const url = skill.sourceUrl?.trim();
  if (url) {
    if (isScientificAgentSkillsSource(url)) {
      return {
        id: SCIENTIFIC_URL_PACK_ID,
        name: "scientific-agent-skills",
        kind: "url",
        refreshUrl: SCIENTIFIC_AGENT_SKILLS_URL,
      };
    }
    const repo = githubRepoPath(url);
    if (repo) {
      return {
        id: `url:${repo.owner}/${repo.repo}`,
        name: repo.repo,
        kind: "url",
        refreshUrl: githubRepoHome(url),
      };
    }
    return {
      id: `url:${url}`,
      name: url,
      kind: "url",
      refreshUrl: url,
    };
  }
  const folder = skill.sourceFolder?.trim();
  if (!folder) return null;
  return {
    id: folderPackId(folder),
    name: folderPackName(folder),
    kind: "folder",
    sourceFolder: folder,
  };
}

/** Group a skill by install URL, then by folder when no URL was recorded. */
export function resolveSkillPackId(
  skill: {
    folder: string;
    name?: string;
    sourceUrl?: string | null;
    sourceFolder?: string | null;
  },
  _scientificFolders?: ReadonlySet<string>,
): SkillPackGroupId {
  // A recorded folder import is never an official pack, even when its
  // folder or skill name matches a default-pack marker.
  if (skill.sourceFolder?.trim()) {
    return IMPORTED_SKILL_PACK_ID;
  }
  if (skill.sourceUrl?.trim()) {
    return (
      defaultPackIdFromSourceUrl(skill.sourceUrl) ?? IMPORTED_SKILL_PACK_ID
    );
  }
  if (
    isPaperSpineSkill({
      folder: skill.folder,
      name: skill.name ?? skill.folder,
    })
  ) {
    return "paper-spine";
  }
  const keys = skillKeys(skill);
  const academic = DEFAULT_SKILL_PACKS.find(
    (pack) => pack.id === "academic-research-skills",
  );
  const nature = DEFAULT_SKILL_PACKS.find(
    (pack) => pack.id === "nature-skills",
  );
  const humanizer = DEFAULT_SKILL_PACKS.find(
    (pack) => pack.id === "paper-humanizer-skill",
  );
  if (academic && keys.some((key) => folderMatchesPack(key, academic))) {
    return "academic-research-skills";
  }
  if (nature && keys.some((key) => folderMatchesPack(key, nature))) {
    return "nature-skills";
  }
  if (humanizer && keys.some((key) => folderMatchesPack(key, humanizer))) {
    return "paper-humanizer-skill";
  }
  return "imported";
}

export function isDefaultPackSkill(
  skill: { folder: string; name?: string; sourceUrl?: string | null },
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
