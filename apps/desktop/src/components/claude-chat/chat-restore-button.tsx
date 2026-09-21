import { MessageCircleIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export function ChatRestoreButton({
  attention = false,
  onOpen,
  className,
}: {
  attention?: boolean;
  onOpen: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      data-testid="open-ai-assistant"
      aria-label="Open AI Assistant"
      title="Open AI chat"
      onClick={onOpen}
      className={cn(
        "relative flex size-12 items-center justify-center rounded-full border border-border bg-background text-foreground shadow-lg transition-all duration-300 ease-out hover:scale-105 hover:shadow-xl",
        className,
      )}
    >
      <MessageCircleIcon className="size-5" />
      {attention && (
        <span
          data-testid="open-ai-assistant-attention"
          className="absolute top-0.5 right-0.5 size-2 rounded-full bg-primary"
        />
      )}
    </button>
  );
}
