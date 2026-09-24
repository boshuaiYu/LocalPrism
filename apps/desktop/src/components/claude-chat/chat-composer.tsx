import {
  type CSSProperties,
  type FC,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ArrowUpIcon,
  SquareIcon,
  XIcon,
  FileTextIcon,
  FileCodeIcon,
  FileIcon,
  ImageIcon,
  FileSpreadsheetIcon,
  PaperclipIcon,
  ChevronDownIcon,
  PlusIcon,
  Trash2Icon,
  CornerDownRightIcon,
  ListEndIcon,
} from "lucide-react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { writeFile, mkdir, exists, remove } from "@tauri-apps/plugin-fs";
import { join, tempDir } from "@tauri-apps/api/path";
import { invoke } from "@tauri-apps/api/core";
import { useShallow } from "zustand/react/shallow";
import {
  CLAUDE_CODE_PROVIDER_ID,
  chatPeerForTab,
  offsetToLineCol,
  type PromptContextOverride,
  type QueuedGuidance,
  useClaudeChatStore,
} from "@/stores/claude-chat-store";
import { useClaudeSetupStore } from "@/stores/claude-setup-store";
import { useDocumentStore, type ProjectFile } from "@/stores/document-store";
import { getUniqueTargetName } from "@/lib/tauri/fs";
import { runProjectFsOperation } from "@/lib/project-fs-operations";
import {
  commitOwnedChatAttachmentContexts,
  finishTemporaryChatAttachment,
  ownsChatAttachmentState,
} from "@/lib/chat-attachment-commit";
import { getProviderDisplayName } from "@/lib/provider-icons";
import { getModelCapabilities } from "@/lib/model-capabilities";
import {
  getSelectedCodexModel,
  isRuntimeSendDisabled,
  RuntimeSelector,
  runtimeSelectionSupportsImages,
} from "@/components/runtime/runtime-selector";
import { composerControlsLayout } from "@/lib/composer-controls-layout";
import {
  deriveReasoningStrength,
  reasoningStrengthChipLabel,
  reasoningStrengthWireValue,
} from "@/lib/reasoning-strength";
import { PermissionModePicker } from "@/components/runtime/permission-mode-picker";
import { AgentSelector } from "@/components/agents/agent-selector";
import {
  replyModeForAgent,
  requestPresetAgentFlash,
  shouldFlashPresetAgentSwitch,
  type ReplyMode,
} from "@/lib/reply-mode";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/use-i18n";
import { useRuntimeStore } from "@/stores/runtime-store";
import {
  resolveProviderRequestModel,
  selectedProviderModel as findCatalogModel,
  useProviderStore,
} from "@/stores/provider-store";
import { ChatTokenMeter } from "./chat-token-meter";
import { SlashCommandPicker, type SlashCommand } from "./slash-command-picker";
import {
  resolveOutgoingSlashPrompt,
  resolveSlashComposerValue,
  resolveVisibleSlashMessage,
} from "@/lib/slash-command-send";
import { createLogger } from "@/lib/debug/logger";

const log = createLogger("chat-composer");
const EMPTY_GUIDANCE: QueuedGuidance[] = [];

// Re-export for other modules
export type { SlashCommand };

interface PinnedContext {
  label: string;
  filePath: string;
  selectedText: string;
  imageDataUrl?: string; // thumbnail for captured images
  isTemporary?: boolean;
}

function pastedFileExtension(file: File) {
  const namedExt = file.name.split(".").pop()?.trim().toLowerCase();
  if (namedExt && namedExt !== file.name.toLowerCase()) return namedExt;
  return file.type.split("/")[1]?.split("+")[0] || "png";
}

function safePastedFileName(file: File, index: number) {
  const ext = pastedFileExtension(file).replace(/[^a-z0-9]/g, "") || "png";
  const base =
    file.name && file.name !== "image.png"
      ? file.name.replace(/\.[^.]+$/, "")
      : `paste-${Date.now()}-${index + 1}`;
  return `${base.replace(/[^a-zA-Z0-9._-]/g, "_")}.${ext}`;
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Read failed"));
    reader.readAsDataURL(file);
  });
}

function temporaryFilePaths(contexts: PinnedContext[]) {
  return contexts
    .filter((context) => context.isTemporary)
    .map((context) => context.filePath);
}

async function cleanupTemporaryFilePaths(paths: string[] | undefined) {
  if (!paths?.length) return;
  await Promise.all(
    paths.map(async (path) => {
      try {
        await remove(path);
      } catch (err) {
        log.warn("Failed to remove temporary pasted file", {
          path,
          error: String(err),
        });
      }
    }),
  );
}

function cleanupTemporaryPinnedContext(context: PinnedContext) {
  if (!context.isTemporary) return;
  void cleanupTemporaryFilePaths([context.filePath]);
}

function pinnedContextDedupKey(context: PinnedContext) {
  return context.isTemporary
    ? `temporary:${context.filePath}`
    : `label:${context.label}`;
}

function appendUniquePinnedContexts(
  current: PinnedContext[],
  next: PinnedContext[],
) {
  const seen = new Set(current.map(pinnedContextDedupKey));
  const unique = next.filter((context) => {
    const key = pinnedContextDedupKey(context);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return [...current, ...unique];
}

function isPdfPath(path: string) {
  return path.toLowerCase().endsWith(".pdf");
}

function getFileIcon(file: ProjectFile) {
  if (file.type === "image")
    return <ImageIcon className="size-3.5 shrink-0 text-muted-foreground" />;
  if (file.type === "pdf")
    return (
      <FileSpreadsheetIcon className="size-3.5 shrink-0 text-muted-foreground" />
    );
  if (file.type === "style")
    return <FileCodeIcon className="size-3.5 shrink-0 text-muted-foreground" />;
  if (file.type === "other")
    return <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />;
  return <FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />;
}

function formatGuidanceText(guidance: QueuedGuidance) {
  const label = guidance.displayPrompt ?? guidance.prompt;
  return guidance.contextOverride?.label
    ? `${guidance.contextOverride.label} - ${label}`
    : label;
}

function claudeModelDisplayName(model: string) {
  switch (model) {
    case "sonnet":
      return "Sonnet";
    case "opus":
      return "Opus";
    case "haiku":
      return "Haiku";
    case "opusplan":
      return "OpusPlan";
    default:
      return model;
  }
}

function ComposerModelChip({
  buttonRef,
  label,
  effortLabel,
  modelId,
  providerName,
  disabled,
  onClick,
}: {
  buttonRef: RefObject<HTMLButtonElement | null>;
  label: string;
  effortLabel: string | null;
  modelId: string;
  providerName: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      data-testid="composer-model-trigger"
      onClick={onClick}
      title={modelId}
      aria-label={
        effortLabel
          ? `Switch model ${modelId}, ${effortLabel}`
          : `Switch model ${modelId}`
      }
      disabled={disabled}
      className="flex h-8 w-fit min-w-0 max-w-full shrink items-center gap-1.5 self-start overflow-hidden rounded-full border border-border/80 bg-background/70 px-2.5 text-foreground text-xs transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span className="min-w-0 truncate text-left">{label}</span>
      {effortLabel ? (
        <span className="shrink-0 text-muted-foreground/60">
          · {effortLabel}
        </span>
      ) : null}
      <span className="sr-only">{providerName}</span>
      <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
    </button>
  );
}

const REPLY_MODE_LABEL: Record<
  ReplyMode,
  | "chat.replyMode.custom"
  | "chat.replyMode.academic-polish"
  | "chat.replyMode.de-ai"
  | "chat.replyMode.peer-review"
> = {
  custom: "chat.replyMode.custom",
  "academic-polish": "chat.replyMode.academic-polish",
  "de-ai": "chat.replyMode.de-ai",
  "peer-review": "chat.replyMode.peer-review",
};

function ReplyModePill({ agentId }: { agentId: string | null }) {
  const { t } = useI18n();
  const mode = replyModeForAgent(agentId);
  const label = t(REPLY_MODE_LABEL[mode]);
  return (
    <span
      data-testid="reply-mode"
      data-reply-mode={mode}
      title={t("chat.replyMode")}
      className="flex h-7 max-w-28 shrink-0 items-center truncate rounded-full px-2 text-muted-foreground text-xs"
    >
      {label}
    </span>
  );
}

export const ChatComposer: FC<{
  isOpen?: boolean;
  agentFlashId?: string | null;
}> = ({ isOpen, agentFlashId = null }) => {
  const { t } = useI18n();
  const sendPrompt = useClaudeChatStore((s) => s.sendPrompt);
  const setChatError = useClaudeChatStore((s) => s._setError);
  const queueGuidance = useClaudeChatStore((s) => s.queueGuidance);
  const cancelExecution = useClaudeChatStore((s) => s.cancelExecution);
  const removeQueuedGuidance = useClaudeChatStore(
    (s) => s.removeQueuedGuidance,
  );
  const forceQueuedGuidanceNow = useClaudeChatStore(
    (s) => s.forceQueuedGuidanceNow,
  );
  const isStreaming = useClaudeChatStore((s) => s.isStreaming);
  const selectedModel = useClaudeChatStore((s) => s.selectedModel);
  const setSelectedModel = useClaudeChatStore((s) => s.setSelectedModel);
  const selectedProviderCredentialId = useClaudeChatStore(
    (s) => s.selectedProviderCredentialId,
  );
  const setSelectedProviderCredentialId = useClaudeChatStore(
    (s) => s.setSelectedProviderCredentialId,
  );
  const selectedProviderModels = useClaudeChatStore(
    (s) => s.selectedProviderModels,
  );
  const effortLevel = useClaudeChatStore((s) => s.effortLevel);
  const setEffortLevel = useClaudeChatStore((s) => s.setEffortLevel);
  const activeTabId = useClaudeChatStore((s) => s.activeTabId);
  const activeTabMeta = useClaudeChatStore(
    useShallow((s) => {
      const tab = s.tabs.find((candidate) => candidate.id === s.activeTabId);
      return {
        runtime: tab?.runtime ?? "claude",
        chatPeer: tab?.chatPeer,
        providerKey: tab?.providerKey ?? null,
        runtimeModel: tab?.runtimeModel ?? null,
        reasoningEffort: tab?.reasoningEffort ?? null,
        agentId: tab?.agentId ?? null,
        isStopping: (tab?.cancelledAttempts?.length ?? 0) > 0,
      };
    }),
  );
  const ensureWritableTab = useClaudeChatStore((s) => s.ensureWritableTab);
  const changeTabRuntime = useClaudeChatStore((s) => s.changeTabRuntime);
  const updateTabRuntimeSelection = useClaudeChatStore(
    (s) => s.updateTabRuntimeSelection,
  );
  const queuedGuidance = useClaudeChatStore(
    (s) =>
      s.tabs.find((tab) => tab.id === s.activeTabId)?.queuedGuidance ??
      EMPTY_GUIDANCE,
  );
  const visibleQueuedGuidance = useMemo(
    () => queuedGuidance.filter((guidance) => !guidance.displayedInChat),
    [queuedGuidance],
  );
  const openAiCredentials = useClaudeSetupStore((s) => s.openAiCredentials);
  const activeOpenAiCredentialId = useClaudeSetupStore(
    (s) => s.activeOpenAiCredentialId,
  );
  const claudeAccount = useRuntimeStore((s) => s.accounts.claude);
  const codexAccount = useRuntimeStore((s) => s.accounts.codex);
  const codexModels = useRuntimeStore((s) => s.models.codex);
  const codexModelsLoading = useRuntimeStore((s) => !!s.loading.codex);
  const refreshCodexModels = useRuntimeStore((s) => s.refreshModels);
  const configuredOpenAiCredential =
    selectedProviderCredentialId &&
    selectedProviderCredentialId !== CLAUDE_CODE_PROVIDER_ID
      ? (openAiCredentials.find(
          (credential) => credential.id === selectedProviderCredentialId,
        ) ?? null)
      : null;
  const fallbackProviderCredential =
    (activeOpenAiCredentialId
      ? openAiCredentials.find(
          (credential) => credential.id === activeOpenAiCredentialId,
        )
      : null) ??
    openAiCredentials[0] ??
    null;
  // API peer never falls back to the built-in Claude Code provider — an
  // explicit OpenAI-compatible credential (or none, prompting to add one).
  const selectedProviderCredential =
    configuredOpenAiCredential ?? fallbackProviderCredential;
  const chatPeer = chatPeerForTab({
    runtime: activeTabMeta.runtime,
    chatPeer: activeTabMeta.chatPeer,
    providerKey: activeTabMeta.providerKey,
  });
  const archivedCodex = activeTabMeta.runtime === "codex";
  const providerReady = useProviderStore((state) => state.ready);
  const engineInstalling = useClaudeSetupStore((state) => state.isInstalling);
  const providerModels = useProviderStore((state) => state.models);
  const activeProviderName =
    useProviderStore(
      (state) => state.cards.find((card) => card.isActive)?.name,
    ) ?? "Provider";
  const claudeAvailable =
    claudeAccount.installed && claudeAccount.authenticated;
  // API peer needs Claude CLI installed (wire runtime) plus a credential;
  // OAuth login is not required when using an OpenAI-compatible provider.
  const apiAvailable = claudeAccount.installed && !!selectedProviderCredential;
  const selectedRuntimeModelId =
    chatPeer !== "codex"
      ? resolveProviderRequestModel(
          activeTabMeta.runtimeModel ?? selectedModel,
          providerModels,
        )
      : (activeTabMeta.runtimeModel ?? null);
  const catalogModel = findCatalogModel(
    providerModels,
    selectedRuntimeModelId ?? selectedModel,
  );
  const strengthControl = deriveReasoningStrength(
    catalogModel,
    activeTabMeta.reasoningEffort ?? effortLevel,
  );
  const selectedRuntimeEffort = reasoningStrengthWireValue(strengthControl);
  const selectedClaudeModel =
    chatPeer !== "codex"
      ? (selectedRuntimeModelId ?? selectedModel)
      : selectedModel;
  const selectedClaudeEffort = selectedRuntimeEffort ?? effortLevel;
  const selectedCodexModel = getSelectedCodexModel(
    codexModels,
    chatPeer === "codex" ? selectedRuntimeModelId : null,
  );
  const codexAvailable = codexAccount.installed && codexAccount.authenticated;
  const runtimeSelectionReady = archivedCodex ? false : providerReady;
  const runtimeBusy = isStreaming || activeTabMeta.isStopping;
  const selectedProviderModel = selectedProviderCredential
    ? selectedProviderModels[selectedProviderCredential.id] ||
      selectedProviderCredential.model
    : null;
  const directProviderModel =
    selectedProviderModel || selectedProviderCredential?.model || "Provider";
  const selectedProviderSupportsVision = selectedProviderCredential
    ? getModelCapabilities({
        label: selectedProviderCredential.label,
        baseUrl: selectedProviderCredential.base_url,
        model: directProviderModel,
      }).vision
    : true;
  const selectedProviderDisplayName = selectedProviderCredential
    ? getProviderDisplayName({
        label: selectedProviderCredential.label,
        baseUrl: selectedProviderCredential.base_url,
        model: selectedProviderCredential.model,
      })
    : "Provider";
  const [input, setInput] = useState("");
  const hasInput = input.trim().length > 0;
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Model picker state
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const modelButtonRef = useRef<HTMLButtonElement>(null);
  const [pickerPos, setPickerPos] = useState<{ left: number; bottom: number }>({
    left: 0,
    bottom: 0,
  });
  const [controlsWidth, setControlsWidth] = useState(0);
  const controlsRef = useRef<HTMLDivElement>(null);
  const controlsLayout = composerControlsLayout(controlsWidth);

  useLayoutEffect(() => {
    const node = controlsRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const update = () => setControlsWidth(node.clientWidth);
    update();
    const observer = new ResizeObserver(() => update());
    observer.observe(node);
    return () => observer.disconnect();
  }, [archivedCodex]);

  // Recalculate popup position when it opens
  useLayoutEffect(() => {
    if (!modelPickerOpen || !modelButtonRef.current) return;
    const rect = modelButtonRef.current.getBoundingClientRect();
    setPickerPos({
      left: rect.left,
      bottom: window.innerHeight - rect.top + 4,
    });
  }, [modelPickerOpen]);

  // API peer's `selectedProviderCredentialId` must point at a real credential
  // so sendPrompt never starts a bare Claude OAuth turn. Claude peer ignores it.
  useEffect(() => {
    const selectedOpenAiCredentialMissing =
      selectedProviderCredentialId &&
      selectedProviderCredentialId !== CLAUDE_CODE_PROVIDER_ID &&
      !openAiCredentials.some(
        (credential) => credential.id === selectedProviderCredentialId,
      );
    if (selectedOpenAiCredentialMissing) {
      setSelectedProviderCredentialId(fallbackProviderCredential?.id ?? null);
      return;
    }

    if (
      chatPeer === "api" &&
      (!selectedProviderCredentialId ||
        selectedProviderCredentialId === CLAUDE_CODE_PROVIDER_ID) &&
      fallbackProviderCredential
    ) {
      setSelectedProviderCredentialId(fallbackProviderCredential.id);
    }
  }, [
    chatPeer,
    fallbackProviderCredential,
    fallbackProviderCredential?.id,
    openAiCredentials,
    selectedProviderCredentialId,
    setSelectedProviderCredentialId,
  ]);

  // Pinned contexts — supports multiple files/selections
  const [pinnedContexts, setPinnedContexts] = useState<PinnedContext[]>([]);
  const hasPinnedImages = pinnedContexts.some(
    (context) => context.imageDataUrl,
  );
  const runtimeSupportsImages = runtimeSelectionSupportsImages(
    chatPeer,
    selectedCodexModel,
    selectedProviderSupportsVision,
  );
  const imageCompatibilityError =
    hasPinnedImages &&
    !runtimeSupportsImages &&
    (chatPeer === "codex"
      ? selectedCodexModel !== null
      : chatPeer === "api"
        ? selectedProviderCredential !== null
        : true)
      ? `${
          chatPeer === "codex"
            ? `Codex ${selectedCodexModel?.displayName ?? selectedRuntimeModelId}`
            : chatPeer === "api"
              ? `${selectedProviderDisplayName} ${directProviderModel}`
              : `${activeProviderName} ${
                  providerModels.find(
                    (model) => model.id === selectedClaudeModel,
                  )?.displayName ?? claudeModelDisplayName(selectedClaudeModel)
                }`
        } does not support image input. Remove the pasted image or switch to a vision-capable model.`
      : null;

  useEffect(() => {
    if (imageCompatibilityError) {
      setChatError(activeTabId, imageCompatibilityError);
    }
  }, [activeTabId, imageCompatibilityError, setChatError]);

  // File drop state
  const [isDragOver, setIsDragOver] = useState(false);

  // @ mention state
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionFiles, setMentionFiles] = useState<ProjectFile[]>([]);
  const mentionRef = useRef<HTMLDivElement>(null);

  // / slash command state
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const slashSelectedRef = useRef(false); // true after user picks a command — suppresses re-open

  // Keep refs to latest input/pinnedContexts so the tab-switch effect can
  // save the draft without depending on these values (which would cause loops).
  const inputRef = useRef(input);
  inputRef.current = input;
  const pinnedContextsRef = useRef(pinnedContexts);
  pinnedContextsRef.current = pinnedContexts;

  // Save draft to previous tab, restore draft from new tab
  const prevTabIdRef = useRef(activeTabId);
  useEffect(() => {
    const prevTabId = prevTabIdRef.current;
    if (prevTabId !== activeTabId) {
      // Save current input to the *previous* tab's draft (using refs for latest values)
      useClaudeChatStore.getState().saveDraft(prevTabId, {
        input: inputRef.current,
        pinnedContexts: pinnedContextsRef.current,
      });
    }
    prevTabIdRef.current = activeTabId;

    // Restore draft from the new active tab
    const tab = useClaudeChatStore
      .getState()
      .tabs.find((t) => t.id === activeTabId);
    const draft = tab?.draft;
    setInput(draft?.input ?? "");
    setPinnedContexts(draft?.pinnedContexts ?? []);
    setMentionQuery(null);
    setSlashQuery(null);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [activeTabId]);

  useEffect(() => {
    return () => {
      const tabId = prevTabIdRef.current;
      if (!tabId) return;
      useClaudeChatStore.getState().saveDraft(tabId, {
        input: inputRef.current,
        pinnedContexts: pinnedContextsRef.current,
      });
    };
  }, []);
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
  const composerRef = useRef<HTMLDivElement>(null);

  // Watch selection changes to auto-pin context
  const selectionRange = useDocumentStore((s) => s.selectionRange);
  const activeFileId = useDocumentStore((s) => s.activeFileId);
  const files = useDocumentStore((s) => s.files);
  const importFiles = useDocumentStore((s) => s.importFiles);
  const projectRoot = useDocumentStore((s) => s.projectRoot);

  // Consume pending attachments from external sources (e.g. PDF capture)
  const pendingAttachments = useClaudeChatStore((s) => s.pendingAttachments);
  const consumePendingAttachments = useClaudeChatStore(
    (s) => s.consumePendingAttachments,
  );
  const pendingPinnedContextRemovalLabels = useClaudeChatStore(
    (s) => s.pendingPinnedContextRemovalLabels,
  );
  const consumePendingPinnedContextRemovals = useClaudeChatStore(
    (s) => s.consumePendingPinnedContextRemovals,
  );

  // Focus textarea when the drawer opens
  const prevOpenRef = useRef(false);
  useEffect(() => {
    if (isOpen && !prevOpenRef.current) {
      setTimeout(() => textareaRef.current?.focus(), 0);
    }
    prevOpenRef.current = !!isOpen;
  }, [isOpen]);

  useEffect(() => {
    if (pendingAttachments.length === 0) return;
    const attachments = consumePendingAttachments();
    if (attachments.length === 0) return;
    setPinnedContexts((prev) => {
      return appendUniquePinnedContexts(prev, attachments);
    });
    // Focus textarea so user can type immediately
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, [pendingAttachments, consumePendingAttachments]);

  useEffect(() => {
    if (pendingPinnedContextRemovalLabels.length === 0) return;
    const labels = consumePendingPinnedContextRemovals();
    if (labels.length === 0) return;
    const labelsToRemove = new Set(labels);
    setPinnedContexts((prev) =>
      prev.filter((context) => !labelsToRemove.has(context.label)),
    );
  }, [pendingPinnedContextRemovalLabels, consumePendingPinnedContextRemovals]);

  const currentContextLabel = useMemo(() => {
    if (!selectionRange) return null;
    const file = files.find((f) => f.id === activeFileId);
    if (!file?.content) return null;
    const start = offsetToLineCol(file.content, selectionRange.start);
    const end = offsetToLineCol(file.content, selectionRange.end);
    return `@${file.relativePath}:${start.line}:${start.col}-${end.line}:${end.col}`;
  }, [selectionRange, activeFileId, files]);

  // Auto-pin when a new selection is made
  useEffect(() => {
    if (!selectionRange || !currentContextLabel) return;
    const file = files.find((f) => f.id === activeFileId);
    if (!file?.content) return;
    // Replace any existing selection-based context (keep file contexts)
    setPinnedContexts((prev) => {
      const filtered = prev.filter(
        (c) => !c.label.includes(":") || c.label.startsWith("@attachments/"),
      );
      return [
        ...filtered,
        {
          label: currentContextLabel,
          filePath: file.relativePath,
          selectedText: file.content!.slice(
            selectionRange.start,
            selectionRange.end,
          ),
        },
      ];
    });
  }, [selectionRange, currentContextLabel, activeFileId, files]);

  // Compute @ mention matches
  useEffect(() => {
    if (mentionQuery === null) {
      setMentionFiles([]);
      return;
    }
    const q = mentionQuery.toLowerCase();
    const matched = files
      .filter(
        (f) =>
          f.relativePath.toLowerCase().includes(q) ||
          f.name.toLowerCase().includes(q),
      )
      .slice(0, 8);
    setMentionFiles(matched);
    setMentionIndex(0);
  }, [mentionQuery, files]);

  // Keep commands loaded so send can strip questionnaire leftovers even if the picker closed.
  useEffect(() => {
    invoke<SlashCommand[]>("slash_commands_list", {
      projectPath: projectRoot ?? undefined,
    })
      .then((commands) =>
        setSlashCommands(Array.isArray(commands) ? commands : []),
      )
      .catch(() => setSlashCommands([]));
  }, [projectRoot]);

  const buildPinnedContextForFile = useCallback(
    async (file: ProjectFile): Promise<PinnedContext> => {
      const isTextFile =
        file.type === "tex" ||
        file.type === "bib" ||
        file.type === "style" ||
        file.type === "markdown" ||
        file.type === "other";

      return {
        label: `@${file.relativePath}`,
        filePath: file.relativePath,
        selectedText: isTextFile
          ? (file.content ?? "")
          : `[Referenced file: ${file.relativePath} (${file.type} file)]`,
      };
    },
    [],
  );

  const selectMention = useCallback(
    async (file: ProjectFile) => {
      // Replace @query with empty and pin the file as context
      const textarea = textareaRef.current;
      if (!textarea) return;
      const cursorPos = textarea.selectionStart;
      // Find the @ position before cursor
      const textBefore = input.slice(0, cursorPos);
      const atIndex = textBefore.lastIndexOf("@");
      if (atIndex === -1) return;
      const newInput = input.slice(0, atIndex) + input.slice(cursorPos);
      setInput(newInput);
      setMentionQuery(null);

      // Pin the whole file as context
      const context = await buildPinnedContextForFile(file);
      setPinnedContexts((prev) => [...prev, context]);

      // Refocus textarea
      setTimeout(() => textarea.focus(), 0);
    },
    [buildPinnedContextForFile, input],
  );

  const selectSlashCommand = useCallback((command: SlashCommand) => {
    const newInput = resolveSlashComposerValue(inputRef.current, command);

    setInput(newInput);
    setSlashQuery(null);
    slashSelectedRef.current = true;

    // Refocus and move cursor to end
    setTimeout(() => {
      const textarea = textareaRef.current;
      if (textarea) {
        textarea.focus();
        textarea.selectionStart = textarea.selectionEnd = newInput.length;
        // Auto-resize
        textarea.style.height = "auto";
        textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
      }
    }, 0);
  }, []);

  // Handle file drops — guard against duplicate calls from stale HMR listeners
  const isProcessingDropRef = useRef(false);
  const handleFileDropRef = useRef<(paths: string[]) => Promise<void>>(
    async () => {},
  );
  handleFileDropRef.current = async (paths: string[]) => {
    const initialDocument = useDocumentStore.getState();
    const initiatingTabId = useClaudeChatStore.getState().activeTabId;
    if (
      !initialDocument.projectRoot ||
      initialDocument.isProjectMutating ||
      paths.length === 0
    ) {
      return;
    }
    const owner = {
      projectRoot: initialDocument.projectRoot,
      projectGeneration: initialDocument.projectGeneration,
      tabId: initiatingTabId,
    };
    const stillOwnsAttachment = () => {
      const currentDocument = useDocumentStore.getState();
      return ownsChatAttachmentState(
        owner,
        currentDocument,
        useClaudeChatStore.getState().activeTabId,
      );
    };
    if (isProcessingDropRef.current) return;
    isProcessingDropRef.current = true;

    try {
      // Import files to attachments/ folder — returns actual (deduplicated) relative paths
      const importedPaths = await importFiles(paths, "attachments");
      if (!stillOwnsAttachment()) return;

      // Pin each file as context
      const storeFiles = useDocumentStore.getState().files;
      const newContexts: PinnedContext[] = [];

      for (const relativePath of importedPaths) {
        const imported = storeFiles.find(
          (f) => f.relativePath === relativePath,
        );

        if (imported) {
          newContexts.push(await buildPinnedContextForFile(imported));
        } else {
          // File imported but type might be filtered out — still pin as reference
          newContexts.push({
            label: `@${relativePath}`,
            filePath: relativePath,
            selectedText: `[Attached file: ${relativePath}]`,
          });
        }
      }

      if (newContexts.length > 0) {
        await commitOwnedChatAttachmentContexts({
          contexts: newContexts,
          isCurrent: stillOwnsAttachment,
          cleanup: cleanupTemporaryFilePaths,
          commit: (contexts) => {
            setPinnedContexts((prev) => {
              return appendUniquePinnedContexts(prev, contexts);
            });
          },
        });
      }
    } finally {
      isProcessingDropRef.current = false;
    }
  };

  const handleAttachFiles = useCallback(async () => {
    if (!projectRoot) return;
    const selected = await open({
      multiple: true,
      directory: false,
      title: "Attach files",
    });
    const paths =
      typeof selected === "string"
        ? [selected]
        : Array.isArray(selected)
          ? selected
          : [];
    if (paths.length === 0) return;
    await handleFileDropRef.current(paths);
  }, [projectRoot]);

  // Listen for Tauri drag-drop events (OS file drops)
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    getCurrentWebview()
      .onDragDropEvent(async (event) => {
        if (cancelled) return;
        const { type } = event.payload;
        if (type === "enter") {
          setIsDragOver(true);
        } else if (type === "drop") {
          setIsDragOver(false);
          // Skip if the sidebar already handled this drop (OS file dropped on sidebar file tree)
          if ((window as any).__sidebarHandledDrop) {
            log.debug("skipped — sidebar handled this drop");
            return;
          }
          const paths = (event.payload as { paths: string[] }).paths;
          if (paths?.length > 0) {
            await handleFileDropRef.current?.(paths);
          }
        } else if (type === "leave") {
          setIsDragOver(false);
        }
      })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch(() => {
        // Not in Tauri environment (dev mode), ignore
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Handle clipboard paste — detect files (screenshots, images) and save to attachments/
  const handlePaste = useCallback(
    async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const clipboardFiles = e.clipboardData?.files;
      const initialDocument = useDocumentStore.getState();
      const initiatingTabId = useClaudeChatStore.getState().activeTabId;
      if (
        !clipboardFiles ||
        clipboardFiles.length === 0 ||
        !initialDocument.projectRoot ||
        initialDocument.isProjectMutating
      ) {
        return;
      }
      const owner = {
        projectRoot: initialDocument.projectRoot,
        projectGeneration: initialDocument.projectGeneration,
        tabId: initiatingTabId,
      };
      const stillOwnsProject = () => {
        const current = useDocumentStore.getState();
        return ownsChatAttachmentState(
          owner,
          current,
          useClaudeChatStore.getState().activeTabId,
        );
      };

      // Check if there are actual file items (not just text)
      const fileItems = Array.from(clipboardFiles);
      if (fileItems.length === 0) return;

      e.preventDefault();

      const newContexts: PinnedContext[] = [];

      for (const [index, file] of fileItems.entries()) {
        if (file.type.startsWith("image/")) {
          try {
            const fileName = safePastedFileName(file, index);
            const tempRoot = await join(
              await tempDir(),
              "LocalPrism",
              "chat-pastes",
            );
            if (!(await exists(tempRoot))) {
              await mkdir(tempRoot, { recursive: true });
            }
            const fullPath = await join(
              tempRoot,
              `${Date.now()}-${index + 1}-${fileName}`,
            );
            const buffer = await file.arrayBuffer();
            await writeFile(fullPath, new Uint8Array(buffer));

            const context = await finishTemporaryChatAttachment({
              temporaryPath: fullPath,
              isCurrent: stillOwnsProject,
              cleanup: cleanupTemporaryFilePaths,
              buildContext: async (): Promise<PinnedContext> => ({
                label:
                  fileItems.length > 1
                    ? `Pasted image ${index + 1}`
                    : "Pasted image",
                filePath: fullPath,
                selectedText: [
                  `[Temporary pasted image: ${fullPath}]`,
                  "Use this image file as visual context for the user's message.",
                ].join("\n"),
                imageDataUrl: await readFileAsDataUrl(file),
                isTemporary: true,
              }),
            });
            if (context) newContexts.push(context);
          } catch (err) {
            log.error("Failed to save pasted image", {
              fileName: file.name || "clipboard image",
              error: String(err),
            });
          }
          continue;
        }

        // Generate a filename — use the original name or a timestamp-based name for screenshots
        let fileName = file.name;
        if (!fileName || fileName === "image.png") {
          const ext = file.type.split("/")[1] || "png";
          fileName = `paste-${Date.now()}.${ext}`;
        }

        const targetName = `attachments/${fileName}`;

        try {
          const buffer = await file.arrayBuffer();
          const isText = file.type.startsWith("text/");
          const textContent = isText ? await file.text() : null;
          if (!stillOwnsProject()) continue;

          const uniqueName = await runProjectFsOperation(owner, async () => {
            const attachmentsDir = await join(owner.projectRoot, "attachments");
            if (!(await exists(attachmentsDir))) {
              await mkdir(attachmentsDir, { recursive: true });
            }
            const name = await getUniqueTargetName(
              owner.projectRoot,
              targetName,
            );
            const fullPath = await join(owner.projectRoot, name);
            await writeFile(fullPath, new Uint8Array(buffer));
            return name;
          });
          if (!stillOwnsProject()) continue;

          const content =
            isPdfPath(uniqueName) || file.type === "application/pdf"
              ? `[Attached file: ${uniqueName} (PDF)]`
              : (textContent ??
                `[Attached file: ${uniqueName} (${file.type})]`);

          newContexts.push({
            label: `@${uniqueName}`,
            filePath: uniqueName,
            selectedText: content,
          });
        } catch (err) {
          log.error("Failed to save pasted file", {
            fileName,
            error: String(err),
          });
        }
      }

      if (newContexts.length > 0) {
        const shouldRefresh = newContexts.some((context) =>
          context.label.startsWith("@"),
        );
        try {
          await commitOwnedChatAttachmentContexts({
            contexts: newContexts,
            isCurrent: stillOwnsProject,
            cleanup: cleanupTemporaryFilePaths,
            beforeCommit: shouldRefresh
              ? () => useDocumentStore.getState().refreshFiles()
              : undefined,
            commit: (contexts) => {
              setPinnedContexts((prev) => {
                return appendUniquePinnedContexts(prev, contexts);
              });
            },
          });
        } catch (err) {
          log.error("Failed to commit pasted file contexts", {
            error: String(err),
          });
        }
      }
    },
    [],
  );

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed) return;
    if (!runtimeSelectionReady) return;
    if (imageCompatibilityError) {
      setChatError(activeTabId, imageCompatibilityError);
      return;
    }

    // Chat shows the slash label. The engine still gets the expanded body
    // (or /name for skills so Claude can invoke the Skill tool).
    const visiblePrompt = resolveVisibleSlashMessage(trimmed, slashCommands);
    const finalPrompt = resolveOutgoingSlashPrompt(trimmed, slashCommands);

    setInput("");
    setMentionQuery(null);
    setSlashQuery(null);
    slashSelectedRef.current = false;

    let contextOverride: PromptContextOverride | undefined;
    if (pinnedContexts.length > 0) {
      const combinedLabel = pinnedContexts.map((c) => c.label).join(", ");
      const combinedText = pinnedContexts
        .map((c) => c.selectedText)
        .join("\n\n---\n\n");
      contextOverride = {
        label: combinedLabel,
        filePath: pinnedContexts[0].filePath,
        selectedText: combinedText,
        temporaryFilePaths: temporaryFilePaths(pinnedContexts),
      };
    }

    if (isStreaming) {
      queueGuidance(activeTabId, finalPrompt, contextOverride, visiblePrompt);
    } else if (contextOverride) {
      sendPrompt(finalPrompt, contextOverride, {
        displayPrompt: visiblePrompt,
      });
    } else {
      sendPrompt(finalPrompt, undefined, { displayPrompt: visiblePrompt });
    }
    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
    // Clear pinned contexts after send. Temporary files are removed by the
    // completion event once the provider has finished with them.
    setPinnedContexts([]);
  }, [
    activeTabId,
    input,
    isStreaming,
    queueGuidance,
    sendPrompt,
    pinnedContexts,
    imageCompatibilityError,
    runtimeSelectionReady,
    setChatError,
    slashCommands,
  ]);

  const handleGuideQueuedGuidance = useCallback(
    (guidance: QueuedGuidance) => {
      if (isStreaming) {
        void forceQueuedGuidanceNow(activeTabId, guidance.id);
        return;
      }

      removeQueuedGuidance(activeTabId, guidance.id);
      void sendPrompt(guidance.prompt, guidance.contextOverride, {
        displayPrompt: guidance.displayPrompt,
      });
    },
    [
      activeTabId,
      forceQueuedGuidanceNow,
      isStreaming,
      removeQueuedGuidance,
      sendPrompt,
    ],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Slash command picker is open — let the picker handle keyboard events
      // (it uses window.addEventListener for ArrowUp/Down, Enter, Tab, Escape)
      if (slashQuery !== null) {
        if (
          e.key === "Enter" ||
          e.key === "ArrowDown" ||
          e.key === "ArrowUp" ||
          e.key === "Tab" ||
          e.key === "Escape"
        ) {
          e.preventDefault();
          return;
        }
      }

      // @ mention navigation
      if (mentionQuery !== null && mentionFiles.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setMentionIndex((i) => Math.min(i + 1, mentionFiles.length - 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setMentionIndex((i) => Math.max(i - 1, 0));
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          void selectMention(mentionFiles[mentionIndex]);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setMentionQuery(null);
          return;
        }
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
      // Backspace at start of empty input removes last pinned context
      if (e.key === "Backspace" && pinnedContexts.length > 0 && input === "") {
        e.preventDefault();
        setPinnedContexts((prev) => prev.slice(0, -1));
      }
    },
    [
      handleSend,
      pinnedContexts,
      input,
      mentionQuery,
      mentionFiles,
      mentionIndex,
      selectMention,
      slashQuery,
    ],
  );

  const handleInput = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      setInput(value);

      // Detect / slash command trigger — only at the very start of input
      const slashMatch = value.match(/^\/(\S*)$/);
      if (slashMatch) {
        // Typing /query with no space yet — open picker
        slashSelectedRef.current = false;
        setSlashQuery(slashMatch[1]);
        setMentionQuery(null);
      } else if (slashSelectedRef.current) {
        // User already selected a command — don't re-open picker
      } else if (!value.startsWith("/")) {
        setSlashQuery(null);
      }

      // Detect @ mention trigger (only when not in slash command mode)
      if (!value.startsWith("/")) {
        const cursorPos = e.target.selectionStart;
        const textBefore = value.slice(0, cursorPos);
        // Match @ at start of input or after a space
        const atMatch = textBefore.match(/(?:^|[\s])@([^\s]*)$/);
        if (atMatch) {
          setMentionQuery(atMatch[1]);
        } else {
          setMentionQuery(null);
        }
      }

      // Auto-resize
      const el = e.target;
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    },
    [],
  );

  // Scroll active mention into view
  useEffect(() => {
    if (mentionRef.current) {
      const active = mentionRef.current.querySelector("[data-active=true]");
      active?.scrollIntoView({ block: "nearest" });
    }
  }, [mentionIndex]);

  // Close model picker on click outside
  useEffect(() => {
    if (!modelPickerOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        modelPickerRef.current &&
        !modelPickerRef.current.contains(target) &&
        modelButtonRef.current &&
        !modelButtonRef.current.contains(target)
      ) {
        setModelPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [modelPickerOpen]);

  const composerCatalogModel =
    providerModels.find((model) => model.id === selectedRuntimeModelId) ??
    providerModels.find((model) => model.isDefault) ??
    providerModels[0];
  const composerModelId =
    composerCatalogModel?.id ?? selectedRuntimeModelId ?? selectedModel;
  const composerModelLabel =
    composerCatalogModel?.displayName ??
    claudeModelDisplayName(composerModelId);
  const composerEffortLabel = reasoningStrengthChipLabel(strengthControl);
  const sendButton = (
    <TooltipIconButton
      tooltip={
        isStreaming && !hasInput
          ? "Stop"
          : isStreaming
            ? "Queue guidance"
            : "Send"
      }
      side="top"
      variant="default"
      size="icon"
      className="size-8 rounded-full"
      onClick={
        isStreaming && !hasInput
          ? () => void cancelExecution(activeTabId)
          : handleSend
      }
      disabled={isRuntimeSendDisabled(
        isStreaming,
        hasInput,
        runtimeSelectionReady,
      )}
    >
      {isStreaming && !hasInput ? (
        <SquareIcon className="size-3.5 fill-current" />
      ) : (
        <ArrowUpIcon className="size-4" />
      )}
    </TooltipIconButton>
  );

  return (
    <div
      ref={composerRef}
      className="relative mx-auto w-full min-w-0 max-w-[44rem] shrink-0 px-4 pt-1 pb-5"
      style={
        {
          "--composer-bg":
            "color-mix(in oklab, var(--color-muted) 22%, var(--color-background))",
          "--composer-radius": "0.875rem",
          "--composer-padding": "10px",
        } as CSSProperties
      }
    >
      {/* / slash command picker — portal to body to escape all stacking contexts */}
      {slashQuery !== null && (
        <SlashCommandPicker
          projectPath={projectRoot}
          query={slashQuery}
          anchorRef={composerRef}
          onSelect={selectSlashCommand}
          onClose={() => {
            setSlashQuery(null);
          }}
        />
      )}

      {/* Model picker popup — portal to body to escape all stacking contexts */}
      {modelPickerOpen &&
        createPortal(
          <div
            ref={modelPickerRef}
            className="fixed w-[28rem] max-w-[calc(100vw-1rem)] overflow-hidden rounded-xl border border-border bg-popover/95 p-1.5 text-popover-foreground shadow-lg backdrop-blur-sm"
            style={{
              left: pickerPos.left,
              bottom: pickerPos.bottom,
              zIndex: 9999,
            }}
          >
            <RuntimeSelector
              key={activeTabId}
              peer={chatPeer}
              claudeAvailable={claudeAvailable}
              apiAvailable={apiAvailable}
              codexAvailable={codexAvailable}
              codexModels={codexModels}
              codexModelsLoading={codexModelsLoading}
              selectedModelId={selectedRuntimeModelId}
              reasoningEffort={selectedRuntimeEffort}
              agentId={activeTabMeta.agentId ?? null}
              projectPath={projectRoot}
              busy={runtimeBusy}
              apiProviderControls={null}
              selectedClaudeModel={selectedClaudeModel}
              selectedClaudeEffort={selectedClaudeEffort}
              onPeerChange={(nextPeer, options) =>
                changeTabRuntime(activeTabId, nextPeer, options)
              }
              onSelectionChange={(selection) =>
                updateTabRuntimeSelection(activeTabId, selection)
              }
              onClaudeModelChange={setSelectedModel}
              onClaudeEffortChange={setEffortLevel}
              onRefreshCodexModels={() => refreshCodexModels("codex")}
            />
          </div>,
          document.body,
        )}

      {/* @ mention dropdown */}
      {slashQuery === null &&
        mentionQuery !== null &&
        mentionFiles.length > 0 && (
          <div
            ref={mentionRef}
            className="absolute right-4 bottom-full left-4 mb-2 max-h-48 overflow-y-auto rounded-xl border border-border bg-background shadow-lg"
          >
            {mentionFiles.map((file, i) => {
              const parts = file.relativePath.split("/");
              const fileName = parts.pop()!;
              const dirPath = parts.length > 0 ? `${parts.join("/")}/` : "";
              return (
                <button
                  key={file.id}
                  data-active={i === mentionIndex}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors",
                    i === mentionIndex
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-muted",
                  )}
                  onMouseDown={(e) => {
                    e.preventDefault(); // prevent textarea blur
                    void selectMention(file);
                  }}
                  onMouseEnter={() => setMentionIndex(i)}
                >
                  {getFileIcon(file)}
                  <span className="truncate font-mono text-sm">{fileName}</span>
                  {dirPath && (
                    <span className="ml-auto shrink-0 font-mono text-muted-foreground text-xs">
                      {dirPath}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

      {archivedCodex ? (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-border/60 bg-muted/30 px-4 py-3">
          <p className="text-muted-foreground text-sm">
            {t("errors.readOnly")}
          </p>
          <button
            type="button"
            onClick={() => ensureWritableTab()}
            className="inline-flex h-8 items-center rounded-full bg-primary px-3 font-medium text-primary-foreground text-xs"
          >
            {t("chat.startNew")}
          </button>
        </div>
      ) : (
        <div
          data-composer-shell
          data-agent-flash={agentFlashId ?? undefined}
          className={cn(
            "flex w-full flex-col gap-2.5 overflow-hidden rounded-(--composer-radius) border border-border/70 bg-(--composer-bg) p-(--composer-padding) shadow-[0_4px_20px_-10px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.04)] transition-[border-color,box-shadow] focus-within:border-border focus-within:shadow-[0_8px_28px_-12px_rgba(0,0,0,0.12),0_1px_2px_rgba(0,0,0,0.05)] dark:border-muted-foreground/15 dark:shadow-none dark:focus-within:border-muted-foreground/30",
            agentFlashId && "lp-agent-switch-flash",
            isDragOver &&
              "border-ring border-dashed bg-[color-mix(in_oklab,var(--color-accent)_50%,var(--color-background))]",
          )}
        >
          {visibleQueuedGuidance.length > 0 && (
            <div className="max-h-20 overflow-y-auto rounded-xl border border-border/60 bg-background/60 text-xs">
              {visibleQueuedGuidance.map((guidance) => {
                const displayText = formatGuidanceText(guidance);
                return (
                  <div
                    key={guidance.id}
                    className="flex min-h-8 items-center gap-1.5 border-border/50 border-b px-3 py-1 last:border-b-0"
                  >
                    <ListEndIcon className="size-3 shrink-0 text-muted-foreground/60" />
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      {displayText}
                    </span>
                    <button
                      type="button"
                      className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2 font-normal text-muted-foreground transition-colors hover:bg-muted-foreground/15 hover:text-foreground/90 dark:hover:bg-muted"
                      title={
                        isStreaming
                          ? t("chat.guideNow")
                          : t("chat.sendGuidance")
                      }
                      onClick={() => handleGuideQueuedGuidance(guidance)}
                    >
                      <CornerDownRightIcon className="size-3" />
                      {t("chat.guide")}
                    </button>
                    <button
                      type="button"
                      aria-label={t("chat.removeQueued")}
                      className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-red-500/10 hover:text-red-600 dark:hover:bg-red-500/15 dark:hover:text-red-400"
                      onClick={() => {
                        void cleanupTemporaryFilePaths(
                          guidance.contextOverride?.temporaryFilePaths,
                        );
                        removeQueuedGuidance(activeTabId, guidance.id);
                      }}
                    >
                      <Trash2Icon className="size-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {/* Pinned context chips */}
          {pinnedContexts.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 px-2.5">
              {pinnedContexts.map((ctx, i) =>
                ctx.imageDataUrl ? (
                  <div
                    key={`${ctx.label}-${i}`}
                    className="group relative overflow-hidden rounded-lg border border-border bg-muted"
                  >
                    <img
                      src={ctx.imageDataUrl}
                      alt={ctx.label}
                      className="block h-16 w-auto object-contain"
                    />
                    <button
                      aria-label={t("chat.removeAttachment")}
                      onClick={() => {
                        void cleanupTemporaryPinnedContext(ctx);
                        setPinnedContexts((prev) =>
                          prev.filter((_, idx) => idx !== i),
                        );
                      }}
                      className="absolute top-0.5 right-0.5 rounded-full bg-background/80 p-0.5 opacity-0 transition-opacity group-hover:opacity-100"
                    >
                      <XIcon className="size-3" />
                    </button>
                  </div>
                ) : (
                  <span
                    key={`${ctx.label}-${i}`}
                    className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 font-mono text-muted-foreground text-xs"
                  >
                    {ctx.label}
                    <button
                      aria-label={t("chat.removeContext")}
                      onClick={() => {
                        void cleanupTemporaryPinnedContext(ctx);
                        setPinnedContexts((prev) =>
                          prev.filter((_, idx) => idx !== i),
                        );
                      }}
                      className="ml-0.5 rounded-sm p-0.5 transition-colors hover:bg-muted-foreground/20"
                    >
                      <XIcon className="size-3" />
                    </button>
                  </span>
                ),
              )}
            </div>
          )}

          {isDragOver ? (
            <div className="flex min-h-10 items-center justify-center px-2.5 py-1 text-muted-foreground text-sm">
              <PaperclipIcon className="mr-2 size-4" />
              {t("chat.dropFiles")}
            </div>
          ) : (
            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleInput}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={
                isStreaming
                  ? t("chat.placeholderStreaming")
                  : engineInstalling
                    ? t("chat.placeholderInstalling")
                    : t("chat.placeholder")
              }
              className="max-h-32 min-h-11 w-full resize-none bg-transparent px-2.5 py-1.5 text-base leading-relaxed outline-none placeholder:text-muted-foreground/70"
              rows={1}
            />
          )}

          <div
            ref={controlsRef}
            data-testid="composer-controls"
            data-layout={controlsLayout}
            className={cn(
              "flex min-w-0 gap-1.5 px-0.5",
              controlsLayout === "narrow"
                ? "flex-col"
                : "w-full flex-row items-center",
            )}
          >
            <div
              data-testid="composer-controls-leading"
              className={cn(
                "flex min-w-0 items-center gap-1.5",
                controlsLayout === "narrow" ? "w-full flex-wrap" : "shrink-0",
              )}
            >
              <TooltipIconButton
                tooltip="Attach files"
                side="top"
                type="button"
                variant="ghost"
                size="icon"
                className="size-8 shrink-0 rounded-full"
                onClick={handleAttachFiles}
                disabled={!projectRoot}
              >
                <PlusIcon className="size-4" />
              </TooltipIconButton>
              <PermissionModePicker busy={runtimeBusy} />
              <AgentSelector
                variant="pill"
                peer="claude"
                projectPath={projectRoot}
                agentId={activeTabMeta.agentId ?? null}
                busy={runtimeBusy}
                onAgentChange={(agent) => {
                  const previousAgentId = activeTabMeta.agentId ?? null;
                  const nextAgentId = agent?.id ?? null;
                  const result = updateTabRuntimeSelection(activeTabId, {
                    runtimeModel: agent
                      ? (agent.model ?? selectedRuntimeModelId ?? selectedModel)
                      : selectedRuntimeModelId,
                    reasoningEffort: agent
                      ? (agent.reasoningEffort ?? selectedRuntimeEffort)
                      : selectedRuntimeEffort,
                    agentId: nextAgentId,
                  });
                  if (
                    result === "changed" &&
                    shouldFlashPresetAgentSwitch(previousAgentId, nextAgentId)
                  ) {
                    requestPresetAgentFlash(nextAgentId ?? "");
                  }
                }}
              />
              <ReplyModePill agentId={activeTabMeta.agentId ?? null} />
              <ChatTokenMeter />
              {controlsLayout === "narrow" ? (
                <div data-testid="composer-send" className="ml-auto shrink-0">
                  {sendButton}
                </div>
              ) : null}
            </div>
            {controlsLayout === "wide" ? (
              <div
                data-testid="composer-controls-model"
                className="flex min-w-0 flex-1 justify-end overflow-hidden"
              >
                <ComposerModelChip
                  buttonRef={modelButtonRef}
                  label={composerModelLabel}
                  effortLabel={composerEffortLabel}
                  modelId={composerModelId}
                  providerName={activeProviderName}
                  disabled={runtimeBusy}
                  onClick={() => setModelPickerOpen((open) => !open)}
                />
              </div>
            ) : null}
            {controlsLayout === "wide" ? (
              <div data-testid="composer-send" className="shrink-0">
                {sendButton}
              </div>
            ) : (
              <ComposerModelChip
                buttonRef={modelButtonRef}
                label={composerModelLabel}
                effortLabel={composerEffortLabel}
                modelId={composerModelId}
                providerName={activeProviderName}
                disabled={runtimeBusy}
                onClick={() => setModelPickerOpen((open) => !open)}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
};
