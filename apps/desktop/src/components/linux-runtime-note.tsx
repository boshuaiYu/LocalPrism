import { LINUX_RUNTIME_DEPS, isLinuxDesktop } from "@/lib/linux-runtime-deps";

export function LinuxRuntimeNote() {
  if (
    typeof navigator === "undefined" ||
    !isLinuxDesktop(navigator.userAgent)
  ) {
    return null;
  }

  return (
    <aside
      data-testid="linux-runtime-note"
      className="lp-panel rounded-xl border px-4 py-3 text-left"
    >
      <h2 className="font-medium text-sm">Linux libraries</h2>
      <p className="mt-1 text-lp-meta text-xs leading-relaxed">
        {LINUX_RUNTIME_DEPS.summary}
      </p>
      <p className="mt-2 font-mono text-lp-meta text-xs">
        {LINUX_RUNTIME_DEPS.debianInstall}
      </p>
    </aside>
  );
}
