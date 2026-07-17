import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({
    children,
    onOpenChange,
  }: {
    children: ReactNode;
    onOpenChange?: (open: boolean) => void;
  }) => (
    <div>
      <button
        type="button"
        aria-label="Open test session menu"
        onClick={() => onOpenChange?.(true)}
      />
      {children}
    </div>
  ),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => children,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    disabled,
    onSelect,
  }: {
    children: ReactNode;
    disabled?: boolean;
    onSelect?: () => void;
  }) => (
    <div
      data-disabled={disabled ? "true" : "false"}
      onClick={() => !disabled && onSelect?.()}
    >
      {children}
    </div>
  ),
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogDescription: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogFooter: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { SessionSelector } from "@/components/claude-chat/session-selector";
import { useClaudeChatStore } from "@/stores/claude-chat-store";
import { useDocumentStore } from "@/stores/document-store";

interface SessionInfo {
  session_id: string;
  title: string;
  last_modified: number;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function session(sessionId: string, title: string): SessionInfo {
  return { session_id: sessionId, title, last_modified: 1 };
}

function findButton(label: string): HTMLButtonElement {
  const button = document.querySelector(`button[aria-label="${label}"]`);
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${label}`);
  }
  return button;
}

describe("SessionSelector concurrency guards", () => {
  let container: HTMLDivElement;
  let root: Root;
  const originalNewSession = useClaudeChatStore.getState().newSession;
  const originalSetSessionTitle =
    useClaudeChatStore.getState()._setSessionTitle;

  beforeEach(() => {
    vi.clearAllMocks();
    const baseTab = useClaudeChatStore.getState().tabs[0];
    useDocumentStore.setState({ projectRoot: "/project-a" });
    useClaudeChatStore.setState({
      tabs: [
        {
          ...baseTab,
          id: "tab-a",
          projectPath: "/project-a",
          sessionId: "shared-session",
          sessionRef: {
            runtime: "claude",
            projectPath: "/project-a",
            sessionId: "shared-session",
          },
          isStreaming: false,
          cancelledAttempts: [],
        },
      ],
      activeTabId: "tab-a",
      activeProjectPath: "/project-a",
      sessionId: "shared-session",
      messages: [],
      isStreaming: false,
      newSession: originalNewSession,
      _setSessionTitle: originalSetSessionTitle,
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
    useClaudeChatStore.setState({
      newSession: originalNewSession,
      _setSessionTitle: originalSetSessionTitle,
    });
  });

  async function renderAndOpen() {
    await act(async () => root.render(<SessionSelector />));
    await act(async () => {
      findButton("Open test session menu").click();
      await Promise.resolve();
    });
  }

  it("disables deletion with an accessible hint while a session is stopping", async () => {
    useClaudeChatStore.setState((state) => ({
      tabs: state.tabs.map((tab) => ({
        ...tab,
        activeAttemptId: "attempt-a",
        cancelledAttempts: [
          {
            attemptId: "attempt-a",
            attemptEpoch: 1,
            runtime: "claude" as const,
            mode: "terminate" as const,
          },
        ],
      })),
    }));
    vi.mocked(invoke).mockResolvedValue([
      session("shared-session", "Stopping session"),
    ] as never);

    await renderAndOpen();

    const deleteButton = findButton(
      "Cannot delete Stopping session while it is running or stopping",
    );
    expect(deleteButton.disabled).toBe(true);
    expect(deleteButton.title).toContain("running or stopping");
  });

  it("keeps the newer project list when an older list request resolves last", async () => {
    const projectA = deferred<SessionInfo[]>();
    const projectB = deferred<SessionInfo[]>();
    vi.mocked(invoke).mockImplementation((command, args: any) => {
      if (command !== "list_claude_sessions") return Promise.resolve() as any;
      return (
        args.projectPath === "/project-a" ? projectA.promise : projectB.promise
      ) as any;
    });

    await renderAndOpen();
    await act(async () => {
      useDocumentStore.setState({ projectRoot: "/project-b" });
    });
    await act(async () => {
      findButton("Open test session menu").click();
      projectB.resolve([session("shared-session", "Project B session")]);
      await projectB.promise;
    });
    await act(async () => {
      projectA.resolve([session("shared-session", "Project A stale")]);
      await projectA.promise;
    });

    expect(document.body.textContent).toContain("Project B session");
    expect(document.body.textContent).not.toContain("Project A stale");
  });

  it("ignores a delete completion after the project owner changes", async () => {
    const deletion = deferred<void>();
    const newSession = vi.fn();
    useClaudeChatStore.setState({ newSession });
    vi.mocked(invoke).mockImplementation((command, args: any) => {
      if (command === "list_claude_sessions") {
        const title =
          args.projectPath === "/project-a"
            ? "Project A session"
            : "Project B session";
        return Promise.resolve([session("shared-session", title)]) as any;
      }
      if (command === "delete_claude_session") return deletion.promise as any;
      return Promise.resolve() as any;
    });

    await renderAndOpen();
    await act(async () => findButton("Delete Project A session").click());
    const dialogDelete = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Delete",
    );
    if (!(dialogDelete instanceof HTMLButtonElement)) {
      throw new Error("Dialog delete button not found");
    }
    await act(async () => dialogDelete.click());

    await act(async () => {
      useDocumentStore.setState({ projectRoot: "/project-b" });
      useClaudeChatStore.setState({
        activeProjectPath: "/project-b",
        sessionId: "shared-session",
      });
    });
    await act(async () => {
      findButton("Open test session menu").click();
      await Promise.resolve();
    });
    await act(async () => {
      deletion.resolve();
      await deletion.promise;
    });

    expect(document.body.textContent).toContain("Project B session");
    expect(newSession).not.toHaveBeenCalled();
  });

  it("does not let an in-flight list resurrect a session deleted on the same project", async () => {
    const staleList = deferred<SessionInfo[]>();
    const deletion = deferred<void>();
    let listCount = 0;
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "list_claude_sessions") {
        listCount += 1;
        return (
          listCount === 1
            ? Promise.resolve([session("shared-session", "Delete me")])
            : staleList.promise
        ) as any;
      }
      if (command === "delete_claude_session") return deletion.promise as any;
      return Promise.resolve() as any;
    });

    await renderAndOpen();
    await act(async () => findButton("Delete Delete me").click());
    const dialogDelete = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Delete",
    );
    if (!(dialogDelete instanceof HTMLButtonElement)) {
      throw new Error("Dialog delete button not found");
    }
    await act(async () => dialogDelete.click());
    await act(async () => findButton("Open test session menu").click());

    await act(async () => {
      deletion.resolve();
      await deletion.promise;
    });
    await act(async () => {
      staleList.resolve([session("shared-session", "Resurrected")]);
      await staleList.promise;
    });

    expect(document.body.textContent).not.toContain("Resurrected");
    expect(document.body.textContent).toContain("No previous sessions");
  });
});
