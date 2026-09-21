import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open as shellOpen } from "@tauri-apps/plugin-shell";

export type ProviderKind =
  | "official-claude"
  | "official-chatgpt"
  | "third-party";
export type ProviderApiFormat =
  | "anthropic"
  | "openai_chat"
  | "openai_responses";

export interface ProviderCard {
  id: string;
  kind: ProviderKind;
  name: string;
  authenticated: boolean;
  isActive: boolean;
  accountLabel: string | null;
}

export interface ProviderModel {
  id: string;
  displayName: string;
  reasoningEfforts: string[];
  isDefault: boolean;
  contextWindow?: number | null;
}

export interface ProviderWorkspaceStatus {
  engineInstalled: boolean;
  engineVersion: string | null;
  missingGit: boolean;
  activeId: string | null;
  activeAuthenticated: boolean;
  ready: boolean;
  cards: ProviderCard[];
  models: ProviderModel[];
}

export interface SavedProviderInput {
  id?: string;
  name: string;
  apiKey: string;
  baseUrl: string;
  apiFormat?: ProviderApiFormat;
  models: {
    main: string;
    haiku?: string;
    sonnet?: string;
    opus?: string;
  };
}

export function isWorkspaceAiReady(status: {
  engineInstalled: boolean;
  activeAuthenticated: boolean;
}): boolean {
  return status.engineInstalled && status.activeAuthenticated;
}

const emptyStatus = (): ProviderWorkspaceStatus => ({
  engineInstalled: false,
  engineVersion: null,
  missingGit: false,
  activeId: null,
  activeAuthenticated: false,
  ready: false,
  cards: [],
  models: [],
});

interface ProviderState extends ProviderWorkspaceStatus {
  loading: boolean;
  oauthBusy: "claude" | "chatgpt" | null;
  oauthUrl: string | null;
  error: string | null;
  refresh: () => Promise<void>;
  activate: (id: string) => Promise<void>;
  upsertThirdParty: (
    provider: SavedProviderInput,
    activate?: boolean,
  ) => Promise<void>;
  remove: (id: string) => Promise<void>;
  startOAuth: (kind: "claude" | "chatgpt") => Promise<void>;
  logout: (kind: "claude" | "chatgpt") => Promise<void>;
}

let oauthUnlisten: UnlistenFn | null = null;

async function ensureOAuthListener(): Promise<void> {
  if (oauthUnlisten) return;
  oauthUnlisten = await listen<{ kind?: string; ok?: boolean; error?: string }>(
    "provider-oauth-complete",
    (event) => {
      const payload = event.payload;
      useProviderStore.setState({
        oauthBusy: null,
        oauthUrl: null,
        error: payload?.ok ? null : (payload?.error ?? "Sign-in failed"),
      });
      void useProviderStore.getState().refresh();
    },
  );
}

export const useProviderStore = create<ProviderState>((set) => ({
  ...emptyStatus(),
  loading: false,
  oauthBusy: null,
  oauthUrl: null,
  error: null,

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      await ensureOAuthListener();
      const status = await invoke<ProviderWorkspaceStatus>("provider_status");
      set({ ...status, loading: false });
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

  activate: async (id) => {
    set({ error: null });
    const status = await invoke<ProviderWorkspaceStatus>("provider_activate", {
      id,
    });
    set(status);
  },

  upsertThirdParty: async (provider, activate = true) => {
    set({ error: null });
    const status = await invoke<ProviderWorkspaceStatus>(
      "provider_upsert_third_party",
      {
        provider: {
          id: provider.id ?? "",
          name: provider.name,
          apiKey: provider.apiKey,
          baseUrl: provider.baseUrl,
          apiFormat: provider.apiFormat ?? "openai_chat",
          models: provider.models,
        },
        activate,
      },
    );
    set(status);
  },

  remove: async (id) => {
    const status = await invoke<ProviderWorkspaceStatus>("provider_delete", {
      id,
    });
    set(status);
  },

  startOAuth: async (kind) => {
    set({ oauthBusy: kind, error: null, oauthUrl: null });
    try {
      await ensureOAuthListener();
      const start = await invoke<{ authUrl: string; loginId: string }>(
        "provider_oauth_start",
        { kind },
      );
      set({ oauthUrl: start.authUrl });
      try {
        await shellOpen(start.authUrl);
      } catch {
        // User can copy the URL from the card.
      }
    } catch (error) {
      set({
        oauthBusy: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

  logout: async (kind) => {
    const status = await invoke<ProviderWorkspaceStatus>(
      "provider_oauth_logout",
      { kind },
    );
    set({ ...status, oauthBusy: null, oauthUrl: null });
  },
}));

export function resetProviderStoreForTests(): void {
  useProviderStore.setState({
    ...emptyStatus(),
    loading: false,
    oauthBusy: null,
    oauthUrl: null,
    error: null,
  });
}

export function selectedProviderModel(
  models: readonly ProviderModel[],
  selectedId: string | null,
): ProviderModel | null {
  if (selectedId) {
    return models.find((model) => model.id === selectedId) ?? null;
  }
  return models.find((model) => model.isDefault) ?? models[0] ?? null;
}

/** Prefer a catalog id so ChatGPT Official never inherits the Claude `opus` default. */
export function resolveProviderRequestModel(
  requested: string | null | undefined,
  models: readonly ProviderModel[],
): string | null {
  const trimmed = requested?.trim() || null;
  if (models.length === 0) {
    return trimmed;
  }
  if (trimmed && models.some((model) => model.id === trimmed)) {
    return trimmed;
  }
  return (
    models.find((model) => model.isDefault)?.id ?? models[0]?.id ?? trimmed
  );
}
