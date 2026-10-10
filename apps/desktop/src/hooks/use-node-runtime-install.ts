import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useNodeRuntimeStore } from "@/stores/node-runtime-store";

export function useNodeRuntimeInstallListener() {
  const finishInstall = useNodeRuntimeStore((state) => state._finishInstall);
  const setProgress = useNodeRuntimeStore((state) => state._setProgress);

  useEffect(() => {
    const output = listen<string>("node-runtime-install-output", (event) => {
      setProgress(event.payload);
    });
    const complete = listen<boolean>(
      "node-runtime-install-complete",
      (event) => {
        finishInstall(event.payload);
      },
    );
    return () => {
      void output.then((unsubscribe) => unsubscribe());
      void complete.then((unsubscribe) => unsubscribe());
    };
  }, [finishInstall, setProgress]);
}
