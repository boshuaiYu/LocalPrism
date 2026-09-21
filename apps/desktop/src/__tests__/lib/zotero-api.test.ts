import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  childZoteroCollections,
  descendantCollectionKeys,
  fetchCollections,
  importCollection,
  rootZoteroCollections,
  syncCollection,
} from "@/lib/zotero-api";

function jsonResponse(
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  });
}

describe("zotero collection tree helpers", () => {
  const collections = [
    { key: "A", name: "Root", parentKey: false as const, itemCount: 1 },
    { key: "B", name: "Child", parentKey: "A", itemCount: 2 },
    { key: "C", name: "Orphan", parentKey: "MISSING", itemCount: 0 },
  ];

  it("treats missing parents as roots so nested rows stay visible", () => {
    expect(rootZoteroCollections(collections).map((item) => item.key)).toEqual([
      "A",
      "C",
    ]);
    expect(
      childZoteroCollections(collections, "A").map((item) => item.key),
    ).toEqual(["B"]);
    expect(descendantCollectionKeys(collections, "A")).toEqual(["A", "B"]);
  });
});

describe("zotero-api latest library fetch", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    invokeMock.mockReset();
    invokeMock.mockRejectedValue(
      new Error("zotero_api_request unused in test"),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("pages every collection and disables HTTP caching", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (/\/collections\/[^/?]+\/collections/.test(url)) {
        return jsonResponse([], { "Total-Results": "0" });
      }
      if (url.includes("/collections?") && !url.includes("/items")) {
        const start = Number(new URL(url).searchParams.get("start") ?? "0");
        const rows =
          start === 0
            ? [
                {
                  key: "OLD1",
                  data: { key: "OLD1", name: "Old", parentCollection: false },
                  meta: { numItems: 1 },
                },
              ]
            : [
                {
                  key: "NEW1",
                  data: {
                    key: "NEW1",
                    name: "Newest",
                    parentCollection: false,
                  },
                  meta: { numItems: 3 },
                },
              ];
        return jsonResponse(rows, {
          "Total-Results": "2",
          "Last-Modified-Version": "11",
        });
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const collections = await fetchCollections("key", "123");

    expect(collections.map((collection) => collection.name)).toEqual([
      "Old",
      "Newest",
    ]);
    const firstCall = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(firstCall[0]).toContain("/users/123/collections?");
    expect(firstCall[0]).toContain("limit=100");
    expect(firstCall[1]?.cache).toBe("no-store");
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes("/collections/OLD1/collections"),
      ),
    ).toBe(true);
  });

  it("imports bibliographic items from /items, including empty-bibtex rows", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        [
          {
            key: "PAPER1",
            bibtex: "@article{new2026,\n  title = {Latest Paper}\n}",
            data: {
              itemType: "journalArticle",
              title: "Latest Paper",
              date: "2026",
            },
          },
          {
            key: "PAPER2",
            bibtex: "",
            data: {
              itemType: "preprint",
              title: "Brand New Preprint",
              date: "2026",
              creators: [{ lastName: "Li", firstName: "Wei" }],
            },
          },
        ],
        { "Total-Results": "2", "Last-Modified-Version": "44" },
      ),
    );

    const result = await importCollection("key", "123", null);

    const requestUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(requestUrl).toContain("/users/123/items?");
    expect(requestUrl).not.toContain("/items/top");
    expect(requestUrl).toContain("sort=dateModified");
    expect(requestUrl).not.toContain("itemType=");
    expect(result.bibtex).toContain("Latest Paper");
    expect(result.bibtex).toContain("Brand New Preprint");
    expect(result.keyMap.PAPER2).toBeTruthy();
    expect(result.libraryVersion).toBe(44);
  });

  it("strips abstract/note/file from imported and synced bibtex", async () => {
    const noisyItem = {
      key: "PAPER1",
      bibtex: `@article{noisy,
  title = {Clean Title},
  author = {Doe, Jane},
  year = {2026},
  abstract = {drop this abstract},
  note = {private note},
  file = {C:/Zotero/storage/ABC/paper.pdf},
  keywords = {extra}
}`,
      data: { itemType: "journalArticle", title: "Clean Title" },
    };
    fetchMock.mockImplementation(async () =>
      jsonResponse([noisyItem], {
        "Total-Results": "1",
        "Last-Modified-Version": "7",
      }),
    );

    const imported = await importCollection("key", "123", null);
    expect(imported.bibtex).toContain("Clean Title");
    expect(imported.bibtex).not.toMatch(/\babstract\s*=/i);
    expect(imported.bibtex).not.toMatch(/\bnote\s*=/i);
    expect(imported.bibtex).not.toMatch(/\bfile\s*=/i);
    expect(imported.bibtex).not.toContain("paper.pdf");

    const synced = await syncCollection("key", "123", null, 0);
    expect(synced.updatedEntries[0]?.bibtex).toContain("Clean Title");
    expect(synced.updatedEntries[0]?.bibtex).not.toMatch(/\babstract\s*=/i);
    expect(synced.updatedEntries[0]?.bibtex).not.toMatch(/\bfile\s*=/i);
  });

  it("imports items from nested collections when syncing a parent", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/collections?") && !url.includes("/items")) {
        return jsonResponse(
          [
            {
              key: "PARENT",
              data: { key: "PARENT", name: "Parent", parentCollection: false },
              meta: { numItems: 0 },
            },
            {
              key: "CHILD",
              data: { key: "CHILD", name: "Child", parentCollection: "PARENT" },
              meta: { numItems: 1 },
            },
          ],
          { "Total-Results": "2" },
        );
      }
      if (url.includes("/collections/PARENT/items")) {
        return jsonResponse([], {
          "Total-Results": "0",
          "Last-Modified-Version": "9",
        });
      }
      if (url.includes("/collections/CHILD/items")) {
        return jsonResponse(
          [
            {
              key: "NESTED",
              bibtex: "@article{nested,\n  title = {Nested Latest}\n}",
              data: { itemType: "journalArticle", title: "Nested Latest" },
            },
          ],
          { "Total-Results": "1", "Last-Modified-Version": "10" },
        );
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const result = await importCollection("key", "123", "PARENT");
    expect(result.bibtex).toContain("Nested Latest");
    expect(result.keyMap.NESTED).toBe("nested");
  });

  it("does not use since= when incrementally syncing My Library so newest items are not skipped", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(
          [
            {
              key: "NEWEST",
              bibtex: "@article{newest,\n  title = {Just Added}\n}",
              data: { itemType: "journalArticle", title: "Just Added" },
            },
          ],
          { "Total-Results": "1", "Last-Modified-Version": "90" },
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({ items: [] }, { "Last-Modified-Version": "90" }),
      );

    const result = await syncCollection("key", "123", null, 88);

    const itemsUrl = String(
      fetchMock.mock.calls.find(([url]) =>
        String(url).includes("/users/123/items?"),
      )?.[0],
    );
    expect(itemsUrl).toContain("/users/123/items?");
    expect(itemsUrl).not.toContain("since=");
    expect(result.updatedEntries.some((entry) => entry.key === "NEWEST")).toBe(
      true,
    );
  });

  it("drops attachments after paging unfiltered items so newest papers stay visible", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        [
          {
            key: "PDF1",
            bibtex: "",
            data: { itemType: "attachment", title: "paper.pdf" },
          },
          {
            key: "NEWEST",
            bibtex: "@article{newest,\n  title = {Just Added}\n}",
            data: { itemType: "journalArticle", title: "Just Added" },
          },
        ],
        { "Total-Results": "2", "Last-Modified-Version": "91" },
      ),
    );

    const result = await importCollection("key", "123", null);
    expect(result.bibtex).toContain("Just Added");
    expect(result.keyMap.PDF1).toBeUndefined();
    expect(result.keyMap.NEWEST).toBe("newest");
  });

  it("merges local desktop items with the web library so unsynced newest rows appear", async () => {
    invokeMock.mockImplementation(
      async (_command: unknown, args: { source?: string; path: string }) => {
        if (!String(args.path).includes("/items")) {
          throw new Error(`unexpected path ${args.path}`);
        }
        if (args.source === "local") {
          return {
            status: 200,
            headers: {
              "Total-Results": "1",
              "Last-Modified-Version": "12",
            },
            body: JSON.stringify([
              {
                key: "LOCAL1",
                bibtex: "@article{local,\n  title = {Unsynced Latest}\n}",
                data: { itemType: "journalArticle", title: "Unsynced Latest" },
              },
            ]),
            source: "local",
          };
        }
        return {
          status: 200,
          headers: {
            "Total-Results": "1",
            "Last-Modified-Version": "10",
          },
          body: JSON.stringify([
            {
              key: "WEB1",
              bibtex: "@article{web,\n  title = {Cloud Paper}\n}",
              data: { itemType: "journalArticle", title: "Cloud Paper" },
            },
          ]),
          source: "web",
        };
      },
    );

    const onProgress = vi.fn();
    const result = await importCollection("key", "123", null, onProgress);
    expect(result.bibtex).toContain("Unsynced Latest");
    expect(result.bibtex).toContain("Cloud Paper");
    expect(result.keyMap.LOCAL1).toBe("local");
    expect(result.keyMap.WEB1).toBe("web");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onProgress.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(onProgress).toHaveBeenCalledWith(1, 1);
  });

  it("walks /collections/{key}/collections when the index is only top-level", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/collections/PARENT/collections")) {
        return jsonResponse(
          [
            {
              key: "CHILD",
              data: { key: "CHILD", name: "Child", parentCollection: false },
              meta: { numItems: 2 },
            },
          ],
          { "Total-Results": "1" },
        );
      }
      if (url.includes("/collections/CHILD/collections")) {
        return jsonResponse(
          [
            {
              key: "GRAND",
              data: {
                key: "GRAND",
                name: "Grandchild",
                parentCollection: "CHILD",
              },
              meta: { numItems: 1 },
            },
          ],
          { "Total-Results": "1" },
        );
      }
      if (url.includes("/collections/GRAND/collections")) {
        return jsonResponse([], { "Total-Results": "0" });
      }
      if (url.includes("/collections?") && !url.includes("/items")) {
        return jsonResponse(
          [
            {
              key: "PARENT",
              data: { key: "PARENT", name: "Parent", parentCollection: false },
              meta: { numItems: 0 },
            },
          ],
          { "Total-Results": "1" },
        );
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const collections = await fetchCollections("key", "123");
    expect(rootZoteroCollections(collections).map((item) => item.key)).toEqual([
      "PARENT",
    ]);
    expect(
      childZoteroCollections(collections, "PARENT").map((item) => item.name),
    ).toEqual(["Child"]);
    expect(
      childZoteroCollections(collections, "CHILD").map((item) => item.name),
    ).toEqual(["Grandchild"]);
    expect(descendantCollectionKeys(collections, "PARENT")).toEqual([
      "PARENT",
      "CHILD",
      "GRAND",
    ]);
  });

  it("keeps web parentKey when local rows omit nesting", async () => {
    invokeMock.mockImplementation(
      async (_command: unknown, args: { source?: string; path: string }) => {
        if (!String(args.path).includes("/collections")) {
          throw new Error(`unexpected path ${args.path}`);
        }
        const isChildEndpoint = /\/collections\/[^/?]+\/collections/.test(
          args.path,
        );
        if (args.source === "local") {
          if (isChildEndpoint) {
            return {
              status: 200,
              headers: { "Total-Results": "0" },
              body: "[]",
              source: "local",
            };
          }
          return {
            status: 200,
            headers: { "Total-Results": "2" },
            body: JSON.stringify([
              {
                key: "PARENT",
                data: {
                  key: "PARENT",
                  name: "Parent",
                  parentCollection: false,
                },
                meta: { numItems: 0 },
              },
              {
                key: "CHILD",
                data: { key: "CHILD", name: "Child", parentCollection: false },
                meta: { numItems: 1 },
              },
            ]),
            source: "local",
          };
        }
        if (isChildEndpoint) {
          return {
            status: 200,
            headers: { "Total-Results": "0" },
            body: "[]",
            source: "web",
          };
        }
        return {
          status: 200,
          headers: { "Total-Results": "2" },
          body: JSON.stringify([
            {
              key: "PARENT",
              data: { key: "PARENT", name: "Parent", parentCollection: false },
              meta: { numItems: 0 },
            },
            {
              key: "CHILD",
              data: { key: "CHILD", name: "Child", parentCollection: "PARENT" },
              meta: { numItems: 1 },
            },
          ]),
          source: "web",
        };
      },
    );

    const collections = await fetchCollections("key", "123");
    expect(collections.find((item) => item.key === "CHILD")?.parentKey).toBe(
      "PARENT",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
