import { describe, expect, it } from "vitest";
import {
  buildCiteCommand,
  collectCitekeysFromSynced,
  filterCitekeys,
} from "@/lib/zotero-citekeys";
import type { CollectionSyncInfo } from "@/stores/zotero-store";

function syncInfo(
  partial: Partial<CollectionSyncInfo> & {
    name: string;
    keyMap: Record<string, string>;
  },
): CollectionSyncInfo {
  return {
    collectionKey: partial.collectionKey ?? "COLL",
    name: partial.name,
    bibFileName: partial.bibFileName ?? "refs.bib",
    libraryVersion: partial.libraryVersion ?? 1,
    keyMap: partial.keyMap,
  };
}

describe("collectCitekeysFromSynced", () => {
  it("returns empty for missing or empty synced maps", () => {
    expect(collectCitekeysFromSynced(null)).toEqual([]);
    expect(collectCitekeysFromSynced(undefined)).toEqual([]);
    expect(collectCitekeysFromSynced({})).toEqual([]);
  });

  it("flattens, dedupes, and sorts citekeys", () => {
    const synced = {
      A: syncInfo({
        name: "Papers",
        bibFileName: "papers.bib",
        keyMap: { i1: "smith2020", i2: "doe2019" },
      }),
      B: syncInfo({
        name: "Books",
        bibFileName: "books.bib",
        keyMap: { i3: "smith2020", i4: "alpha2021" },
      }),
    };

    expect(collectCitekeysFromSynced(synced)).toEqual([
      {
        citekey: "alpha2021",
        collectionName: "Books",
        bibFileName: "books.bib",
      },
      {
        citekey: "doe2019",
        collectionName: "Papers",
        bibFileName: "papers.bib",
      },
      {
        citekey: "smith2020",
        collectionName: "Papers",
        bibFileName: "papers.bib",
      },
    ]);
  });

  it("skips empty citekeys", () => {
    const synced = {
      A: syncInfo({
        name: "Papers",
        keyMap: { i1: "", i2: "keep" },
      }),
    };
    expect(collectCitekeysFromSynced(synced).map((e) => e.citekey)).toEqual([
      "keep",
    ]);
  });
});

describe("filterCitekeys", () => {
  const entries = [
    {
      citekey: "smith2020deep",
      collectionName: "ML Papers",
      bibFileName: "ml.bib",
    },
    {
      citekey: "doe2019",
      collectionName: "Books",
      bibFileName: "books.bib",
    },
  ];

  it("returns all when query is blank", () => {
    expect(filterCitekeys(entries, "  ")).toEqual(entries);
  });

  it("matches citekey, collection, or bib file case-insensitively", () => {
    expect(filterCitekeys(entries, "SMITH").map((e) => e.citekey)).toEqual([
      "smith2020deep",
    ]);
    expect(filterCitekeys(entries, "books").map((e) => e.citekey)).toEqual([
      "doe2019",
    ]);
    expect(filterCitekeys(entries, "ml.bib").map((e) => e.citekey)).toEqual([
      "smith2020deep",
    ]);
  });
});

describe("buildCiteCommand", () => {
  it("builds empty cite shell for no keys", () => {
    expect(buildCiteCommand([])).toBe("\\cite{}");
    expect(buildCiteCommand(["", "  "])).toBe("\\cite{}");
  });

  it("joins unique keys with commas", () => {
    expect(buildCiteCommand(["a"])).toBe("\\cite{a}");
    expect(buildCiteCommand(["a", "b", "a"])).toBe("\\cite{a,b}");
    expect(buildCiteCommand(["  a ", "b"])).toBe("\\cite{a,b}");
  });
});
