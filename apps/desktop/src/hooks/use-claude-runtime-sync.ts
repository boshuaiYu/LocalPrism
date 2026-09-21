import { useEffect } from "react";
import { useClaudeChatStore } from "@/stores/claude-chat-store";
import { useClaudeSetupStore } from "@/stores/claude-setup-store";
import {
  resolveProviderRequestModel,
  useProviderStore,
} from "@/stores/provider-store";
import { useRuntimeStore } from "@/stores/runtime-store";

function syncChatSelectionToCatalog(
  models: Parameters<typeof resolveProviderRequestModel>[1],
): void {
  if (models.length === 0) return;
  const chat = useClaudeChatStore.getState();
  const selectedModel =
    resolveProviderRequestModel(chat.selectedModel, models) ??
    chat.selectedModel;
  let tabsChanged = false;
  const tabs = chat.tabs.map((tab) => {
    const next = resolveProviderRequestModel(tab.runtimeModel, models);
    if (!next || next === tab.runtimeModel) return tab;
    tabsChanged = true;
    return { ...tab, runtimeModel: next };
  });
  if (selectedModel === chat.selectedModel && !tabsChanged) return;
  useClaudeChatStore.setState({
    selectedModel,
    ...(tabsChanged ? { tabs } : {}),
  });
}

export function useClaudeRuntimeSync(): void {
  useEffect(() => {
    void useProviderStore
      .getState()
      .refresh()
      .catch(() => undefined);
    const stopProviderReady = useProviderStore.subscribe(
      (state, previousState) => {
        if (
          state.models !== previousState.models ||
          state.activeId !== previousState.activeId
        ) {
          syncChatSelectionToCatalog(state.models);
        }
        if (state.ready && !previousState.ready) {
          useClaudeChatStore.getState().ensureWritableTab();
        }
      },
    );
    const stopSetup = useClaudeSetupStore.subscribe((state, previousState) => {
      if (
        previousState.status !== state.status &&
        state.status !== "checking" &&
        state.status !== "error"
      ) {
        void useRuntimeStore
          .getState()
          .refresh("claude")
          .catch(() => undefined);
        void useProviderStore
          .getState()
          .refresh()
          .catch(() => undefined);
      }
    });
    return () => {
      stopProviderReady();
      stopSetup();
    };
  }, []);
}
