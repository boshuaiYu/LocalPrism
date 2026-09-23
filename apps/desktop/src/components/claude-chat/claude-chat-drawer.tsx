import { PanelRightCloseIcon } from "lucide-react";

import { ApprovalDialog } from "@/components/approvals/approval-dialog";
import { SubagentPanel } from "@/components/subagents/subagent-panel";
import { useChatLayoutStore } from "@/stores/chat-layout-store";
import { useClaudeChatStore } from "@/stores/claude-chat-store";
import { lastUserPrompt } from "@/lib/chat-error-card";
import { ChatMessages } from "./chat-messages";
import { ChatComposer } from "./chat-composer";
import { ChatErrorCard } from "./chat-error-card";
import { ChatTabBar } from "./chat-tab-bar";
import { useI18n } from "@/lib/use-i18n";

export function ClaudeChatDrawer() {
  const { t } = useI18n();
  const error = useClaudeChatStore((s) => s.error);
  const messages = useClaudeChatStore((s) => s.messages);
  const isStreaming = useClaudeChatStore((s) => s.isStreaming);
  const activeTabId = useClaudeChatStore((s) => s.activeTabId);
  const sendPrompt = useClaudeChatStore((s) => s.sendPrompt);
  const clearMessages = useClaudeChatStore((s) => s.clearMessages);
  const setError = useClaudeChatStore((s) => s._setError);
  const visible = useChatLayoutStore((s) => s.visible);
  const hideChat = useChatLayoutStore((s) => s.setVisible);

  return (
    <section
      data-testid="chat-pane"
      data-tour="tour-chat"
      className="flex h-full min-h-0 min-w-0 flex-col bg-background"
      aria-label={t("chrome.chat")}
    >
      <ChatTabBar
        leading={
          <button
            type="button"
            onClick={() => hideChat(false)}
            className="ml-1.5 flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-muted-foreground text-xs transition-colors hover:bg-muted/80 hover:text-foreground"
            aria-label={t("chrome.hideChat")}
            title={t("chrome.hideChat")}
          >
            <PanelRightCloseIcon className="size-3.5" />
            <span>{t("chrome.hide")}</span>
          </button>
        }
      />

      {error && (
        <ChatErrorCard
          error={error}
          retryPrompt={lastUserPrompt(messages)}
          busy={isStreaming}
          onRetry={(prompt) => void sendPrompt(prompt)}
          onClearConversation={clearMessages}
          onDismiss={() => setError(activeTabId, null)}
        />
      )}

      <SubagentPanel />

      <div className="relative min-h-0 flex-1 overflow-hidden">
        <ChatMessages />
        <ApprovalDialog />
      </div>

      <ChatComposer isOpen={visible} />
    </section>
  );
}
