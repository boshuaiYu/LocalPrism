import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BotIcon } from "lucide-react";
import { useAgentStore } from "@/stores/agent-store";
import {
  PRODUCT_TOUR_EVENT,
  applyProductTourCue,
  initialTourWorkspaceChrome,
  type ProductTourCue,
} from "@/lib/product-tour";
import { useI18n } from "@/lib/use-i18n";
import { cn } from "@/lib/utils";
import {
  wireRuntimeFromPeer,
  type AgentProfile,
  type ChatRuntimePeer,
  type RuntimeKind,
} from "@/runtime/types";

export interface AgentSelectorProps {
  peer: ChatRuntimePeer;
  projectPath?: string | null;
  agentId: string | null;
  busy?: boolean;
  variant?: "select" | "pill";
  /** Called with the selected agent profile, or null for Default. */
  onAgentChange: (agent: AgentProfile | null) => void;
}

export function AgentSelector({
  peer,
  projectPath,
  agentId,
  busy = false,
  variant = "select",
  onAgentChange,
}: AgentSelectorProps) {
  const { t } = useI18n();
  const runtime: RuntimeKind = wireRuntimeFromPeer(peer);
  const agents = useAgentStore((state) => state.agents);
  const loading = useAgentStore((state) => state.loading);
  const refresh = useAgentStore((state) => state.refresh);

  useEffect(() => {
    void refresh(runtime, projectPath ?? undefined);
  }, [runtime, projectPath, refresh]);

  const options = useMemo(
    () => (agents ?? []).filter((agent) => agent.runtime === runtime),
    [agents, runtime],
  );

  const selected = options.find((agent) => agent.id === agentId) ?? null;
  const [open, setOpen] = useState(false);
  const menuOpenRef = useRef(open);
  menuOpenRef.current = open;
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onTourCue = (event: Event) => {
      const cue = (event as CustomEvent<ProductTourCue>).detail;
      const next = applyProductTourCue(
        initialTourWorkspaceChrome({ agentMenuOpen: menuOpenRef.current }),
        cue,
      );
      menuOpenRef.current = next.agentMenuOpen;
      setOpen(next.agentMenuOpen);
    };
    window.addEventListener(PRODUCT_TOUR_EVENT, onTourCue);
    return () => window.removeEventListener(PRODUCT_TOUR_EVENT, onTourCue);
  }, []);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 0, bottom: 0 });

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    setPos({
      left: rect.left,
      bottom: window.innerHeight - rect.top + 4,
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        menuRef.current?.contains(target) ||
        buttonRef.current?.contains(target) ||
        (target instanceof Element &&
          target.closest('[data-testid="product-tour"]'))
      ) {
        return;
      }
      setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  if (variant === "pill") {
    return (
      <>
        <button
          ref={buttonRef}
          type="button"
          data-tour="tour-agent-switch"
          title={t("agents.one")}
          aria-label={t("agents.selectNamed", {
            name: selected?.name ?? t("agents.default"),
          })}
          aria-expanded={open}
          disabled={busy || loading}
          onClick={() => setOpen((value) => !value)}
          className="flex h-7 shrink-0 items-center gap-1 rounded-full px-2 text-muted-foreground text-xs transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          <BotIcon className="size-3.5" />
          <span className="max-w-28 truncate">
            {selected?.name ?? t("agents.default")}
          </span>
        </button>
        {open &&
          createPortal(
            <div
              ref={menuRef}
              role="menu"
              data-tour="tour-agent-menu"
              aria-label={t("agents.select")}
              className="fixed w-64 max-w-[calc(100vw-1rem)] overflow-hidden rounded-xl border border-border bg-popover/95 p-1.5 text-popover-foreground shadow-lg backdrop-blur-sm"
              style={{ left: pos.left, bottom: pos.bottom, zIndex: 9999 }}
            >
              <p className="px-2 py-1 font-medium text-muted-foreground text-xs">
                {t("agents.one")}
              </p>
              {[
                { id: "", name: t("agents.default"), scope: "user" as const },
                ...options,
              ].map((agent) => {
                const active = (selected?.id ?? "") === agent.id;
                return (
                  <button
                    type="button"
                    key={`${agent.scope}:${agent.id || "default"}`}
                    role="menuitemradio"
                    aria-checked={active}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-xs",
                      active
                        ? "bg-accent text-accent-foreground"
                        : "text-foreground hover:bg-muted",
                    )}
                    onClick={() => {
                      onAgentChange(
                        agent.id
                          ? (options.find((item) => item.id === agent.id) ??
                              null)
                          : null,
                      );
                      setOpen(false);
                    }}
                  >
                    <span className="truncate">
                      {agent.name}
                      {agent.scope === "project"
                        ? ` ${t("agents.projectBadge")}`
                        : ""}
                    </span>
                    {active && <span aria-hidden>✓</span>}
                  </button>
                );
              })}
            </div>,
            document.body,
          )}
      </>
    );
  }

  return (
    <div className="px-2 pb-2">
      <label
        htmlFor="composer-agent-select"
        className="mb-1 block font-medium text-muted-foreground text-xs"
      >
        {t("agents.one")}
      </label>
      <select
        id="composer-agent-select"
        data-tour="tour-agent-switch"
        aria-label={t("agents.select")}
        className={cn(
          "w-full rounded-lg border border-border bg-background px-3 py-2 text-xs",
          "disabled:cursor-not-allowed disabled:opacity-50",
        )}
        disabled={busy || loading}
        value={selected?.id ?? ""}
        onChange={(event) => {
          const next = event.target.value.trim();
          if (!next) {
            onAgentChange(null);
            return;
          }
          onAgentChange(options.find((agent) => agent.id === next) ?? null);
        }}
      >
        <option value="">{t("agents.default")}</option>
        {options.map((agent) => (
          <option key={`${agent.scope}:${agent.id}`} value={agent.id}>
            {agent.name}
            {agent.scope === "project" ? ` ${t("agents.projectBadge")}` : ""}
          </option>
        ))}
      </select>
    </div>
  );
}
