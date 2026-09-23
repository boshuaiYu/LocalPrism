import { type ComponentType, useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  CheckCircle2Icon,
  CircleIcon,
  DownloadIcon,
  Loader2Icon,
  SettingsIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { LinuxRuntimeNote } from "@/components/linux-runtime-note";
import { RuntimeSettings } from "@/components/runtime/runtime-settings";
import { areDefaultSkillPacksReady } from "@/lib/default-skill-packs";
import { skillPaperWorkflowGuidance } from "@/lib/skill-workflow-copy";
import { markWelcomeCompleted } from "@/lib/welcome";
import { cn } from "@/lib/utils";
import { useAgentStore } from "@/stores/agent-store";
import { useClaudeSetupStore } from "@/stores/claude-setup-store";
import { useProviderStore } from "@/stores/provider-store";
import { useSkillStore } from "@/stores/skill-store";
import { useUvSetupStore } from "@/stores/uv-setup-store";
import { LanguageSwitch } from "@/components/language-switch";
import { useI18n } from "@/lib/use-i18n";

interface SkillsStatus {
  installed: boolean;
  skill_count: number;
  location: string;
}

export function WelcomeWizard({ onComplete }: { onComplete?: () => void }) {
  const { t } = useI18n();
  const [dismissed, setDismissed] = useState(false);

  const finish = useCallback(() => {
    markWelcomeCompleted();
    setDismissed(true);
    onComplete?.();
  }, [onComplete]);

  if (dismissed) return null;

  return (
    <div
      data-testid="welcome-wizard"
      className="relative flex h-full flex-col overflow-hidden bg-background text-foreground"
    >
      <header className="relative z-10 flex h-[calc(48px+var(--titlebar-height))] shrink-0 items-center justify-between px-6 pt-[var(--titlebar-height)]">
        <div className="flex items-center gap-2">
          <div className="lp-mark flex size-8 items-center justify-center rounded-lg p-0.5">
            <div className="flex size-full items-center justify-center rounded-md bg-background">
              <img
                src="/icon-192.png"
                alt=""
                className="size-6 object-contain"
              />
            </div>
          </div>
          <div>
            <div className="font-semibold text-sm tracking-tight">
              LocalPrism
            </div>
            <div className="text-muted-foreground text-xs">
              {t("onboarding.welcomeSubtitle")}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <LanguageSwitch />
          <Button variant="ghost" className="h-8 px-3 text-xs" onClick={finish}>
            {t("onboarding.skip")}
          </Button>
        </div>
      </header>

      <main className="relative z-10 min-h-0 flex-1 overflow-y-auto px-6 pb-4">
        <SetupStep />
      </main>

      <footer className="relative z-10 flex shrink-0 items-center justify-end gap-3 border-border/60 border-t bg-background/80 px-6 py-4">
        <Button className="lp-primary-cta h-10 rounded-lg" onClick={finish}>
          {t("onboarding.getStarted")}
        </Button>
      </footer>
    </div>
  );
}

function SetupStep() {
  const { t } = useI18n();
  const uvStatus = useUvSetupStore((state) => state.status);
  const uvVersion = useUvSetupStore((state) => state.version);
  const uvInstalling = useUvSetupStore((state) => state.isInstalling);
  const uvError = useUvSetupStore((state) => state.error);
  const checkUv = useUvSetupStore((state) => state.checkStatus);
  const installUv = useUvSetupStore((state) => state.install);
  const finishUvInstall = useUvSetupStore((state) => state._finishInstall);

  const paperSpineSkills = useSkillStore((state) => state.skills);
  const skillError = useSkillStore((state) => state.error);
  const skillLoading = useSkillStore((state) => state.loading);
  const installingPackId = useSkillStore((state) => state.installingPackId);
  const refreshSkills = useSkillStore((state) => state.refresh);
  const ensurePaperSpineSkills = useSkillStore(
    (state) => state.ensurePaperSpineSkills,
  );
  const ensureDefaultSkillPacks = useSkillStore(
    (state) => state.ensureDefaultSkillPacks,
  );
  const agents = useAgentStore((state) => state.agents);
  const paperSpineReady = areDefaultSkillPacksReady(paperSpineSkills, agents);

  const runtimeReady = useProviderStore((state) => state.ready);
  const engineStatus = useClaudeSetupStore((state) => state.status);
  const engineInstalling = useClaudeSetupStore((state) => state.isInstalling);
  const engineError = useClaudeSetupStore((state) => state.error);
  const engineVersion = useClaudeSetupStore((state) => state.version);
  const ensureEngine = useClaudeSetupStore((state) => state.ensureEngine);
  const engineInstalled =
    engineStatus === "ready" || engineStatus === "not-authenticated";

  const [paperSpineInstalling, setPaperSpineInstalling] = useState(false);
  const [skillsStatus, setSkillsStatus] = useState<SkillsStatus | null>(null);
  const [showSkillsOnboarding, setShowSkillsOnboarding] = useState(false);
  const [OnboardingComponent, setOnboardingComponent] = useState<ComponentType<{
    onClose: () => void;
  }> | null>(null);

  const checkSkills = useCallback(async () => {
    try {
      const status = await invoke<SkillsStatus>("check_skills_installed", {
        projectPath: null,
      });
      setSkillsStatus(status);
    } catch {
      setSkillsStatus(null);
    }
  }, []);

  useEffect(() => {
    void checkUv();
    void refreshSkills();
    void checkSkills();
    void ensureEngine();
    void ensureDefaultSkillPacks().finally(() => {
      void checkSkills();
    });
  }, [
    checkSkills,
    checkUv,
    ensureDefaultSkillPacks,
    ensureEngine,
    refreshSkills,
  ]);

  useEffect(() => {
    const unlisten = listen<boolean>("uv-install-complete", (event) => {
      finishUvInstall(event.payload);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [finishUvInstall]);

  useEffect(() => {
    if (showSkillsOnboarding && !OnboardingComponent) {
      void import(
        "@/components/scientific-skills/scientific-skills-onboarding"
      ).then((mod) =>
        setOnboardingComponent(() => mod.ScientificSkillsOnboarding),
      );
    }
  }, [OnboardingComponent, showSkillsOnboarding]);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 py-2">
      <div className="text-center">
        <h1 className="font-semibold text-2xl tracking-tight">
          {t("env.installTitle")}
        </h1>
        <p className="mx-auto mt-2 max-w-xl text-muted-foreground text-sm leading-relaxed">
          {t("env.installLead")}
        </p>
        <p className="mx-auto mt-2 max-w-xl text-muted-foreground text-xs leading-relaxed">
          {skillPaperWorkflowGuidance()}
        </p>
      </div>

      <section className="overflow-hidden rounded-2xl border border-border/70 bg-background/80 shadow-sm">
        <SetupRow
          ok={uvStatus === "ready"}
          busy={uvInstalling || uvStatus === "checking"}
          label={t("env.pythonUv")}
          detail={
            uvInstalling
              ? t("env.installing")
              : uvStatus === "ready"
                ? (uvVersion ?? t("env.installed"))
                : uvStatus === "checking"
                  ? t("env.checking")
                  : (uvError ?? t("env.notInstalled"))
          }
          action={
            uvStatus === "not-installed" && !uvInstalling
              ? { label: t("env.install"), onClick: () => void installUv() }
              : uvInstalling
                ? { label: t("env.installing"), loading: true }
                : undefined
          }
        />
        <SetupRow
          ok={paperSpineReady}
          busy={paperSpineInstalling || skillLoading}
          label={t("env.paperSpine")}
          detail={
            paperSpineInstalling || skillLoading
              ? installingPackId
                ? t("env.installingNamed", { name: installingPackId })
                : t("env.installingPacks")
              : paperSpineReady
                ? t("env.packsInstalled")
                : (skillError ?? t("env.notInstalled"))
          }
          action={
            paperSpineInstalling || skillLoading
              ? { label: t("env.installing"), loading: true }
              : paperSpineReady
                ? undefined
                : {
                    label: t("env.install"),
                    onClick: () => {
                      setPaperSpineInstalling(true);
                      void ensurePaperSpineSkills().finally(() =>
                        setPaperSpineInstalling(false),
                      );
                    },
                  }
          }
        />
        <SetupRow
          ok={engineInstalled}
          busy={engineInstalling || engineStatus === "checking"}
          label={t("env.writingEngine")}
          detail={
            engineInstalling
              ? t("providers.installingCli")
              : engineInstalled
                ? (engineVersion ?? t("env.installed"))
                : engineStatus === "missing-git"
                  ? t("env.gitRequired")
                  : engineStatus === "checking"
                    ? t("env.checking")
                    : (engineError ?? t("env.notInstalled"))
          }
          action={
            engineInstalling
              ? { label: t("env.installing"), loading: true }
              : engineStatus === "not-installed"
                ? {
                    label: t("env.install"),
                    onClick: () => void ensureEngine(),
                  }
                : undefined
          }
        />
        <SetupRow
          ok={!!skillsStatus?.installed}
          label={t("env.scientificSkills")}
          detail={
            skillsStatus?.installed
              ? t("env.skillCount", { count: skillsStatus.skill_count })
              : t("env.optionalPacks")
          }
          action={{
            label: skillsStatus?.installed ? t("env.manage") : t("env.install"),
            icon: skillsStatus?.installed ? "settings" : "download",
            onClick: () => setShowSkillsOnboarding(true),
          }}
        />
        <SetupRow
          ok={runtimeReady}
          label={t("env.modelProvider")}
          detail={runtimeReady ? t("env.ready") : t("env.apiOrOfficial")}
        />
      </section>

      <LinuxRuntimeNote />

      <section className="overflow-hidden rounded-2xl border border-border/70 bg-background/80 shadow-sm">
        <div className="border-border/60 border-b px-5 py-3">
          <h2 className="font-medium text-sm">{t("env.addApiKey")}</h2>
          <p className="mt-1 text-lp-meta text-xs">{t("env.addApiKeyHelp")}</p>
        </div>
        <RuntimeSettings refreshOnMount showEngine={false} />
      </section>

      {showSkillsOnboarding && OnboardingComponent && (
        <OnboardingComponent
          onClose={() => {
            setShowSkillsOnboarding(false);
            void checkSkills();
            void refreshSkills();
          }}
        />
      )}
    </div>
  );
}

function SetupRow({
  ok,
  busy = false,
  label,
  detail,
  action,
}: {
  ok: boolean;
  busy?: boolean;
  label: string;
  detail: string;
  action?: {
    label: string;
    onClick?: () => void;
    loading?: boolean;
    icon?: "download" | "settings";
  };
}) {
  return (
    <div className="flex min-h-14 min-w-0 items-center gap-3 border-border/60 border-b px-4 py-3 last:border-b-0">
      <div
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-md border",
          ok
            ? "border-green-500/20 bg-green-500/10 text-green-600"
            : "border-border/70 bg-muted/30 text-muted-foreground",
        )}
      >
        {busy ? (
          <Loader2Icon className="size-3.5 animate-spin" />
        ) : ok ? (
          <CheckCircle2Icon className="size-3.5" />
        ) : (
          <CircleIcon className="size-3.5" />
        )}
      </div>
      <div className="flex min-w-0 flex-1 items-baseline gap-3">
        <span
          className={cn(
            "w-36 shrink-0 truncate font-medium text-sm",
            ok ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {label}
        </span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs">
          {detail}
        </span>
      </div>
      {action && (
        <Button
          variant="outline"
          size="sm"
          className="h-8 shrink-0 rounded-md px-2.5 text-xs"
          onClick={action.onClick}
          disabled={action.loading}
        >
          {action.loading ? (
            <Loader2Icon className="size-3 animate-spin" />
          ) : action.icon === "settings" ? (
            <SettingsIcon className="size-3" />
          ) : (
            <DownloadIcon className="size-3" />
          )}
          {action.label}
        </Button>
      )}
    </div>
  );
}
