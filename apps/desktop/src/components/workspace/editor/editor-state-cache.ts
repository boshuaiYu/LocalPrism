/** Per-file editor state cache: fileId → { cursor, scrollTop } */
export const editorStateCache = new Map<
  string,
  { cursor: number; scrollTop: number }
>();

/** Clear editor state cache (e.g., on project close). */
export function clearEditorStateCache(): void {
  editorStateCache.clear();
}
