export interface MarkdownSourcePosition {
  line: number;
  column: number;
}

type HastLike = {
  type?: string;
  children?: HastLike[];
  properties?: Record<string, unknown>;
  position?: {
    start?: { line?: number; column?: number };
  };
};

const SOURCE_LINE_SELECTOR = "[data-source-line]";
const NON_NAVIGATING_TARGET =
  "a[href], button, input, textarea, select, summary";

/**
 * mdast positions are 1-based. The editor jump API takes a character offset
 * into the same source string SyncTeX already uses.
 */
export function readMarkdownSourcePosition(
  node: unknown,
): MarkdownSourcePosition | null {
  if (!node || typeof node !== "object") return null;
  const position = (node as { position?: unknown }).position;
  if (!position || typeof position !== "object") return null;
  const start = (position as { start?: unknown }).start;
  if (!start || typeof start !== "object") return null;
  const line = (start as { line?: unknown }).line;
  const column = (start as { column?: unknown }).column;
  if (typeof line !== "number" || !Number.isInteger(line) || line < 1) {
    return null;
  }
  const col =
    typeof column === "number" && Number.isFinite(column) && column >= 1
      ? Math.floor(column)
      : 1;
  return { line, column: col };
}

export function markdownSourceDataAttributes(node: unknown): {
  "data-source-line"?: number;
  "data-source-column"?: number;
} {
  const position = readMarkdownSourcePosition(node);
  if (!position) return {};
  return {
    "data-source-line": position.line,
    "data-source-column": position.column,
  };
}

export function markdownSourceOffset(
  content: string,
  line: number,
  column = 1,
): number | null {
  if (!Number.isInteger(line) || line < 1) return null;
  const lines = content.split("\n");
  if (line > lines.length) return null;
  let offset = 0;
  for (let index = 0; index < line - 1; index++) {
    offset += lines[index].length + 1;
  }
  const lineLength = lines[line - 1]?.length ?? 0;
  const col = Number.isFinite(column) && column >= 1 ? Math.floor(column) : 1;
  offset += Math.min(col - 1, lineLength);
  return offset;
}

function selectionInside(boundary: Element): boolean {
  const selection = boundary.ownerDocument.defaultView?.getSelection();
  if (
    !selection ||
    selection.rangeCount === 0 ||
    selection.toString().length === 0
  ) {
    return false;
  }
  const anchor = selection.getRangeAt(0).commonAncestorContainer;
  return boundary.contains(anchor);
}

export function markdownClickSourceOffset(
  content: string,
  target: Element,
  boundary: Element,
): number | null {
  if (!boundary.contains(target)) return null;
  // A drag-selection inside the preview is for copying. A selection in the
  // source editor must not swallow the click.
  if (selectionInside(boundary)) return null;
  if (target.closest(NON_NAVIGATING_TARGET)) return null;
  const source = target.closest(SOURCE_LINE_SELECTOR);
  if (!(source instanceof Element) || !boundary.contains(source)) return null;
  const line = Number(source.getAttribute("data-source-line"));
  const column = Number(source.getAttribute("data-source-column") ?? "1");
  if (!Number.isInteger(line)) return null;
  return markdownSourceOffset(content, line, column);
}

/** Stamp hast elements so clicks can resolve the original markdown line. */
export function rehypeMarkdownSourcePositions() {
  return (tree: HastLike) => {
    annotateMarkdownSourcePositions(tree);
  };
}

function annotateMarkdownSourcePositions(node: HastLike) {
  if (node.type === "element") {
    const position = readMarkdownSourcePosition(node);
    if (position) {
      node.properties = node.properties ?? {};
      node.properties.dataSourceLine = position.line;
      node.properties.dataSourceColumn = position.column;
    }
  }
  if (!node.children) return;
  for (const child of node.children) annotateMarkdownSourcePositions(child);
}
