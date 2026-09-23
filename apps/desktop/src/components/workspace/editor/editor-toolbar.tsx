import { RefObject, useCallback, useEffect, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import {
  BoldIcon,
  ItalicIcon,
  ListIcon,
  Heading1Icon,
  Heading2Icon,
  CodeIcon,
  CropIcon,
  FunctionSquareIcon,
  FileTextIcon,
  ImageIcon,
  MinusIcon,
  PlusIcon,
  BookMarkedIcon,
  ChevronDownIcon,
} from "lucide-react";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { Button } from "@/components/ui/button";
import codexIcon from "@/assets/codex.svg";
import cursorIcon from "@/assets/cursor.svg";
import vscodeIcon from "@/assets/vscode.svg";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useDocumentStore } from "@/stores/document-store";
import { useSettingsStore } from "@/stores/settings-store";
import { findCiteAtSelection, type CiteAtCursor } from "@/lib/latex-cite-edit";
import { CitationPickerDialog } from "@/components/workspace/editor/citation-picker-dialog";
import { useI18n } from "@/lib/use-i18n";

interface EditorInfo {
  id: string;
  name: string;
}

const ZOOM_OPTIONS = [
  { value: "0.5", label: "50%" },
  { value: "0.75", label: "75%" },
  { value: "1", label: "100%" },
  { value: "1.25", label: "125%" },
  { value: "1.5", label: "150%" },
  { value: "2", label: "200%" },
  { value: "3", label: "300%" },
  { value: "4", label: "400%" },
];

const DEFAULT_EDITOR_ID = "codex";
const PREFERRED_EDITOR_STORAGE_KEY = "localprism.preferredEditor";

const MONO_EDITOR_ICONS: Record<string, string> = {
  cursor: cursorIcon,
  codex: codexIcon,
};

function readPreferredEditorId(): string {
  try {
    const stored = localStorage.getItem(PREFERRED_EDITOR_STORAGE_KEY)?.trim();
    return stored || DEFAULT_EDITOR_ID;
  } catch {
    return DEFAULT_EDITOR_ID;
  }
}

function rememberPreferredEditorId(editorId: string) {
  try {
    localStorage.setItem(PREFERRED_EDITOR_STORAGE_KEY, editorId);
  } catch {
    // Private mode can reject storage. The in-memory choice still applies.
  }
}

function preferredEditor(
  editors: EditorInfo[],
  preferredId: string,
): EditorInfo | undefined {
  return (
    editors.find((editor) => editor.id === preferredId) ??
    editors.find((editor) => editor.id === DEFAULT_EDITOR_ID) ??
    editors[0]
  );
}

function EditorBrandIcon({ editor }: { editor: EditorInfo }) {
  const mono = MONO_EDITOR_ICONS[editor.id];
  if (mono) {
    return (
      <span
        aria-hidden="true"
        data-editor-icon={editor.id}
        className="inline-block size-4 shrink-0 bg-foreground"
        style={{
          WebkitMaskImage: `url("${mono}")`,
          maskImage: `url("${mono}")`,
          WebkitMaskRepeat: "no-repeat",
          maskRepeat: "no-repeat",
          WebkitMaskPosition: "center",
          maskPosition: "center",
          WebkitMaskSize: "contain",
          maskSize: "contain",
        }}
      />
    );
  }
  if (editor.id === "vscode") {
    return (
      <img
        src={vscodeIcon}
        alt=""
        aria-hidden="true"
        data-editor-icon="vscode"
        draggable={false}
        className="size-4"
      />
    );
  }
  return null;
}

function EditorMenuLabel({ editor }: { editor: EditorInfo }) {
  return (
    <span className="flex items-center gap-2">
      <EditorBrandIcon editor={editor} />
      {editor.name}
    </span>
  );
}

function OpenInEditorMenu({
  editors,
  onOpen,
  onRefresh,
}: {
  editors: EditorInfo[];
  onOpen: (editorId: string) => void;
  onRefresh: () => void;
}) {
  const { t } = useI18n();
  const [preferredId, setPreferredId] = useState(readPreferredEditorId);
  const selected = preferredEditor(editors, preferredId);

  const chooseEditor = (editorId: string) => {
    setPreferredId(editorId);
    rememberPreferredEditorId(editorId);
    onOpen(editorId);
  };

  return (
    <div className="flex items-center">
      <Button
        variant="ghost"
        size="icon"
        className="size-6 rounded-r-none p-1"
        title={
          selected
            ? t("editor.openWith", { name: selected.name })
            : t("editor.noneFound")
        }
        disabled={!selected}
        onClick={() => {
          if (selected) onOpen(selected.id);
        }}
      >
        {selected ? (
          <EditorBrandIcon editor={selected} />
        ) : (
          <EditorBrandIcon editor={{ id: DEFAULT_EDITOR_ID, name: "Codex" }} />
        )}
      </Button>
      <DropdownMenu
        onOpenChange={(open) => {
          if (open) onRefresh();
        }}
      >
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-4 rounded-l-none px-0"
            title={t("editor.choose")}
            aria-label={t("editor.choose")}
          >
            <ChevronDownIcon className="size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {editors.length === 0 ? (
            <DropdownMenuItem disabled>
              {t("editor.noneFound")}
            </DropdownMenuItem>
          ) : (
            editors.map((editor) => (
              <DropdownMenuItem
                key={editor.id}
                onClick={() => chooseEditor(editor.id)}
              >
                <EditorMenuLabel editor={editor} />
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

interface EditorToolbarProps {
  editorView: RefObject<EditorView | null>;
  fileType?: "tex" | "image";
  imageScale?: number;
  onImageScaleChange?: (scale: number) => void;
  cropMode?: boolean;
  onCropToggle?: () => void;
}

export function EditorToolbar({
  editorView,
  fileType = "tex",
  imageScale = 1,
  onImageScaleChange,
  cropMode,
  onCropToggle,
}: EditorToolbarProps) {
  const vimMode = useSettingsStore((s) => s.vimMode);
  const setVimMode = useSettingsStore((s) => s.setVimMode);

  const fileName = useDocumentStore((s) => {
    const activeFile = s.files.find((f) => f.id === s.activeFileId);
    return activeFile?.name ?? "main.tex";
  });
  const activeFilePath = useDocumentStore((s) => {
    const activeFile = s.files.find((f) => f.id === s.activeFileId);
    return activeFile?.relativePath;
  });
  const projectRoot = useDocumentStore((s) => s.projectRoot);

  const [editors, setEditors] = useState<EditorInfo[]>([]);
  const [citationPickerOpen, setCitationPickerOpen] = useState(false);
  const [editingCite, setEditingCite] = useState<CiteAtCursor | null>(null);

  const refreshEditors = useCallback(() => {
    invoke<EditorInfo[]>("detect_editors")
      .then((found) => {
        setEditors(
          Array.isArray(found)
            ? found.filter((editor) => editor.id && editor.name)
            : [],
        );
      })
      .catch((err: unknown) => {
        console.error("detect_editors failed:", err);
      });
  }, []);

  useEffect(() => {
    refreshEditors();
  }, [refreshEditors]);

  const openInEditor = useCallback(
    (editorId: string) => {
      if (!projectRoot) return;
      const view = editorView.current;
      const line = view
        ? view.state.doc.lineAt(view.state.selection.main.head).number
        : undefined;
      invoke("open_in_editor", {
        editorId,
        projectPath: projectRoot,
        filePath: activeFilePath,
        line,
      }).catch((err) => console.error("open_in_editor failed:", err));
    },
    [projectRoot, activeFilePath, editorView],
  );

  const insertText = (before: string, after: string = "") => {
    if (useDocumentStore.getState().isProjectMutating) return;
    const view = editorView.current;
    if (!view) return;

    const { from, to } = view.state.selection.main;
    const selectedText = view.state.sliceDoc(from, to);

    view.dispatch({
      changes: {
        from,
        to,
        insert: before + selectedText + after,
      },
      selection: {
        anchor: from + before.length,
        head: from + before.length + selectedText.length,
      },
    });
    view.focus();
  };

  const openCitationPicker = () => {
    const view = editorView.current;
    if (view) {
      const { from, to } = view.state.selection.main;
      setEditingCite(findCiteAtSelection(view.state.doc.toString(), from, to));
    } else {
      setEditingCite(null);
    }
    setCitationPickerOpen(true);
  };

  const insertCitationCommand = (citeCommand: string) => {
    if (useDocumentStore.getState().isProjectMutating) return;
    const view = editorView.current;
    if (!view) return;

    const { from, to } = editingCite ?? view.state.selection.main;
    view.dispatch({
      changes: { from, to, insert: citeCommand },
      selection: { anchor: from + citeCommand.length },
    });
    setEditingCite(null);
    view.focus();
  };

  const wrapSelection = (wrapper: string) => {
    insertText(wrapper, wrapper);
  };

  const zoomIn = () => onImageScaleChange?.(Math.min(4, imageScale + 0.25));
  const zoomOut = () => onImageScaleChange?.(Math.max(0.25, imageScale - 0.25));

  if (fileType === "image") {
    return (
      <div className="flex h-[calc(var(--workspace-topbar-height)+var(--titlebar-height))] min-w-0 items-center justify-between border-border border-b bg-muted/30 px-2">
        <div className="flex min-w-0 max-w-[min(18rem,35vw)] items-center gap-1.5">
          <ImageIcon className="size-4 shrink-0 text-muted-foreground" />
          <span
            className="min-w-0 truncate font-medium text-muted-foreground text-sm"
            title={activeFilePath ?? fileName}
          >
            {fileName}
          </span>
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            onClick={zoomOut}
            disabled={imageScale <= 0.25}
          >
            <MinusIcon className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            onClick={zoomIn}
            disabled={imageScale >= 4}
          >
            <PlusIcon className="size-3.5" />
          </Button>
          <Select
            value={imageScale.toString()}
            onValueChange={(v) => onImageScaleChange?.(Number(v))}
          >
            <SelectTrigger size="sm" className="h-6! w-auto text-xs">
              <SelectValue>{Math.round(imageScale * 100)}%</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {ZOOM_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {onCropToggle && !fileName.toLowerCase().endsWith(".svg") && (
            <>
              <div className="mx-1 h-4 w-px bg-border" />
              <Button
                variant={cropMode ? "default" : "ghost"}
                size="sm"
                className="h-6 gap-1 px-2 text-xs"
                onClick={onCropToggle}
              >
                <CropIcon className="size-3.5" />
                Crop
              </Button>
            </>
          )}
          <OpenInEditorMenu
            editors={editors}
            onOpen={openInEditor}
            onRefresh={refreshEditors}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(var(--workspace-topbar-height)+var(--titlebar-height))] min-w-0 items-center gap-1 border-border border-b bg-muted/30 px-2">
      <div className="flex min-w-0 max-w-[min(18rem,35vw)] shrink items-center gap-1.5">
        <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
        <span
          className="min-w-0 truncate font-medium text-muted-foreground text-sm"
          title={activeFilePath ?? fileName}
        >
          {fileName}
        </span>
      </div>
      <div className="mx-2 h-4 w-px shrink-0 bg-border" />
      <TooltipIconButton
        tooltip="Bold (\\textbf)"
        onClick={() => insertText("\\textbf{", "}")}
      >
        <BoldIcon className="size-4" />
      </TooltipIconButton>
      <TooltipIconButton
        tooltip="Italic (\\textit)"
        onClick={() => insertText("\\textit{", "}")}
      >
        <ItalicIcon className="size-4" />
      </TooltipIconButton>
      <TooltipIconButton
        tooltip="Code (\\texttt)"
        onClick={() => insertText("\\texttt{", "}")}
      >
        <CodeIcon className="size-4" />
      </TooltipIconButton>
      <div className="mx-2 h-4 w-px bg-border" />
      <TooltipIconButton
        tooltip="Section"
        onClick={() => insertText("\\section{", "}")}
      >
        <Heading1Icon className="size-4" />
      </TooltipIconButton>
      <TooltipIconButton
        tooltip="Subsection"
        onClick={() => insertText("\\subsection{", "}")}
      >
        <Heading2Icon className="size-4" />
      </TooltipIconButton>
      <TooltipIconButton
        tooltip="List item"
        onClick={() => insertText("\\item ")}
      >
        <ListIcon className="size-4" />
      </TooltipIconButton>
      <div className="mx-2 h-4 w-px bg-border" />
      <TooltipIconButton
        tooltip="Inline math ($...$)"
        onClick={() => wrapSelection("$")}
      >
        <FunctionSquareIcon className="size-4" />
      </TooltipIconButton>
      <TooltipIconButton
        tooltip="Display math (\\[...\\])"
        onClick={() => insertText("\\[\n  ", "\n\\]")}
      >
        <span className="font-mono text-xs">∫</span>
      </TooltipIconButton>
      <div className="mx-2 h-4 w-px bg-border" />
      <TooltipIconButton
        tooltip="Insert or edit citation (\\cite)"
        onClick={openCitationPicker}
      >
        <BookMarkedIcon className="size-4" />
      </TooltipIconButton>
      <div className="mx-2 h-4 w-px bg-border" />
      <Button
        variant={vimMode ? "default" : "ghost"}
        size="sm"
        className="h-6 px-2 font-mono text-xs"
        onClick={() => setVimMode(!vimMode)}
        title="Toggle Vim mode"
      >
        VIM
      </Button>
      <div data-tauri-drag-region className="flex-1 self-stretch" />
      <OpenInEditorMenu
        editors={editors}
        onOpen={openInEditor}
        onRefresh={refreshEditors}
      />
      <CitationPickerDialog
        open={citationPickerOpen}
        onOpenChange={(open) => {
          setCitationPickerOpen(open);
          if (!open) setEditingCite(null);
        }}
        onInsert={insertCitationCommand}
        initialKeys={editingCite?.keys}
        citePrefix={editingCite?.prefix}
      />
    </div>
  );
}
