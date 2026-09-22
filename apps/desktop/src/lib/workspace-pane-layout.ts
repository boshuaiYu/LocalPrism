import { contentPaneSize } from "@/stores/chat-layout-store";

export const PANE_LAYOUT_STORAGE_KEY = "localprism.workspace-pane-layout.v1";
export const SIDEBAR_SPLIT_AUTOSAVE_ID = "localprism-sidebar-split";
export const SIDEBAR_PANE_SIZE = 15;

export interface PaneVisibility {
  code: boolean;
  chat: boolean;
  pdf: boolean;
}

export type PaneId = "sidebar" | "code" | "chat" | "pdf";

export interface PaneLayoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function paneIds(visibility: PaneVisibility): PaneId[] {
  const ids: PaneId[] = ["sidebar"];
  if (visibility.code) ids.push("code");
  if (visibility.chat) ids.push("chat");
  if (visibility.pdf) ids.push("pdf");
  return ids;
}

export function paneLayoutKey(visibility: PaneVisibility): string {
  return paneIds(visibility).join("+");
}

export function defaultPaneSizes(visibility: PaneVisibility): number[] {
  return paneIds(visibility).map((id) => {
    if (id === "sidebar") return SIDEBAR_PANE_SIZE;
    return contentPaneSize({
      code: visibility.code,
      chat: visibility.chat,
      pdf: visibility.pdf,
      pane: id,
    });
  });
}

export function sanitizePaneSizes(
  value: unknown,
  length: number,
): number[] | null {
  if (!Array.isArray(value) || value.length !== length) return null;
  if (
    !value.every(
      (size) => typeof size === "number" && Number.isFinite(size) && size > 0,
    )
  ) {
    return null;
  }
  const sum = value.reduce((total, size) => total + size, 0);
  if (sum < 90 || sum > 110) return null;
  return value.map((size) => (size / sum) * 100);
}

function readMap(storage: PaneLayoutStorage): Record<string, number[]> {
  const raw = storage.getItem(PANE_LAYOUT_STORAGE_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    return parsed as Record<string, number[]>;
  } catch {
    return {};
  }
}

export function readPaneLayout(
  visibility: PaneVisibility,
  storage: PaneLayoutStorage,
): number[] | null {
  const saved = readMap(storage)[paneLayoutKey(visibility)];
  return sanitizePaneSizes(saved, paneIds(visibility).length);
}

const PANE_MINIMUMS: Record<PaneId, number> = {
  sidebar: 10,
  code: 22,
  chat: 18,
  pdf: 22,
};

export function paneLayoutIsUsable(
  visibility: PaneVisibility,
  sizes: number[],
): boolean {
  const ids = paneIds(visibility);
  if (sizes.length !== ids.length) return false;
  return ids.every((id, index) => sizes[index] >= PANE_MINIMUMS[id] - 0.5);
}

export function writePaneLayout(
  visibility: PaneVisibility,
  sizes: number[],
  storage: PaneLayoutStorage,
): void {
  const sanitized = sanitizePaneSizes(sizes, paneIds(visibility).length);
  if (!sanitized || !paneLayoutIsUsable(visibility, sanitized)) return;
  const next = readMap(storage);
  next[paneLayoutKey(visibility)] = sanitized;
  storage.setItem(PANE_LAYOUT_STORAGE_KEY, JSON.stringify(next));
}

export function clearPaneLayouts(storage: PaneLayoutStorage): void {
  storage.removeItem(PANE_LAYOUT_STORAGE_KEY);
  storage.removeItem(`react-resizable-panels:${SIDEBAR_SPLIT_AUTOSAVE_ID}`);
}

export function paneSizeMap(
  visibility: PaneVisibility,
  storage: PaneLayoutStorage,
): Record<PaneId, number> {
  const ids = paneIds(visibility);
  const sizes =
    readPaneLayout(visibility, storage) ?? defaultPaneSizes(visibility);
  const map: Record<PaneId, number> = {
    sidebar: SIDEBAR_PANE_SIZE,
    code: 0,
    chat: 0,
    pdf: 0,
  };
  ids.forEach((id, index) => {
    map[id] = sizes[index] ?? map[id];
  });
  return map;
}
