import { useEffect, useState } from "react";
import {
  SettingsIcon,
  DownloadIcon,
  LoaderIcon,
  LogOutIcon,
  RefreshCwIcon,
  ExternalLinkIcon,
  LinkIcon,
  UserIcon,
  FolderIcon,
  LibraryIcon,
  ChevronRightIcon,
  ChevronDownIcon,
  CheckIcon,
  XIcon,
} from "lucide-react";
import { useZoteroStore, type CollectionSyncInfo } from "@/stores/zotero-store";
import { useDocumentStore } from "@/stores/document-store";
import { cn } from "@/lib/utils";
import { canonicalProjectPath } from "@/lib/project-fs-operations";
import {
  childZoteroCollections,
  rootZoteroCollections,
  type ZoteroCollection,
} from "@/lib/zotero-api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const MYLIB_KEY = "__my_library__";

type ZoteroSyncProgress = {
  loaded: number;
  total: number;
  writing?: boolean;
};

function compactSyncHeader(
  name: string,
  progress: ZoteroSyncProgress | null,
): string {
  if (progress?.writing) return `Writing ${name}`;
  if (progress && progress.total > 0) {
    return `Downloading ${name} ${progress.loaded}/${progress.total}`;
  }
  return `Downloading ${name}`;
}

function zoteroSyncStatus(progress: ZoteroSyncProgress | null): string {
  if (progress?.writing) return "Writing bibliography…";
  if (progress && progress.total > 0) {
    return `${progress.loaded}/${progress.total}`;
  }
  return "Downloading…";
}

function zoteroSyncPercent(progress: ZoteroSyncProgress | null): number | null {
  if (!progress || progress.total <= 0) return null;
  return Math.min(100, Math.round((progress.loaded / progress.total) * 100));
}

function syncingCollectionName(
  isSyncing: string,
  collections: ZoteroCollection[],
  syncedCollections: Record<string, CollectionSyncInfo>,
): string {
  if (isSyncing === MYLIB_KEY) return "My Library";
  return (
    collections.find((collection) => collection.key === isSyncing)?.name ??
    syncedCollections[isSyncing]?.name ??
    "collection"
  );
}

function ZoteroSyncBar({
  progress,
  label,
}: {
  progress: ZoteroSyncProgress | null;
  label: string;
}) {
  const percent = zoteroSyncPercent(progress);
  if (percent === null) return null;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className="h-1 overflow-hidden rounded-full bg-muted"
    >
      <div
        className="h-full bg-foreground/60 transition-[width] duration-300"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

export function ZoteroPanel() {
  const isAuthenticated = useZoteroStore((s) => s.isAuthenticated);
  const _username = useZoteroStore((s) => s.username);
  const isValidating = useZoteroStore((s) => s.isValidating);
  const isSyncing = useZoteroStore((s) => s.isSyncing);
  const syncProgress = useZoteroStore((s) => s.syncProgress);
  const projectRoot = useDocumentStore((s) => s.projectRoot);
  const allSyncedCollections = useZoteroStore((s) => s.syncedCollections);
  const syncedCollections = projectRoot
    ? (allSyncedCollections[canonicalProjectPath(projectRoot)] ?? {})
    : {};
  const error = useZoteroStore((s) => s.error);
  const collections = useZoteroStore((s) => s.collections);
  const isLoadingCollections = useZoteroStore((s) => s.isLoadingCollections);
  const connectWithOAuth = useZoteroStore((s) => s.connectWithOAuth);
  const cancelConnect = useZoteroStore((s) => s.cancelConnect);
  const _disconnect = useZoteroStore((s) => s.disconnect);
  const revalidate = useZoteroStore((s) => s.revalidate);
  const _loadCollections = useZoteroStore((s) => s.loadCollections);
  const importCollectionToBib = useZoteroStore((s) => s.importCollectionToBib);
  const syncCollectionBib = useZoteroStore((s) => s.syncCollectionBib);
  const removeCollection = useZoteroStore((s) => s.removeCollection);

  const [connectDialogOpen, setConnectDialogOpen] = useState(false);

  useEffect(() => {
    const { apiKey } = useZoteroStore.getState();
    if (apiKey) revalidate();
  }, [revalidate]);

  const topCollections = rootZoteroCollections(collections);
  const headerStatus = isSyncing
    ? compactSyncHeader(
        syncingCollectionName(isSyncing, collections, syncedCollections),
        syncProgress,
      )
    : null;

  return (
    <div className="flex h-full flex-col">
      {/* Content */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!isAuthenticated ? (
          <NotConnectedView
            isValidating={isValidating}
            error={error}
            onConnect={connectWithOAuth}
            onCancel={cancelConnect}
            onApiKey={() => setConnectDialogOpen(true)}
          />
        ) : (
          <div className="py-0.5">
            {/* Error */}
            {error && (
              <div className="mx-2 mb-1 rounded bg-destructive/10 px-2 py-1 text-destructive text-xs">
                {error}
              </div>
            )}

            {/* Compact progress under the Zotero header */}
            {isSyncing && headerStatus && (
              <div className="mx-2 mb-1 space-y-0.5">
                <div className="flex items-center gap-1 text-muted-foreground text-xs">
                  <LoaderIcon className="size-3 shrink-0 animate-spin" />
                  <span className="truncate">{headerStatus}</span>
                </div>
                <ZoteroSyncBar progress={syncProgress} label={headerStatus} />
              </div>
            )}

            {/* My Library */}
            <CollectionRow
              collectionKey={null}
              name="My Library"
              icon={<LibraryIcon className="size-3.5" />}
              syncInfo={syncedCollections[MYLIB_KEY]}
              isSyncing={isSyncing === MYLIB_KEY}
              syncProgress={syncProgress}
              onImport={() => importCollectionToBib(null, "My Library")}
              onSync={() => syncCollectionBib(null)}
              onRemove={() => removeCollection(null)}
              disabled={!!isSyncing}
            />

            {topCollections.length > 0 && (
              <div className="mx-2 my-0.5 border-sidebar-border border-t" />
            )}

            {isLoadingCollections ? (
              <div className="flex items-center gap-1 px-2 py-1 text-muted-foreground text-xs">
                <LoaderIcon className="size-3 animate-spin" />
                Loading...
              </div>
            ) : (
              topCollections.map((col) => (
                <CollectionBranch
                  key={col.key}
                  collection={col}
                  collections={collections}
                  syncedCollections={syncedCollections}
                  isSyncing={isSyncing}
                  syncProgress={syncProgress}
                  disabled={!!isSyncing}
                  depth={0}
                  onImport={importCollectionToBib}
                  onSync={syncCollectionBib}
                  onRemove={removeCollection}
                />
              ))
            )}
          </div>
        )}
      </div>

      <ZoteroApiKeyDialog
        open={connectDialogOpen}
        onOpenChange={setConnectDialogOpen}
      />
    </div>
  );
}

/** Header rendered separately by Sidebar so it sits outside the resizable panel content */
export function ZoteroHeader() {
  const isAuthenticated = useZoteroStore((s) => s.isAuthenticated);
  const username = useZoteroStore((s) => s.username);
  const isLoadingCollections = useZoteroStore((s) => s.isLoadingCollections);
  const disconnect = useZoteroStore((s) => s.disconnect);
  const loadCollections = useZoteroStore((s) => s.loadCollections);

  return (
    <div
      className="relative flex w-full items-center justify-center px-3"
      data-tour="tour-zotero"
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "size-1.5 rounded-full",
            isAuthenticated ? "bg-foreground" : "bg-muted-foreground/30",
          )}
        />
        <span className="font-medium text-xs">Zotero</span>
      </div>
      {isAuthenticated && (
        <div className="absolute right-3 flex items-center gap-1">
          <button
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
            onClick={loadCollections}
            title="Refresh"
          >
            <RefreshCwIcon
              className={cn("size-3.5", isLoadingCollections && "animate-spin")}
            />
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="rounded p-1 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground">
                <SettingsIcon className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <div className="flex items-center gap-2 px-2 py-1">
                <UserIcon className="size-3.5 text-muted-foreground" />
                <span className="truncate text-muted-foreground text-xs">
                  {username}
                </span>
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={disconnect}>
                <LogOutIcon className="mr-2 size-3.5" />
                Disconnect
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </div>
  );
}

// ─── Not Connected View ───

function NotConnectedView({
  isValidating,
  error,
  onConnect,
  onCancel,
  onApiKey,
}: {
  isValidating: boolean;
  error: string | null;
  onConnect: () => void;
  onCancel: () => void;
  onApiKey: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-3 py-4 text-center">
      <div className="flex size-8 items-center justify-center rounded-full bg-muted">
        <LinkIcon className="size-4 text-muted-foreground" />
      </div>
      <p className="text-[11px] text-muted-foreground leading-relaxed">
        Connect Zotero to import references.
      </p>
      {isValidating ? (
        <div className="flex flex-col items-center gap-1">
          <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <LoaderIcon className="size-3 animate-spin" />
            Authorizing...
          </div>
          <button
            className="text-[10px] text-muted-foreground underline"
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-1">
          <Button
            size="sm"
            className="h-6 gap-1 text-[11px]"
            onClick={onConnect}
          >
            <ExternalLinkIcon className="size-3" />
            Connect
          </Button>
          <button
            className="text-[10px] text-muted-foreground underline"
            onClick={onApiKey}
          >
            API key
          </button>
        </div>
      )}
      {error && <p className="text-[10px] text-destructive">{error}</p>}
    </div>
  );
}

// ─── Collection Tree ───

function CollectionBranch({
  collection,
  collections,
  syncedCollections,
  isSyncing,
  syncProgress,
  disabled,
  depth,
  ancestry = [],
  onImport,
  onSync,
  onRemove,
}: {
  collection: ZoteroCollection;
  collections: ZoteroCollection[];
  syncedCollections: Record<string, CollectionSyncInfo>;
  isSyncing: string | null;
  syncProgress: ZoteroSyncProgress | null;
  disabled: boolean;
  depth: number;
  ancestry?: string[];
  onImport: (collectionKey: string | null, name: string) => void;
  onSync: (collectionKey: string | null) => void;
  onRemove: (collectionKey: string | null) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  if (ancestry.includes(collection.key)) return null;
  const nextAncestry = [...ancestry, collection.key];
  const children = childZoteroCollections(collections, collection.key);
  return (
    <>
      <CollectionRow
        collectionKey={collection.key}
        name={collection.name}
        icon={<FolderIcon className="size-3.5" />}
        itemCount={collection.itemCount}
        syncInfo={syncedCollections[collection.key]}
        isSyncing={isSyncing === collection.key}
        syncProgress={syncProgress}
        onImport={() => onImport(collection.key, collection.name)}
        onSync={() => onSync(collection.key)}
        onRemove={() => onRemove(collection.key)}
        disabled={disabled}
        depth={depth}
        hasChildren={children.length > 0}
        expanded={expanded}
        onToggle={() => setExpanded((current) => !current)}
      />
      {expanded &&
        children.map((child) => (
          <CollectionBranch
            key={child.key}
            collection={child}
            collections={collections}
            syncedCollections={syncedCollections}
            isSyncing={isSyncing}
            syncProgress={syncProgress}
            disabled={disabled}
            depth={depth + 1}
            ancestry={nextAncestry}
            onImport={onImport}
            onSync={onSync}
            onRemove={onRemove}
          />
        ))}
    </>
  );
}

// ─── Collection Row ───

function CollectionRow({
  collectionKey: _collectionKey,
  name,
  icon,
  itemCount,
  syncInfo,
  isSyncing,
  syncProgress,
  onImport,
  onSync,
  onRemove,
  disabled,
  depth = 0,
  hasChildren = false,
  expanded = true,
  onToggle,
}: {
  collectionKey: string | null;
  name: string;
  icon: React.ReactNode;
  itemCount?: number;
  syncInfo?: CollectionSyncInfo;
  isSyncing: boolean;
  syncProgress?: ZoteroSyncProgress | null;
  onImport: () => void;
  onSync: () => void;
  onRemove: () => void;
  disabled: boolean;
  depth?: number;
  hasChildren?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  const isSynced = !!syncInfo;
  const status = isSyncing ? zoteroSyncStatus(syncProgress ?? null) : null;

  return (
    <div
      className="group flex items-center gap-1.5 py-0.5 pr-2"
      style={{ paddingLeft: `${8 + depth * 12}px` }}
      aria-busy={isSyncing || undefined}
    >
      {hasChildren ? (
        <button
          type="button"
          className="rounded p-0.5 text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
          title={expanded ? `Collapse ${name}` : `Expand ${name}`}
          aria-expanded={expanded}
          onClick={onToggle}
        >
          {expanded ? (
            <ChevronDownIcon className="size-3" />
          ) : (
            <ChevronRightIcon className="size-3" />
          )}
        </button>
      ) : (
        <span className="size-4 shrink-0" />
      )}
      <span className="shrink-0 text-muted-foreground">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          {isSyncing && (
            <LoaderIcon className="size-3 shrink-0 animate-spin text-muted-foreground" />
          )}
          <span className="truncate text-foreground text-sm">{name}</span>
          {isSynced && !isSyncing && (
            <CheckIcon className="size-2.5 shrink-0 text-muted-foreground" />
          )}
        </div>
        {isSyncing ? (
          <div className="mt-0.5 space-y-0.5">
            <p className="truncate text-muted-foreground text-xs leading-none">
              {status}
            </p>
            <ZoteroSyncBar
              progress={syncProgress ?? null}
              label={status ?? ""}
            />
          </div>
        ) : isSynced ? (
          <p className="truncate text-muted-foreground text-xs leading-none">
            {syncInfo.bibFileName}
          </p>
        ) : itemCount !== undefined ? (
          <p className="text-muted-foreground text-xs leading-none">
            {itemCount} items
          </p>
        ) : null}
      </div>
      {!(isSyncing && !isSynced) && (
        <div
          className={cn(
            "flex shrink-0 items-center gap-0.5 transition-opacity",
            isSyncing ? "opacity-100" : "opacity-0 group-hover:opacity-100",
          )}
        >
          {isSynced ? (
            <>
              <button
                className="rounded p-0.5 text-muted-foreground hover:bg-sidebar-accent hover:text-foreground disabled:opacity-30"
                onClick={onSync}
                disabled={disabled}
                title="Sync"
              >
                {isSyncing ? (
                  <LoaderIcon className="size-3 animate-spin" />
                ) : (
                  <RefreshCwIcon className="size-3" />
                )}
              </button>
              <button
                className="rounded p-0.5 text-muted-foreground hover:bg-sidebar-accent hover:text-foreground disabled:opacity-30"
                onClick={onRemove}
                disabled={disabled}
                title="Remove"
              >
                <XIcon className="size-3" />
              </button>
            </>
          ) : (
            <button
              className="rounded p-0.5 text-muted-foreground hover:bg-sidebar-accent hover:text-foreground disabled:opacity-30"
              onClick={onImport}
              disabled={disabled}
              title="Import"
            >
              <DownloadIcon className="size-3" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── API Key Dialog ───

function ZoteroApiKeyDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const connect = useZoteroStore((s) => s.connectWithApiKey);
  const isValidating = useZoteroStore((s) => s.isValidating);
  const error = useZoteroStore((s) => s.error);

  const handleConnect = async () => {
    const key = apiKey.trim();
    if (!key) return;
    const success = await connect(key);
    if (success) {
      onOpenChange(false);
      setApiKey("");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Connect to Zotero</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-4">
          <p className="text-muted-foreground text-sm">
            Enter your Zotero API key.
          </p>
          <Input
            type="password"
            placeholder="Zotero API Key"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleConnect();
            }}
            autoFocus
          />
          {error && <p className="text-destructive text-xs">{error}</p>}
          <p className="text-muted-foreground text-xs">
            Create a key at{" "}
            <a
              href="https://www.zotero.org/settings/keys"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline"
            >
              zotero.org/settings/keys
            </a>
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleConnect}
            disabled={!apiKey.trim() || isValidating}
          >
            {isValidating ? "Validating..." : "Connect"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
