const INCLUDE_PATTERN = /\\(?:input|include)\s*(?:\[[^\]]*\])?\s*\{([^{}]+)\}/g;

export interface LatexOutlineFile {
  relativePath: string;
  content?: string;
  type?: string;
}

export interface LatexOutlineEntry {
  relativePath: string;
  fileName: string;
  title: string | null;
  depth: number;
  exists: boolean;
}

export function stripLatexComments(source: string): string {
  return source
    .split("\n")
    .map((line) => {
      let out = "";
      for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        if (char === "%" && line[index - 1] !== "\\") break;
        out += char;
      }
      return out;
    })
    .join("\n");
}

export function parseLatexIncludes(source: string): string[] {
  const refs: string[] = [];
  for (const match of stripLatexComments(source).matchAll(INCLUDE_PATTERN)) {
    const raw = match[1]?.trim();
    if (raw) refs.push(raw);
  }
  return refs;
}

export function chapterTitle(source: string | undefined): string | null {
  if (!source) return null;
  const match = stripLatexComments(source).match(
    /\\chapter\*?(?:\[[^\]]*\])?\{([^{}]+)\}/,
  );
  const title = match?.[1]?.replace(/\s+/g, " ").trim();
  return title || null;
}

export function resolveLatexInclude(
  fromRelativePath: string,
  ref: string,
): string {
  const normalized = ref.replace(/\\/g, "/").replace(/^\.\//, "");
  const withExt = /\.[A-Za-z0-9]+$/.test(normalized)
    ? normalized
    : `${normalized}.tex`;
  const slash = fromRelativePath.replace(/\\/g, "/");
  const baseDir = slash.includes("/")
    ? slash.slice(0, slash.lastIndexOf("/"))
    : "";
  const combined = withExt.startsWith("/")
    ? withExt.slice(1)
    : baseDir
      ? `${baseDir}/${withExt}`
      : withExt;
  return normalizeRelative(combined);
}

function normalizeRelative(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

function isTexFile(file: LatexOutlineFile): boolean {
  return (
    file.type === "tex" || file.relativePath.toLowerCase().endsWith(".tex")
  );
}

function normalizedPath(path: string): string {
  return path.replace(/\\/g, "/");
}

const ROOT_PREFERENCE = ["main.tex", "paper.tex", "thesis.tex"];

export function buildLatexProjectOutline(
  files: readonly LatexOutlineFile[],
): LatexOutlineEntry[] {
  const texFiles = files.filter(isTexFile);
  if (texFiles.length === 0) return [];

  const byPath = new Map(
    texFiles.map((file) => [normalizedPath(file.relativePath), file]),
  );
  const included = new Set<string>();
  for (const file of texFiles) {
    const from = normalizedPath(file.relativePath);
    for (const ref of parseLatexIncludes(file.content ?? "")) {
      included.add(resolveLatexInclude(from, ref));
    }
  }

  const roots = texFiles.filter(
    (file) => !included.has(normalizedPath(file.relativePath)),
  );
  roots.sort((left, right) => {
    const leftName = normalizedPath(left.relativePath).toLowerCase();
    const rightName = normalizedPath(right.relativePath).toLowerCase();
    const leftRank = ROOT_PREFERENCE.indexOf(leftName);
    const rightRank = ROOT_PREFERENCE.indexOf(rightName);
    const leftScore = leftRank === -1 ? 99 : leftRank;
    const rightScore = rightRank === -1 ? 99 : rightRank;
    if (leftScore !== rightScore) return leftScore - rightScore;
    return (
      parseLatexIncludes(right.content ?? "").length -
      parseLatexIncludes(left.content ?? "").length
    );
  });

  const root = roots[0] ?? texFiles[0];
  const entries: LatexOutlineEntry[] = [];
  const seen = new Set<string>();

  const walk = (path: string, depth: number) => {
    if (depth > 8 || seen.has(path)) return;
    seen.add(path);
    const file = byPath.get(path);
    const fileName = path.split("/").pop() || path;
    entries.push({
      relativePath: path,
      fileName,
      title: chapterTitle(file?.content),
      depth,
      exists: Boolean(file),
    });
    if (!file?.content) return;
    for (const ref of parseLatexIncludes(file.content)) {
      walk(resolveLatexInclude(path, ref), depth + 1);
    }
  };

  walk(normalizedPath(root.relativePath), 0);
  if (entries.length < 2) return [];
  return entries;
}
