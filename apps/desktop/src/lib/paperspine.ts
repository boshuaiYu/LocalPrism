import type { RuntimeSkill } from "@/runtime/types";

/** Claude-facing skills inside the PaperSpine repo (avoids duplicated Codex/Hermes copies). */
export const PAPERSPINE_SKILLS_URL =
  "https://github.com/WUBING2023/PaperSpine/tree/main/dist/claude/skills";

export function isPaperSpineSkill(
  skill: Pick<RuntimeSkill, "folder" | "name">,
): boolean {
  const folder = skill.folder.toLowerCase();
  const name = skill.name.toLowerCase();
  return (
    folder.includes("paper-spine") ||
    folder.includes("paperspine") ||
    name.includes("paper spine") ||
    name.includes("paperspine")
  );
}

export function isPaperSpineSlashCommand(command: string): boolean {
  const name = command.trim().replace(/^\//, "").toLowerCase();
  return name.includes("paper-spine") || name.includes("paperspine");
}
