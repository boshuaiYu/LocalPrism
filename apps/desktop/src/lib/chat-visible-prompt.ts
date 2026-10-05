import {
  BUILTIN_AGENT_PRESETS,
  isBuiltinAgentPresetId,
} from "@/lib/agent-presets";

const COMPRESSION_LEAD =
  "The earlier part of this conversation was compressed. Continue from this summary and the recent turns.";
const REPLY_HEADER =
  /^\[Reply mode: ([a-z0-9-]+)\. Follow this speaking style for this turn only\. Do not rewrite earlier messages\.\][ \t]*(?:\n|$)/;

const FILE_LINE = /^\[Currently open file: [^\n\]]*\][ \t]*(?:\n|$)/;
const SELECTION_LINE = /^\[Selection: ([^\n\]]*)\][ \t]*(?:\n|$)/;
const SELECTED_BLOCK = /^\[Selected text:\n[\s\S]*?\n\][ \t]*(?:\n|$)/;
const SYSTEM_REMINDER =
  /^<system-reminder>[\s\S]*?<\/system-reminder>[ \t]*(?:\n|$)/;
const REPLY_END_LINE = /(?:^|\n)\[\/Reply mode\][ \t]*(?:\n|$)/;
const RECENT_ROLE_LINE = /^(?:User|Assistant|Note|Summary): /;

function lineTokenIndex(text: string, token: string): number {
  if (text.startsWith(token)) return 0;
  const at = text.indexOf(`\n${token}`);
  return at >= 0 ? at + 1 : -1;
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

function matchReplyHeader(text: string): RegExpExecArray | null {
  const match = REPLY_HEADER.exec(text);
  if (!match?.[1] || !isBuiltinAgentPresetId(match[1])) return null;
  return match;
}

function hasExactReplyHeaderLine(text: string): boolean {
  return text.split("\n").some((line) => matchReplyHeader(line) !== null);
}

function prefixLooksInjected(prefix: string): boolean {
  const trimmed = prefix.trim();
  if (!trimmed) return true;
  if (trimmed.startsWith(COMPRESSION_LEAD)) return true;
  if (hasExactReplyHeaderLine(trimmed)) return true;
  if (REPLY_END_LINE.test(trimmed)) return true;
  return instructionFingerprints().some((fingerprint) =>
    trimmed.includes(fingerprint),
  );
}

function knownInstructionBodies(): string[] {
  return BUILTIN_AGENT_PRESETS.map((preset) => preset.instructions.trim())
    .filter((instructions) => instructions.length > 0)
    .sort((left, right) => right.length - left.length);
}

/** Only the exact leading wrapper `replyStylePrefix` writes. */
function stripLeadingReplyMode(text: string): string {
  const header = matchReplyHeader(text);
  if (!header) return text;
  let rest = text.slice(header[0].length);
  const end = REPLY_END_LINE.exec(rest);
  if (end) {
    rest = rest.slice(end.index + end[0].length);
    return rest.replace(/^\n+/, "");
  }
  const body = rest.trimStart();
  for (const instructions of knownInstructionBodies()) {
    if (body.startsWith(instructions)) {
      rest = body.slice(instructions.length);
      break;
    }
  }
  return rest.replace(/^\n+/, "");
}

/**
 * Compression carryover is a leading block: the lead sentence, `Summary:`,
 * and optional `Recent turns:` role lines. The user text follows that block.
 */
function stripLeadingCompression(text: string): string {
  if (!text.startsWith(COMPRESSION_LEAD)) return text;
  let rest = text.slice(COMPRESSION_LEAD.length).replace(/^\n+/, "");
  if (!rest.startsWith("Summary:")) return text;
  rest = rest.slice("Summary:".length).replace(/^\n/, "");

  const recentAt = rest.search(/(?:^|\n\n)Recent turns:\n/);
  if (recentAt >= 0) {
    const recentStart = rest.indexOf("Recent turns:\n", recentAt);
    const afterHeader = rest.slice(recentStart + "Recent turns:\n".length);
    const lines = afterHeader.split("\n");
    let index = 0;
    while (index < lines.length) {
      const line = lines[index] ?? "";
      if (line === "") {
        index += 1;
        while (index < lines.length && lines[index] === "") index += 1;
        return lines.slice(index).join("\n");
      }
      if (RECENT_ROLE_LINE.test(line)) {
        index += 1;
        continue;
      }
      return lines.slice(index).join("\n");
    }
    return "";
  }

  const split = rest.search(/\n\n/);
  if (split < 0) return text;
  return rest.slice(split).replace(/^\n+/, "");
}

function peelLeadingContext(text: string): {
  selectionLabel: string | null;
  body: string;
  peeled: boolean;
} {
  let rest = text;
  let selectionLabel: string | null = null;
  let peeled = false;
  let sawFile = false;
  for (let guard = 0; guard < 16; guard += 1) {
    const trimmed = rest.replace(/^\n+/, "");
    if (trimmed !== rest) rest = trimmed;
    const reminder = SYSTEM_REMINDER.exec(rest);
    if (reminder) {
      rest = rest.slice(reminder[0].length);
      peeled = true;
      continue;
    }
    const file = FILE_LINE.exec(rest);
    if (file) {
      rest = rest.slice(file[0].length);
      peeled = true;
      sawFile = true;
      continue;
    }
    if (!sawFile) break;
    const selection = SELECTION_LINE.exec(rest);
    if (selection) {
      const label = selection[1]?.trim();
      if (label) selectionLabel = label;
      rest = rest.slice(selection[0].length);
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
 * History bubbles show the text the person wrote. Open-file headers,
 * selections, reply-mode instructions, and compression carryover stay in
 * the model prompt. Live bubbles already store that raw text, so callers
 * must not run this again on them.
 */
export function visibleUserPromptText(text: string): string {
  if (!text) return text;
  const normalized = text.replace(/\r\n/g, "\n").replace(/^\n+/, "");
  if (!normalized) return text;

  let working = stripLeadingReplyMode(normalized);
  let changed = working !== normalized;

  const withoutCompression = stripLeadingCompression(working);
  if (withoutCompression !== working) {
    working = withoutCompression;
    changed = true;
  }

  const anchor = lineTokenIndex(working, "[Currently open file:");
  if (anchor > 0 && prefixLooksInjected(working.slice(0, anchor))) {
    working = working.slice(anchor);
    changed = true;
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
