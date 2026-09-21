import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-shell";
import { sanitizeBibtex } from "@/lib/zotero-bibtex";

export { sanitizeBibtex } from "@/lib/zotero-bibtex";

const ZOTERO_BASE = "https://api.zotero.org";
const PAGE_LIMIT = 100;
const NON_BIB_ITEM_TYPES = new Set(["attachment", "note", "annotation"]);

export interface ZoteroCredentials {
  apiKey: string;
  userID: string;
  username: string;
}

export interface ZoteroCollection {
  key: string;
  name: string;
  parentKey: string | false;
  itemCount: number;
}

/** Result of importing a collection */
export interface CollectionImportResult {
  bibtex: string;
  libraryVersion: number;
  keyMap: Record<string, string>;
  totalItems: number;
}

/** Result of an incremental sync */
export interface CollectionSyncResult {
  updatedEntries: { key: string; citekey: string; bibtex: string }[];
  deletedKeys: string[];
  libraryVersion: number;
}

interface ZoteroItemPayload {
  key: string;
  bibtex?: string;
  data?: {
    itemType?: string;
    title?: string;
    name?: string;
    date?: string;
    creators?: Array<{ lastName?: string; firstName?: string }>;
  };
}

// ─── OAuth Flow (via Tauri Rust backend) ───

export async function startOAuth(): Promise<void> {
  const result = await invoke<{ authorize_url: string }>("zotero_start_oauth");
  await open(result.authorize_url);
}

export async function completeOAuth(): Promise<ZoteroCredentials> {
  const result = await invoke<{
    api_key: string;
    user_id: string;
    username: string;
  }>("zotero_complete_oauth");
  return {
    apiKey: result.api_key,
    userID: result.user_id,
    username: result.username,
  };
}

export async function cancelOAuth(): Promise<void> {
  await invoke("zotero_cancel_oauth");
}

// ─── Zotero Web API v3 ───

type ZoteroSource = "web" | "local";

interface ZoteroProxyResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  source: string;
}

function rejectStaleOrFailedStatus(status: number): void {
  if (status === 304) {
    throw new Error("Zotero API returned 304; refusing stale library data");
  }
  if (status === 403) throw new Error("Invalid or expired API key");
  if (status < 200 || status >= 300) {
    throw new Error(`Zotero API error: ${status}`);
  }
}

function responseFromProxy(proxied: ZoteroProxyResponse): Response {
  rejectStaleOrFailedStatus(proxied.status);
  return new Response(proxied.body, {
    status: proxied.status,
    headers: proxied.headers,
  });
}

async function webZoteroFetch(
  apiKey: string,
  path: string,
  headers?: Record<string, string>,
): Promise<Response> {
  const response = await fetch(`${ZOTERO_BASE}${path}`, {
    cache: "no-store",
    headers: {
      "Zotero-API-Key": apiKey,
      "Zotero-API-Version": "3",
      "Cache-Control": "no-cache, no-store",
      Pragma: "no-cache",
      ...headers,
    },
  });
  rejectStaleOrFailedStatus(response.status);
  return response;
}

async function zoteroFetch(
  apiKey: string,
  path: string,
  headers?: Record<string, string>,
  source: ZoteroSource = "web",
): Promise<Response> {
  try {
    const proxied = await invoke<ZoteroProxyResponse>("zotero_api_request", {
      apiKey,
      path,
      extraHeaders: headers ?? {},
      source,
    });
    return responseFromProxy(proxied);
  } catch (error) {
    if (source === "local") {
      throw new Error("Zotero local API unavailable");
    }
    if (error instanceof Error && error.message.startsWith("Zotero API")) {
      throw error;
    }
    if (
      error instanceof Error &&
      (error.message.includes("Invalid or expired API key") ||
        error.message.includes("refusing stale library data"))
    ) {
      throw error;
    }
    return webZoteroFetch(apiKey, path, headers);
  }
}

function extractCitekey(bibtex: string): string {
  const match = bibtex.match(/@\w+\{([^,\s]+)/);
  return match ? match[1] : "";
}

function fallbackBibtex(item: ZoteroItemPayload): string {
  const data = item.data;
  if (!data || NON_BIB_ITEM_TYPES.has(data.itemType ?? "")) return "";
  const title = (data.title || data.name || "Untitled").replace(/[{}]/g, "");
  const year = (data.date ?? "").match(/\d{4}/)?.[0] ?? "";
  const authors = (data.creators ?? [])
    .map((creator) =>
      [creator.lastName, creator.firstName].filter(Boolean).join(", "),
    )
    .filter(Boolean)
    .join(" and ");
  const citekey = item.key.replace(/[^A-Za-z0-9]/g, "") || "item";
  const fields = [
    `  title = {${title}}`,
    authors ? `  author = {${authors}}` : null,
    year ? `  year = {${year}}` : null,
  ].filter(Boolean);
  return `@misc{${citekey},\n${fields.join(",\n")}\n}`;
}

function itemBibtex(item: ZoteroItemPayload): string {
  const fromApi = item.bibtex?.trim() ?? "";
  return sanitizeBibtex(fromApi || fallbackBibtex(item));
}

export function normalizeCollectionParentKey(value: unknown): string | false {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (
      !trimmed ||
      trimmed === "false" ||
      trimmed === "0" ||
      trimmed === "true"
    ) {
      return false;
    }
    return trimmed;
  }
  return false;
}

function parseCollectionRecord(raw: unknown): ZoteroCollection | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as {
    key?: unknown;
    name?: unknown;
    parentCollection?: unknown;
    data?: {
      key?: unknown;
      name?: unknown;
      parentCollection?: unknown;
    };
    meta?: { numItems?: unknown };
  };
  const data = row.data ?? {};
  const key = String(row.key ?? data.key ?? "").trim();
  if (!key) return null;
  const name = String(data.name ?? row.name ?? "").trim();
  return {
    key,
    name: name || key,
    parentKey: normalizeCollectionParentKey(
      data.parentCollection ?? row.parentCollection,
    ),
    itemCount: Number(row.meta?.numItems ?? 0) || 0,
  };
}

export function isRootZoteroCollection(
  collection: ZoteroCollection,
  all: readonly ZoteroCollection[],
): boolean {
  const parent = collection.parentKey;
  if (!parent) return true;
  return !all.some((item) => item.key === parent);
}

export function rootZoteroCollections(
  collections: readonly ZoteroCollection[],
): ZoteroCollection[] {
  return collections.filter((collection) =>
    isRootZoteroCollection(collection, collections),
  );
}

export function childZoteroCollections(
  collections: readonly ZoteroCollection[],
  parentKey: string,
): ZoteroCollection[] {
  return collections.filter((collection) => collection.parentKey === parentKey);
}

function bibliographicParams(start: number): URLSearchParams {
  // Do not send itemType to the API. Combined with `start`, Zotero's filter
  // can page against a different total than the returned rows and skip newest
  // items. Attachments/notes are dropped after the response arrives.
  return new URLSearchParams({
    format: "json",
    include: "bibtex",
    limit: String(PAGE_LIMIT),
    start: String(start),
    sort: "dateModified",
    direction: "desc",
  });
}

export function descendantCollectionKeys(
  collections: ZoteroCollection[],
  rootKey: string,
): string[] {
  const keys = [rootKey];
  const queue = [rootKey];
  while (queue.length > 0) {
    const parent = queue.shift();
    if (!parent) break;
    for (const collection of collections) {
      if (collection.parentKey === parent && !keys.includes(collection.key)) {
        keys.push(collection.key);
        queue.push(collection.key);
      }
    }
  }
  return keys;
}

export async function validateApiKey(
  apiKey: string,
): Promise<ZoteroCredentials> {
  const response = await zoteroFetch(apiKey, "/keys/current");
  const data = await response.json();
  return {
    apiKey,
    userID: String(data.userID),
    username: data.username ?? "",
  };
}

// ─── Collections ───

async function pageCollectionPath(
  apiKey: string,
  basePath: string,
  source: ZoteroSource,
): Promise<ZoteroCollection[]> {
  const collections: ZoteroCollection[] = [];
  let start = 0;
  let total = 0;

  while (true) {
    const params = new URLSearchParams({
      format: "json",
      limit: String(PAGE_LIMIT),
      start: String(start),
      sort: "dateModified",
      direction: "desc",
    });
    const separator = basePath.includes("?") ? "&" : "?";
    const response = await zoteroFetch(
      apiKey,
      `${basePath}${separator}${params}`,
      undefined,
      source,
    );
    if (start === 0) {
      total = Number(response.headers.get("Total-Results") ?? 0);
    }
    const data = (await response.json()) as unknown;
    const rows = Array.isArray(data) ? data : [];
    if (rows.length === 0) break;
    for (const row of rows) {
      const parsed = parseCollectionRecord(row);
      if (parsed) collections.push(parsed);
    }
    start += rows.length;
    if (total > 0 && start >= total) break;
  }

  return collections;
}

async function fetchNestedCollections(
  apiKey: string,
  userID: string,
  source: ZoteroSource,
  byKey: Map<string, ZoteroCollection>,
): Promise<void> {
  const hasNested = [...byKey.values()].some(
    (collection) =>
      typeof collection.parentKey === "string" && collection.parentKey,
  );
  if (hasNested) return;

  const queue = [...byKey.keys()];
  const fetched = new Set<string>();
  while (queue.length > 0) {
    const parent = queue.shift();
    if (!parent || fetched.has(parent)) continue;
    fetched.add(parent);
    const children = await pageCollectionPath(
      apiKey,
      `/users/${userID}/collections/${parent}/collections`,
      source,
    ).catch(() => []);
    for (const child of children) {
      const resolved: ZoteroCollection = {
        ...child,
        parentKey:
          typeof child.parentKey === "string" && child.parentKey
            ? child.parentKey
            : parent,
      };
      const existing = byKey.get(resolved.key);
      if (!existing) {
        byKey.set(resolved.key, resolved);
        queue.push(resolved.key);
        continue;
      }
      if (!existing.parentKey) {
        byKey.set(resolved.key, { ...existing, parentKey: parent });
      }
    }
  }
}

async function fetchCollectionsFromSource(
  apiKey: string,
  userID: string,
  source: ZoteroSource,
): Promise<ZoteroCollection[]> {
  const listed = await pageCollectionPath(
    apiKey,
    `/users/${userID}/collections`,
    source,
  );
  const byKey = new Map<string, ZoteroCollection>();
  for (const collection of listed) byKey.set(collection.key, collection);
  await fetchNestedCollections(apiKey, userID, source, byKey);
  return [...byKey.values()];
}

function mergeCollectionsByKey(
  web: ZoteroCollection[],
  local: ZoteroCollection[],
): ZoteroCollection[] {
  const byKey = new Map<string, ZoteroCollection>();
  for (const collection of web) byKey.set(collection.key, collection);
  for (const collection of local) {
    const existing = byKey.get(collection.key);
    if (!existing) {
      byKey.set(collection.key, collection);
      continue;
    }
    byKey.set(collection.key, {
      ...existing,
      ...collection,
      name: collection.name || existing.name,
      itemCount: Math.max(existing.itemCount, collection.itemCount),
      parentKey: collection.parentKey || existing.parentKey,
    });
  }
  return [...byKey.values()];
}

export async function fetchCollections(
  apiKey: string,
  userID: string,
): Promise<ZoteroCollection[]> {
  const web = await fetchCollectionsFromSource(apiKey, userID, "web");
  const local = await fetchCollectionsFromSource(apiKey, userID, "local").catch(
    () => [],
  );
  return mergeCollectionsByKey(web, local);
}

interface ImportedZoteroItem {
  key: string;
  citekey: string;
  bibtex: string;
}

interface ItemImportBatch {
  items: ImportedZoteroItem[];
  libraryVersion: number;
  totalItems: number;
}

function collectionImportFromBatch(
  batch: ItemImportBatch,
): CollectionImportResult {
  const keyMap: Record<string, string> = {};
  for (const item of batch.items) {
    if (item.citekey) keyMap[item.key] = item.citekey;
  }
  return {
    bibtex: batch.items.map((item) => item.bibtex).join("\n\n"),
    libraryVersion: batch.libraryVersion,
    keyMap,
    totalItems: batch.totalItems,
  };
}

async function importItemsFromSource(
  apiKey: string,
  basePath: string,
  source: ZoteroSource,
  onProgress?: (loaded: number, total: number) => void,
): Promise<ItemImportBatch> {
  const itemsByKey = new Map<string, ImportedZoteroItem>();
  let start = 0;
  let total = 0;
  let libraryVersion = 0;

  while (true) {
    const response = await zoteroFetch(
      apiKey,
      `${basePath}?${bibliographicParams(start)}`,
      undefined,
      source,
    );

    if (start === 0) {
      total = Number(response.headers.get("Total-Results") ?? 0);
      libraryVersion = Number(
        response.headers.get("Last-Modified-Version") ?? 0,
      );
    }

    const items = (await response.json()) as ZoteroItemPayload[];
    if (items.length === 0) break;

    for (const item of items) {
      if (NON_BIB_ITEM_TYPES.has(item.data?.itemType ?? "")) continue;
      const bibtex = itemBibtex(item);
      if (!bibtex.trim()) continue;
      itemsByKey.set(item.key, {
        key: item.key,
        citekey: extractCitekey(bibtex),
        bibtex,
      });
    }

    start += items.length;
    onProgress?.(Math.min(start, total || start), total);
    if (total > 0 && start >= total) break;
  }

  return {
    items: [...itemsByKey.values()],
    libraryVersion,
    totalItems: total || itemsByKey.size,
  };
}

async function importItemsFromPath(
  apiKey: string,
  basePath: string,
  onProgress?: (loaded: number, total: number) => void,
): Promise<ItemImportBatch> {
  const settled = await Promise.allSettled([
    importItemsFromSource(apiKey, basePath, "web", onProgress),
    importItemsFromSource(apiKey, basePath, "local", onProgress),
  ]);
  const batches = settled.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  if (batches.length === 0) {
    const first = settled[0];
    throw first?.status === "rejected"
      ? first.reason
      : new Error("Zotero API error: failed to load items");
  }
  return mergeImportBatches(batches);
}

function mergeImportBatches(batches: ItemImportBatch[]): ItemImportBatch {
  const itemsByKey = new Map<string, ImportedZoteroItem>();
  let libraryVersion = 0;
  let totalItems = 0;

  for (const batch of batches) {
    libraryVersion = Math.max(libraryVersion, batch.libraryVersion);
    totalItems += batch.totalItems;
    for (const item of batch.items) {
      itemsByKey.set(item.key, item);
    }
  }

  return {
    items: [...itemsByKey.values()],
    libraryVersion,
    totalItems,
  };
}

// ─── Collection Import (full download) ───

/**
 * Import all bibliographic items from a collection tree, or the whole library.
 * Pass collectionKey = null to import "My Library".
 */
async function loadCollectionBatch(
  apiKey: string,
  userID: string,
  collectionKey: string | null,
  onProgress?: (loaded: number, total: number) => void,
): Promise<ItemImportBatch> {
  if (!collectionKey) {
    return importItemsFromPath(apiKey, `/users/${userID}/items`, onProgress);
  }

  const collections = await fetchCollections(apiKey, userID);
  const collectionKeys = descendantCollectionKeys(collections, collectionKey);
  const batches: ItemImportBatch[] = [];
  let loadedItems = 0;
  for (const key of collectionKeys) {
    batches.push(
      await importItemsFromPath(
        apiKey,
        `/users/${userID}/collections/${key}/items`,
        (loaded, total) => {
          onProgress?.(loadedItems + loaded, loadedItems + Math.max(total, 0));
        },
      ),
    );
    loadedItems += batches[batches.length - 1]?.totalItems ?? 0;
  }
  return mergeImportBatches(batches);
}

export async function importCollection(
  apiKey: string,
  userID: string,
  collectionKey: string | null,
  onProgress?: (loaded: number, total: number) => void,
): Promise<CollectionImportResult> {
  return collectionImportFromBatch(
    await loadCollectionBatch(apiKey, userID, collectionKey, onProgress),
  );
}

// ─── Incremental Sync ───

/**
 * Sync a collection or the full library.
 * Zotero's `since` parameter is library-wide and can skip newly added items
 * when the stored version is stale, so we always re-fetch current items.
 */
export async function syncCollection(
  apiKey: string,
  userID: string,
  collectionKey: string | null,
  lastVersion: number,
  onProgress?: (loaded: number, total: number) => void,
): Promise<CollectionSyncResult> {
  const batch = await loadCollectionBatch(
    apiKey,
    userID,
    collectionKey,
    onProgress,
  );

  let deletedKeys: string[] = [];
  let libraryVersion = batch.libraryVersion;
  if (!collectionKey && lastVersion > 0) {
    const deletedResponse = await zoteroFetch(
      apiKey,
      `/users/${userID}/deleted?since=${lastVersion}`,
    );
    const deleted = (await deletedResponse.json()) as { items?: string[] };
    deletedKeys = deleted.items ?? [];
    libraryVersion = Math.max(
      libraryVersion,
      Number(deletedResponse.headers.get("Last-Modified-Version") ?? 0),
    );
  }

  return {
    updatedEntries: batch.items.map((item) => ({
      key: item.key,
      citekey: item.citekey,
      bibtex: item.bibtex,
    })),
    deletedKeys,
    libraryVersion,
  };
}
