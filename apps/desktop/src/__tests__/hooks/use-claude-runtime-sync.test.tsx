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
import { useClaudeSetupStore } from "@/stores/claude-setup-store";
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

  beforeEach(() => {
    resetRuntimeStoreForTests();
    refresh = vi.fn<RuntimeState["refresh"]>().mockResolvedValue(undefined);
    useRuntimeStore.setState({ refresh });
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

  it("unsubscribes on unmount", async () => {
    await renderProbe();

    await act(async () => root.unmount());
    root = createRoot(container);
    useClaudeSetupStore.setState({ status: "checking", error: null });
    useClaudeSetupStore.setState({ status: "ready", error: null });
    expect(refresh).not.toHaveBeenCalled();
  });
});
