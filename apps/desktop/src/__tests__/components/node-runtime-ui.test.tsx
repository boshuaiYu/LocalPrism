import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeRuntimeDialog } from "@/components/node-runtime-dialog";
import { NodeRuntimePrompt } from "@/components/node-runtime-prompt";
import { resetMockTauriEvents } from "@/__tests__/mocks/tauri";
import {
  NODE_RUNTIME_DECLINED_KEY,
  useNodeRuntimeStore,
} from "@/stores/node-runtime-store";

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    ...props
  }: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    "data-testid"?: string;
  }) => (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={props["data-testid"]}
    >
      {children}
    </button>
  ),
}));

function runtime(overrides: Record<string, unknown> = {}) {
  return {
    available: false,
    source: null,
    version: null,
    node_path: null,
    npx_path: null,
    managed_dir: null,
    ...overrides,
  };
}

describe("Node.js runtime UI", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetMockTauriEvents();
    localStorage.removeItem(NODE_RUNTIME_DECLINED_KEY);
    useNodeRuntimeStore.setState({
      status: "checking",
      source: null,
      version: null,
      nodePath: null,
      npxPath: null,
      managedDir: null,
      isInstalling: false,
      isRemoving: false,
      progress: null,
      error: null,
      promptDeclined: false,
    });
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "check_node_runtime") return runtime();
      return undefined;
    });
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
    document.body.querySelector("[data-slot='dialog-portal']")?.remove();
    resetMockTauriEvents();
  });

  async function renderPrompt() {
    await act(async () => {
      root.render(<NodeRuntimePrompt />);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("explains the private runtime and installs after confirmation", async () => {
    await renderPrompt();

    expect(document.body.textContent).toContain("Node.js is needed");
    expect(document.body.textContent).toContain(
      "does not change the system PATH",
    );

    const install = document.querySelector(
      '[data-testid="node-runtime-install"]',
    );
    if (!(install instanceof HTMLButtonElement)) {
      throw new Error("install button was not rendered");
    }
    await act(async () => {
      install.click();
      await Promise.resolve();
    });

    expect(vi.mocked(invoke)).toHaveBeenCalledWith("install_node_runtime");
  });

  it("does not nag again after the user declines", async () => {
    await renderPrompt();
    const decline = document.querySelector(
      '[data-testid="node-runtime-decline"]',
    );
    if (!(decline instanceof HTMLButtonElement)) {
      throw new Error("decline button was not rendered");
    }
    await act(async () => {
      decline.click();
    });

    expect(localStorage.getItem(NODE_RUNTIME_DECLINED_KEY)).toBe("true");
    expect(useNodeRuntimeStore.getState().promptDeclined).toBe(true);
    expect(
      document.querySelector('[data-testid="node-runtime-prompt"]'),
    ).toBeNull();

    await act(async () => {
      root.render(<NodeRuntimePrompt />);
      await Promise.resolve();
    });
    expect(
      document.querySelector('[data-testid="node-runtime-prompt"]'),
    ).toBeNull();
  });

  it("stays quiet when node and npx are already available", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "check_node_runtime") {
        return runtime({
          available: true,
          source: "system",
          version: "v22.14.0",
          node_path: "/usr/bin/node",
          npx_path: "/usr/bin/npx",
        });
      }
      return undefined;
    });

    await renderPrompt();

    expect(
      document.querySelector('[data-testid="node-runtime-prompt"]'),
    ).toBeNull();
  });

  it("shows managed status with reinstall and remove in the environment dialog", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "check_node_runtime") {
        return runtime({
          available: true,
          source: "managed",
          version: "v22.14.0",
          node_path: "/data/runtimes/node/bin/node",
          npx_path: "/data/runtimes/node/bin/npx",
          managed_dir: "/data/runtimes/node",
        });
      }
      return undefined;
    });

    await act(async () => {
      root.render(<NodeRuntimeDialog open onClose={() => undefined} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain("v22.14.0");
    expect(document.body.textContent).toContain("/data/runtimes/node/bin/node");
    expect(document.body.textContent).toContain("Private");
    expect(
      document.querySelector('[data-testid="node-runtime-reinstall"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="node-runtime-remove"]'),
    ).not.toBeNull();

    const remove = document.querySelector(
      '[data-testid="node-runtime-remove"]',
    );
    if (!(remove instanceof HTMLButtonElement)) {
      throw new Error("remove action was not rendered");
    }
    await act(async () => {
      remove.click();
      await Promise.resolve();
    });
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("remove_node_runtime");

    const reinstall = document.querySelector(
      '[data-testid="node-runtime-reinstall"]',
    );
    if (!(reinstall instanceof HTMLButtonElement)) {
      throw new Error("reinstall action was not rendered");
    }
    await act(async () => {
      reinstall.click();
      await Promise.resolve();
    });
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("install_node_runtime");
  });
});
