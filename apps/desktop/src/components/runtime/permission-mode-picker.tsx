import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ShieldCheckIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/stores/settings-store";
import {
  PERMISSION_MODE_OPTIONS,
  type PermissionMode,
} from "@/lib/permission-mode";

export function permissionModeLabel(mode: PermissionMode): string {
  return (
    PERMISSION_MODE_OPTIONS.find((option) => option.id === mode)?.label ??
    "Approvals"
  );
}

export function PermissionModePicker({ busy = false }: { busy?: boolean }) {
  const permissionMode = useSettingsStore((state) => state.permissionMode);
  const setPermissionMode = useSettingsStore(
    (state) => state.setPermissionMode,
  );
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
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
        buttonRef.current?.contains(target)
      ) {
        return;
      }
      setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        title="Approval policy"
        aria-label={`Approval policy ${permissionModeLabel(permissionMode)}`}
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen((value) => !value)}
        className="flex h-7 min-w-0 max-w-full shrink items-center gap-1 overflow-hidden rounded-full px-2 text-muted-foreground text-xs transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
      >
        <ShieldCheckIcon className="size-3.5" />
        <span className="min-w-0 max-w-28 truncate">
          {permissionModeLabel(permissionMode)}
        </span>
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label="Approval policy"
            className="fixed w-72 max-w-[calc(100vw-1rem)] overflow-hidden rounded-xl border border-border bg-popover/95 p-1.5 text-popover-foreground shadow-lg backdrop-blur-sm"
            style={{ left: pos.left, bottom: pos.bottom, zIndex: 9999 }}
          >
            <p className="px-2 py-1 font-medium text-muted-foreground text-xs">
              Approvals
            </p>
            <p className="px-2 pb-1.5 text-[11px] text-muted-foreground leading-snug">
              Passed to Claude Code as --permission-mode. Allow edits
              auto-accepts file edits and asks you about other tools. Full
              access skips the prompt.
            </p>
            {PERMISSION_MODE_OPTIONS.map((option) => (
              <button
                type="button"
                key={option.id}
                role="menuitemradio"
                aria-checked={permissionMode === option.id}
                aria-label={`Approval policy ${option.label}`}
                title={option.description}
                className={cn(
                  "flex w-full items-start justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors",
                  permissionMode === option.id
                    ? "bg-accent text-accent-foreground"
                    : "text-foreground hover:bg-muted",
                )}
                onClick={() => {
                  setPermissionMode(option.id);
                  setOpen(false);
                }}
              >
                <span className="min-w-0">
                  <span className="block font-medium text-xs">
                    {option.label}
                  </span>
                  <span className="block text-[11px] text-muted-foreground">
                    {option.description}
                  </span>
                </span>
                {permissionMode === option.id && <span aria-hidden>✓</span>}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
