import { isSkillToolName } from "@/lib/skill-tool-result";

/** Tauri event emitted after a settings or marketplace skill install/delete. */
export const SKILLS_CHANGED_EVENT = "skills-changed";

/** Browser event after the skills store finishes reloading. */
export const SKILLS_LIST_UPDATED_EVENT = "localprism-skills-list-updated";

export function notifySkillsListUpdated(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(SKILLS_LIST_UPDATED_EVENT));
}

function toolRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object") return {};
  return input as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

export function pathLooksLikeSkillInstall(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  if (!normalized.includes("skill")) return false;
  return (
    normalized.endsWith("/skill.md") ||
    normalized.includes("/claude-home/skills/") ||
    normalized.includes("/.localprism/skills/") ||
    normalized.includes("/skills/")
  );
}

function commandInstallsSkill(command: string): boolean {
  const text = command.toLowerCase();
  if (!text.includes("skill")) return false;
  return (
    text.includes("claude-home/skills") ||
    text.includes(".localprism/skills") ||
    text.includes("skill.md") ||
    /\b(git clone|cp |copy |mkdir |mv |install)\b/.test(text)
  );
}

const WRITE_TOOLS = new Set([
  "write",
  "edit",
  "multiedit",
  "notebookedit",
  "applypatch",
  "apply_patch",
]);

/**
 * Chat installs skills by running the Skill tool or by writing SKILL.md.
 * Either one should reload the Skills list.
 */
export function shouldRefreshSkillsAfterTool(
  name?: string | null,
  input?: unknown,
): boolean {
  if (isSkillToolName(name)) return true;
  const normalized = name?.trim().toLowerCase() ?? "";
  const record = toolRecord(input);
  const paths = ["file_path", "filePath", "path", "target"]
    .map((key) => stringField(record, key))
    .filter((value) => value.length > 0);
  if (
    WRITE_TOOLS.has(normalized) &&
    paths.some((path) => pathLooksLikeSkillInstall(path))
  ) {
    return true;
  }
  if (
    normalized === "bash" ||
    normalized === "shell" ||
    normalized === "powershell"
  ) {
    const command =
      stringField(record, "command") || stringField(record, "cmd");
    return commandInstallsSkill(command);
  }
  return false;
}
