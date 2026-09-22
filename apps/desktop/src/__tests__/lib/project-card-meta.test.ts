import { describe, expect, it } from "vitest";
import {
  formatRelativeUpdated,
  projectCardMetaLine,
  projectPathSubtitle,
} from "@/lib/project-card-meta";

const now = Date.parse("2026-09-22T12:00:00Z");

describe("project card meta", () => {
  it("formats recent updates relative to now", () => {
    expect(formatRelativeUpdated(now - 30_000, now)).toBe("Updated just now");
    expect(formatRelativeUpdated(now - 5 * 60_000, now)).toBe("Updated 5m ago");
    expect(formatRelativeUpdated(now - 3 * 60 * 60_000, now)).toBe(
      "Updated 3h ago",
    );
    expect(formatRelativeUpdated(now - 2 * 24 * 60 * 60_000, now)).toBe(
      "Updated 2d ago",
    );
  });

  it("keeps the last two path segments as the subtitle", () => {
    expect(projectPathSubtitle("/Users/me/papers/thesis")).toBe(
      "…/papers/thesis",
    );
    expect(projectPathSubtitle("C:\\work\\notes")).toBe("…/work/notes");
  });

  it("joins path, time, and preview status when a preview exists", () => {
    expect(
      projectCardMetaLine({
        path: "/Users/me/papers/thesis",
        updatedAt: now - 60_000,
        now,
        preview: "pdf",
      }),
    ).toBe("…/papers/thesis · Updated 1m ago · PDF ready");
  });
});
