export interface CompileLogAnchor {
  file?: string;
  line?: number;
  message: string;
}

export interface CompileFixSourceFile {
  relativePath: string;
  content?: string | null;
}

export interface CompileFixPrompt {
  prompt: string;
  displayPrompt: string;
  anchors: CompileLogAnchor[];
}

export const COMPILE_FIX_WITH_AI_LABEL = "Fix with AI";

const TEX_FILE = String.raw`(?:[A-Za-z]:[\\/])?(?:\.{1,2}[\\/])?(?:[\w.@+-]+[\\/])*[\w.@+-]+\.(?:tex|ltx|sty|cls|bib|bst|dtx|ins)`;
const FILE_LINE_RE = new RegExp(
  String.raw`(?:^|[\s:(])(${TEX_FILE}):(\d+)(?::\d+)?:?\s*(.*)$`,
);
const OPEN_FILE_RE = new RegExp(String.raw`\((${TEX_FILE})`, "g");
const TEX_LINE_RE = /^l\.(\d+)\b/;
const EXCERPT_RADIUS = 6;
const MAX_LOG_CHARS = 12_000;

interface PositionedAnchor extends CompileLogAnchor {
  index: number;
}

function normalizeReportedFile(raw: string): string {
  return raw
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^[A-Za-z]:\//, "")
    .replace(/^\/+/, "");
}

function normalizeProjectPath(raw: string): string {
  return raw.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function uniqueOpenFiles(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(OPEN_FILE_RE)) {
    const file = normalizeReportedFile(match[1] ?? "");
    if (file && !found.includes(file)) found.push(file);
  }
  return found;
}

function anchorKey(anchor: CompileLogAnchor): string {
  return `${anchor.file ?? ""}\0${anchor.line ?? ""}\0${anchor.message}`;
}

export function parseCompileLogAnchors(log: string): CompileLogAnchor[] {
  if (!log.trim()) return [];
  const lines = log.split(/\r?\n/);
  const positioned: PositionedAnchor[] = [];

  for (let index = 0; index < lines.length; index++) {
    const match = lines[index]?.match(FILE_LINE_RE);
    if (!match) continue;
    const line = Number(match[2]);
    const message = match[3]?.trim() ?? "";
    if (!message || !Number.isInteger(line) || line < 1) continue;
    positioned.push({
      index,
      file: normalizeReportedFile(match[1] ?? ""),
      line,
      message,
    });
  }

  for (let index = 0; index < lines.length; index++) {
    const current = lines[index] ?? "";
    if (!current.startsWith("!")) continue;
    const message = current.slice(1).trim();
    if (!message) continue;

    let lookaheadEnd = Math.min(lines.length, index + 7);
    for (let cursor = index + 1; cursor < lookaheadEnd; cursor++) {
      if ((lines[cursor] ?? "").startsWith("!")) {
        lookaheadEnd = cursor;
        break;
      }
    }
    const windowLines = lines.slice(index, lookaheadEnd);
    if (windowLines.some((line) => FILE_LINE_RE.test(line))) continue;

    let reportedLine: number | undefined;
    for (const line of windowLines) {
      const lineMatch = line.match(TEX_LINE_RE);
      if (!lineMatch) continue;
      const parsed = Number(lineMatch[1]);
      if (Number.isInteger(parsed) && parsed >= 1) {
        reportedLine = parsed;
        break;
      }
    }

    let file: string | undefined;
    if (reportedLine) {
      const context = lines
        .slice(Math.max(0, index - 3), lookaheadEnd)
        .join("\n");
      const files = uniqueOpenFiles(context);
      if (files.length === 1) file = files[0];
    }

    positioned.push({
      index,
      ...(file ? { file } : {}),
      ...(reportedLine ? { line: reportedLine } : {}),
      message,
    });
  }

  positioned.sort((left, right) => left.index - right.index);
  const seen = new Set<string>();
  const anchors: CompileLogAnchor[] = [];
  for (const item of positioned) {
    const anchor: CompileLogAnchor = { message: item.message };
    if (item.file) anchor.file = item.file;
    if (item.line) anchor.line = item.line;
    const key = anchorKey(anchor);
    if (seen.has(key)) continue;
    seen.add(key);
    anchors.push(anchor);
  }
  return anchors;
}

export function formatAnchorBullet(anchor: CompileLogAnchor): string {
  const message = anchor.message.trim();
  if (anchor.file && anchor.line) {
    return `${anchor.file}:${anchor.line} — ${message}`;
  }
  if (anchor.file) return `${anchor.file} — ${message}`;
  if (anchor.line) return `line ${anchor.line} — ${message}`;
  return message;
}

function stripCompilePreamble(log: string): string {
  return log.replace(/^Compilation failed(?: \([^)]*\))?\s*\n+/, "");
}

export function compileErrorSummaries(log: string): string[] {
  const anchors = parseCompileLogAnchors(log);
  if (anchors.length > 0) return anchors.map(formatAnchorBullet);

  const detail = stripCompilePreamble(log).trim();
  if (!detail) return ["Compilation failed"];
  return detail
    .split(/\n{2,}/)
    .map((chunk) => chunk.replace(/\s+/g, " ").trim())
    .filter((chunk) => chunk.length > 0)
    .slice(0, 5);
}

export function parseDisplayedCompileBullet(line: string): {
  message: string;
  location?: string;
} {
  const trimmed = line.trim().replace(/^- /, "");
  const located = trimmed.match(/^(.+?):(\d+) — (.+)$/);
  if (located) {
    return {
      message: located[3] ?? trimmed,
      location: `${located[1]}:${located[2]}`,
    };
  }
  const lineOnly = trimmed.match(/^line (\d+) — (.+)$/);
  if (lineOnly) {
    return {
      message: lineOnly[2] ?? trimmed,
      location: `line ${lineOnly[1]}`,
    };
  }
  const fileOnly = trimmed.match(
    /^(.+?\.(?:tex|ltx|sty|cls|bib|bst|dtx|ins)) — (.+)$/i,
  );
  if (fileOnly) {
    return {
      message: fileOnly[2] ?? trimmed,
      location: fileOnly[1],
    };
  }
  return { message: trimmed };
}

function findProjectFile(
  files: CompileFixSourceFile[],
  reported: string,
):
  | { status: "found"; file: CompileFixSourceFile }
  | { status: "missing" }
  | { status: "ambiguous" } {
  const target = normalizeProjectPath(reported).toLowerCase();
  const exact = files.filter(
    (file) => normalizeProjectPath(file.relativePath).toLowerCase() === target,
  );
  if (exact.length === 1 && exact[0])
    return { status: "found", file: exact[0] };
  if (exact.length > 1) return { status: "ambiguous" };

  const suffix = files.filter((file) => {
    const relative = normalizeProjectPath(file.relativePath).toLowerCase();
    return target.endsWith(`/${relative}`) || relative.endsWith(`/${target}`);
  });
  if (suffix.length === 1 && suffix[0]) {
    return { status: "found", file: suffix[0] };
  }
  if (suffix.length > 1) return { status: "ambiguous" };
  return { status: "missing" };
}

function formatExcerpt(content: string, focusLine: number): string | null {
  const lines = content.split("\n");
  if (focusLine < 1 || focusLine > lines.length) return null;
  const start = Math.max(1, focusLine - EXCERPT_RADIUS);
  const end = Math.min(lines.length, focusLine + EXCERPT_RADIUS);
  const width = String(end).length;
  const body: string[] = [];
  for (let line = start; line <= end; line++) {
    body.push(`${String(line).padStart(width, " ")}| ${lines[line - 1] ?? ""}`);
  }
  return body.join("\n");
}

function sourceSection(
  anchors: CompileLogAnchor[],
  files: CompileFixSourceFile[],
): string {
  const located = anchors.filter(
    (anchor): anchor is CompileLogAnchor & { file: string; line: number } =>
      Boolean(anchor.file && anchor.line),
  );
  if (located.length === 0) {
    return "No source excerpt was attached. The log did not name a project file and line that could be opened.";
  }

  const parts: string[] = [];
  const seen = new Set<string>();
  for (const anchor of located) {
    const where = `${anchor.file}:${anchor.line}`;
    if (seen.has(where)) continue;
    seen.add(where);
    const resolved = findProjectFile(files, anchor.file);
    if (resolved.status === "ambiguous") {
      parts.push(
        `No source excerpt was attached for ${where} because that path matches more than one project file.`,
      );
      continue;
    }
    if (resolved.status === "missing") {
      parts.push(
        `No source excerpt was attached for ${where} because that file is not in the open project.`,
      );
      continue;
    }
    if (typeof resolved.file.content !== "string") {
      parts.push(
        `No source excerpt was attached for ${where} because that file is not loaded.`,
      );
      continue;
    }
    const excerpt = formatExcerpt(resolved.file.content, anchor.line);
    if (!excerpt) {
      const total =
        resolved.file.content.length === 0
          ? 0
          : resolved.file.content.split("\n").length;
      parts.push(
        `No source excerpt was attached for ${where} because line ${anchor.line} is outside the loaded file (${total} lines).`,
      );
      continue;
    }
    parts.push(
      `Source excerpt from ${resolved.file.relativePath} around line ${anchor.line}:\n\`\`\`\n${excerpt}\n\`\`\``,
    );
  }
  return parts.join("\n\n");
}

function truncateLog(log: string): string {
  if (log.length <= MAX_LOG_CHARS) return log;
  return `${log.slice(0, 8_000)}\n\n[log truncated]\n\n${log.slice(-3_000)}`;
}

export function buildCompileFixPrompt(input: {
  log: string;
  files: CompileFixSourceFile[];
}): CompileFixPrompt {
  const log = input.log ?? "";
  const anchors = parseCompileLogAnchors(log);
  const bullets =
    anchors.length > 0
      ? anchors.map(formatAnchorBullet)
      : compileErrorSummaries(log);
  const displayPrompt = [
    "[Compilation errors]",
    ...bullets.map((bullet) => `- ${bullet}`),
    "",
    "Fix these LaTeX compilation errors.",
  ].join("\n");
  const prompt = [
    displayPrompt,
    "",
    "Only edit a file or line when the log reports it. The currently open file may be different.",
    "",
    "Compile log:",
    "```",
    truncateLog(log),
    "```",
    "",
    sourceSection(anchors, input.files),
  ].join("\n");

  return { prompt, displayPrompt, anchors };
}
