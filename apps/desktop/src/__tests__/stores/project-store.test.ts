import { beforeEach, describe, expect, it, vi } from "vitest";

const ensureProjectAgentsMd = vi.hoisted(() => vi.fn());

vi.mock("@/lib/project-agents-md", () => ({
  ensureProjectAgentsMd: (...args: unknown[]) => ensureProjectAgentsMd(...args),
}));

import { useProjectStore } from "@/stores/project-store";

describe("useProjectStore", () => {
  beforeEach(() => {
    // Reset the store between tests
    useProjectStore.setState({
      recentProjects: [],
      lastProjectFolder: null,
    });
  });

  describe("addRecentProject", () => {
    it("adds a project with extracted name", () => {
      useProjectStore.getState().addRecentProject("/Users/dev/my-thesis");
      const { recentProjects } = useProjectStore.getState();
      expect(recentProjects).toHaveLength(1);
      expect(recentProjects[0].path).toBe("/Users/dev/my-thesis");
      expect(recentProjects[0].name).toBe("my-thesis");
    });

    it("moves duplicate to front and deduplicates", () => {
      const store = useProjectStore.getState();
      store.addRecentProject("/a");
      store.addRecentProject("/b");
      store.addRecentProject("/a");
      const { recentProjects } = useProjectStore.getState();
      expect(recentProjects).toHaveLength(2);
      expect(recentProjects[0].path).toBe("/a");
      expect(recentProjects[1].path).toBe("/b");
    });

    it("normalizes trailing separators when deduplicating", () => {
      const store = useProjectStore.getState();
      store.addRecentProject("C:\\Projects\\LocalPrism\\paper\\");
      store.addRecentProject("C:\\Projects\\LocalPrism\\paper");
      const { recentProjects } = useProjectStore.getState();
      expect(recentProjects).toHaveLength(1);
      expect(recentProjects[0]).toMatchObject({
        path: "C:\\Projects\\LocalPrism\\paper",
        name: "paper",
      });
    });

    it("limits to MAX_RECENT (10) entries", () => {
      const store = useProjectStore.getState();
      for (let i = 0; i < 12; i++) {
        store.addRecentProject(`/project-${i}`);
      }
      const { recentProjects } = useProjectStore.getState();
      expect(recentProjects).toHaveLength(10);
      // Most recent should be first
      expect(recentProjects[0].path).toBe("/project-11");
    });

    it("extracts name from path correctly", () => {
      useProjectStore.getState().addRecentProject("/a/b/c/deep-folder");
      expect(useProjectStore.getState().recentProjects[0].name).toBe(
        "deep-folder",
      );
    });

    it("uses full path as name if no segments", () => {
      useProjectStore.getState().addRecentProject("standalone");
      expect(useProjectStore.getState().recentProjects[0].name).toBe(
        "standalone",
      );
    });
  });

  describe("removeRecentProject", () => {
    it("removes a project by path", () => {
      const store = useProjectStore.getState();
      store.addRecentProject("/a");
      store.addRecentProject("/b");
      store.removeRecentProject("/a");
      const { recentProjects } = useProjectStore.getState();
      expect(recentProjects).toHaveLength(1);
      expect(recentProjects[0].path).toBe("/b");
    });
  });

  describe("renameRecentProject", () => {
    it("replaces the old recent project path with the new folder path", () => {
      const store = useProjectStore.getState();
      store.addRecentProject("/work/old");
      store.addRecentProject("/work/other");
      store.renameRecentProject("/work/old", "/work/new");

      const { recentProjects } = useProjectStore.getState();
      expect(recentProjects[0]).toMatchObject({
        path: "/work/new",
        name: "new",
      });
      expect(
        recentProjects.some((project) => project.path === "/work/old"),
      ).toBe(false);
      expect(
        recentProjects.some((project) => project.path === "/work/other"),
      ).toBe(true);
    });

    it("matches renamed paths even when the old recent path has a trailing slash", () => {
      const store = useProjectStore.getState();
      store.addRecentProject("/work/old/");
      store.renameRecentProject("/work/old", "/work/new/");

      const { recentProjects } = useProjectStore.getState();
      expect(recentProjects).toHaveLength(1);
      expect(recentProjects[0]).toMatchObject({
        path: "/work/new",
        name: "new",
      });
    });
  });

  describe("enableCodexAgentsMd", () => {
    beforeEach(() => {
      ensureProjectAgentsMd.mockReset();
      ensureProjectAgentsMd.mockResolvedValue("created");
    });

    it("creates AGENTS.md when enabling Codex later", async () => {
      const reason = await useProjectStore
        .getState()
        .enableCodexAgentsMd("/work/paper/");

      expect(ensureProjectAgentsMd).toHaveBeenCalledWith("/work/paper", true);
      expect(reason).toBe("created");
    });

    it("surfaces exists when AGENTS.md is already present", async () => {
      ensureProjectAgentsMd.mockResolvedValueOnce("exists");
      const reason = await useProjectStore
        .getState()
        .enableCodexAgentsMd("/work/paper");
      expect(reason).toBe("exists");
    });
  });
});
