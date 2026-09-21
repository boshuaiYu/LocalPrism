import { useEffect, useMemo, useState } from "react";
import { BookMarkedIcon, CheckIcon, SearchIcon } from "lucide-react";
import { useZoteroStore } from "@/stores/zotero-store";
import { useDocumentStore, type ProjectFile } from "@/stores/document-store";

const IDLE_SYNCED_COLLECTIONS = {};
const IDLE_PROJECT_FILES: ProjectFile[] = [];
import { orderEditedCitekeys } from "@/lib/latex-cite-edit";
import {
  applyCurrentBibFileNames,
  buildCiteCommand,
  collectBibliographyNamesFromTex,
  collectCitekeysFromProjectFiles,
  collectCitekeysFromSynced,
  collectCitekeysFromTexCitations,
  filterCitekeys,
  isBibliographyFile,
  mergeCitekeyEntries,
  pinCitekeysFirst,
  syncedCollectionsForProject,
  type CitekeyEntry,
} from "@/lib/zotero-citekeys";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

interface CitationPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInsert: (citeCommand: string) => void;
  /** Keys already in the \\cite under the cursor; when set, confirm updates that cite. */
  initialKeys?: string[];
  /** Command prefix to keep, e.g. `\\citep` or `\\citet*[see][]`. */
  citePrefix?: string;
}

export function CitationPickerDialog({
  open,
  onOpenChange,
  onInsert,
  initialKeys,
  citePrefix,
}: CitationPickerDialogProps) {
  const isAuthenticated = useZoteroStore((s) => s.isAuthenticated);
  const allSyncedCollections = useZoteroStore((s) =>
    open ? s.syncedCollections : IDLE_SYNCED_COLLECTIONS,
  );
  const projectRoot = useDocumentStore((s) => s.projectRoot);
  const projectFiles = useDocumentStore((s) =>
    open ? s.files : IDLE_PROJECT_FILES,
  );
  const loadFileContent = useDocumentStore((s) => s.loadFileContent);

  const syncedCollections = useMemo(
    () => syncedCollectionsForProject(allSyncedCollections, projectRoot),
    [allSyncedCollections, projectRoot],
  );

  const editingEntries = useMemo<CitekeyEntry[]>(
    () =>
      (initialKeys ?? []).map((citekey) => ({
        citekey,
        collectionName: "Current citation",
        bibFileName: "",
      })),
    [initialKeys],
  );

  const allEntries = useMemo(
    () =>
      applyCurrentBibFileNames(
        mergeCitekeyEntries(
          collectCitekeysFromSynced(syncedCollections),
          collectCitekeysFromProjectFiles(projectFiles),
          collectCitekeysFromTexCitations(projectFiles),
          editingEntries,
        ),
        projectFiles,
      ),
    [editingEntries, projectFiles, syncedCollections],
  );

  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const isEditing = citePrefix != null;

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelected(new Set(initialKeys ?? []));
  }, [open, initialKeys]);

  useEffect(() => {
    if (!open) return;
    const wanted = new Set(
      collectBibliographyNamesFromTex(projectFiles).map((name) =>
        name.toLowerCase(),
      ),
    );
    for (const file of projectFiles) {
      const fileName = (
        file.name ||
        file.relativePath.split(/[\\/]/).pop() ||
        ""
      ).toLowerCase();
      if ((isBibliographyFile(file) || wanted.has(fileName)) && !file.content) {
        void loadFileContent(file.id || file.relativePath);
      }
    }
  }, [loadFileContent, open, projectFiles]);

  const filtered = useMemo(
    () => pinCitekeysFirst(filterCitekeys(allEntries, query), initialKeys),
    [allEntries, initialKeys, query],
  );

  const typedKeys = query
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);
  const hasSyncedCollections = Object.keys(syncedCollections).length > 0;

  const toggle = (citekey: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(citekey)) next.delete(citekey);
      else next.add(citekey);
      return next;
    });
  };

  const handleInsert = () => {
    const ordered = isEditing
      ? orderEditedCitekeys(selected, initialKeys)
      : [
          ...filtered
            .filter((e) => selected.has(e.citekey))
            .map((e) => e.citekey),
        ];
    if (!isEditing) {
      for (const key of selected) {
        if (!ordered.includes(key)) ordered.push(key);
      }
    }
    if (ordered.length === 0 && typedKeys.length > 0) {
      ordered.push(...typedKeys);
    }
    if (ordered.length === 0) return;
    onInsert(buildCiteCommand(ordered, citePrefix));
    onOpenChange(false);
  };

  const canInsert = selected.size > 0 || typedKeys.length > 0;
  const insertCount = selected.size > 0 ? selected.size : typedKeys.length;
  const insertLabel = isEditing
    ? insertCount > 1
      ? `Update ${insertCount} citations`
      : "Update citation"
    : insertCount > 1
      ? `Insert ${insertCount} citations`
      : "Insert citation";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(80vh,32rem)] max-h-[min(80vh,32rem)] flex-col gap-3 overflow-hidden sm:max-w-md">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <BookMarkedIcon className="size-4" />
            {isEditing ? "Edit citation" : "Insert citation"}
          </DialogTitle>
          <DialogDescription>
            {isEditing
              ? "Add or remove keys in the citation under the cursor. Confirm to update the existing command."
              : "Pick from .bib files, Zotero, or keys already used in the document. You can also type a citekey and insert it."}
          </DialogDescription>
        </DialogHeader>

        <div className="relative shrink-0">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search or type citekey…"
            className="h-8 pl-8"
            onKeyDown={(e) => {
              if (e.key === "Enter" && canInsert) {
                e.preventDefault();
                handleInsert();
              }
            }}
          />
        </div>

        {allEntries.length > 0 ? (
          <div
            role="listbox"
            aria-multiselectable="true"
            className="min-h-0 flex-1 overflow-y-auto rounded-md border p-1"
          >
            {filtered.length === 0 ? (
              <p className="px-2 py-6 text-center text-muted-foreground text-sm">
                No citekeys match “{query.trim()}”. Press Insert to use it
                anyway.
              </p>
            ) : (
              filtered.map((entry) => (
                <CitekeyRow
                  key={entry.citekey}
                  entry={entry}
                  selected={selected.has(entry.citekey)}
                  onToggle={() => toggle(entry.citekey)}
                />
              ))
            )}
          </div>
        ) : (
          <EmptyHelp
            title={
              !isAuthenticated && !hasSyncedCollections
                ? "No bibliography loaded"
                : !hasSyncedCollections
                  ? "No synced collections"
                  : "No citekeys yet"
            }
            body={
              !isAuthenticated && !hasSyncedCollections
                ? "Add a .bib file, connect Zotero, or type a citekey above."
                : !hasSyncedCollections
                  ? "Sync a Zotero collection, add entries to a project .bib file, or type a citekey above."
                  : "Synced collections and project .bib files have no citation keys yet. Type a citekey above or sync again."
            }
          />
        )}

        <DialogFooter className="shrink-0 sm:justify-between">
          <span className="self-center text-muted-foreground text-xs">
            {selected.size > 0
              ? `${selected.size} selected`
              : allEntries.length > 0
                ? `${allEntries.length} citekey${allEntries.length === 1 ? "" : "s"}`
                : "Type a citekey to insert"}
          </span>
          <div className="flex shrink-0 gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              className="shrink-0"
              disabled={!canInsert}
              onClick={handleInsert}
            >
              {insertLabel}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EmptyHelp({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-md border border-dashed px-4 py-8 text-center">
      <p className="font-medium text-sm">{title}</p>
      <p className="mt-1 text-muted-foreground text-xs leading-relaxed">
        {body}
      </p>
    </div>
  );
}

function CitekeyRow({
  entry,
  selected,
  onToggle,
}: {
  entry: CitekeyEntry;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onToggle}
      className={cn(
        "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
        selected ? "bg-accent text-accent-foreground" : "hover:bg-muted/60",
      )}
    >
      <span
        className={cn(
          "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border",
          selected
            ? "border-foreground bg-foreground text-background"
            : "border-muted-foreground/40",
        )}
      >
        {selected && <CheckIcon className="size-3" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-sm">
          {entry.citekey}
        </span>
        <span className="block truncate text-muted-foreground text-xs">
          {entry.collectionName}
          {entry.bibFileName ? ` · ${entry.bibFileName}` : ""}
        </span>
      </span>
    </button>
  );
}
