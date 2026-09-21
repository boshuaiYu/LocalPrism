import { isSkillInstructionDump } from "@/lib/skill-tool-result";

export const MAX_SLASH_SUBSTITUTION_CHARS = 8_000;

export type SlashCommandLike = {
  name: string;
  full_command: string;
  scope: string;
  content: string;
  accepts_arguments: boolean;
  description?: string | null;
};

function knownSlashNames(commands: SlashCommandLike[]): string[] {
  return Array.from(
    new Set(commands.map((command) => command.full_command.replace(/^\//, ""))),
  )
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
}

function splitKnownSlashName(
  token: string,
  commands: SlashCommandLike[],
): { name: string; glued: string } {
  const names = knownSlashNames(commands);
  const exact = names.find(
    (name) => name.toLowerCase() === token.toLowerCase(),
  );
  if (exact) return { name: exact, glued: "" };

  for (const name of names) {
    if (token.length <= name.length) continue;
    if (!token.toLowerCase().startsWith(name.toLowerCase())) continue;
    const glued = token.slice(name.length);
    if (!glued || /^[-a-zA-Z0-9]/.test(glued)) continue;
    return { name, glued };
  }
  return { name: token, glued: "" };
}

export function parseLeadingSlashCommand(
  input: string,
  commands: SlashCommandLike[] = [],
): { name: string; args: string } | null {
  const trimmed = input.trim();
  const slashMatch = trimmed.match(/^\/(\S+)\s*([\s\S]*)/);
  if (!slashMatch) return null;
  const split = splitKnownSlashName(slashMatch[1], commands);
  const args = `${split.glued} ${slashMatch[2]}`.trim();
  return { name: split.name, args };
}

function normalizeComparableText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** True when leftover text is the command's own hints/questionnaire, not user notes. */
export function isCommandHintLeftover(
  args: string,
  command: SlashCommandLike,
): boolean {
  const leftover = args.trim();
  if (!leftover) return true;
  if (leftover.includes("$ARGUMENTS")) return true;

  const leftoverNorm = normalizeComparableText(leftover);
  if (!leftoverNorm) return true;

  const candidates = [command.content, command.description ?? ""]
    .map((value) => value?.trim() ?? "")
    .filter(Boolean);

  for (const candidate of candidates) {
    const candidateNorm = normalizeComparableText(candidate);
    if (!candidateNorm) continue;
    if (leftoverNorm === candidateNorm) return true;

    const firstLine = candidate
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (firstLine && normalizeComparableText(firstLine) === leftoverNorm) {
      return true;
    }

    // Copied questionnaire / SKILL.md excerpt — not a short user note.
    if (leftoverNorm.length >= 24 && candidateNorm.includes(leftoverNorm)) {
      return true;
    }
    if (candidateNorm.length >= 24 && leftoverNorm.includes(candidateNorm)) {
      return true;
    }
  }

  return false;
}

export function resolveUserSlashArguments(
  args: string,
  command: SlashCommandLike,
): string {
  return isCommandHintLeftover(args, command) ? "" : args.trim();
}

/** Composer value after picking a slash command from the picker. */
export function resolveSlashComposerValue(
  currentInput: string,
  command: SlashCommandLike,
): string {
  const parsed = parseLeadingSlashCommand(currentInput, [command]);
  if (!parsed) {
    return `${command.full_command} `;
  }
  const args = resolveUserSlashArguments(parsed.args, command);
  return args ? `${command.full_command} ${args}` : `${command.full_command} `;
}

function commandMatchesName(command: SlashCommandLike, name: string): boolean {
  return (
    command.full_command.replace(/^\//, "").toLowerCase() === name.toLowerCase()
  );
}

function matchSlashCommand(
  input: string,
  commands: SlashCommandLike[],
): { command: SlashCommandLike; args: string } | null {
  const parsed = parseLeadingSlashCommand(input.trim(), commands);
  if (!parsed || commands.length === 0) {
    return null;
  }
  const matches = commands.filter((command) =>
    commandMatchesName(command, parsed.name),
  );
  if (matches.length === 0) {
    return null;
  }
  const command = matches.find((item) => item.scope === "skill") ?? matches[0];
  return {
    command,
    args: resolveUserSlashArguments(parsed.args, command),
  };
}

function visibleSlashLabel(command: SlashCommandLike, args: string): string {
  return args ? `${command.full_command} ${args}` : command.full_command;
}

/** Chat bubble / composer label. Never the expanded SKILL.md or command body. */
export function resolveVisibleSlashMessage(
  input: string,
  commands: SlashCommandLike[],
): string {
  const trimmed = input.trim();
  const matched = matchSlashCommand(trimmed, commands);
  if (!matched) {
    return trimmed;
  }
  return visibleSlashLabel(matched.command, matched.args);
}

/** Resolve composer input into the prompt that should be sent to the runtime. */
export function resolveOutgoingSlashPrompt(
  input: string,
  commands: SlashCommandLike[],
): string {
  const trimmed = input.trim();
  const matched = matchSlashCommand(trimmed, commands);
  if (!matched) {
    return trimmed;
  }

  const { command, args } = matched;

  // Skills stay as /name so Claude can use the Skill tool. PaperSpine is
  // rewritten later in Rust so the hostile host orchestrator is never injected.
  if (command.scope === "skill" || isSkillInstructionDump(command.content)) {
    return visibleSlashLabel(command, args);
  }

  let content = command.content;
  if (command.accepts_arguments) {
    content = content.replace(/\$ARGUMENTS/g, args);
  }
  if (content.length <= MAX_SLASH_SUBSTITUTION_CHARS) {
    return content;
  }
  const notes = args || trimmed;
  return `${content.slice(0, MAX_SLASH_SUBSTITUTION_CHARS)}\n\n[LocalPrism truncated this slash command because it was too large. Continue from the user's notes: ${notes}]`;
}
