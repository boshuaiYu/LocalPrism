import { useEffect } from "react";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { toast } from "sonner";
import { ClaudeSetup } from "@/components/claude-setup";
import { RuntimeCard } from "@/components/runtime/runtime-card";
import { useClaudeSetupStore } from "@/stores/claude-setup-store";
import { useRuntimeStore } from "@/stores/runtime-store";

async function consume(
  action: () => Promise<unknown> | unknown,
): Promise<void> {
  try {
    await action();
  } catch {
    // Runtime stores own the user-facing error state.
  }
}

async function openAuthorizationPage(url: string): Promise<void> {
  try {
    await shellOpen(url);
  } catch {
    toast.error("Could not open authorization page", {
      description: "Copy the URL and open it manually.",
    });
  }
}

export interface RuntimeSettingsProps {
  refreshOnMount?: boolean;
}

export function RuntimeSettings({
  refreshOnMount = true,
}: RuntimeSettingsProps) {
  const accounts = useRuntimeStore((state) => state.accounts);
  const loading = useRuntimeStore((state) => state.loading);
  const installInFlight = useRuntimeStore((state) => state.installInFlight);
  const login = useRuntimeStore((state) => state.login);
  const refresh = useRuntimeStore((state) => state.refresh);
  const install = useRuntimeStore((state) => state.install);
  const startLogin = useRuntimeStore((state) => state.startLogin);
  const ensureInstalledAndStartLogin = useRuntimeStore(
    (state) => state.ensureInstalledAndStartLogin,
  );
  const codexSetupFlow = useRuntimeStore((state) => state.codexSetupFlow);
  const resetCodexSetupFlow = useRuntimeStore(
    (state) => state.resetCodexSetupFlow,
  );
  const cancelLogin = useRuntimeStore((state) => state.cancelLogin);
  const logout = useRuntimeStore((state) => state.logout);
  const checkClaudeStatus = useClaudeSetupStore((state) => state.checkStatus);

  useEffect(() => {
    if (!refreshOnMount) return;
    void consume(() => refresh());
  }, [refresh, refreshOnMount]);

  return (
    <div className="space-y-5 p-5">
      <RuntimeCard
        sectionId="claude"
        title="Claude"
        description="Claude Code login and Anthropic / Claude-compatible API keys"
        account={accounts.claude}
        loading={loading.claude}
        installInFlight={installInFlight.claude}
        onLogout={() =>
          consume(async () => {
            await logout("claude");
            await checkClaudeStatus();
          })
        }
      >
        <ClaudeSetup variant="embedded" scope="claude" />
      </RuntimeCard>

      <RuntimeCard
        sectionId="codex"
        title="Codex"
        description="ChatGPT login or your own OpenAI / Codex API key"
        account={accounts.codex}
        loading={loading.codex}
        installInFlight={installInFlight.codex}
        login={login.codex}
        setupFlow={codexSetupFlow}
        onInstall={() =>
          consume(async () => {
            resetCodexSetupFlow();
            await install("codex");
          })
        }
        onLogin={(mode, apiKey) =>
          consume(() =>
            mode === "api-key"
              ? startLogin("codex", mode, apiKey)
              : ensureInstalledAndStartLogin("codex", mode),
          )
        }
        onCancelLogin={() => consume(() => cancelLogin("codex"))}
        onLogout={() => consume(() => logout("codex"))}
        onOpenExternal={openAuthorizationPage}
      />

      <RuntimeCard
        sectionId="third-party"
        title="Third-party API"
        description="OpenAI-compatible and Anthropic-compatible providers (SiliconFlow, DeepSeek, Xiaomi, Qwen, …)"
        account={accounts.claude}
        loading={loading.claude}
      >
        <ClaudeSetup variant="embedded" scope="third-party" />
      </RuntimeCard>
    </div>
  );
}
