import { BUILTIN_AGENT_PRESETS } from "@/lib/agent-presets";

const REPLY_MODE_START = "[Reply mode:";
const REPLY_MODE_END = "[/Reply mode]";
const COMPRESSION_LEAD =
  "The earlier part of this conversation was compressed.";

const CONTEXT_TOKENS = [
  "[Currently open file:",
  "[File:",
  "[Selection:",
  "[Selected text:",
] as const;

const FILE_LINE = /^\[(?:Currently open file|File): [^\n\]]*\][ \t]*(?:\n|$)/;
const SELECTION_LINE = /^\[Selection: ([^\n\]]*)\][ \t]*(?:\n|$)/;
const SELECTED_BLOCK = /^\[Selected text:\n[\s\S]*?\n\][ \t]*(?:\n|$)/;
const SYSTEM_REMINDER =
  /^<system-reminder>[\s\S]*?<\/system-reminder>[ \t]*(?:\n|$)/;

function lineTokenIndex(text: string, token: string): number {
  if (text.startsWith(token)) return 0;
  const at = text.indexOf(`\n${token}`);
  return at >= 0 ? at + 1 : -1;
}

function earliestContextIndex(text: string): number {
  let best = -1;
  for (const token of CONTEXT_TOKENS) {
    const index = lineTokenIndex(text, token);
    if (index >= 0 && (best < 0 || index < best)) best = index;
  }
  return best;
}

function hasHiddenContext(text: string): boolean {
  return (
    text.includes(REPLY_MODE_START) ||
    text.includes(REPLY_MODE_END) ||
    text.includes(COMPRESSION_LEAD) ||
    text.includes("<system-reminder>") ||
    earliestContextIndex(text) >= 0
  );
}

function instructionFingerprints(): string[] {
  const fingerprints = [
    "保持原意、术语、数字、单位、统计量",
    "原样保留 LaTeX",
    "你是一个学术 LaTeX 论文润色的智能体",
    "你是一个学术文本去模板化的智能体",
    "你是一个论文审稿的智能体",
  ];
  for (const preset of BUILTIN_AGENT_PRESETS) {
    const head = preset.instructions.trim().slice(0, 48);
    if (head) fingerprints.push(head);
  }
  return fingerprints;
}

function prefixLooksInjected(prefix: string): boolean {
  const trimmed = prefix.trim();
  if (!trimmed) return true;
  if (trimmed.includes(REPLY_MODE_START)) return true;
  if (trimmed.includes(REPLY_MODE_END)) return true;
  if (trimmed.includes(COMPRESSION_LEAD)) return true;
  return instructionFingerprints().some((fingerprint) =>
    trimmed.includes(fingerprint),
  );
}

function stripMarkedReplyMode(text: string): string {
  const start = text.indexOf(REPLY_MODE_START);
  if (start < 0) return text;
  const end = text.indexOf(REPLY_MODE_END, start);
  if (end < 0) return text;
  return `${text.slice(0, start)}${text.slice(end + REPLY_MODE_END.length)}`;
}

function knownInstructionBodies(): string[] {
  return BUILTIN_AGENT_PRESETS.map((preset) => preset.instructions.trim())
    .filter((instructions) => instructions.length > 0)
    .sort((left, right) => right.length - left.length);
}

function stripUnmarkedReplyMode(text: string): string {
  const leading = text.match(/^\s*/)?.[0] ?? "";
  const trimmed = text.slice(leading.length);
  const header = trimmed.match(/^\[Reply mode:[^\n]*\]\n?/);
  if (!header) return text;
  let rest = trimmed.slice(header[0].length);
  const body = rest.trimStart();
  for (const instructions of knownInstructionBodies()) {
    if (body.startsWith(instructions)) {
      rest = body.slice(instructions.length);
      break;
    }
  }
  return `${leading}${rest}`;
}

function peelLeadingContext(text: string): {
  selectionLabel: string | null;
  body: string;
  peeled: boolean;
} {
  let rest = text;
  let selectionLabel: string | null = null;
  let peeled = false;
  for (let guard = 0; guard < 16; guard += 1) {
    const trimmed = rest.replace(/^\n+/, "");
    if (trimmed !== rest) rest = trimmed;
    const reminder = SYSTEM_REMINDER.exec(rest);
    if (reminder) {
      rest = rest.slice(reminder[0].length);
      peeled = true;
      continue;
    }
    const selection = SELECTION_LINE.exec(rest);
    if (selection) {
      const label = selection[1]?.trim();
      if (label) selectionLabel = label;
      rest = rest.slice(selection[0].length);
      peeled = true;
      continue;
    }
    const file = FILE_LINE.exec(rest);
    if (file) {
      rest = rest.slice(file[0].length);
      peeled = true;
      continue;
    }
    const selected = SELECTED_BLOCK.exec(rest);
    if (selected) {
      rest = rest.slice(selected[0].length);
      peeled = true;
      continue;
    }
    break;
  }
  return { selectionLabel, body: rest.replace(/^\n+/, ""), peeled };
}

/**
 * User bubbles show the text the person wrote. Open-file headers, selections,
 * reply-mode instructions, and compression carryover stay in the model prompt.
 */
export function visibleUserPromptText(text: string): string {
  if (!text) return text;
  const normalized = text.replace(/\r\n/g, "\n");
  if (!hasHiddenContext(normalized)) return text;

  let working = stripMarkedReplyMode(normalized);
  let changed = working !== normalized;

  const anchor = earliestContextIndex(working);
  if (anchor > 0) {
    const lineEnd = working.indexOf("\n", anchor);
    const line =
      lineEnd >= 0 ? working.slice(anchor, lineEnd) : working.slice(anchor);
    const ambient =
      line.startsWith("[Currently open file:") &&
      line.includes("Location only");
    if (ambient || prefixLooksInjected(working.slice(0, anchor))) {
      working = working.slice(anchor);
      changed = true;
    }
  } else if (anchor < 0) {
    const stripped = stripUnmarkedReplyMode(working);
    if (stripped !== working) {
      working = stripped;
      changed = true;
    }
  }

  const peeled = peelLeadingContext(working);
  if (!changed && !peeled.peeled) return text;
  const body = peeled.body;
  if (!body.trim()) return text;
  if (!peeled.selectionLabel) return body;
  if (
    body === peeled.selectionLabel ||
    body.startsWith(`${peeled.selectionLabel}\n`)
  ) {
    return body;
  }
  return `${peeled.selectionLabel}\n${body}`;
}
