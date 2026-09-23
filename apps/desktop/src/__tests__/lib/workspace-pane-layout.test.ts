import { describe, expect, it } from "vitest";
import {
  PANE_LAYOUT_STORAGE_KEY,
  defaultPaneSizes,
  paneSizeMap,
  readPaneLayout,
  writePaneLayout,
  type PaneLayoutStorage,
} from "@/lib/workspace-pane-layout";

function memoryStorage(): PaneLayoutStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

const allPanes = { code: true, chat: true, pdf: true };

describe("workspace pane layout", () => {
  it("defaults to sidebar plus the shared content split", () => {
    expect(defaultPaneSizes(allPanes)).toEqual([15, 33, 24, 28]);
    expect(defaultPaneSizes({ code: true, chat: false, pdf: true })).toEqual([
      15, 42.5, 42.5,
    ]);
  });

  it("persists a layout per visible pane set and restores it", () => {
    const storage = memoryStorage();
    writePaneLayout(allPanes, [18, 30, 22, 30], storage);
    expect(readPaneLayout(allPanes, storage)).toEqual([18, 30, 22, 30]);
    expect(
      readPaneLayout({ code: true, chat: false, pdf: true }, storage),
    ).toBeNull();
    expect(paneSizeMap(allPanes, storage).chat).toBe(22);
  });

  it("ignores a collapsed pane that is below its minimum width", () => {
    const storage = memoryStorage();
    writePaneLayout(allPanes, [15, 50, 2, 33], storage);
    expect(readPaneLayout(allPanes, storage)).toBeNull();
  });

  it("ignores layouts that do not match the open panes", () => {
    const storage = memoryStorage();
    storage.setItem(
      PANE_LAYOUT_STORAGE_KEY,
      JSON.stringify({ "sidebar+code+chat+pdf": [10, 20] }),
    );
    expect(readPaneLayout(allPanes, storage)).toBeNull();
  });
});
