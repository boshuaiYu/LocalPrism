import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stores = vi.hoisted(() => {
  const zoteroState = {
    isAuthenticated: true,
    username: "tester",
    isValidating: false,
    isSyncing: null as string | null,
    syncProgress: null as {
      loaded: number;
      total: number;
      writing?: boolean;
    } | null,
    syncedCollections: {
      "c:/work/paper": {
        COLL: {
          collectionKey: "COLL",
          name: "Research",
          bibFileName: "research.bib",
          libraryVersion: 1,
          keyMap: {},
        },
      },
    },
    error: null,
    collections: [
      {
        key: "COLL",
        name: "Research",
        parentKey: false as const,
        itemCount: 2,
      },
      {
        key: "CHILD",
        name: "Nested Methods",
        parentKey: "COLL",
        itemCount: 4,
      },
      {
        key: "GRAND",
        name: "Datasets",
        parentKey: "CHILD",
        itemCount: 1,
      },
    ],
    isLoadingCollections: false,
    connectWithOAuth: vi.fn(),
    cancelConnect: vi.fn(),
    disconnect: vi.fn(),
    revalidate: vi.fn(),
    loadCollections: vi.fn(),
    importCollectionToBib: vi.fn(),
    syncCollectionBib: vi.fn(),
    removeCollection: vi.fn(),
    connectWithApiKey: vi.fn(),
  };
  return {
    documentState: { projectRoot: "C:\\Work\\Paper\\" as string | null },
    zoteroState,
  };
});

vi.mock("@/stores/document-store", () => ({
  useDocumentStore: (
    selector: (state: typeof stores.documentState) => unknown,
  ) => selector(stores.documentState),
}));

vi.mock("@/stores/zotero-store", () => ({
  useZoteroStore: Object.assign(
    (selector: (state: typeof stores.zoteroState) => unknown) =>
      selector(stores.zoteroState),
    { getState: () => stores.zoteroState },
  ),
}));

import { ZoteroPanel } from "@/components/workspace/zotero-panel";

describe("ZoteroPanel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    stores.zoteroState.isSyncing = null;
    stores.zoteroState.syncProgress = null;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("reads canonical Windows project keys when showing synced collections", async () => {
    await act(async () => root.render(<ZoteroPanel />));

    expect(container.textContent).toContain("research.bib");
    expect(container.querySelector('button[title="Sync"]')).not.toBeNull();
  });

  it("renders nested Zotero collections under their parents", async () => {
    await act(async () => root.render(<ZoteroPanel />));

    expect(container.textContent).toContain("Research");
    expect(container.textContent).toContain("Nested Methods");
    expect(container.textContent).toContain("Datasets");
    expect(container.textContent).toContain("4 items");
  });

  it("collapses nested Zotero folders when the chevron is clicked", async () => {
    await act(async () => root.render(<ZoteroPanel />));

    const collapse = Array.from(container.querySelectorAll("button")).find(
      (button) => button.getAttribute("title") === "Collapse Research",
    );
    expect(collapse).toBeTruthy();

    await act(async () =>
      collapse?.dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );

    expect(container.textContent).toContain("Research");
    expect(container.textContent).not.toContain("Nested Methods");
    expect(container.textContent).not.toContain("Datasets");
  });

  function hasFullscreenSyncOverlay(rootEl: HTMLElement): boolean {
    return Array.from(rootEl.querySelectorAll("*")).some((node) => {
      if (!(node instanceof HTMLElement)) return false;
      const className = node.className;
      if (typeof className !== "string") return false;
      const coversViewport =
        className.includes("inset-0") ||
        className.includes("h-screen") ||
        className.includes("h-dvh") ||
        className.includes("w-screen");
      const layered =
        className.includes("fixed") || className.includes("absolute");
      return coversViewport && layered;
    });
  }

  it("shows loaded/total and a progressbar on the syncing collection row", async () => {
    stores.zoteroState.isSyncing = "COLL";
    stores.zoteroState.syncProgress = { loaded: 12, total: 80 };

    await act(async () => root.render(<ZoteroPanel />));

    expect(container.textContent).toContain("Research");
    expect(container.textContent).toContain("Downloading Research 12/80");
    expect(container.textContent).toMatch(/12\/80/);
    const bars = container.querySelectorAll('[role="progressbar"]');
    expect(bars.length).toBeGreaterThan(0);
    expect(bars[0]?.getAttribute("aria-valuenow")).toBe("15");
    expect(hasFullscreenSyncOverlay(container)).toBe(false);
  });

  it("shows first-import progress on the row instead of a static Download icon", async () => {
    stores.zoteroState.isSyncing = "CHILD";
    stores.zoteroState.syncProgress = { loaded: 12, total: 80 };

    await act(async () => root.render(<ZoteroPanel />));

    expect(container.textContent).toContain("Downloading Nested Methods 12/80");
    const busyRow = container.querySelector('[aria-busy="true"]');
    expect(busyRow?.textContent).toContain("Nested Methods");
    expect(busyRow?.textContent).toMatch(/12\/80/);
    expect(busyRow?.querySelector(".animate-spin")).not.toBeNull();
    expect(busyRow?.querySelector('button[title="Import"]')).toBeNull();
    expect(container.querySelector('[role="progressbar"]')).not.toBeNull();
    expect(hasFullscreenSyncOverlay(container)).toBe(false);
  });

  it("shows starting download instead of looking idle before the first byte", async () => {
    stores.zoteroState.isSyncing = "CHILD";
    stores.zoteroState.syncProgress = { loaded: 0, total: 0 };

    await act(async () => root.render(<ZoteroPanel />));

    expect(container.textContent).toContain("Downloading Nested Methods");
    const busyRow = container.querySelector('[aria-busy="true"]');
    expect(busyRow?.textContent).toContain("Nested Methods");
    expect(busyRow?.textContent).toContain("Downloading…");
    expect(busyRow?.querySelector('button[title="Import"]')).toBeNull();
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
  });

  it("shows writing bibliography after the download finishes", async () => {
    stores.zoteroState.isSyncing = "COLL";
    stores.zoteroState.syncProgress = {
      loaded: 80,
      total: 80,
      writing: true,
    };

    await act(async () => root.render(<ZoteroPanel />));

    expect(container.textContent).toContain("Writing Research");
    expect(container.textContent).toContain("Writing bibliography");
    expect(container.querySelector('[role="progressbar"]')).not.toBeNull();
  });
});
