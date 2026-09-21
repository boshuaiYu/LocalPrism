import type { CollectionSyncInfo } from "@/stores/zotero-store";
import { canonicalProjectPath } from "@/lib/project-fs-operations";

/** A selectable citekey sourced from a synced Zotero collection. */
export interface CitekeyEntry {
  citekey: string;
  collectionName: string;
  bibFileName: string;
}

/**
 * Flatten all citekeys from the project's synced Zotero collections.
 * Deduplicates by citekey (first collection wins).
 */
export function collectCitekeysFromSynced(
  syncedCollections: Record<string, CollectionSyncInfo> | undefined | null,
): CitekeyEntry[] {
  if (!syncedCollections) return [];

  const seen = new Set<string>();
  const entries: CitekeyEntry[] = [];

  for (const info of Object.values(syncedCollections)) {
    if (!info?.keyMap) continue;
    for (const raw of Object.values(info.keyMap)) {
      const citekey = normalizeCitekey(raw);
      if (!citekey || seen.has(citekey)) continue;
      seen.add(citekey);
      entries.push({
        citekey,
        collectionName: info.name,
        bibFileName: info.bibFileName,
      });
    }
  }

  entries.sort((a, b) =>
    a.citekey.localeCompare(b.citekey, undefined, { sensitivity: "base" }),
  );
  return entries;
}

const SKIPPED_BIB_KINDS = new Set(["string", "preamble", "comment"]);
/** Only entry starts (`@article{` at BOL / after newline), not `@type{` inside fields. */
const BIB_ENTRY_RE = /(?:^|\n)\s*@(\w+)\s*\{\s*([^,\s}]+)/g;
const TEX_CITE_RE = /\\cite(?:t|p|alt|alp|author|year|num)?\*?\{([^{}]+)\}/gi;
const TEX_BIBLIOGRAPHY_RE =
  /\\(?:bibliography|addbibresource|addglobalbib)\*?\{([^{}]+)\}/gi;
const CITE_WRAP_RE =
  /^\\cite(?:t|p|alt|alp|author|year|num)?\*?\{([^{}\s]*)\}?$/i;
const VALID_CITEKEY_RE = /^[A-Za-z0-9_:-]+$/;

/**
 * Unwrap `\cite{...}` / `\citep{...}` wrappers and drop invalid BibTeX keys.
 * Empty keys and keys containing `\`, `{`, `}`, or spaces are rejected.
 */
export function normalizeCitekey(
  raw: string | null | undefined,
): string | null {
  if (raw == null) return null;
  let key = raw.trim();
  if (!key) return null;

  const wrapped = key.match(CITE_WRAP_RE);
  if (wrapped) {
    key = wrapped[1].trim();
  }

  if (
    !key ||
    /^\\cite/i.test(key) ||
    /[\\{}\s]/.test(key) ||
    !VALID_CITEKEY_RE.test(key)
  ) {
    return null;
  }
  return key;
}

/** Parse citekeys from raw BibTeX text. */
export function collectCitekeysFromBibContent(
  content: string,
  collectionName: string,
  bibFileName: string,
): CitekeyEntry[] {
  if (!content.trim()) return [];

  const seen = new Set<string>();
  const entries: CitekeyEntry[] = [];
  BIB_ENTRY_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = BIB_ENTRY_RE.exec(content))) {
    const kind = match[1].toLowerCase();
    const citekey = normalizeCitekey(match[2]);
    if (SKIPPED_BIB_KINDS.has(kind) || !citekey || seen.has(citekey)) continue;
    seen.add(citekey);
    entries.push({
      citekey,
      collectionName,
      bibFileName,
    });
  }

  return entries;
}

export function collectCitekeysFromProjectFiles(
  files:
    | ReadonlyArray<{
        name?: string;
        relativePath?: string;
        type?: string;
        content?: string;
      }>
    | undefined
    | null,
): CitekeyEntry[] {
  if (!files) return [];

  const seen = new Set<string>();
  const entries: CitekeyEntry[] = [];

  for (const file of files) {
    const fileName =
      file.name?.trim() ||
      file.relativePath?.split(/[\\/]/).pop()?.trim() ||
      "";
    const isBib = isBibliographyFile(file);
    if (!isBib || !file.content) continue;

    for (const entry of collectCitekeysFromBibContent(
      file.content,
      "Project bibliography",
      fileName || "references.bib",
    )) {
      const citekey = normalizeCitekey(entry.citekey);
      if (!citekey || seen.has(citekey)) continue;
      seen.add(citekey);
      entries.push({ ...entry, citekey });
    }
  }

  entries.sort((a, b) =>
    a.citekey.localeCompare(b.citekey, undefined, { sensitivity: "base" }),
  );
  return entries;
}

export function isBibliographyFile(file: {
  name?: string;
  relativePath?: string;
  type?: string;
}): boolean {
  const fileName =
    file.name?.trim() || file.relativePath?.split(/[\\/]/).pop()?.trim() || "";
  return (
    file.type === "bib" ||
    fileName.toLowerCase().endsWith(".bib") ||
    file.relativePath?.toLowerCase().endsWith(".bib") === true
  );
}

/** Keys already used in the project, so the picker still has something to insert. */
export function collectCitekeysFromTexCitations(
  files:
    | ReadonlyArray<{
        name?: string;
        relativePath?: string;
        type?: string;
        content?: string;
      }>
    | undefined
    | null,
): CitekeyEntry[] {
  if (!files) return [];
  const seen = new Set<string>();
  const entries: CitekeyEntry[] = [];
  for (const file of files) {
    if (file.type === "bib" || !file.content) continue;
    const fileName =
      file.name?.trim() ||
      file.relativePath?.split(/[\\/]/).pop()?.trim() ||
      "main.tex";
    TEX_CITE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = TEX_CITE_RE.exec(file.content))) {
      for (const raw of match[1].split(",")) {
        const citekey = normalizeCitekey(raw);
        if (!citekey || seen.has(citekey)) continue;
        seen.add(citekey);
        entries.push({
          citekey,
          collectionName: "Used in document",
          bibFileName: fileName,
        });
      }
    }
  }
  entries.sort((a, b) =>
    a.citekey.localeCompare(b.citekey, undefined, { sensitivity: "base" }),
  );
  return entries;
}

/** `\bibliography{reference}` / `\addbibresource{foo.bib}` names from .tex files. */
export function collectBibliographyNamesFromTex(
  files:
    | ReadonlyArray<{
        type?: string;
        content?: string;
      }>
    | undefined
    | null,
): string[] {
  if (!files) return [];
  const names = new Set<string>();
  for (const file of files) {
    if (file.type === "bib" || !file.content) continue;
    TEX_BIBLIOGRAPHY_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = TEX_BIBLIOGRAPHY_RE.exec(file.content))) {
      for (const raw of match[1].split(",")) {
        const name = raw.trim().replace(/^"+|"+$/g, "");
        if (!name) continue;
        names.add(name.toLowerCase().endsWith(".bib") ? name : `${name}.bib`);
      }
    }
  }
  return [...names];
}

export function syncedCollectionsForProject(
  allSyncedCollections:
    | Record<string, Record<string, CollectionSyncInfo>>
    | undefined
    | null,
  projectRoot: string | null | undefined,
): Record<string, CollectionSyncInfo> {
  if (!allSyncedCollections || !projectRoot) return {};
  const key = canonicalProjectPath(projectRoot);
  if (allSyncedCollections[key]) return allSyncedCollections[key];
  const hit = Object.entries(allSyncedCollections).find(
    ([candidate]) => canonicalProjectPath(candidate) === key,
  );
  return hit?.[1] ?? {};
}

function bibliographyFileName(file: {
  name?: string;
  relativePath?: string;
}): string {
  return (
    file.name?.trim() || file.relativePath?.split(/[\\/]/).pop()?.trim() || ""
  );
}

export function sameBibFileName(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/**
 * Overlay the current project .bib file names onto citekey rows.
 * Synced Zotero metadata keeps the name from the last sync, so a sidebar
 * rename would otherwise keep showing the old file.
 */
export function applyCurrentBibFileNames(
  entries: CitekeyEntry[],
  files:
    | ReadonlyArray<{
        name?: string;
        relativePath?: string;
        type?: string;
        content?: string;
      }>
    | undefined
    | null,
): CitekeyEntry[] {
  if (!entries.length) return entries;

  const bibFiles = (files ?? []).filter(isBibliographyFile);
  const currentNames = bibFiles.map(bibliographyFileName).filter(Boolean);

  const citekeyToFile = new Map<string, string>();
  for (const file of bibFiles) {
    const fileName = bibliographyFileName(file);
    if (!fileName || !file.content) continue;
    for (const parsed of collectCitekeysFromBibContent(
      file.content,
      "",
      fileName,
    )) {
      if (!citekeyToFile.has(parsed.citekey)) {
        citekeyToFile.set(parsed.citekey, fileName);
      }
    }
  }

  const storedNames = [
    ...new Set(entries.map((entry) => entry.bibFileName).filter(Boolean)),
  ];
  const missingStored = storedNames.filter(
    (name) => !currentNames.some((current) => sameBibFileName(current, name)),
  );
  const unclaimedCurrent = currentNames.filter(
    (name) => !storedNames.some((stored) => sameBibFileName(stored, name)),
  );
  const staleToCurrent = new Map<string, string>();
  if (missingStored.length === 1 && unclaimedCurrent.length === 1) {
    staleToCurrent.set(missingStored[0], unclaimedCurrent[0]);
  }

  return entries.map((entry) => {
    const fromCitekey = citekeyToFile.get(entry.citekey);
    if (fromCitekey && !sameBibFileName(fromCitekey, entry.bibFileName)) {
      return { ...entry, bibFileName: fromCitekey };
    }
    const remapped = [...staleToCurrent.entries()].find(([oldName]) =>
      sameBibFileName(oldName, entry.bibFileName),
    )?.[1];
    if (remapped) {
      return { ...entry, bibFileName: remapped };
    }
    return entry;
  });
}

/** First source wins; results are sorted by citekey. */
export function mergeCitekeyEntries(
  ...lists: Array<CitekeyEntry[] | undefined | null>
): CitekeyEntry[] {
  const seen = new Set<string>();
  const entries: CitekeyEntry[] = [];
  for (const list of lists) {
    if (!list) continue;
    for (const entry of list) {
      const citekey = normalizeCitekey(entry.citekey);
      if (!citekey || seen.has(citekey)) continue;
      seen.add(citekey);
      entries.push({ ...entry, citekey });
    }
  }
  entries.sort((a, b) =>
    a.citekey.localeCompare(b.citekey, undefined, { sensitivity: "base" }),
  );
  return entries;
}

/** Case-insensitive filter on citekey, collection name, or bib file name. */
export function filterCitekeys(
  entries: CitekeyEntry[],
  query: string,
): CitekeyEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter(
    (e) =>
      e.citekey.toLowerCase().includes(q) ||
      e.collectionName.toLowerCase().includes(q) ||
      e.bibFileName.toLowerCase().includes(q),
  );
}

/**
 * Put already-cited keys first, in cite order. Remaining entries keep their
 * relative order. Missing or empty pin lists leave the list unchanged.
 */
export function pinCitekeysFirst(
  entries: CitekeyEntry[],
  pinnedKeys: readonly string[] | undefined | null,
): CitekeyEntry[] {
  if (!pinnedKeys?.length || entries.length === 0) return entries;

  const byKey = new Map<string, CitekeyEntry>();
  for (const entry of entries) {
    if (!byKey.has(entry.citekey)) byKey.set(entry.citekey, entry);
  }

  const pinned: CitekeyEntry[] = [];
  const pinnedSet = new Set<string>();
  for (const raw of pinnedKeys) {
    const citekey = normalizeCitekey(raw);
    if (!citekey || pinnedSet.has(citekey)) continue;
    const entry = byKey.get(citekey);
    if (!entry) continue;
    pinnedSet.add(citekey);
    pinned.push(entry);
  }
  if (pinned.length === 0) return entries;

  return [
    ...pinned,
    ...entries.filter((entry) => !pinnedSet.has(entry.citekey)),
  ];
}

function normalizeCitePrefix(prefix?: string | null): string {
  const trimmed = prefix?.trim() || "\\cite";
  return trimmed.startsWith("\\") ? trimmed : `\\${trimmed}`;
}

/** Build a LaTeX \\cite{...} command from one or more citekeys. */
export function buildCiteCommand(
  keys: string[],
  prefix?: string | null,
): string {
  const commandPrefix = normalizeCitePrefix(prefix);
  const unique = [
    ...new Set(
      keys
        .map((key) => normalizeCitekey(key))
        .filter((key): key is string => Boolean(key)),
    ),
  ];
  if (unique.length === 0) return `${commandPrefix}{}`;
  const command = `${commandPrefix}{${unique.join(",")}}`;
  if (
    /\\cite[^{]*\{\s*\\cite/i.test(command) ||
    unique.some((key) => /[\\{}]/.test(key))
  ) {
    return `${commandPrefix}{}`;
  }
  return command;
}
