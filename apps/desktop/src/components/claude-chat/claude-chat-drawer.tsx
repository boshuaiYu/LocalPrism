import { PanelRightCloseIcon } from "lucide-react";

import { ApprovalDialog } from "@/components/approvals/approval-dialog";
import { SubagentPanel } from "@/components/subagents/subagent-panel";
import { useChatLayoutStore } from "@/stores/chat-layout-store";
import { useClaudeChatStore } from "@/stores/claude-chat-store";
import { ChatMessages } from "./chat-messages";
import { ChatComposer } from "./chat-composer";
import { ChatTabBar } from "./chat-tab-bar";

export function ClaudeChatDrawer() {
  const error = useClaudeChatStore((s) => s.error);
  const visible = useChatLayoutStore((s) => s.visible);
  const hideChat = useChatLayoutStore((s) => s.setVisible);

  return (
    <section
      data-testid="chat-pane"
      className="flex h-full min-h-0 min-w-0 flex-col bg-background"
      aria-label="Chat"
    >
      <ChatTabBar
        leading={
          <button
            type="button"
            onClick={() => hideChat(false)}
            className="ml-1.5 flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-muted-foreground text-xs transition-colors hover:bg-muted/80 hover:text-foreground"
            aria-label="Hide chat"
            title="Hide AI chat to a small icon"
          >
            <PanelRightCloseIcon className="size-3.5" />
            <span>Hide</span>
          </button>
        }
      />

      {error && (
        <div className="mx-3 mt-2 mb-1 rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-1.5 text-destructive text-xs">
          {error}
        </div>
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
