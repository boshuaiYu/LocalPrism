import { normalizeCitekey } from "@/lib/zotero-citekeys";

/**
 * Keep the command names in sync with TEX_CITE_RE in zotero-citekeys.ts.
 * Optional prenotes/postnotes (`\citep[see][p. 1]{key}`) are preserved as prefix.
 */
const CITE_AT_CURSOR_RE =
  /\\cite(?:t|p|alt|alp|author|year|num)?\*?(?:\[[^\]]*\])*\{([^{}]*)\}/gi;

export interface CiteAtCursor {
  from: number;
  to: number;
  /** Text before the key-list braces, e.g. `\\cite` or `\\citep[see][]`. */
  prefix: string;
  keys: string[];
}

export function parseCiteKeyList(raw: string): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const citekey = normalizeCitekey(part);
    if (!citekey || seen.has(citekey)) continue;
    seen.add(citekey);
    keys.push(citekey);
  }
  return keys;
}

export function findCitesInDoc(doc: string): CiteAtCursor[] {
  const cites: CiteAtCursor[] = [];
  CITE_AT_CURSOR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CITE_AT_CURSOR_RE.exec(doc))) {
    const full = match[0];
    if (!full) {
      CITE_AT_CURSOR_RE.lastIndex += 1;
      continue;
    }
    const from = match.index;
    const to = from + full.length;
    const brace = full.lastIndexOf("{");
    cites.push({
      from,
      to,
      prefix: full.slice(0, brace),
      keys: parseCiteKeyList(match[1] ?? ""),
    });
  }
  return cites;
}

/**
 * A cite is editable when the selection is inside it, equal to it, or a
 * collapsed cursor sits immediately on either edge of the command.
 */
export function findCiteAtSelection(
  doc: string,
  from: number,
  to: number,
): CiteAtCursor | null {
  const lo = Math.max(0, Math.min(from, to));
  const hi = Math.max(from, to, lo);
  const cites = findCitesInDoc(doc);

  const containing = cites.filter((cite) => cite.from <= lo && hi <= cite.to);
  if (containing.length === 1) return containing[0];
  if (containing.length > 1) {
    return containing.reduce((best, cite) =>
      cite.to - cite.from < best.to - best.from ? cite : best,
    );
  }

  if (lo !== hi) return null;

  return (
    cites.find((cite) => cite.to === lo) ??
    cites.find((cite) => cite.from === lo) ??
    null
  );
}

/** Remaining original keys keep their order; newly picked keys are appended. */
export function orderEditedCitekeys(
  selected: Iterable<string>,
  originalKeys: string[] | undefined,
): string[] {
  const selectedSet = selected instanceof Set ? selected : new Set(selected);
  const ordered: string[] = [];
  for (const key of originalKeys ?? []) {
    if (selectedSet.has(key) && !ordered.includes(key)) ordered.push(key);
  }
  for (const key of selectedSet) {
    if (!ordered.includes(key)) ordered.push(key);
  }
  return ordered;
}
