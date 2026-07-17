import { remove } from "@tauri-apps/plugin-fs";

export async function cleanupTemporaryChatFiles(paths: string[]) {
  await Promise.all(
    Array.from(new Set(paths)).map(async (path) => {
      try {
        await remove(path);
      } catch {
        // Best-effort cleanup must not mask runtime lifecycle handling.
      }
    }),
  );
}
