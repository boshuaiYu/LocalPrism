import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import { useClaudeRuntimeSync } from "@/hooks/use-claude-runtime-sync";
import { useClaudeChatStore } from "@/stores/claude-chat-store";
import { useClaudeSetupStore } from "@/stores/claude-setup-store";
import {
  resetProviderStoreForTests,
  useProviderStore,
} from "@/stores/provider-store";
import {
  resetRuntimeStoreForTests,
  type RuntimeState,
  useRuntimeStore,
} from "@/stores/runtime-store";

function SyncProbe() {
  useClaudeRuntimeSync();
  return null;
}

describe("useClaudeRuntimeSync", () => {
  let container: HTMLDivElement;
  let root: Root;
  let refresh: Mock<RuntimeState["refresh"]>;
  let providerRefresh: Mock;

  beforeEach(() => {
    resetRuntimeStoreForTests();
    resetProviderStoreForTests();
    refresh = vi.fn<RuntimeState["refresh"]>().mockResolvedValue(undefined);
    providerRefresh = vi.fn().mockResolvedValue(undefined);
    useRuntimeStore.setState({ refresh });
    useProviderStore.setState({ refresh: providerRefresh });
    useClaudeSetupStore.setState({ status: "checking", error: null });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    resetRuntimeStoreForTests();
    resetProviderStoreForTests();
  });

  async function renderProbe() {
    await act(async () => {
      root.render(<SyncProbe />);
      await Promise.resolve();
    });
  }

  it("refreshes shared Claude after a standalone legacy setup settles", async () => {
    await renderProbe();

    await act(async () => {
      useClaudeSetupStore.setState({ status: "ready", error: null });
      await Promise.resolve();
    });

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith("claude");
  });

  it("ignores checking to error but refreshes when error later changes to ready", async () => {
    await renderProbe();

    await act(async () => {
      useClaudeSetupStore.setState({ status: "error", error: "failed" });
      await Promise.resolve();
    });
    expect(refresh).not.toHaveBeenCalled();

    await act(async () => {
      useClaudeSetupStore.setState({ status: "ready", error: null });
      await Promise.resolve();
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith("claude");
  });

  it("does not refresh for fields changing within the same stable status", async () => {
    useClaudeSetupStore.setState({
      status: "ready",
      error: null,
      version: "1.0.0",
    });
    await renderProbe();

    await act(async () => {
      useClaudeSetupStore.setState({ version: "1.1.0" });
      await Promise.resolve();
    });

    expect(refresh).not.toHaveBeenCalled();
  });

  it("snaps leftover Claude aliases onto the live provider catalog", async () => {
    useClaudeChatStore.setState({
      selectedModel: "opus",
      tabs: [
        {
          ...useClaudeChatStore.getState().tabs[0],
          runtimeModel: "sonnet",
        },
      ],
    });
    await renderProbe();

    await act(async () => {
      useProviderStore.setState({
        activeId: "chatgpt-official",
        models: [
          {
            id: "gpt-5.4",
            displayName: "GPT-5.4",
            reasoningEfforts: ["medium"],
            isDefault: true,
          },
          {
            id: "gpt-5.3-codex",
            displayName: "Codex",
            reasoningEfforts: ["medium"],
            isDefault: false,
          },
        ],
      });
      await Promise.resolve();
    });

    expect(useClaudeChatStore.getState().selectedModel).toBe("gpt-5.4");
    expect(useClaudeChatStore.getState().tabs[0]?.runtimeModel).toBe("gpt-5.4");
  });

  it("keeps an explicit Terra selection", async () => {
    useClaudeChatStore.setState({
      selectedModel: "gpt-5.6-terra",
      tabs: [
        {
          ...useClaudeChatStore.getState().tabs[0],
          runtimeModel: "gpt-5.6-terra",
        },
      ],
    });
    await renderProbe();

    await act(async () => {
      useProviderStore.setState({
        activeId: "chatgpt-official",
        models: [
          {
            id: "gpt-5.5",
            displayName: "GPT-5.5",
            reasoningEfforts: ["low", "medium", "high"],
            isDefault: true,
          },
          {
            id: "gpt-5.6-terra",
            displayName: "GPT-5.6 Terra",
            reasoningEfforts: ["low", "medium", "high", "xhigh"],
            isDefault: false,
          },
        ],
      });
      await Promise.resolve();
    });

    expect(useClaudeChatStore.getState().selectedModel).toBe("gpt-5.6-terra");
    expect(useClaudeChatStore.getState().tabs[0]?.runtimeModel).toBe(
      "gpt-5.6-terra",
    );
  });

  it("unsubscribes on unmount", async () => {
    await renderProbe();

    await act(async () => root.unmount());
    root = createRoot(container);
    useClaudeSetupStore.setState({ status: "checking", error: null });
    useClaudeSetupStore.setState({ status: "ready", error: null });
    expect(refresh).not.toHaveBeenCalled();
  });
});
