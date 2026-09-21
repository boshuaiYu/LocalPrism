import { create } from "zustand";

interface ChatLayoutState {
  visible: boolean;
  suppressAutoOpen: boolean;
  toggle: () => void;
  setVisible: (visible: boolean) => void;
  reveal: () => void;
}

export const useChatLayoutStore = create<ChatLayoutState>((set) => ({
  visible: true,
  suppressAutoOpen: false,
  toggle: () =>
    set((state) =>
      state.visible
        ? { visible: false, suppressAutoOpen: true }
        : { visible: true, suppressAutoOpen: false },
    ),
  setVisible: (visible) =>
    set({
      visible,
      suppressAutoOpen: !visible,
    }),
  reveal: () => set({ visible: true, suppressAutoOpen: false }),
}));

export function resetChatLayoutStoreForTests(): void {
  useChatLayoutStore.setState({ visible: true, suppressAutoOpen: false });
}

/** Percent widths inside the workspace PanelGroup, including the 15% sidebar. */
export function contentPaneSize(options: {
  code: boolean;
  chat: boolean;
  pdf: boolean;
  pane: "code" | "chat" | "pdf";
}): number {
  const paneVisible =
    (options.pane === "code" && options.code) ||
    (options.pane === "chat" && options.chat) ||
    (options.pane === "pdf" && options.pdf);
  if (!paneVisible) return 0;

  const visible =
    Number(options.code) + Number(options.chat) + Number(options.pdf);
  if (visible <= 1) return 85;
  if (visible === 2) {
    if (options.pane === "chat") return 32;
    if (options.code && options.pdf) return 42.5;
    return 53;
  }
  if (options.pane === "code") return 33;
  if (options.pane === "chat") return 24;
  return 28;
}
