import { FileTextIcon } from "lucide-react";
import { buildLatexProjectOutline } from "@/lib/latex-project-outline";
import { useI18n } from "@/lib/use-i18n";
import { cn } from "@/lib/utils";
import type { ProjectFile } from "@/stores/document-store";

export function LatexOutline({
  files,
  activeFileId,
  onSelectFile,
}: {
  files: ProjectFile[];
  activeFileId: string | null;
  onSelectFile: (id: string) => void;
}) {
  const { t } = useI18n();
  const outline = buildLatexProjectOutline(files);
  if (outline.length < 2) return null;

  return (
    <div
      className="shrink-0 border-sidebar-border border-b"
      data-testid="latex-outline"
    >
      <div className="flex h-7 items-center px-3 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
        {t("chrome.chapters")}
      </div>
      <div className="max-h-36 overflow-y-auto px-1 pb-1">
        {outline.map((entry) => {
          const active = entry.exists && entry.relativePath === activeFileId;
          return (
            <button
              key={`${entry.depth}:${entry.relativePath}`}
              type="button"
              className={cn(
                "flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs",
                active
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "hover:bg-sidebar-accent/70",
                !entry.exists && "text-muted-foreground",
              )}
              style={{ paddingLeft: `${8 + entry.depth * 12}px` }}
              title={
                entry.exists ? entry.relativePath : t("chrome.missingFile")
              }
              disabled={!entry.exists}
              onClick={() => onSelectFile(entry.relativePath)}
            >
              <FileTextIcon className="size-3.5 shrink-0" />
              <span className="min-w-0 truncate">
                {entry.title ? `${entry.title}` : entry.fileName}
              </span>
              {entry.title && (
                <span className="ml-auto shrink-0 truncate font-mono text-[10px] text-muted-foreground">
                  {entry.fileName}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
