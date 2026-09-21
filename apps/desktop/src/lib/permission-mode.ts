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
