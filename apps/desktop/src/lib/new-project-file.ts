export type NewProjectFileKind = "tex" | "markdown";
export type CreatedProjectFileType = "tex" | "markdown" | "image";

const IMAGE_EXT = /\.(png|jpg|jpeg|gif|svg|bmp|webp)$/i;
const MARKDOWN_EXT = /\.(md|markdown)$/i;
const TEX_EXT = /\.(tex|ltx)$/i;

export function resolveNewProjectFile(
  rawName: string,
  kind: NewProjectFileKind,
): { name: string; type: CreatedProjectFileType } {
  const trimmed = rawName.trim();
  const hasExtension = /\.\w+$/.test(trimmed);
  const name = hasExtension
    ? trimmed
    : kind === "markdown"
      ? `${trimmed}.md`
      : `${trimmed}.tex`;

  if (IMAGE_EXT.test(name)) {
    return { name, type: "image" };
  }
  if (MARKDOWN_EXT.test(name)) {
    return { name, type: "markdown" };
  }
  if (TEX_EXT.test(name) || kind === "tex") {
    return { name, type: "tex" };
  }
  return { name, type: kind };
}

export function newProjectFileTemplate(
  name: string,
  type: CreatedProjectFileType,
): string {
  if (type === "tex") {
    return `\\documentclass{article}\n\n\\begin{document}\n\n% Your content here\n\n\\end{document}\n`;
  }
  if (type === "markdown") {
    const stem = name.replace(/\.(md|markdown)$/i, "") || "Untitled";
    return `# ${stem}\n\n`;
  }
  return "";
}
