import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../../../src-tauri/src");

describe("pinned CLI installers", () => {
  it("does not pipe a live Claude installer script into a shell", () => {
    const source = readFileSync(resolve(root, "claude.rs"), "utf8");
    expect(source).not.toContain("curl -fsSL https://claude.ai/install.sh | bash");
    expect(source).not.toContain("irm https://claude.ai/install.ps1 | iex");
    expect(source).toContain("pinned_install::claude_asset");
    expect(source).toContain("download_verified_archive");
  });

  it("does not pipe a live uv installer script into a shell", () => {
    const source = readFileSync(resolve(root, "uv.rs"), "utf8");
    expect(source).not.toContain("curl -LsSf https://astral.sh/uv/install.sh | sh");
    expect(source).not.toContain("irm https://astral.sh/uv/install.ps1 | iex");
    expect(source).toContain("pinned_install::uv_asset");
    expect(source).toContain("download_verified_archive");
  });
});
