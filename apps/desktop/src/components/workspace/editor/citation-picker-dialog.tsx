import { useEffect, useMemo, useState } from "react";
import { BookMarkedIcon, CheckIcon, SearchIcon } from "lucide-react";
import { useZoteroStore } from "@/stores/zotero-store";
import { useDocumentStore } from "@/stores/document-store";
import { canonicalProjectPath } from "@/lib/project-fs-operations";
import {
  buildCiteCommand,
  collectCitekeysFromSynced,
  filterCitekeys,
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
import { ScrollArea } from "@/components/ui/scroll-area";

interface CitationPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInsert: (citeCommand: string) => void;
}

export function CitationPickerDialog({
  open,
  onOpenChange,
  onInsert,
}: CitationPickerDialogProps) {
  const isAuthenticated = useZoteroStore((s) => s.isAuthenticated);
  const allSyncedCollections = useZoteroStore((s) => s.syncedCollections);
  const projectRoot = useDocumentStore((s) => s.projectRoot);

  const syncedCollections = useMemo(() => {
    if (!projectRoot) return {};
    return allSyncedCollections[canonicalProjectPath(projectRoot)] ?? {};
  }, [allSyncedCollections, projectRoot]);

  const allEntries = useMemo(
    () => collectCitekeysFromSynced(syncedCollections),
    [syncedCollections],
  );

  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelected(new Set());
  }, [open]);

  const filtered = useMemo(
    () => filterCitekeys(allEntries, query),
    [allEntries, query],
  );

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
    if (selected.size === 0) return;
    // Preserve list order for stable, predictable citekey joins
    const ordered = filtered
      .filter((e) => selected.has(e.citekey))
      .map((e) => e.citekey);
    // Include any selected keys filtered out of the current query
    for (const key of selected) {
      if (!ordered.includes(key)) ordered.push(key);
    }
    onInsert(buildCiteCommand(ordered));
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(80vh,32rem)] flex-col gap-3 overflow-hidden sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BookMarkedIcon className="size-4" />
            Insert citation
          </DialogTitle>
          <DialogDescription>
            Select citekeys from synced Zotero collections.
          </DialogDescription>
        </DialogHeader>

        {!isAuthenticated ? (
          <EmptyHelp
            title="Zotero not connected"
            body="Connect Zotero in the sidebar, then sync a collection to insert citations."
          />
        ) : !hasSyncedCollections ? (
          <EmptyHelp
            title="No synced collections"
            body="Import or sync a Zotero collection first. Citekeys appear here after sync."
          />
        ) : allEntries.length === 0 ? (
          <EmptyHelp
            title="No citekeys yet"
            body="Synced collections have no citation keys. Sync again after adding items in Zotero."
          />
        ) : (
          <>
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search citekeys…"
                className="h-8 pl-8"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && selected.size > 0) {
                    e.preventDefault();
                    handleInsert();
                  }
                }}
              />
            </div>

            <ScrollArea className="min-h-0 flex-1 rounded-md border">
              <div className="p-1" role="listbox" aria-multiselectable="true">
                {filtered.length === 0 ? (
                  <p className="px-2 py-6 text-center text-muted-foreground text-sm">
                    No citekeys match “{query.trim()}”.
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
            </ScrollArea>

            <DialogFooter className="sm:justify-between">
              <span className="self-center text-muted-foreground text-xs">
                {selected.size === 0
                  ? `${allEntries.length} citekey${allEntries.length === 1 ? "" : "s"}`
                  : `${selected.size} selected`}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onOpenChange(false)}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  disabled={selected.size === 0}
                  onClick={handleInsert}
                >
                  Insert{" "}
                  {selected.size > 0
                    ? `\\cite{${[...selected].slice(0, 2).join(",")}${selected.size > 2 ? ",…" : ""}}`
                    : "\\cite{}"}
                </Button>
              </div>
            </DialogFooter>
          </>
        )}
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
