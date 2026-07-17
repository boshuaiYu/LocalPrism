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
  const login = useRuntimeStore((state) => state.login);
  const refresh = useRuntimeStore((state) => state.refresh);
  const install = useRuntimeStore((state) => state.install);
  const startLogin = useRuntimeStore((state) => state.startLogin);
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
        title="Claude / Claude-backed providers"
        description="Claude Code and OpenAI-compatible providers"
        account={accounts.claude}
        loading={loading.claude}
        onLogout={() =>
          consume(async () => {
            await logout("claude");
            await checkClaudeStatus();
          })
        }
      >
        <ClaudeSetup variant="embedded" />
      </RuntimeCard>

      <RuntimeCard
        title="Codex"
        description="OpenAI Codex runtime"
        account={accounts.codex}
        loading={loading.codex}
        login={login.codex}
        onInstall={() => consume(() => install("codex"))}
        onLogin={(mode, apiKey) =>
          consume(() => startLogin("codex", mode, apiKey))
        }
        onCancelLogin={() => consume(() => cancelLogin("codex"))}
        onLogout={() => consume(() => logout("codex"))}
        onOpenExternal={openAuthorizationPage}
      />
    </div>
  );
}
