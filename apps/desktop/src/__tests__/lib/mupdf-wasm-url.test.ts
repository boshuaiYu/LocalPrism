import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveMupdfWasmUrl } from "@/lib/mupdf/mupdf-wasm-url";

describe("resolveMupdfWasmUrl", () => {
  it("rewrites the wasm file to Vite @fs only in local dev", () => {
    expect(
      resolveMupdfWasmUrl("mupdf-wasm.wasm", {
        useDevFs: true,
        devFsPath:
          "F:/Projects/claude-prism/node_modules/mupdf/dist/mupdf-wasm.wasm",
      }),
    ).toBe(
      "/@fs/F:/Projects/claude-prism/node_modules/mupdf/dist/mupdf-wasm.wasm",
    );
  });

  it("leaves the packaged wasm locator untouched", () => {
    expect(
      resolveMupdfWasmUrl("mupdf-wasm.wasm", {
        useDevFs: false,
        devFsPath:
          "F:/Projects/claude-prism/node_modules/mupdf/dist/mupdf-wasm.wasm",
      }),
    ).toBe("mupdf-wasm.wasm");
  });
});

describe("mupdf-worker wasm locator", () => {
  it("does not gate the @fs rewrite on import.meta.env.DEV", () => {
    const workerPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../lib/mupdf/mupdf-worker.ts",
    );
    const source = readFileSync(workerPath, "utf8");
    expect(source).toContain("__MUPDF_USE_FS_WASM__");
    expect(source).not.toContain("if (import.meta.env.DEV)");
  });
});
