import { useUpdateStore } from "@/stores/update-store";

/** Shared updater state. Download stays in the background until restart. */
export function useUpdater() {
  const status = useUpdateStore((state) => state.status);
  const checkForUpdate = useUpdateStore((state) => state.checkForUpdate);
  const applyUpdate = useUpdateStore((state) => state.applyUpdate);
  return { status, checkForUpdate, installUpdate: applyUpdate };
}
