import { describe, expect, it } from "vitest";
import {
  DEFAULT_PERMISSION_MODE,
  normalizePermissionMode,
  PERMISSION_MODE_OPTIONS,
  PERMISSION_MODES,
} from "@/lib/permission-mode";

describe("normalizePermissionMode", () => {
  it("keeps the three Claude modes this host can honor", () => {
    expect(normalizePermissionMode("acceptEdits")).toBe("acceptEdits");
    expect(normalizePermissionMode("bypassPermissions")).toBe(
      "bypassPermissions",
    );
    expect(normalizePermissionMode("plan")).toBe("plan");
  });

  it("maps ask/dont-ask leftovers onto allow-edits", () => {
    expect(normalizePermissionMode("default")).toBe("acceptEdits");
    expect(normalizePermissionMode("dontAsk")).toBe("acceptEdits");
  });

  it("falls back to allow-edits for unknown values", () => {
    expect(normalizePermissionMode(null)).toBe(DEFAULT_PERMISSION_MODE);
    expect(normalizePermissionMode("nope")).toBe(DEFAULT_PERMISSION_MODE);
  });
});

describe("PERMISSION_MODE_OPTIONS", () => {
  it("exposes only allow-edits, full access, and plan", () => {
    expect(PERMISSION_MODES).toEqual([
      "acceptEdits",
      "bypassPermissions",
      "plan",
    ]);
    expect(PERMISSION_MODE_OPTIONS.map((item) => item.id)).toEqual(
      PERMISSION_MODES,
    );
  });

  it("says allow-edits asks before extra tools run", () => {
    const option = PERMISSION_MODE_OPTIONS.find(
      (item) => item.id === "acceptEdits",
    );
    expect(option?.description.toLowerCase()).toMatch(/ask you|approval/);
    expect(option?.description.toLowerCase()).not.toMatch(/cannot show/);
  });
});
