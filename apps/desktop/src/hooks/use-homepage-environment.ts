import { useEffect, useState } from "react";
import { areDefaultSkillPacksReady } from "@/lib/default-skill-packs";
import { useAgentStore } from "@/stores/agent-store";
import { useSkillStore } from "@/stores/skill-store";
import { useUvSetupStore } from "@/stores/uv-setup-store";

export type PaperSpineBootstrapStatus =
  | "idle"
  | "checking"
  | "installing"
  | "ready"
  | "error";

let bootstrapInFlight: Promise<void> | null = null;

export function resetHomepageEnvironmentBootstrapForTests() {
  bootstrapInFlight = null;
}

async function bootstrapHomepageEnvironment(): Promise<void> {
  const uv = useUvSetupStore.getState();
  await uv.checkStatus();
  if (useUvSetupStore.getState().status === "not-installed") {
    await uv.install();
  }

  const skills = useSkillStore.getState();
  await skills.ensureDefaultSkillPacks();
}

export function useHomepageEnvironment() {
  const uvStatus = useUvSetupStore((state) => state.status);
  const uvInstalling = useUvSetupStore((state) => state.isInstalling);
  const uvVersion = useUvSetupStore((state) => state.version);
  const uvError = useUvSetupStore((state) => state.error);
  const skills = useSkillStore((state) => state.skills);
  const skillError = useSkillStore((state) => state.error);
  const skillLoading = useSkillStore((state) => state.loading);
  const agents = useAgentStore((state) => state.agents);
  const defaultReady = areDefaultSkillPacksReady(skills, agents);
  const [paperSpine, setPaperSpine] =
    useState<PaperSpineBootstrapStatus>("idle");

  useEffect(() => {
    let cancelled = false;
    setPaperSpine((current) => (current === "ready" ? current : "checking"));

    if (!bootstrapInFlight) {
      bootstrapInFlight = bootstrapHomepageEnvironment().finally(() => {
        bootstrapInFlight = null;
      });
    }

    void bootstrapInFlight
      .then(() => {
        if (cancelled) return;
        const ready = areDefaultSkillPacksReady(
          useSkillStore.getState().skills,
          useAgentStore.getState().agents,
        );
        setPaperSpine(ready ? "ready" : "error");
      })
      .catch(() => {
        if (!cancelled) setPaperSpine("error");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (skillLoading) {
      setPaperSpine((current) =>
        current === "ready" ? current : "installing",
      );
    } else if (defaultReady) {
      setPaperSpine("ready");
    }
  }, [defaultReady, skillLoading]);

  return {
    uvStatus,
    uvInstalling,
    uvVersion,
    uvError,
    paperSpine,
    paperSpineError: skillError,
    paperSpineInstalled: defaultReady,
  };
}
