import type { CollectionSyncInfo } from "@/stores/zotero-store";

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
    for (const citekey of Object.values(info.keyMap)) {
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

/** Build a LaTeX \\cite{...} command from one or more citekeys. */
export function buildCiteCommand(keys: string[]): string {
  const unique = [...new Set(keys.map((k) => k.trim()).filter(Boolean))];
  if (unique.length === 0) return "\\cite{}";
  return `\\cite{${unique.join(",")}}`;
}
