export const PERMISSION_MODES = [
  "acceptEdits",
  "bypassPermissions",
  "plan",
] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const DEFAULT_PERMISSION_MODE: PermissionMode = "acceptEdits";

const LEGACY_PERMISSION_MODES: Record<string, PermissionMode> = {
  default: "acceptEdits",
  dontAsk: "acceptEdits",
};

export const PERMISSION_MODE_OPTIONS: readonly {
  id: PermissionMode;
  label: string;
  description: string;
}[] = [
  {
    id: "acceptEdits",
    // Host path-guard must confirm the resolved path stays in-project
    // before these auto-accepted edits run.
    label: "Allow edits",
    description:
      "Claude Code auto-accepts file edits. Bash, web, and other tools ask you here before they run.",
  },
  {
    id: "bypassPermissions",
    label: "Full access",
    description:
      "Same as Claude Code bypassPermissions: run tools without asking. Use this if commands must execute.",
  },
  {
    id: "plan",
    label: "Plan only",
    description:
      "Same as Claude Code plan mode: read and plan this turn, do not edit or run commands.",
  },
];

export function isPermissionMode(
  value: string | null | undefined,
): value is PermissionMode {
  return PERMISSION_MODES.includes(value as PermissionMode);
}

export function normalizePermissionMode(
  value: string | null | undefined,
): PermissionMode {
  if (isPermissionMode(value)) return value;
  if (value && value in LEGACY_PERMISSION_MODES) {
    return LEGACY_PERMISSION_MODES[value];
  }
  return DEFAULT_PERMISSION_MODE;
}

export function isShellToolName(toolName: string | null | undefined): boolean {
  const normalized = toolName?.trim().toLowerCase();
  return normalized === "bash" || normalized === "powershell";
}

export function toolNameFromApprovalTitle(
  title: string | null | undefined,
): string | null {
  const match = title?.trim().match(/^Allow\s+(.+?)\s*\??$/i);
  const name = match?.[1]?.trim();
  return name ? name : null;
}

export function isScopedShellRuleContent(
  content: string | null | undefined,
): boolean {
  const trimmed = content?.trim() ?? "";
  return trimmed.length > 0 && trimmed !== "*" && trimmed !== "**";
}

function commandFromDetails(details: unknown): string {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return "";
  }
  const command = (details as { command?: unknown }).command;
  return typeof command === "string" ? command.trim() : "";
}

function hasScopedShellSuggestion(permissions: unknown): boolean {
  if (!Array.isArray(permissions)) return false;
  for (const item of permissions) {
    if (!item || typeof item !== "object") continue;
    const rules = (item as { rules?: unknown }).rules;
    if (!Array.isArray(rules)) continue;
    for (const rule of rules) {
      if (!rule || typeof rule !== "object") continue;
      const toolName = (rule as { toolName?: unknown }).toolName;
      const content = (rule as { ruleContent?: unknown }).ruleContent;
      if (
        typeof toolName === "string" &&
        isShellToolName(toolName) &&
        typeof content === "string" &&
        isScopedShellRuleContent(content)
      ) {
        return true;
      }
    }
  }
  return false;
}

/** Session persistence is only offered when it will not become tool-wide shell. */
export function canPersistSessionApproval(request: {
  title?: string | null;
  command?: string | null;
  permissions?: unknown;
  details?: unknown;
}): boolean {
  const toolName = toolNameFromApprovalTitle(request.title ?? "") ?? "";
  if (!isShellToolName(toolName)) {
    return true;
  }
  if (hasScopedShellSuggestion(request.permissions)) {
    return true;
  }
  const command =
    request.command?.trim() || commandFromDetails(request.details);
  return command.length > 0;
}
