import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stores = vi.hoisted(() => {
  const zoteroState = {
    isAuthenticated: true,
    syncedCollections: {
      "c:/work/paper": {
        COLL: {
          collectionKey: "COLL",
          name: "Research",
          bibFileName: "research.bib",
          libraryVersion: 1,
          keyMap: {
            item1: "smith2020",
            item2: "doe2019",
          },
        },
      },
    },
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
  useZoteroStore: (selector: (state: typeof stores.zoteroState) => unknown) =>
    selector(stores.zoteroState),
}));

import { CitationPickerDialog } from "@/components/workspace/editor/citation-picker-dialog";

describe("CitationPickerDialog", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    stores.zoteroState.isAuthenticated = true;
    stores.zoteroState.syncedCollections = {
      "c:/work/paper": {
        COLL: {
          collectionKey: "COLL",
          name: "Research",
          bibFileName: "research.bib",
          libraryVersion: 1,
          keyMap: {
            item1: "smith2020",
            item2: "doe2019",
          },
        },
      },
    };
    stores.documentState.projectRoot = "C:\\Work\\Paper\\";
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

  it("lists synced citekeys and inserts multi-key cite command", async () => {
    const onInsert = vi.fn();
    const onOpenChange = vi.fn();

    await act(async () =>
      root.render(
        <CitationPickerDialog
          open
          onOpenChange={onOpenChange}
          onInsert={onInsert}
        />,
      ),
    );

    // Radix Dialog portals into document.body
    expect(document.body.textContent).toContain("smith2020");
    expect(document.body.textContent).toContain("doe2019");

    const options = Array.from(
      document.body.querySelectorAll('[role="option"]'),
    ) as HTMLButtonElement[];
    expect(options).toHaveLength(2);

    await act(async () => {
      options[0].click();
      options[1].click();
    });

    const insertBtn = Array.from(document.body.querySelectorAll("button")).find(
      (b) =>
        b.textContent?.includes("Insert") &&
        !b.textContent?.includes("citation"),
    );
    expect(insertBtn).toBeTruthy();
    await act(async () => insertBtn!.click());

    expect(onInsert).toHaveBeenCalledWith("\\cite{doe2019,smith2020}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows help when Zotero is not connected", async () => {
    stores.zoteroState.isAuthenticated = false;

    await act(async () =>
      root.render(
        <CitationPickerDialog open onOpenChange={vi.fn()} onInsert={vi.fn()} />,
      ),
    );

    expect(document.body.textContent).toContain("Zotero not connected");
    expect(document.body.querySelector('[role="option"]')).toBeNull();
  });

  it("shows help when no collections are synced", async () => {
    stores.zoteroState.syncedCollections = {};

    await act(async () =>
      root.render(
        <CitationPickerDialog open onOpenChange={vi.fn()} onInsert={vi.fn()} />,
      ),
    );

    expect(document.body.textContent).toContain("No synced collections");
  });
});
