import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stores = vi.hoisted(() => {
  const zoteroState = {
    isAuthenticated: true,
    username: "tester",
    isValidating: false,
    isSyncing: null as string | null,
    syncProgress: null,
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
});
