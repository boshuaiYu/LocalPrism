import { describe, expect, it } from "vitest";
import { homeProjectListState } from "@/lib/home-project-list";

describe("homeProjectListState", () => {
  it("shows an empty home when there are no recent projects", () => {
    expect(
      homeProjectListState({ recentCount: 0, query: "", matchCount: 0 }),
    ).toBe("empty");
  });

  it("shows no-results when a search matches nothing", () => {
    expect(
      homeProjectListState({
        recentCount: 3,
        query: "missing",
        matchCount: 0,
      }),
    ).toBe("no-results");
  });

  it("lists projects when the search matches", () => {
    expect(
      homeProjectListState({ recentCount: 3, query: "thesis", matchCount: 1 }),
    ).toBe("list");
  });
});
