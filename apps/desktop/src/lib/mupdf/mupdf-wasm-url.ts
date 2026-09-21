export function resolveMupdfWasmUrl(
  path: string,
  options: { useDevFs: boolean; devFsPath: string },
): string {
  if (options.useDevFs && path.endsWith("mupdf-wasm.wasm")) {
    return `/@fs/${options.devFsPath}`;
  }
  return path;
}
