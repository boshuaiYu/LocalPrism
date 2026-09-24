import { type FC, memo, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircleIcon,
  ArrowDownIcon,
  CheckIcon,
  CopyIcon,
  CornerDownRightIcon,
  Undo2Icon,
} from "lucide-react";
import {
  useClaudeChatStore,
  type ClaudeStreamMessage,
  type ContentBlock,
  type QueuedGuidance,
} from "@/stores/claude-chat-store";
import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { cn } from "@/lib/utils";
import { MarkdownRenderer } from "./markdown-renderer";
import { StreamingIndicator } from "./streaming-indicator";
import { ThinkingWidget, ToolWidget } from "./tool-widgets";
import { parseDisplayedCompileBullet } from "@/lib/compile-fix-prompt";
import {
  collapseRepeatedSkillToolMessages,
  isSkillInstructionDump,
  isSkillToolName,
  isSkillToolResultEcho,
} from "@/lib/skill-tool-result";
import {
  chatTerminalState,
  isIntermediateChatBlock,
  lastUserTextMessageIndex,
  settleChatMessages,
} from "@/lib/chat-turn-settlement";
import { canOfferCompression } from "@/lib/chat-compression";
import { transcriptHasContentBelow } from "@/lib/chat-scroll";
import {
  canRewindTo,
  isUserPrompt,
  lastUserPromptIndex,
  rewindAnchor,
} from "@/lib/chat-rewind";
import { localizeChatNotice } from "@/lib/chat-empty-reply";
import { useI18n } from "@/lib/use-i18n";

const EMPTY_PENDING_GUIDANCE: QueuedGuidance[] = [];
const THREAD_MAX_WIDTH = "max-w-[44rem]";

const MessageActions: FC<{
  text: string;
  align?: "left" | "right";
  rewindIndex?: number;
}> = ({ text, align = "left", rewindIndex }) => {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [confirmingRewind, setConfirmingRewind] = useState(false);
  const rewindToMessage = useClaudeChatStore((state) => state.rewindToMessage);
  const regenerateRewoundUserTurn = useClaudeChatStore(
    (state) => state.regenerateRewoundUserTurn,
  );
  const showRegenerate = useClaudeChatStore((state) => {
    if (state.isStreaming || align !== "right" || rewindIndex == null) {
      return false;
    }
    const tab = state.tabs.find(
      (candidate) => candidate.id === state.activeTabId,
    );
    const pending = tab?.rewindRegenerate?.prompt;
    if (!pending || text.trim() !== pending) return false;
    const messages = tab?.messages ?? [];
    const message = messages[rewindIndex];
    return (
      !!message &&
      isUserPrompt(message) &&
      lastUserPromptIndex(messages) === rewindIndex
    );
  });
  const rewindReady = useClaudeChatStore((state) => {
    if (state.isStreaming || rewindIndex == null) return false;
    const tab = state.tabs.find(
      (candidate) => candidate.id === state.activeTabId,
    );
    const messages = tab?.messages ?? state.messages;
    return (
      canRewindTo(messages, rewindIndex) &&
      rewindAnchor(messages, rewindIndex) != null
    );
  });
  const canCopy = text.trim().length > 0;

  const handleCopy = async () => {
    if (!canCopy) return;
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  if (!canCopy && !rewindReady && !confirmingRewind && !showRegenerate) {
    return null;
  }

  return (
    <div
      className={cn(
        "flex items-center gap-1 text-muted-foreground",
        align === "right" ? "justify-end" : "justify-start",
      )}
    >
      {confirmingRewind ? (
        <div className="flex max-w-full flex-wrap items-center gap-1">
          <span className="px-1 text-xs leading-4">{t("chat.rewindHint")}</span>
          <button
            type="button"
            data-testid="rewind-confirm"
            className="rounded-md px-2 py-1 text-foreground text-xs hover:bg-muted"
            onClick={() => {
              if (rewindIndex == null) return;
              setConfirmingRewind(false);
              void rewindToMessage(rewindIndex);
            }}
          >
            {t("chat.rewindConfirm")}
          </button>
          <button
            type="button"
            data-testid="rewind-cancel"
            className="rounded-md px-2 py-1 text-xs hover:bg-muted"
            onClick={() => setConfirmingRewind(false)}
          >
            {t("chat.rewindCancel")}
          </button>
        </div>
      ) : (
        <>
          {showRegenerate && (
            <button
              type="button"
              data-testid="rewind-regenerate"
              className="rounded-md px-2 py-1 text-foreground text-xs hover:bg-muted"
              onClick={() => {
                void regenerateRewoundUserTurn();
              }}
            >
              {t("chat.regenerate")}
            </button>
          )}
          {rewindReady && (
            <TooltipIconButton
              tooltip={t("chat.rewind")}
              side="top"
              variant="ghost"
              size="icon"
              data-testid="rewind-here"
              className="size-8 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => setConfirmingRewind(true)}
            >
              <Undo2Icon className="size-4" />
            </TooltipIconButton>
          )}
        </>
      )}
      {canCopy && (
        <TooltipIconButton
          tooltip={copied ? t("chat.copied") : t("chat.copy")}
          side="top"
          variant="ghost"
          size="icon"
          className="size-8 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={handleCopy}
        >
          {copied ? (
            <CheckIcon className="fade-in zoom-in-50 size-4 animate-in duration-200" />
          ) : (
            <CopyIcon className="fade-in zoom-in-75 size-4 animate-in duration-150" />
          )}
        </TooltipIconButton>
      )}
    </div>
  );
};

// ─── Chat Messages (main component) ───

export const ChatMessages: FC = () => {
  const { t } = useI18n();
  const messages = useClaudeChatStore((s) => s.messages) ?? [];
  const compressEarlierMessages = useClaudeChatStore(
    (s) => s.compressEarlierMessages,
  );
  const isStreaming = useClaudeChatStore((s) => s.isStreaming);
  const streamingStartedAt = useClaudeChatStore((s) => s.streamingStartedAt);
  const streamingStatus = useClaudeChatStore((s) => s.streamingStatus);
  const streamingRuntime = useClaudeChatStore(
    (s) => s.tabs.find((tab) => tab.id === s.activeTabId)?.runtime ?? "claude",
  );
  const queuedGuidance =
    useClaudeChatStore(
      (s) => s.tabs.find((tab) => tab.id === s.activeTabId)?.queuedGuidance,
    ) ?? EMPTY_PENDING_GUIDANCE;
  const pendingGuidance = useMemo(
    () => queuedGuidance.filter((guidance) => guidance.displayedInChat),
    [queuedGuidance],
  );
  const viewportRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const userHasScrolledRef = useRef(false);
  // Programmatic scrolls also emit scroll events. Keep those from looking
  // like the reader left the latest messages.
  const followScrollRef = useRef(false);
  const anchorScrollTopRef = useRef(0);
  const wasStreamingRef = useRef(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  // Build a map of tool_use_id → tool_result for inline display
  const toolResultMap = useMemo(() => {
    const map = new Map<string, ContentBlock>();
    const visit = (msg: ClaudeStreamMessage) => {
      for (const original of msg.contextSummary?.originals ?? []) {
        visit(original);
      }
      if (msg.type === "user" && Array.isArray(msg.message?.content)) {
        for (const block of msg.message.content) {
          if (block.type === "tool_result" && block.tool_use_id) {
            map.set(block.tool_use_id, block);
          }
        }
      }
    };
    for (const msg of messages) visit(msg);
    return map;
  }, [messages]);

  // Filter displayable messages
  const displayMessages = useMemo(() => {
    // Collect all assistant text for dedup against result
    const assistantTexts = new Set<string>();
    for (const msg of messages) {
      if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
        for (const block of msg.message.content) {
          if (block.type === "text" && block.text) {
            assistantTexts.add(block.text.trim());
          }
        }
      }
    }

    return collapseRepeatedSkillToolMessages(
      messages
        .map((msg, index) =>
          msg.rewindIndex == null ? { ...msg, rewindIndex: index } : msg,
        )
        .filter((msg) => {
          if (msg.subtype === "context-summary") return true;
          if (msg.type === "system" && msg.subtype === "init") return false;
          if (
            msg.type !== "user" &&
            msg.type !== "assistant" &&
            msg.type !== "result"
          )
            return false;
          if (msg.type === "user" && msg.message?.content) {
            if (Array.isArray(msg.message.content)) {
              const hasOnlyToolResults = msg.message.content.every(
                (b: any) => b.type === "tool_result",
              );
              if (hasOnlyToolResults) return false;
              const text = msg.message.content
                .filter((block) => block.type === "text" && block.text)
                .map((block) => block.text)
                .join("\n");
              if (text && isSkillInstructionDump(text)) return false;
            } else if (
              typeof msg.message.content === "string" &&
              isSkillInstructionDump(msg.message.content)
            ) {
              return false;
            }
          }
          if (msg.type === "result" && msg.result) {
            if (assistantTexts.has(msg.result.trim())) return false;
            if (isSkillInstructionDump(msg.result)) return false;
          }
          return true;
        }),
    );
  }, [messages]);

  const settledMessages = useMemo(
    () => (isStreaming ? displayMessages : settleChatMessages(displayMessages)),
    [displayMessages, isStreaming],
  );
  const openTurnStart = lastUserTextMessageIndex(settledMessages);

  const contentBelow = (el: HTMLElement) =>
    transcriptHasContentBelow({
      scrollHeight: el.scrollHeight,
      scrollTop: el.scrollTop,
      clientHeight: el.clientHeight,
    });

  // Auto-scroll to bottom (only if user hasn't scrolled up).
  // Instant while streaming — CSS scroll-smooth would jank on every token.
  // Re-read the ref inside the frame so a scroll-up that lands between the
  // token and the paint wins. Re-arm follow only after that check, and only
  // when the turn has just ended, so the reset cannot scroll this frame.
  useEffect(() => {
    const streamingNow = isStreaming;
    const streamingJustEnded = wasStreamingRef.current && !streamingNow;
    wasStreamingRef.current = streamingNow;
    const frame = window.requestAnimationFrame(() => {
      const el = viewportRef.current;
      if (!el) return;
      if (shouldAutoScrollRef.current) {
        followScrollRef.current = true;
        anchorScrollTopRef.current = el.scrollTop;
        el.scrollTo({
          top: el.scrollHeight,
          behavior: streamingNow ? "instant" : "smooth",
        });
        if (el.scrollTop > anchorScrollTopRef.current) {
          anchorScrollTopRef.current = el.scrollTop;
        }
      }
      setShowScrollToBottom(contentBelow(el) && !shouldAutoScrollRef.current);
      if (streamingJustEnded) {
        shouldAutoScrollRef.current = true;
        userHasScrolledRef.current = false;
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [settledMessages, pendingGuidance, isStreaming]);

  const offerCompression = canOfferCompression(messages);

  const handleScroll = () => {
    const el = viewportRef.current;
    if (!el) return;
    const away = contentBelow(el);
    if (followScrollRef.current) {
      if (el.scrollTop + 1 < anchorScrollTopRef.current) {
        followScrollRef.current = false;
        userHasScrolledRef.current = true;
        shouldAutoScrollRef.current = false;
        anchorScrollTopRef.current = el.scrollTop;
        setShowScrollToBottom(away);
        return;
      }
      if (el.scrollTop > anchorScrollTopRef.current) {
        anchorScrollTopRef.current = el.scrollTop;
      }
      if (!away) {
        followScrollRef.current = false;
        shouldAutoScrollRef.current = true;
        userHasScrolledRef.current = false;
      }
      setShowScrollToBottom(false);
      return;
    }
    if (away) {
      userHasScrolledRef.current = true;
      shouldAutoScrollRef.current = false;
    } else if (userHasScrolledRef.current) {
      shouldAutoScrollRef.current = true;
      userHasScrolledRef.current = false;
    }
    anchorScrollTopRef.current = el.scrollTop;
    setShowScrollToBottom(away);
  };

  const jumpToLatest = () => {
    const el = viewportRef.current;
    if (!el) return;
    shouldAutoScrollRef.current = true;
    userHasScrolledRef.current = false;
    followScrollRef.current = true;
    anchorScrollTopRef.current = el.scrollTop;
    el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
    if (el.scrollTop > anchorScrollTopRef.current) {
      anchorScrollTopRef.current = el.scrollTop;
    }
    const away = contentBelow(el);
    if (away) {
      followScrollRef.current = false;
      shouldAutoScrollRef.current = false;
      userHasScrolledRef.current = true;
    } else {
      followScrollRef.current = false;
    }
    setShowScrollToBottom(away);
  };

  const scrollToBottomLabel = t("chat.scrollToBottom");

  return (
    <>
      <div
        ref={viewportRef}
        onScroll={handleScroll}
        data-testid="chat-transcript"
        className="absolute inset-0 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden scroll-smooth px-5 pt-5 pb-2"
      >
        {settledMessages.length === 0 &&
          pendingGuidance.length === 0 &&
          !isStreaming && (
            <div className="flex h-full items-center justify-center px-6 text-center text-muted-foreground text-sm leading-relaxed">
              {t("chat.ask")}
            </div>
          )}

        {offerCompression && (
          <div
            className={cn(
              "pointer-events-none sticky top-0 z-10 mx-auto mb-1 flex w-full justify-end",
              THREAD_MAX_WIDTH,
            )}
          >
            <button
              type="button"
              data-testid="compress-earlier"
              className="pointer-events-auto px-1 py-1 text-muted-foreground text-xs underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
              disabled={isStreaming}
              onClick={() => void compressEarlierMessages({ force: true })}
            >
              {t("chat.compress")}
            </button>
          </div>
        )}

        {settledMessages.map((msg, idx) => (
          <div
            key={idx}
            className={cn("mx-auto w-full min-w-0", THREAD_MAX_WIDTH)}
          >
            <MessageBubble
              message={msg}
              toolResultMap={toolResultMap}
              live={isStreaming && idx > openTurnStart}
            />
          </div>
        ))}

        {isStreaming && (
          <div className={cn("mx-auto w-full min-w-0 px-2", THREAD_MAX_WIDTH)}>
            <StreamingIndicator
              startedAt={streamingStartedAt}
              status={streamingStatus}
              runtime={streamingRuntime === "codex" ? "codex" : "claude"}
            />
          </div>
        )}

        {pendingGuidance.map((guidance) => (
          <div
            key={guidance.id}
            className={cn("mx-auto w-full min-w-0", THREAD_MAX_WIDTH)}
          >
            <PendingGuidanceMessage guidance={guidance} />
          </div>
        ))}
      </div>
      {showScrollToBottom && (
        <TooltipIconButton
          tooltip={scrollToBottomLabel}
          aria-label={scrollToBottomLabel}
          side="top"
          variant="outline"
          size="icon"
          type="button"
          data-testid="scroll-to-bottom"
          className="absolute bottom-3 left-1/2 z-10 size-9 -translate-x-1/2 rounded-full bg-background/95 shadow-sm"
          onClick={jumpToLatest}
        >
          <ArrowDownIcon className="size-4" />
        </TooltipIconButton>
      )}
    </>
  );
};

// ─── Message Bubble ───

function toolUseIds(message: ClaudeStreamMessage): string[] {
  const content = message.message?.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) =>
    block.type === "tool_use" && block.id ? [block.id] : [],
  );
}

const MessageBubble: FC<{
  message: ClaudeStreamMessage;
  toolResultMap: Map<string, ContentBlock>;
  live?: boolean;
}> = memo(
  ({ message, toolResultMap, live = false }) => {
    if (message.subtype === "context-summary") {
      return <SummaryMessage message={message} toolResultMap={toolResultMap} />;
    }
    if (message.type === "user") {
      return <UserMessage message={message} />;
    }
    if (message.type === "assistant") {
      return (
        <AssistantMessage
          message={message}
          toolResultMap={toolResultMap}
          live={live}
        />
      );
    }
    if (message.type === "result") {
      return <ResultMessage message={message} />;
    }
    return null;
  },
  (prev, next) => {
    if (prev.live !== next.live) return false;
    if (prev.message !== next.message) return false;
    if (prev.message.type !== "assistant") return true;
    return toolUseIds(prev.message).every(
      (id) => prev.toolResultMap.get(id) === next.toolResultMap.get(id),
    );
  },
);

function SummaryMessage({
  message,
  toolResultMap,
}: {
  message: ClaudeStreamMessage;
  toolResultMap: Map<string, ContentBlock>;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const summary = message.contextSummary?.text ?? message.result ?? "";
  const originals = message.contextSummary?.originals ?? [];
  const count = message.contextSummary?.coveredCount ?? originals.length;

  return (
    <div className="mb-4 rounded-lg border border-border/70 bg-muted/40 px-3 py-2">
      <p className="font-medium text-xs">{t("chat.summaryTitle")}</p>
      <p className="mt-1 whitespace-pre-wrap text-sm leading-5">{summary}</p>
      <p className="mt-1 text-muted-foreground text-xs">
        {t("chat.summaryMeta", { count })}
      </p>
      <MessageActions text={summary} rewindIndex={message.rewindIndex} />
      {originals.length > 0 && (
        <button
          type="button"
          className="mt-2 text-xs underline-offset-2 hover:underline"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          {open ? t("chat.hideOriginals") : t("chat.showOriginals")}
        </button>
      )}
      {open && (
        <div className="mt-3 border-border/70 border-t pt-2">
          {originals.map((original, index) => (
            <MessageBubble
              key={index}
              message={original}
              toolResultMap={toolResultMap}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── User Message ───

const UserMessage: FC<{ message: ClaudeStreamMessage }> = ({ message }) => {
  const rawContent = message.message?.content;
  const textContent = Array.isArray(rawContent)
    ? rawContent
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n")
    : typeof rawContent === "string"
      ? rawContent
      : "";

  if (!textContent || isSkillInstructionDump(textContent)) return null;

  const firstLineMatch = textContent.match(/^([^\n]+)\n([\s\S]*)$/);
  const firstLine = firstLineMatch?.[1]?.trim() ?? "";
  const hasContextLabel =
    firstLine.startsWith("@") ||
    firstLine.startsWith("~@") ||
    /^Pasted image(?: \d+)?(?:, Pasted image(?: \d+)?)*$/.test(firstLine);
  const contextLabel = hasContextLabel ? firstLine : null;
  const bodyText =
    hasContextLabel && firstLineMatch ? firstLineMatch[2] : textContent;

  // Parse error block patterns for styled rendering:
  // Lint single: "[Lint error in FILE:LINE]\n[Error: MSG]\n\nPrompt"
  // Lint multi:  "[Lint errors in FILE]\n- FILE:LINE — MSG\n...\n\nPrompt"
  // Compile:     "[Compilation errors]\n- error1\n- error2\n...\n\nPrompt"
  const lintSingleMatch = bodyText.match(
    /^\[Lint error in ([^\]]+)\]\n\[Error: ([^\]]+)\]\n\n([\s\S]*)$/,
  );
  const lintMultiMatch = bodyText.match(
    /^\[Lint errors in ([^\]]+)\]\n((?:- .+\n?)+)\n([\s\S]*)$/,
  );
  const compileErrorMatch = bodyText.match(
    /^\[Compilation errors\]\n((?:- .+\n?)+)\n([\s\S]*)$/,
  );

  // Shared error block renderer
  const renderErrorBlock = (
    title: string,
    errors: { message: string; location?: string }[],
    prompt: string,
  ) => (
    <div className="fade-in slide-in-from-bottom-1 grid w-full min-w-0 animate-in auto-rows-auto grid-cols-[minmax(0,1fr)_minmax(0,max-content)] content-start gap-y-2 px-2 py-4 duration-150 [&:where(>*)]:col-start-2">
      <div className="relative col-start-2 min-w-0">
        <div className="wrap-break-word min-w-0 max-w-full rounded-2xl bg-muted px-4 py-2.5 text-foreground text-sm leading-relaxed empty:hidden">
          <div className="mb-2 rounded-lg border border-red-500/20 bg-red-500/10 px-2.5 py-2">
            <div className="mb-1.5 font-medium text-red-400 text-xs">
              {title}
            </div>
            <div className="space-y-1">
              {errors.map((e, i) => (
                <div key={i} className="flex items-start gap-1.5">
                  <AlertCircleIcon className="mt-0.5 size-3 shrink-0 text-red-400/70" />
                  <span className="flex-1 text-foreground/80 text-xs">
                    {e.message}
                  </span>
                  {e.location && (
                    <span className="shrink-0 font-mono text-muted-foreground text-xs">
                      {e.location}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
          <span className="text-muted-foreground">{prompt}</span>
        </div>
      </div>
      <div className="col-span-full col-start-1 row-start-2 -mr-1 flex justify-end">
        <MessageActions
          text={bodyText}
          align="right"
          rewindIndex={message.rewindIndex}
        />
      </div>
    </div>
  );

  if (lintSingleMatch) {
    const [, location, errorMsg, prompt] = lintSingleMatch;
    return renderErrorBlock(
      `Lint Error`,
      [{ message: errorMsg, location }],
      prompt,
    );
  }

  if (lintMultiMatch) {
    const [, fileName, errorLines, prompt] = lintMultiMatch;
    const errors = errorLines
      .trim()
      .split("\n")
      .map((line) => {
        const m = line.match(/^- (.+?):(\d+) — (.+)$/);
        return m
          ? { message: m[3], location: `${m[1]}:${m[2]}` }
          : { message: line.replace(/^- /, "") };
      });
    return renderErrorBlock(`Lint Errors — ${fileName}`, errors, prompt);
  }

  if (compileErrorMatch) {
    const [, errorLines, prompt] = compileErrorMatch;
    const errors = errorLines
      .trim()
      .split("\n")
      .map((line) => parseDisplayedCompileBullet(line));
    return renderErrorBlock(
      `Compilation ${errors.length === 1 ? "Error" : "Errors"}`,
      errors,
      prompt,
    );
  }

  return (
    <div className="fade-in slide-in-from-bottom-1 grid w-full min-w-0 animate-in auto-rows-auto grid-cols-[minmax(0,1fr)_minmax(0,max-content)] content-start gap-y-2 px-2 py-4 duration-150 [&:where(>*)]:col-start-2">
      <div className="relative col-start-2 min-w-0">
        <div className="wrap-break-word min-w-0 max-w-full rounded-2xl bg-muted px-4 py-2.5 text-foreground text-sm leading-relaxed empty:hidden">
          {contextLabel && (
            <span className="mb-1 inline-flex items-center rounded-md bg-background/60 px-1.5 py-0.5 font-mono text-muted-foreground text-xs">
              {contextLabel}
            </span>
          )}
          {contextLabel && bodyText && <br />}
          <MarkdownRenderer
            content={bodyText}
            className="prose prose-sm dark:prose-invert max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
          />
        </div>
      </div>
      <div className="col-span-full col-start-1 row-start-2 -mr-1 flex justify-end">
        <MessageActions
          text={textContent}
          align="right"
          rewindIndex={message.rewindIndex}
        />
      </div>
    </div>
  );
};

// ─── Assistant Message ───

const PendingGuidanceMessage: FC<{ guidance: QueuedGuidance }> = ({
  guidance,
}) => {
  const contextLabel = guidance.contextOverride?.label ?? null;
  const visiblePrompt = guidance.displayPrompt ?? guidance.prompt;
  const copyText = contextLabel
    ? `${contextLabel}\n${visiblePrompt}`
    : visiblePrompt;

  return (
    <div className="fade-in slide-in-from-bottom-1 grid w-full min-w-0 animate-in auto-rows-auto grid-cols-[minmax(0,1fr)_minmax(0,max-content)] content-start gap-y-2 px-2 py-4 duration-150 [&:where(>*)]:col-start-2">
      <div className="relative col-start-2 min-w-0">
        <div className="wrap-break-word min-w-0 max-w-full rounded-2xl bg-muted px-4 py-2.5 text-foreground text-sm leading-relaxed empty:hidden">
          {contextLabel && (
            <span className="mb-1 inline-flex items-center rounded-md bg-background/60 px-1.5 py-0.5 font-mono text-muted-foreground text-xs">
              {contextLabel}
            </span>
          )}
          {contextLabel && visiblePrompt && <br />}
          <div className="flex min-w-0 items-start gap-2">
            <CornerDownRightIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/70" />
            <MarkdownRenderer
              content={visiblePrompt}
              className="prose prose-sm dark:prose-invert min-w-0 max-w-none flex-1 break-words [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
            />
          </div>
        </div>
      </div>
      <div className="col-span-full col-start-1 row-start-2 -mr-1 flex justify-end">
        <MessageActions text={copyText} align="right" />
      </div>
    </div>
  );
};

const AssistantMessage: FC<{
  message: ClaudeStreamMessage;
  toolResultMap: Map<string, ContentBlock>;
  live?: boolean;
}> = ({ message, toolResultMap, live = false }) => {
  const { language } = useI18n();
  const content = message.message?.content;
  if (!Array.isArray(content) || content.length === 0) return null;
  const visibleContent = live
    ? content
    : content.filter((block) => !isIntermediateChatBlock(block));
  if (visibleContent.length === 0) return null;

  const skillResults = content.flatMap((block) => {
    if (
      block.type !== "tool_use" ||
      !block.id ||
      !isSkillToolName(block.name)
    ) {
      return [];
    }
    const result = toolResultMap.get(block.id);
    return result ? [result] : [];
  });
  const isHiddenSkillText = (text: string) =>
    isSkillToolResultEcho(text, skillResults);

  const hasRenderableContent = visibleContent.some(
    (block) =>
      (block.type === "text" && block.text && !isHiddenSkillText(block.text)) ||
      (block.type === "thinking" && block.thinking) ||
      (block.type === "tool_use" && block.id),
  );

  if (!hasRenderableContent) return null;

  const unfinished = visibleContent.some(
    (block) =>
      block.type === "tool_use" && !!block.id && !toolResultMap.has(block.id),
  );
  const turnState = chatTerminalState({ live, unfinished });

  const copyText = visibleContent
    .filter(
      (block) =>
        block.type === "text" && block.text && !isHiddenSkillText(block.text),
    )
    .map((block) => localizeChatNotice(block.text ?? "", language))
    .join("\n\n");

  return (
    <div
      data-turn-state={turnState}
      className="fade-in slide-in-from-bottom-1 relative mx-auto w-full min-w-0 animate-in py-4 duration-150"
    >
      <div className="wrap-break-word min-w-0 max-w-full px-2 text-foreground text-sm leading-7">
        {visibleContent.map((block, idx) => {
          if (block.type === "text" && block.text) {
            if (isHiddenSkillText(block.text)) {
              return null;
            }
            return (
              <MarkdownRenderer
                key={idx}
                content={localizeChatNotice(block.text, language)}
                className="prose prose-sm dark:prose-invert max-w-none"
              />
            );
          }
          if (block.type === "tool_use" && block.id) {
            const result = toolResultMap.get(block.id);
            return (
              <ToolWidget
                key={idx}
                toolUse={block}
                toolResult={result}
                live={live}
              />
            );
          }
          if (block.type === "thinking" && block.thinking) {
            return (
              <ThinkingWidget
                key={idx}
                thinking={block.thinking}
                signature={block.signature}
                live={live}
              />
            );
          }
          return null;
        })}
      </div>
      <div className="-mb-7.5 ml-2 flex min-h-7.5 items-center pt-1.5">
        <MessageActions text={copyText} rewindIndex={message.rewindIndex} />
      </div>
    </div>
  );
};

// ─── Result Message ───

const ResultMessage: FC<{ message: ClaudeStreamMessage }> = ({ message }) => {
  const isError = message.is_error || message.subtype === "error";
  const resultText = message.result;

  if (
    !resultText ||
    isSkillInstructionDump(resultText) ||
    isIntermediateChatBlock({ type: "text", text: resultText })
  ) {
    return null;
  }

  return (
    <div
      data-turn-state={chatTerminalState({ live: false, error: !!isError })}
      className="fade-in slide-in-from-bottom-1 relative mx-auto w-full min-w-0 animate-in py-4 duration-150"
    >
      <div className="wrap-break-word min-w-0 max-w-full px-2 text-foreground text-sm leading-7">
        {isError ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive text-sm">
            {resultText}
          </div>
        ) : (
          <MarkdownRenderer
            content={resultText}
            className="prose prose-sm dark:prose-invert max-w-none"
          />
        )}
      </div>
      <div className="-mb-7.5 ml-2 flex min-h-7.5 items-center pt-1.5">
        <MessageActions text={resultText} rewindIndex={message.rewindIndex} />
      </div>
      {message.cost_usd != null && (
        <div className="mt-1 px-1 text-right text-muted-foreground text-xs">
          Cost: ${message.cost_usd.toFixed(4)}
        </div>
      )}
    </div>
  );
};
