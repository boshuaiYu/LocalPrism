import { FolderOpenIcon, FolderPlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

export function HomeEmptyState({
  variant,
  query,
  onNewProject,
  onOpenFolder,
  onClearSearch,
}: {
  variant: "empty" | "no-results";
  query?: string;
  onNewProject: () => void;
  onOpenFolder: () => void;
  onClearSearch?: () => void;
}) {
  const title =
    variant === "empty" ? "No projects yet" : "No matching projects";
  const body =
    variant === "empty"
      ? "Create a paper from a template, or open a folder you already have on disk."
      : `Nothing in Recent Projects matches “${query?.trim() || "that search"}”.`;

  return (
    <div
      data-testid={variant === "empty" ? "home-empty-state" : "home-no-results"}
      className="mt-8 rounded-lg border border-border/70 bg-card px-4 py-6 text-center"
    >
      <h2 className="lp-heading">{title}</h2>
      <p className="lp-body mx-auto mt-2 max-w-sm text-pretty">{body}</p>
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        <Button
          type="button"
          variant="outline"
          className="h-10 rounded-lg px-4"
          onClick={onNewProject}
        >
          <FolderPlusIcon className="size-4" />
          New project
        </Button>
        <Button
          type="button"
          className="lp-primary-cta h-10 rounded-lg px-4"
          onClick={onOpenFolder}
        >
          <FolderOpenIcon className="size-4" />
          Open folder
        </Button>
      </div>
      {variant === "no-results" && onClearSearch && (
        <button
          type="button"
          className="lp-meta lp-focus mt-3 rounded-sm underline-offset-2 hover:underline"
          onClick={onClearSearch}
        >
          Clear search
        </button>
      )}
    </div>
  );
}
