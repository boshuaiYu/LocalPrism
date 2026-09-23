import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ConversationRef,
  RuntimeConversation,
  RuntimeKind,
} from "@/runtime/types";

const { runtimeListConversations, runtimeArchiveConversation } = vi.hoisted(
  () => ({
    runtimeListConversations: vi.fn(),
    runtimeArchiveConversation: vi.fn(),
  }),
);

vi.mock("@/runtime/commands", () => ({
  runtimeListConversations,
  runtimeArchiveConversation,
}));

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
      role="menuitem"
      aria-disabled={disabled ? "true" : "false"}
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

import { invoke } from "@tauri-apps/api/core";
import { SessionSelector } from "@/components/claude-chat/session-selector";
import { DISMISSED_FOREIGN_SESSIONS_KEY } from "@/lib/dismissed-foreign-sessions";
import { type TabState, useClaudeChatStore } from "@/stores/claude-chat-store";
import { useDocumentStore } from "@/stores/document-store";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function reference(
  runtime: RuntimeKind,
  projectPath: string,
  sessionId: string,
): ConversationRef {
  return { runtime, projectPath, sessionId };
}

function conversation(
  conversationReference: ConversationRef,
  title: string,
): RuntimeConversation {
  return {
    reference: conversationReference,
    title,
    status: "active",
    updatedAt: 1,
  };
}

function findButton(label: string): HTMLButtonElement {
  const button = document.querySelector(`button[aria-label="${label}"]`);
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${label}`);
  }
  return button;
}

function findDialogButton(label: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Dialog button not found: ${label}`);
  }
  return button;
}

function findMenuItem(title: string): HTMLElement {
  const titleNode = Array.from(document.querySelectorAll("span")).find(
    (candidate) => candidate.textContent === title,
  );
  const item = titleNode?.closest('[role="menuitem"]');
  if (!(item instanceof HTMLElement)) {
    throw new Error(`Menu item not found: ${title}`);
  }
  return item;
}

function setSearchQuery(value: string) {
  const input = document.querySelector('[aria-label="Search chats"]');
  if (!(input instanceof HTMLInputElement)) {
    throw new Error("Search chats input not found");
  }
  const assign = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  assign?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("SessionSelector runtime conversation ownership", () => {
  let container: HTMLDivElement;
  let root: Root;
  const originalNewSession = useClaudeChatStore.getState().newSession;
  const originalResumeConversation =
    useClaudeChatStore.getState().resumeConversation;

  beforeEach(() => {
    vi.clearAllMocks();
    runtimeListConversations.mockResolvedValue([]);
    runtimeArchiveConversation.mockResolvedValue(undefined);
    const baseTab = useClaudeChatStore.getState().tabs[0];
    const currentRef = reference("claude", "/project-a", "shared-session");
    const tab: TabState = {
      ...baseTab,
      id: "tab-a",
      title: "Current chat",
      runtime: currentRef.runtime,
      projectPath: currentRef.projectPath,
      sessionId: currentRef.sessionId,
      sessionRef: currentRef,
      isStreaming: false,
      cancelledAttempts: [],
    };
    useDocumentStore.setState({ projectRoot: currentRef.projectPath });
    useClaudeChatStore.setState({
      tabs: [tab],
      activeTabId: tab.id,
      activeProjectPath: currentRef.projectPath,
      sessionId: currentRef.sessionId,
      messages: [],
      isStreaming: false,
      newSession: originalNewSession,
      resumeConversation: originalResumeConversation,
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
      resumeConversation: originalResumeConversation,
      activeAccountKey: null,
      accountObserved: false,
    });
    localStorage.clear();
  });

  async function renderAndOpen() {
    await act(async () => root.render(<SessionSelector />));
    await act(async () => {
      findButton("Open test session menu").click();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function switchActiveContext(next: ConversationRef) {
    useDocumentStore.setState({ projectRoot: next.projectPath });
    useClaudeChatStore.setState((state) => {
      const current = state.tabs.find((tab) => tab.id === state.activeTabId);
      if (!current) return {};
      const tab = {
        ...current,
        runtime: next.runtime,
        projectPath: next.projectPath,
        sessionId: next.sessionId,
        sessionRef: next,
        isStreaming: false,
        cancelledAttempts: [],
      };
      return {
        tabs: state.tabs.map((candidate) =>
          candidate.id === tab.id ? tab : candidate,
        ),
        activeProjectPath: next.projectPath,
        sessionId: next.sessionId,
      };
    });
  }

  it("lists Claude chats and read-only Codex history for the current project", async () => {
    const listedCodex = reference("codex", "/project-a", "codex-session");
    const listedClaude = reference("claude", "/project-a", "claude-session");
    const resumeConversation = vi.fn();
    useClaudeChatStore.setState({ resumeConversation });
    runtimeListConversations.mockImplementation((runtime, projectPath) => {
      if (projectPath !== "/project-a") {
        return Promise.resolve([
          conversation(
            reference(runtime, projectPath, "other"),
            "Wrong project",
          ),
        ]);
      }
      if (runtime === "claude") {
        return Promise.resolve([
          conversation(listedClaude, "Claude session"),
          conversation(
            reference("codex", "/project-b", "codex-session"),
            "Wrong project",
          ),
        ]);
      }
      return Promise.resolve([conversation(listedCodex, "Codex session")]);
    });

    await renderAndOpen();

    expect(runtimeListConversations).toHaveBeenCalledWith(
      "claude",
      "/project-a",
    );
    expect(runtimeListConversations).toHaveBeenCalledWith(
      "codex",
      "/project-a",
    );
    expect(document.body.textContent).toContain("Claude session");
    expect(document.body.textContent).toContain("Codex session");
    expect(document.body.textContent).toContain("Read-only");
    expect(document.body.textContent).not.toContain("Wrong project");

    await act(async () => findMenuItem("Codex session").click());
    expect(resumeConversation).toHaveBeenCalledWith(
      listedCodex,
      "Codex session",
    );
  });

  it("ignores a late list after runtime and project ownership changes", async () => {
    const projectA = deferred<RuntimeConversation[]>();
    const projectB = deferred<RuntimeConversation[]>();
    runtimeListConversations.mockImplementation((_runtime, projectPath) =>
      projectPath === "/project-a" ? projectA.promise : projectB.promise,
    );

    await renderAndOpen();
    await act(async () => {
      switchActiveContext(reference("codex", "/project-b", "same-id"));
    });
    await act(async () => {
      findButton("Open test session menu").click();
      projectB.resolve([
        conversation(
          reference("codex", "/project-b", "same-id"),
          "Project B Codex",
        ),
      ]);
      await projectB.promise;
    });
    await act(async () => {
      projectA.resolve([
        conversation(
          reference("claude", "/project-a", "same-id"),
          "Project A stale",
        ),
      ]);
      await projectA.promise;
    });

    expect(document.body.textContent).toContain("Project B Codex");
    expect(document.body.textContent).not.toContain("Project A stale");
  });

  it("revalidates the active context before selecting a stale item", async () => {
    const listedRef = reference("claude", "/project-a", "other-session");
    const resumeConversation = vi.fn();
    useClaudeChatStore.setState({ resumeConversation });
    runtimeListConversations.mockResolvedValue([
      conversation(listedRef, "Old context session"),
    ]);
    await renderAndOpen();
    const staleItem = findMenuItem("Old context session");

    await act(async () => {
      switchActiveContext(reference("codex", "/project-b", "other-session"));
      staleItem.click();
      await Promise.resolve();
    });

    expect(resumeConversation).not.toHaveBeenCalled();
  });

  it("does not treat the same session id in another runtime as busy", async () => {
    const claudeRef = reference("claude", "/project-a", "shared-session");
    const codexBusyTab: TabState = {
      ...useClaudeChatStore.getState().tabs[0],
      id: "tab-codex",
      runtime: "codex",
      projectPath: "/project-a",
      sessionId: claudeRef.sessionId,
      sessionRef: { ...claudeRef, runtime: "codex" },
      isStreaming: true,
      activeAttemptId: "codex-attempt",
      cancelledAttempts: [],
    };
    useClaudeChatStore.setState((state) => ({
      tabs: [...state.tabs, codexBusyTab],
    }));
    runtimeListConversations.mockResolvedValue([
      conversation(claudeRef, "Claude same id"),
    ]);

    await renderAndOpen();

    expect(findButton("Delete Claude same id").disabled).toBe(false);
    expect(
      document.querySelector(
        'button[aria-label^="Cannot delete Claude same id"]',
      ),
    ).toBeNull();
  });

  it("switches to an existing busy conversation while keeping archive disabled", async () => {
    const listedRef = reference("claude", "/project-a", "busy-session");
    const baseTab = useClaudeChatStore.getState().tabs[0];
    const busyTab: TabState = {
      ...baseTab,
      id: "tab-busy",
      title: "Busy chat",
      runtime: listedRef.runtime,
      projectPath: listedRef.projectPath,
      sessionId: listedRef.sessionId,
      sessionRef: listedRef,
      isStreaming: true,
      cancelledAttempts: [],
    };
    const resumeConversation = vi.fn();
    useClaudeChatStore.setState((state) => ({
      tabs: [...state.tabs, busyTab],
      resumeConversation,
    }));
    runtimeListConversations.mockResolvedValue([
      conversation(listedRef, "Busy session"),
    ]);

    await renderAndOpen();

    const deleteButton = findButton(
      "Cannot delete Busy session while it is running or stopping",
    );
    expect(deleteButton.disabled).toBe(true);

    await act(async () => findMenuItem("Busy session").click());
    expect(resumeConversation).toHaveBeenCalledWith(listedRef, "Busy session");
  });

  it("permanently deletes Claude chat through the shared archive command", async () => {
    const target = reference("claude", "/project-a", "shared-session");
    const newSession = vi.fn();
    useClaudeChatStore.setState({ newSession });
    runtimeListConversations.mockResolvedValue([
      conversation(target, "Claude chat"),
    ]);
    await renderAndOpen();

    expect(findButton("Delete Claude chat").title).toBe("Delete chat");
    await act(async () => findButton("Delete Claude chat").click());
    expect(document.body.textContent).toContain("Delete Chat");
    expect(document.body.textContent?.toLowerCase()).toContain("permanently");

    await act(async () => {
      findDialogButton("Delete").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(runtimeArchiveConversation).toHaveBeenCalledWith(target);
    expect(newSession).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain("Claude chat");
  });

  it("archives Codex with rollout-safe copy and exact-reference identity", async () => {
    const target = reference("codex", "/project-a", "shared-session");
    switchActiveContext(target);
    const newSession = vi.fn();
    useClaudeChatStore.setState({ newSession });
    runtimeListConversations.mockResolvedValue([
      conversation(target, "Codex chat"),
    ]);
    await renderAndOpen();

    expect(findButton("Archive Codex chat").title).toBe("Archive chat");
    await act(async () => findButton("Archive Codex chat").click());
    expect(document.body.textContent).toContain("Archive Chat");
    expect(document.body.textContent).toContain(
      "Codex rollout files are not deleted",
    );

    await act(async () => {
      findDialogButton("Archive").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(runtimeArchiveConversation).toHaveBeenCalledWith(target);
    expect(newSession).toHaveBeenCalledTimes(1);
  });

  it("does not let a stale archive completion change a new context", async () => {
    const archive = deferred<void>();
    runtimeArchiveConversation.mockReturnValue(archive.promise);
    const oldRef = reference("claude", "/project-a", "shared-session");
    const newRef = reference("codex", "/project-b", "shared-session");
    const newSession = vi.fn();
    useClaudeChatStore.setState({ newSession });
    runtimeListConversations.mockImplementation((_runtime, projectPath) =>
      Promise.resolve([
        conversation(
          projectPath === "/project-a" ? oldRef : newRef,
          projectPath === "/project-a" ? "Old Claude" : "New Codex",
        ),
      ]),
    );
    await renderAndOpen();
    await act(async () => findButton("Delete Old Claude").click());
    await act(async () => findDialogButton("Delete").click());

    await act(async () => {
      switchActiveContext(newRef);
    });
    await act(async () => {
      findButton("Open test session menu").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      archive.resolve();
      await archive.promise;
    });

    expect(document.body.textContent).toContain("New Codex");
    expect(newSession).not.toHaveBeenCalled();
  });

  it("removes an archived reference after leaving and returning to its context", async () => {
    const archive = deferred<void>();
    runtimeArchiveConversation.mockReturnValue(archive.promise);
    const target = reference("claude", "/project-a", "shared-session");
    const otherContext = reference("codex", "/project-b", "other-session");
    const newSession = vi.fn();
    let projectAListCount = 0;
    useClaudeChatStore.setState({ newSession });
    runtimeListConversations.mockImplementation((runtime, projectPath) => {
      if (projectPath === "/project-a") {
        if (runtime === "codex") return Promise.resolve([]);
        projectAListCount += 1;
        return Promise.resolve([
          conversation(
            target,
            projectAListCount === 1 ? "Archive me" : "Archived stale row",
          ),
        ]);
      }
      return Promise.resolve([conversation(otherContext, "Other context")]);
    });

    await renderAndOpen();
    await act(async () => findButton("Delete Archive me").click());
    await act(async () => findDialogButton("Delete").click());

    await act(async () => switchActiveContext(otherContext));
    await act(async () => {
      findButton("Open test session menu").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => switchActiveContext(target));
    await act(async () => {
      findButton("Open test session menu").click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("Archived stale row");

    await act(async () => {
      archive.resolve();
      await archive.promise;
    });

    expect(document.body.textContent).not.toContain("Archived stale row");
    expect(newSession).not.toHaveBeenCalled();
  });

  it("does not let an in-flight list resurrect an archived reference", async () => {
    const target = reference("claude", "/project-a", "shared-session");
    const staleList = deferred<RuntimeConversation[]>();
    let listCount = 0;
    runtimeListConversations.mockImplementation((runtime) => {
      if (runtime === "codex") return Promise.resolve([]);
      listCount += 1;
      return listCount === 1
        ? Promise.resolve([conversation(target, "Archive me")])
        : staleList.promise;
    });
    await renderAndOpen();
    await act(async () => findButton("Delete Archive me").click());
    await act(async () => findDialogButton("Delete").click());
    await act(async () => findButton("Open test session menu").click());

    await act(async () => {
      staleList.resolve([conversation(target, "Resurrected")]);
      await staleList.promise;
    });

    expect(document.body.textContent).not.toContain("Resurrected");
    expect(document.body.textContent).toContain("No previous sessions");
  });

  it("falls back to the first user line or Untitled chat", async () => {
    const untitledRef = reference("claude", "/project-a", "empty-title");
    const firstLineRef = reference("claude", "/project-a", "first-line");
    const current = useClaudeChatStore.getState().tabs[0];
    useClaudeChatStore.setState({
      tabs: [
        {
          ...current,
          id: "tab-first-line",
          title: "New Chat",
          projectPath: firstLineRef.projectPath,
          sessionId: firstLineRef.sessionId,
          sessionRef: firstLineRef,
          messages: [
            {
              type: "user",
              message: {
                content: [{ type: "text", text: "Tighten the abstract" }],
              },
            },
          ],
        },
      ],
      activeTabId: "tab-first-line",
    });
    runtimeListConversations.mockImplementation((runtime) => {
      if (runtime === "codex") return Promise.resolve([]);
      return Promise.resolve([
        conversation(untitledRef, "   "),
        conversation(firstLineRef, "New Chat"),
      ]);
    });

    await renderAndOpen();

    expect(document.body.textContent).toContain("Untitled chat");
    expect(document.body.textContent).toContain("Tighten the abstract");
    expect(findButton("Delete Untitled chat")).toBeTruthy();
    expect(findButton("Delete Tighten the abstract")).toBeTruthy();
  });

  it("filters sessions by title search", async () => {
    runtimeListConversations.mockImplementation((runtime, projectPath) => {
      if (projectPath !== "/project-a") return Promise.resolve([]);
      if (runtime === "claude") {
        return Promise.resolve([
          conversation(
            reference("claude", "/project-a", "claude-session"),
            "Claude session",
          ),
        ]);
      }
      return Promise.resolve([
        conversation(
          reference("codex", "/project-a", "codex-session"),
          "Codex session",
        ),
      ]);
    });

    await renderAndOpen();
    await act(async () => {
      setSearchQuery("claude");
    });
    expect(document.body.textContent).toContain("Claude session");
    expect(document.body.textContent).not.toContain("Codex session");

    await act(async () => {
      setSearchQuery("missing-title");
    });
    expect(document.body.textContent).toContain("No matching chats");
  });

  it("groups chats by recency", async () => {
    const now = Date.now() / 1000;
    runtimeListConversations.mockImplementation((runtime) => {
      if (runtime === "codex") return Promise.resolve([]);
      return Promise.resolve([
        {
          ...conversation(
            reference("claude", "/project-a", "today-session"),
            "Today session",
          ),
          updatedAt: now,
        },
        {
          ...conversation(
            reference("claude", "/project-a", "old-session"),
            "Old session",
          ),
          updatedAt: now - 20 * 86_400,
        },
      ]);
    });

    await renderAndOpen();
    expect(document.body.textContent).toContain("Today");
    expect(document.body.textContent).toContain("Older");
    expect(document.body.textContent).toContain("Today session");
    expect(document.body.textContent).toContain("Old session");
  });

  it("still shows a delete error for a session owned by the signed-in account", async () => {
    const target = reference("claude", "/project-a", "locked-session");
    runtimeListConversations.mockResolvedValue([
      conversation(target, "Locked session"),
    ]);
    runtimeArchiveConversation.mockRejectedValue(new Error("file locked"));
    vi.mocked(invoke).mockResolvedValue(undefined);
    useClaudeChatStore.setState({
      accountObserved: true,
      activeAccountKey: "account-a",
    });
    await renderAndOpen();

    await act(async () => findButton("Delete Locked session").click());
    await act(async () => {
      findDialogButton("Delete").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain("file locked");
    expect(document.body.textContent).toContain("Locked session");
    expect(localStorage.getItem(DISMISSED_FOREIGN_SESSIONS_KEY)).toBeNull();
  });

  it("closes another account's session when the archive command fails", async () => {
    const target = reference("claude", "/project-a", "foreign-session");
    const baseTab = useClaudeChatStore.getState().tabs[0];
    useClaudeChatStore.setState({
      accountObserved: true,
      activeAccountKey: "account-b",
      tabs: [
        {
          ...baseTab,
          id: "tab-foreign",
          title: "Other account",
          projectPath: target.projectPath,
          runtime: target.runtime,
          sessionId: target.sessionId,
          sessionRef: target,
          openedUnderAccountKey: "account-a",
          isStreaming: true,
          streamingStartedAt: 1,
          activeAttemptId: "foreign-attempt",
          cancelledAttempts: [],
        },
      ],
      activeTabId: "tab-foreign",
      activeProjectPath: target.projectPath,
      isStreaming: true,
    });
    runtimeListConversations.mockResolvedValue([
      conversation(target, "Other account"),
    ]);
    runtimeArchiveConversation.mockRejectedValue(new Error("not your thread"));
    await renderAndOpen();

    const deleteButton = findButton("Delete Other account");
    expect(deleteButton.disabled).toBe(false);

    await act(async () => deleteButton.click());
    await act(async () => {
      findDialogButton("Delete").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.body.textContent).not.toContain("not your thread");
    expect(document.body.textContent).not.toContain("Other account");
    expect(
      useClaudeChatStore
        .getState()
        .tabs.some((tab) => tab.id === "tab-foreign"),
    ).toBe(false);
    expect(localStorage.getItem(DISMISSED_FOREIGN_SESSIONS_KEY)).toContain(
      "foreign-session",
    );

    await act(async () => root.unmount());
    root = createRoot(container);
    await renderAndOpen();
    expect(document.body.textContent).not.toContain("Other account");
  });
});
