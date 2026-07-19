import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { CheckCircle2Icon, ExternalLinkIcon, Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { RuntimeAccount, RuntimeLoginState } from "@/runtime/types";

export type RuntimeLoginMode = "browser" | "device-code" | "api-key";

export interface RuntimeCardProps {
  title: string;
  description?: string;
  account: RuntimeAccount;
  login?: RuntimeLoginState | null;
  loading?: boolean;
  /** True only while store.install() is in progress ??not background refresh. */
  installInFlight?: boolean;
  onInstall?: () => Promise<unknown> | unknown;
  onLogin?: (mode: RuntimeLoginMode, apiKey?: string) => Promise<void> | void;
  onCancelLogin?: () => Promise<void> | void;
  onLogout?: () => Promise<void> | void;
  onOpenExternal?: (url: string) => Promise<void> | void;
  children?: ReactNode;
}

function consume(action: (() => Promise<unknown> | unknown) | undefined) {
  if (!action) return;
  void Promise.resolve()
    .then(action)
    .catch(() => undefined);
}

export function RuntimeCard({
  title,
  description,
  account,
  login,
  loading = false,
  installInFlight = false,
  onInstall,
  onLogin,
  onCancelLogin,
  onLogout,
  onOpenExternal,
  children,
}: RuntimeCardProps) {
  const [apiKey, setApiKey] = useState("");

  const submitApiKey = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const credential = apiKey.trim();
    if (!credential || !onLogin) return;
    try {
      await onLogin("api-key", credential);
    } catch {
      // The shared runtime store owns the redacted error shown below.
    } finally {
      setApiKey("");
    }
  };

  const waiting = login?.status === "waiting" ? login : null;
  const loginError = login?.status === "error" ? login.message : null;
  const hasLiveLoginError = login?.status === "error" && login.loginId !== null;
  const loginStatus = login?.status ?? null;
  const installing =
    Boolean(installInFlight) && !account.installed && !!onInstall;
  const controlsLocked = loading || installInFlight;

  useEffect(() => {
    if (!account.installed || account.authenticated || loginStatus !== null) {
      setApiKey("");
    }
  }, [account.installed, account.authenticated, loginStatus]);

  const startInteractiveLogin = (mode: "browser" | "device-code") => {
    setApiKey("");
    consume(() => onLogin?.(mode));
  };

  return (
    <section
      className="overflow-hidden rounded-xl border border-border/70 bg-background"
      data-runtime={account.runtime}
    >
      <div className="flex items-start justify-between gap-4 border-border/60 border-b px-5 py-4">
        <div className="min-w-0">
          <h3 className="font-semibold text-sm">{title}</h3>
          {description && (
            <p className="mt-1 text-muted-foreground text-xs leading-relaxed">
              {description}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5 text-xs">
          {installing ? (
            <>
              <Loader2Icon className="size-3.5 animate-spin" />
              Installing...
            </>
          ) : loading ? (
            <>
              <Loader2Icon className="size-3.5 animate-spin" />
              Working...
            </>
          ) : account.authenticated ? (
            <>
              <CheckCircle2Icon className="size-3.5 text-emerald-600" />
              Ready
            </>
          ) : account.installed ? (
            "Sign in required"
          ) : (
            "Not installed"
          )}
        </div>
      </div>

      <div className="space-y-4 p-5">
        {account.error && (
          <div
            className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive text-xs"
            role="alert"
          >
            <span className="font-medium">Account error:</span> {account.error}
          </div>
        )}

        {loginError && (
          <div className="space-y-2">
            <div
              className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive text-xs"
              role="alert"
            >
              <span className="font-medium">Login error:</span> {loginError}
            </div>
            {login?.status === "error" &&
              login.loginId !== null &&
              onCancelLogin && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={controlsLocked}
                  onClick={() => consume(onCancelLogin)}
                >
                  Cancel
                </Button>
              )}
          </div>
        )}

        {!account.installed ? (
          onInstall && (
            <Button
              type="button"
              disabled={controlsLocked}
              onClick={() => consume(onInstall)}
            >
              {installing ? "Checking Codex\u2026" : "Install"}
            </Button>
          )
        ) : account.authenticated ? (
          <div className="space-y-3">
            <dl className="grid gap-2 text-xs sm:grid-cols-3">
              <RuntimeDetail label="Version" value={account.version} />
              <RuntimeDetail label="Account" value={account.accountLabel} />
              <RuntimeDetail label="Authentication" value={account.authMode} />
            </dl>
            {onLogout && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={controlsLocked}
                onClick={() => consume(onLogout)}
              >
                Log out
              </Button>
            )}
          </div>
        ) : waiting?.mode === "browser" ? (
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground text-xs">
              Complete sign-in in your browser:
            </p>
            <p className="break-all rounded-md bg-muted/40 px-3 py-2 text-xs">
              {waiting.authUrl}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                disabled={controlsLocked || !onOpenExternal}
                onClick={() => consume(() => onOpenExternal?.(waiting.authUrl))}
              >
                <ExternalLinkIcon className="size-3.5" />
                Open authorization page
              </Button>
              {onCancelLogin && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={controlsLocked}
                  onClick={() => consume(onCancelLogin)}
                >
                  Cancel
                </Button>
              )}
            </div>
          </div>
        ) : waiting?.mode === "device-code" ? (
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground text-xs">
              Open the verification page and enter this code:
            </p>
            <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
              <p className="break-all rounded-md bg-muted/40 px-3 py-2 text-xs">
                {waiting.verificationUrl}
              </p>
              <code className="rounded-md border px-3 py-2 font-semibold text-sm">
                {waiting.userCode}
              </code>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                disabled={controlsLocked || !onOpenExternal}
                onClick={() =>
                  consume(() => onOpenExternal?.(waiting.verificationUrl))
                }
              >
                <ExternalLinkIcon className="size-3.5" />
                Open verification page
              </Button>
              {onCancelLogin && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={controlsLocked}
                  onClick={() => consume(onCancelLogin)}
                >
                  Cancel
                </Button>
              )}
            </div>
          </div>
        ) : hasLiveLoginError ? null : login?.status === "complete" ? (
          <p className="text-muted-foreground text-xs">
            Sign-in completed. Refreshing account status...
          </p>
        ) : (
          onLogin && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={controlsLocked}
                  onClick={() => startInteractiveLogin("browser")}
                >
                  Continue in browser
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={controlsLocked}
                  onClick={() => startInteractiveLogin("device-code")}
                >
                  Use device code
                </Button>
              </div>
              <form className="flex gap-2" onSubmit={submitApiKey}>
                <Input
                  aria-label="Codex API key"
                  type="password"
                  autoComplete="off"
                  value={apiKey}
                  disabled={controlsLocked}
                  placeholder="Codex API key"
                  onChange={(event) => setApiKey(event.currentTarget.value)}
                />
                <Button
                  type="submit"
                  variant="outline"
                  disabled={controlsLocked || !apiKey.trim()}
                >
                  Use API key
                </Button>
              </form>
            </div>
          )
        )}

        {children && (
          <div className="border-border/60 border-t pt-4">{children}</div>
        )}
      </div>
    </section>
  );
}

function RuntimeDetail({
  label,
  value,
}: {
  label: string;
  value: string | null;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate font-medium">
        {value || "Not available"}
      </dd>
    </div>
  );
}
