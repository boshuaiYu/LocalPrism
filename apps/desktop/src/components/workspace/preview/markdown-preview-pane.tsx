import { useEffect } from "react";

import { MarkdownDocument } from "@/components/workspace/preview/markdown-document";
import { useDocumentStore, type ProjectFile } from "@/stores/document-store";

export function MarkdownPreviewPane({ file }: { file: ProjectFile | null }) {
  const loadFileContent = useDocumentStore((state) => state.loadFileContent);
  const liveFile = useDocumentStore((state) => {
    if (!file) return null;
    return state.files.find((candidate) => candidate.id === file.id) ?? file;
  });

  useEffect(() => {
    if (liveFile && liveFile.content === undefined) {
      void loadFileContent(liveFile.id);
    }
  }, [liveFile, loadFileContent]);

  if (!liveFile) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground text-sm">
        No markdown file selected
      </div>
    );
  }

  if (liveFile.content === undefined) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground text-sm">
        Loading markdown…
      </div>
    );
  }

  if (!liveFile.content.trim()) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground text-sm">
        This markdown file is empty
      </div>
    );
  }

  return (
    <div className="md-preview-stage" data-testid="md-preview-stage">
      <article className="md-preview-paper" data-testid="md-preview-paper">
        <MarkdownDocument
          content={liveFile.content}
          filePath={liveFile.absolutePath}
        />
      </article>
    </div>
  );
}
