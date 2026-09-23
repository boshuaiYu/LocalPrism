import { useEffect } from "react";
import { providerAccountKey } from "@/lib/provider-account";
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

function syncActiveAccount(
  state: Parameters<typeof providerAccountKey>[0],
): void {
  useClaudeChatStore.getState().noteActiveAccount(providerAccountKey(state));
}

export function useClaudeRuntimeSync(): void {
  useEffect(() => {
    syncActiveAccount(useProviderStore.getState());
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
        if (providerAccountKey(state) !== providerAccountKey(previousState)) {
          syncActiveAccount(state);
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
