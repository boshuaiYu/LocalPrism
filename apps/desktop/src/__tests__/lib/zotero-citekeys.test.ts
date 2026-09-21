import { describe, expect, it } from "vitest";
import {
  buildCiteCommand,
  applyCurrentBibFileNames,
  collectBibliographyNamesFromTex,
  collectCitekeysFromBibContent,
  collectCitekeysFromProjectFiles,
  collectCitekeysFromSynced,
  collectCitekeysFromTexCitations,
  filterCitekeys,
  mergeCitekeyEntries,
  pinCitekeysFirst,
  normalizeCitekey,
  syncedCollectionsForProject,
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

describe("collectCitekeysFromBibContent", () => {
  it("parses article keys and skips preamble entries", () => {
    const entries = collectCitekeysFromBibContent(
      [
        '@preamble{"\\\\providecommand{\\\\noopsort}[1]{}"}',
        "@article{smith2020,",
        "  title = {Deep Work},",
        "}",
        "@book{doe2019,",
        "  title = {A Book},",
        "}",
      ].join("\n"),
      "Project bibliography",
      "refs.bib",
    );
    expect(entries.map((entry) => entry.citekey)).toEqual([
      "smith2020",
      "doe2019",
    ]);
  });

  it("normalizes a wrapped cite command and drops invalid keys", () => {
    const entries = collectCitekeysFromBibContent(
      [
        "@article{\\cite{acharyyaAgenticAIAutonomous20255},",
        "  title = {Wrapped},",
        "}",
        "@article{good2020,",
        "  title = {Good},",
        "}",
        "@article{foo{bar},",
        "  title = {Braces},",
        "}",
        "@article{\\notakey,",
        "  title = {Slash},",
        "}",
      ].join("\n"),
      "Project bibliography",
      "reference.bib",
    );
    expect(entries.map((entry) => entry.citekey)).toEqual([
      "acharyyaAgenticAIAutonomous20255",
      "good2020",
    ]);
  });

  it("ignores @type{\\cite{...}} embedded in a field", () => {
    const entries = collectCitekeysFromBibContent(
      [
        "@article{real2020,",
        "  title = {Real},",
        "  note = {See @article{\\cite{acharyyaAgenticAIAutonomous20255}}},",
        "}",
      ].join("\n"),
      "Project bibliography",
      "reference.bib",
    );
    expect(entries.map((entry) => entry.citekey)).toEqual(["real2020"]);
    expect(entries.map((entry) => entry.citekey).join("")).not.toContain(
      "\\cite",
    );
  });

  it("parses compact, spaced, and CRLF BibTeX entries", () => {
    const entries = collectCitekeysFromBibContent(
      "@article { spaced2020 ,\r\n  title={A},\r\n}\n@book{tight2021,title={B}}",
      "Project bibliography",
      "refs.bib",
    );
    expect(entries.map((entry) => entry.citekey)).toEqual([
      "spaced2020",
      "tight2021",
    ]);
  });
});

describe("collectCitekeysFromProjectFiles", () => {
  it("normalizes wrapped citekeys from a project .bib file", () => {
    expect(
      collectCitekeysFromProjectFiles([
        {
          name: "reference.bib",
          relativePath: "reference.bib",
          type: "bib",
          content:
            "@article{\\cite{acharyyaAgenticAIAutonomous20255},\n  title={A},\n}",
        },
      ]).map((entry) => entry.citekey),
    ).toEqual(["acharyyaAgenticAIAutonomous20255"]);
  });

  it("reads citekeys from project .bib files", () => {
    expect(
      collectCitekeysFromProjectFiles([
        {
          name: "main.tex",
          type: "tex",
          content: "\\cite{missing}",
        },
        {
          name: "refs.bib",
          relativePath: "refs.bib",
          type: "bib",
          content:
            "@article{alpha2021,\n  title={A},\n}\n\n@article{beta2022,\n}",
        },
      ]).map((entry) => entry.citekey),
    ).toEqual(["alpha2021", "beta2022"]);
  });
});

describe("normalizeCitekey", () => {
  it("unwraps cite commands and keeps normal BibTeX keys", () => {
    expect(normalizeCitekey("foo2020")).toBe("foo2020");
    expect(normalizeCitekey("  foo-bar_1:2  ")).toBe("foo-bar_1:2");
    expect(normalizeCitekey("\\cite{foo2020}")).toBe("foo2020");
    expect(normalizeCitekey("\\citep{foo2020}")).toBe("foo2020");
    expect(normalizeCitekey("\\citet*{foo2020}")).toBe("foo2020");
    expect(normalizeCitekey("\\cite{foo2020")).toBe("foo2020");
  });

  it("rejects empty, spaced, or brace-containing keys", () => {
    expect(normalizeCitekey("")).toBeNull();
    expect(normalizeCitekey("   ")).toBeNull();
    expect(normalizeCitekey(null)).toBeNull();
    expect(normalizeCitekey("bad key")).toBeNull();
    expect(normalizeCitekey("foo{bar}")).toBeNull();
    expect(normalizeCitekey("foo\\bar")).toBeNull();
    expect(normalizeCitekey("\\cite")).toBeNull();
    expect(normalizeCitekey("\\citefoo")).toBeNull();
  });
});

describe("mergeCitekeyEntries", () => {
  it("dedupes a wrapped cite command against the bare key", () => {
    expect(
      mergeCitekeyEntries(
        [
          {
            citekey: "\\cite{foo2020}",
            collectionName: "Project bibliography",
            bibFileName: "reference.bib",
          },
        ],
        [
          {
            citekey: "foo2020",
            collectionName: "Reviews",
            bibFileName: "reference.bib",
          },
        ],
      ),
    ).toEqual([
      {
        citekey: "foo2020",
        collectionName: "Project bibliography",
        bibFileName: "reference.bib",
      },
    ]);
  });

  it("keeps synced keys first and fills gaps from .bib files", () => {
    expect(
      mergeCitekeyEntries(
        collectCitekeysFromSynced({
          A: syncInfo({
            name: "Papers",
            bibFileName: "papers.bib",
            keyMap: {},
          }),
        }),
        collectCitekeysFromBibContent(
          "@article{frombib,\n  title={From bib},\n}",
          "Project bibliography",
          "papers.bib",
        ),
      ).map((entry) => entry.citekey),
    ).toEqual(["frombib"]);
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

describe("pinCitekeysFirst", () => {
  const entries = [
    { citekey: "alpha", collectionName: "Lib", bibFileName: "a.bib" },
    { citekey: "bravo", collectionName: "Lib", bibFileName: "a.bib" },
    { citekey: "charlie", collectionName: "Lib", bibFileName: "a.bib" },
  ];

  it("leaves the list unchanged without pinned keys", () => {
    expect(pinCitekeysFirst(entries, undefined)).toEqual(entries);
    expect(pinCitekeysFirst(entries, [])).toEqual(entries);
  });

  it("moves cited keys to the front in cite order", () => {
    expect(
      pinCitekeysFirst(entries, ["charlie", "alpha"]).map((e) => e.citekey),
    ).toEqual(["charlie", "alpha", "bravo"]);
  });

  it("keeps matching pinned keys first after a filter", () => {
    const filtered = filterCitekeys(
      [
        { citekey: "zeta", collectionName: "Lib", bibFileName: "a.bib" },
        { citekey: "alpha2020", collectionName: "Lib", bibFileName: "a.bib" },
        { citekey: "beta2020", collectionName: "Lib", bibFileName: "a.bib" },
      ],
      "2020",
    );
    expect(
      pinCitekeysFirst(filtered, ["beta2020", "alpha2020"]).map(
        (e) => e.citekey,
      ),
    ).toEqual(["beta2020", "alpha2020"]);
  });

  it("ignores pinned keys that are not in the list", () => {
    expect(
      pinCitekeysFirst(entries, ["missing", "bravo"]).map((e) => e.citekey),
    ).toEqual(["bravo", "alpha", "charlie"]);
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
    expect(buildCiteCommand(["\\cite{a}", "a", "b"])).toBe("\\cite{a,b}");
    expect(buildCiteCommand(["\\cite{foo}"])).toBe("\\cite{foo}");
    expect(buildCiteCommand(["\\cite{\\cite{foo}}"])).toBe("\\cite{}");
    expect(buildCiteCommand(["\\cite{foo}"])).not.toMatch(/\\cite\{\\cite/);
  });

  it("keeps an existing command prefix when rewriting keys", () => {
    expect(buildCiteCommand(["a", "b"], "\\citep")).toBe("\\citep{a,b}");
    expect(buildCiteCommand(["a"], "\\citet*")).toBe("\\citet*{a}");
    expect(buildCiteCommand(["a", "c"], "\\citep[see][p. 1]")).toBe(
      "\\citep[see][p. 1]{a,c}",
    );
    expect(buildCiteCommand([], "\\citep")).toBe("\\citep{}");
  });
});

describe("collectCitekeysFromTexCitations", () => {
  it("collects unique keys from cite commands", () => {
    expect(
      collectCitekeysFromTexCitations([
        {
          name: "main.tex",
          type: "tex",
          content: "\\cite{one,two} and \\citep{one} and \\citet*{three}",
        },
      ]).map((entry) => entry.citekey),
    ).toEqual(["one", "three", "two"]);
  });
});

describe("collectBibliographyNamesFromTex", () => {
  it("reads bibliography and biblatex resource names", () => {
    expect(
      collectBibliographyNamesFromTex([
        {
          type: "tex",
          content:
            "\\bibliography{reference, extra}\n\\addbibresource{local.bib}",
        },
      ]),
    ).toEqual(["reference.bib", "extra.bib", "local.bib"]);
  });
});

describe("applyCurrentBibFileNames", () => {
  it("replaces a stale synced bib name from current file content", () => {
    const entries = collectCitekeysFromSynced({
      A: syncInfo({
        name: "Papers",
        bibFileName: "research.bib",
        keyMap: { i1: "smith2020" },
      }),
    });

    expect(
      applyCurrentBibFileNames(entries, [
        {
          name: "refs.bib",
          relativePath: "refs.bib",
          type: "bib",
          content: "@article{smith2020,\n  title={Deep Work},\n}",
        },
      ]),
    ).toEqual([
      {
        citekey: "smith2020",
        collectionName: "Papers",
        bibFileName: "refs.bib",
      },
    ]);
  });

  it("remaps a one-to-one renamed bib even when content is not loaded", () => {
    const entries = [
      {
        citekey: "smith2020",
        collectionName: "Papers",
        bibFileName: "research.bib",
      },
    ];

    expect(
      applyCurrentBibFileNames(entries, [
        {
          name: "library.bib",
          relativePath: "library.bib",
          type: "bib",
        },
      ]),
    ).toEqual([
      {
        citekey: "smith2020",
        collectionName: "Papers",
        bibFileName: "library.bib",
      },
    ]);
  });
});

describe("syncedCollectionsForProject", () => {
  it("matches a Windows project path to a canonical store key", () => {
    const synced = {
      "g:/work/paper": {
        COLL: syncInfo({
          name: "Papers",
          keyMap: { i1: "alpha" },
        }),
      },
    };
    expect(
      Object.keys(syncedCollectionsForProject(synced, "G:\\work\\paper\\")),
    ).toEqual(["COLL"]);
  });
});
