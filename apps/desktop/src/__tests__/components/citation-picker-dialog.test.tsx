import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stores = vi.hoisted(() => {
  type SyncedCollections = Record<
    string,
    Record<
      string,
      {
        collectionKey: string;
        name: string;
        bibFileName: string;
        libraryVersion: number;
        keyMap: Record<string, string>;
      }
    >
  >;
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
    } as SyncedCollections,
  };
  return {
    documentState: {
      projectRoot: "C:\\Work\\Paper\\" as string | null,
      files: [] as Array<{
        id?: string;
        name: string;
        relativePath: string;
        type: string;
        content?: string;
      }>,
      loadFileContent: vi.fn(async () => undefined),
    },
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
import { findCiteAtSelection } from "@/lib/latex-cite-edit";
import { buildCiteCommand } from "@/lib/zotero-citekeys";

function getByRole(
  role: "button",
  options: { name: RegExp },
): HTMLButtonElement {
  const nodes = Array.from(
    document.body.querySelectorAll('button, [role="button"]'),
  ) as HTMLButtonElement[];
  const matches = nodes.filter((node) => {
    const name = (node.textContent ?? "").replace(/\s+/g, " ").trim();
    return name !== "Cancel" && options.name.test(name);
  });
  if (matches.length === 0) {
    throw new Error(`Unable to find role=${role} name=${options.name}`);
  }
  return matches[0];
}

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
    stores.documentState.files = [];
    stores.documentState.loadFileContent = vi.fn(async () => undefined);
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

    const dialog = document.body.querySelector('[data-slot="dialog-content"]');
    expect(dialog?.className ?? "").toMatch(/h-\[min\(80vh,32rem\)\]/);

    const listbox = document.body.querySelector('[role="listbox"]');
    expect(listbox).toBeTruthy();
    expect(listbox?.className ?? "").toMatch(/overflow-y-auto/);
    expect(listbox?.className ?? "").toMatch(/min-h-0/);
    expect(listbox?.className ?? "").toMatch(/flex-1/);

    const idleInsert = getByRole("button", { name: /^Insert citation$/ });
    expect(idleInsert.disabled).toBe(true);
    expect(idleInsert.textContent).not.toContain("\\cite{");

    const options = Array.from(
      document.body.querySelectorAll('[role="option"]'),
    ) as HTMLButtonElement[];
    expect(options).toHaveLength(2);

    await act(async () => {
      options[0].click();
    });
    expect(getByRole("button", { name: /^Insert citation$/ }).disabled).toBe(
      false,
    );

    await act(async () => {
      options[1].click();
    });

    const insertBtn = getByRole("button", { name: /^Insert 2 citations$/ });
    expect(insertBtn.textContent).toMatch(/Insert 2 citations/);
    expect(insertBtn.textContent).not.toContain("\\cite{");
    await act(async () => insertBtn.click());

    expect(onInsert).toHaveBeenCalledWith("\\cite{doe2019,smith2020}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("shows help when Zotero is not connected", async () => {
    stores.zoteroState.isAuthenticated = false;
    stores.zoteroState.syncedCollections = {};

    await act(async () =>
      root.render(
        <CitationPickerDialog open onOpenChange={vi.fn()} onInsert={vi.fn()} />,
      ),
    );

    expect(document.body.textContent).toContain("No bibliography loaded");
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

  it("shows the renamed project bib file instead of the stale synced name", async () => {
    stores.documentState.files = [
      {
        name: "refs.bib",
        relativePath: "refs.bib",
        type: "bib",
        content: "@article{smith2020,\n  title = {Deep Work},\n}",
      },
    ];

    await act(async () =>
      root.render(
        <CitationPickerDialog open onOpenChange={vi.fn()} onInsert={vi.fn()} />,
      ),
    );

    expect(document.body.textContent).toContain("smith2020");
    expect(document.body.textContent).toContain("refs.bib");
    expect(document.body.textContent).not.toContain("research.bib");
  });

  it("lists citekeys from project .bib files when the synced key map is empty", async () => {
    stores.zoteroState.syncedCollections = {
      "c:/work/paper": {
        COLL: {
          collectionKey: "COLL",
          name: "Research",
          bibFileName: "research.bib",
          libraryVersion: 1,
          keyMap: {},
        },
      },
    };
    stores.documentState.files = [
      {
        name: "research.bib",
        relativePath: "research.bib",
        type: "bib",
        content: "@article{frombib2024,\n  title = {From Bib},\n}",
      },
    ];

    await act(async () =>
      root.render(
        <CitationPickerDialog open onOpenChange={vi.fn()} onInsert={vi.fn()} />,
      ),
    );

    expect(document.body.textContent).toContain("frombib2024");
    expect(document.body.textContent).not.toContain("No citekeys yet");
  });

  it("lists citekeys already used in tex when no bib or Zotero keys exist", async () => {
    stores.zoteroState.isAuthenticated = false;
    stores.zoteroState.syncedCollections = {};
    stores.documentState.files = [
      {
        name: "main.tex",
        relativePath: "main.tex",
        type: "tex",
        content: "See \\cite{ref2020,other2021} and \\citep{ref2020}.",
      },
    ];

    await act(async () =>
      root.render(
        <CitationPickerDialog open onOpenChange={vi.fn()} onInsert={vi.fn()} />,
      ),
    );

    expect(document.body.textContent).toContain("ref2020");
    expect(document.body.textContent).toContain("other2021");
  });

  it("inserts a typed citekey when the list is empty", async () => {
    stores.zoteroState.isAuthenticated = false;
    stores.zoteroState.syncedCollections = {};
    const onInsert = vi.fn();

    await act(async () =>
      root.render(
        <CitationPickerDialog
          open
          onOpenChange={vi.fn()}
          onInsert={onInsert}
        />,
      ),
    );

    const input = document.body.querySelector("input");
    expect(input).toBeTruthy();
    await act(async () => {
      const descriptor = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      );
      descriptor?.set?.call(input, "manual2024");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const insertBtn = getByRole("button", { name: /^Insert citation$/ });
    expect(insertBtn).toBeTruthy();
    await act(async () => insertBtn!.click());
    expect(onInsert).toHaveBeenCalledWith("\\cite{manual2024}");
  });

  it("lists already-cited keys first in cite order", async () => {
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
            item3: "zeta2021",
          },
        },
      },
    };
    const cite = findCiteAtSelection("\\cite{smith2020,doe2019}", 2, 2);

    await act(async () =>
      root.render(
        <CitationPickerDialog
          open
          onOpenChange={vi.fn()}
          onInsert={vi.fn()}
          initialKeys={cite?.keys}
          citePrefix={cite?.prefix}
        />,
      ),
    );

    const optionKeys = Array.from(
      document.body.querySelectorAll('[role="option"] .font-mono'),
    ).map((node) => node.textContent ?? "");
    expect(optionKeys).toEqual(["smith2020", "doe2019", "zeta2021"]);

    const selected = Array.from(
      document.body.querySelectorAll('[role="option"][aria-selected="true"]'),
    );
    expect(selected).toHaveLength(2);
    expect(selected[0].textContent).toContain("smith2020");
    expect(selected[1].textContent).toContain("doe2019");
  });

  it("pre-selects keys from the cite under the cursor and writes them back", async () => {
    const onInsert = vi.fn();
    const source =
      "\\citep{AgenticAIWill,alfarisyUnsupervisedDomainSpecificOpenWorld2025,aliiqbalRedefiningObjectDetection2024}";
    const cite = findCiteAtSelection(source, 2, 2);
    expect(cite?.keys).toEqual([
      "AgenticAIWill",
      "alfarisyUnsupervisedDomainSpecificOpenWorld2025",
      "aliiqbalRedefiningObjectDetection2024",
    ]);

    await act(async () =>
      root.render(
        <CitationPickerDialog
          open
          onOpenChange={vi.fn()}
          onInsert={onInsert}
          initialKeys={cite?.keys}
          citePrefix={cite?.prefix}
        />,
      ),
    );

    expect(document.body.textContent).toContain("Edit citation");
    expect(document.body.textContent).toContain("Current citation");
    expect(document.body.textContent).toContain("AgenticAIWill");

    const selected = Array.from(
      document.body.querySelectorAll('[role="option"][aria-selected="true"]'),
    ).map((node) => node.textContent ?? "");
    expect(selected.some((text) => text.includes("AgenticAIWill"))).toBe(true);
    expect(
      selected.some((text) =>
        text.includes("alfarisyUnsupervisedDomainSpecificOpenWorld2025"),
      ),
    ).toBe(true);
    expect(
      selected.some((text) =>
        text.includes("aliiqbalRedefiningObjectDetection2024"),
      ),
    ).toBe(true);

    const updateBtn = getByRole("button", { name: /^Update 3 citations$/ });
    await act(async () => updateBtn.click());

    expect(onInsert).toHaveBeenCalledWith(
      buildCiteCommand(cite!.keys, cite!.prefix),
    );
  });

  it("lets the user drop and add keys while keeping original order", async () => {
    const onInsert = vi.fn();
    const cite = findCiteAtSelection("\\cite{smith2020,doe2019}", 2, 2);

    await act(async () =>
      root.render(
        <CitationPickerDialog
          open
          onOpenChange={vi.fn()}
          onInsert={onInsert}
          initialKeys={cite?.keys}
          citePrefix={cite?.prefix}
        />,
      ),
    );

    const options = Array.from(
      document.body.querySelectorAll('[role="option"]'),
    ) as HTMLButtonElement[];
    const byKey = (key: string) =>
      options.find((option) => option.textContent?.includes(key));

    expect(byKey("smith2020")?.getAttribute("aria-selected")).toBe("true");
    expect(byKey("doe2019")?.getAttribute("aria-selected")).toBe("true");

    await act(async () => {
      byKey("doe2019")!.click();
    });

    const updateBtn = getByRole("button", { name: /^Update citation$/ });
    await act(async () => updateBtn.click());

    expect(onInsert).toHaveBeenCalledWith(
      buildCiteCommand(["smith2020"], cite!.prefix),
    );
  });

  it("appends a newly picked key after the original cite keys", async () => {
    const onInsert = vi.fn();
    const cite = findCiteAtSelection("\\cite{doe2019}", 2, 2);

    await act(async () =>
      root.render(
        <CitationPickerDialog
          open
          onOpenChange={vi.fn()}
          onInsert={onInsert}
          initialKeys={cite?.keys}
          citePrefix={cite?.prefix}
        />,
      ),
    );

    const options = Array.from(
      document.body.querySelectorAll('[role="option"]'),
    ) as HTMLButtonElement[];
    const smith = options.find((option) =>
      option.textContent?.includes("smith2020"),
    );
    expect(smith?.getAttribute("aria-selected")).toBe("false");

    await act(async () => {
      smith!.click();
    });

    const updateBtn = getByRole("button", { name: /^Update 2 citations$/ });
    await act(async () => updateBtn.click());

    expect(onInsert).toHaveBeenCalledWith(
      buildCiteCommand(["doe2019", "smith2020"], cite!.prefix),
    );
  });
});
