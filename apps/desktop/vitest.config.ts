import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  define: {
    __MUPDF_WASM_FS_PATH__: JSON.stringify(""),
    __MUPDF_USE_FS_WASM__: JSON.stringify(false),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/__tests__/mocks/tauri.ts"],
  },
});
