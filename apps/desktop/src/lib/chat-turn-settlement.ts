export type ChatTerminalState =
  | "streaming"
  | "completed"
  | "error"
  | "cancelled";

export interface SettlableBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
}

export interface SettlableMessage {
  type: string;
  subtype?: string;
  result?: string;
  is_error?: boolean;
  message?: {
    content?: SettlableBlock[];
  };
}

const INTERMEDIATE_RESIDUE =
  /^(?:thinking(?:\.{3}|…)?|no response requested\.?)$/i;

export function isChatIntermediateResidue(
  text: string | null | undefined,
): boolean {
  const normalized = text?.trim().replace(/\s+/g, " ") ?? "";
  if (!normalized) return false;
  return INTERMEDIATE_RESIDUE.test(normalized);
}

export function isIntermediateChatBlock(block: SettlableBlock): boolean {
  if (block.type === "text") return isChatIntermediateResidue(block.text);
  if (block.type === "thinking") {
    return !block.thinking?.trim() || isChatIntermediateResidue(block.thinking);
  }
  return false;
}

export function chatTerminalState(input: {
  live: boolean;
  error?: boolean;
  unfinished?: boolean;
}): ChatTerminalState {
  if (input.live) return "streaming";
  if (input.error) return "error";
  if (input.unfinished) return "cancelled";
  return "completed";
}

export function toolActivityPhase(
  hasResult: boolean,
  isError: boolean | undefined,
  live: boolean,
): ChatTerminalState {
  if (isError) return "error";
  if (hasResult) return "completed";
  if (live) return "streaming";
  return "cancelled";
}

function settleMessage<T extends SettlableMessage>(message: T): T | null {
  if (message.type === "result" && isChatIntermediateResidue(message.result)) {
    return null;
  }
  if (message.type !== "assistant") return message;
  const content = message.message?.content;
  if (!Array.isArray(content)) return message;

  const nextContent = content.filter(
    (block) => !isIntermediateChatBlock(block),
  );
  if (nextContent.length === 0) return null;
  if (nextContent.length === content.length) return message;
  return {
    ...message,
    message: {
      ...message.message,
      content: nextContent,
    },
  };
}

/** Drop in-progress placeholders once a turn is no longer streaming. */
export function settleChatMessages<T extends SettlableMessage>(
  messages: readonly T[],
): T[] {
  let changed = false;
  const next: T[] = [];
  for (const message of messages) {
    const settled = settleMessage(message);
    if (settled === null) {
      changed = true;
      continue;
    }
    if (settled !== message) changed = true;
    next.push(settled);
  }
  return changed ? next : (messages as T[]);
}

export function lastUserTextMessageIndex(
  messages: readonly SettlableMessage[],
): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.type !== "user") continue;
    const content = message.message?.content;
    const hasText = Array.isArray(content)
      ? content.some((block) => block.type === "text" && !!block.text?.trim())
      : false;
    if (hasText) return index;
  }
  return -1;
}
