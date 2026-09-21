export const LIVE_COMPILE_DEBOUNCE_MS = 800;

export function shouldScheduleLiveCompile(input: {
  autoCompile: boolean;
  isTexPreview: boolean;
  isProjectMutating: boolean;
  isCompiling: boolean;
  pendingRecompile: boolean;
  contentGeneration: number;
  lastCompiledGeneration: number | undefined;
}): boolean {
  if (!input.autoCompile || !input.isTexPreview || input.isProjectMutating) {
    return false;
  }
  if (input.isCompiling || input.pendingRecompile) {
    return false;
  }
  if (input.lastCompiledGeneration === input.contentGeneration) {
    return false;
  }
  return true;
}
