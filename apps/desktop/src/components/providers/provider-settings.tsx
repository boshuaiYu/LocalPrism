import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useClaudeSetupStore } from "@/stores/claude-setup-store";
import { useProviderStore, type ProviderCard } from "@/stores/provider-store";
import {
  THIRD_PARTY_PRESETS,
  thirdPartyPresetById,
  type ThirdPartyPreset,
} from "@/lib/third-party-presets";
import { getProviderIconSrc } from "@/lib/provider-icons";
import { cn } from "@/lib/utils";

export interface ProviderSettingsProps {
  refreshOnMount?: boolean;
  showEngine?: boolean;
  officialOpenDefault?: boolean;
}

export function ProviderSettings({
  refreshOnMount = true,
  showEngine = true,
  officialOpenDefault = false,
}: ProviderSettingsProps) {
  const refresh = useProviderStore((state) => state.refresh);
  const cards = useProviderStore((state) => state.cards);
  const engineInstalled = useProviderStore((state) => state.engineInstalled);
  const missingGit = useProviderStore((state) => state.missingGit);
  const ready = useProviderStore((state) => state.ready);
  const error = useProviderStore((state) => state.error);
  const oauthBusy = useProviderStore((state) => state.oauthBusy);
  const oauthUrl = useProviderStore((state) => state.oauthUrl);
  const activate = useProviderStore((state) => state.activate);
  const startOAuth = useProviderStore((state) => state.startOAuth);
  const logout = useProviderStore((state) => state.logout);
  const upsertThirdParty = useProviderStore((state) => state.upsertThirdParty);
  const remove = useProviderStore((state) => state.remove);
  const models = useProviderStore((state) => state.models);
  const activeName =
    cards.find((card) => card.isActive)?.name ?? "the active provider";
  const installEngine = useClaudeSetupStore((state) => state.install);
  const ensureEngine = useClaudeSetupStore((state) => state.ensureEngine);
  const isInstalling = useClaudeSetupStore((state) => state.isInstalling);

  useEffect(() => {
    if (refreshOnMount) {
      void refresh();
    }
  }, [refresh, refreshOnMount]);

  useEffect(() => {
    if (!showEngine || engineInstalled || missingGit) return;
    void ensureEngine();
  }, [engineInstalled, ensureEngine, missingGit, showEngine]);

  const official = cards.filter((card) => card.kind !== "third-party");
  const thirdParty = cards.filter((card) => card.kind === "third-party");
  const officialInUse = official.some(
    (card) => card.authenticated || card.isActive,
  );
  const [officialOpen, setOfficialOpen] = useState(
    officialOpenDefault || officialInUse,
  );

  useEffect(() => {
    if (officialInUse) setOfficialOpen(true);
  }, [officialInUse]);

  return (
    <div className="space-y-5 p-5">
      {showEngine && !engineInstalled && (
        <section className="rounded-xl border border-border/70 p-4">
          <p className="text-sm">
            {missingGit
              ? "Git for Windows is required before installing Claude Code CLI."
              : isInstalling
                ? "Installing Claude Code CLI…"
                : "Claude Code CLI is needed before a provider can send chat."}
          </p>
          <Button
            className="mt-3"
            disabled={isInstalling || missingGit}
            onClick={() => void installEngine()}
          >
            {isInstalling ? "Installing…" : "Install Claude Code CLI"}
          </Button>
        </section>
      )}

      <ThirdPartySection
        cards={thirdParty}
        onActivate={(id) => void activate(id)}
        onDelete={(id) => void remove(id)}
        onSave={(provider) => void upsertThirdParty(provider, true)}
      />

      <section className="rounded-xl border border-border/70">
        <button
          type="button"
          className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
          onClick={() => setOfficialOpen((open) => !open)}
        >
          <span>
            <span className="block font-medium text-sm">
              Official Claude / ChatGPT login
            </span>
            <span className="mt-0.5 block text-muted-foreground text-xs">
              Optional browser sign-in. An API key is enough.
            </span>
          </span>
          <span className="text-muted-foreground text-xs">
            {officialOpen ? "Hide" : "Show"}
          </span>
        </button>
        {officialOpen && (
          <div className="space-y-3 border-border/70 border-t px-4 py-3">
            {official.map((card) => (
              <OfficialCard
                key={card.id}
                card={card}
                busy={
                  (card.kind === "official-claude" && oauthBusy === "claude") ||
                  (card.kind === "official-chatgpt" && oauthBusy === "chatgpt")
                }
                oauthUrl={
                  (card.kind === "official-claude" && oauthBusy === "claude") ||
                  (card.kind === "official-chatgpt" && oauthBusy === "chatgpt")
                    ? oauthUrl
                    : null
                }
                onLogin={() =>
                  void startOAuth(
                    card.kind === "official-chatgpt" ? "chatgpt" : "claude",
                  )
                }
                onLogout={() =>
                  void logout(
                    card.kind === "official-chatgpt" ? "chatgpt" : "claude",
                  )
                }
                onActivate={() => void activate(card.id)}
              />
            ))}
          </div>
        )}
      </section>

      {error && <p className="text-destructive text-sm">{error}</p>}
      <p className="text-muted-foreground text-xs">
        Ready when the engine is installed and one provider is active. An API
        key is enough
        {ready ? " · ready" : ""}.
        {models.length > 0
          ? ` ${models.length} models from ${activeName}.`
          : ""}
      </p>
    </div>
  );
}

function OfficialCard({
  card,
  busy,
  oauthUrl,
  onLogin,
  onLogout,
  onActivate,
}: {
  card: ProviderCard;
  busy: boolean;
  oauthUrl: string | null;
  onLogin: () => void;
  onLogout: () => void;
  onActivate: () => void;
}) {
  return (
    <section className="rounded-lg bg-muted/30 p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-medium text-sm">{card.name}</h3>
          <p className="mt-1 text-muted-foreground text-sm">
            {card.authenticated
              ? card.accountLabel || "Signed in"
              : "Browser sign-in. Tokens stay in LocalPrism."}
          </p>
        </div>
        <span className="text-muted-foreground text-xs">
          {card.isActive
            ? "Active"
            : card.authenticated
              ? "Ready"
              : "Signed out"}
        </span>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {card.authenticated ? (
          <>
            {!card.isActive && (
              <Button size="sm" onClick={onActivate}>
                Set as default
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={onLogout}>
              Sign out
            </Button>
          </>
        ) : (
          <Button size="sm" disabled={busy} onClick={onLogin}>
            {busy ? "Waiting for browser…" : `Sign in to ${card.name}`}
          </Button>
        )}
      </div>
      {oauthUrl && (
        <p className="mt-2 break-all text-muted-foreground text-xs">
          If the browser did not open, copy this authorization link: {oauthUrl}
        </p>
      )}
    </section>
  );
}

function ThirdPartySection({
  cards,
  onActivate,
  onDelete,
  onSave,
}: {
  cards: ProviderCard[];
  onActivate: (id: string) => void;
  onDelete: (id: string) => void;
  onSave: (provider: {
    name: string;
    apiKey: string;
    baseUrl: string;
    apiFormat: ThirdPartyPreset["apiFormat"];
    models: { main: string };
  }) => void;
}) {
  const defaultPreset = THIRD_PARTY_PRESETS[0];
  const [presetId, setPresetId] = useState<string | null>(defaultPreset.id);
  const [name, setName] = useState(defaultPreset.name);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(defaultPreset.baseUrl);
  const [model, setModel] = useState(defaultPreset.model);
  const preset = thirdPartyPresetById(presetId);
  const isCustom = presetId === "custom";
  const canEditEndpoint = Boolean(preset?.editBaseUrl || isCustom);

  const applyPreset = (next: ThirdPartyPreset) => {
    setPresetId(next.id);
    setName(next.name === "Custom" ? "" : next.name);
    setBaseUrl(next.baseUrl);
    setModel(next.model);
  };

  return (
    <section className="rounded-xl border border-border/70 p-4">
      <h3 className="font-medium text-sm">Use an API key</h3>
      <p className="mt-1 text-muted-foreground text-sm">
        Pick a preset and paste a key. Official Claude or ChatGPT sign-in is not
        required.
      </p>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {THIRD_PARTY_PRESETS.map((item) => {
          const icon = getProviderIconSrc({
            label: item.name,
            baseUrl: item.baseUrl,
          });
          const selected = presetId === item.id;
          return (
            <button
              key={item.id}
              type="button"
              className={cn(
                "flex items-center gap-2 rounded-xl border px-3 py-2.5 text-left transition-colors",
                selected
                  ? "border-foreground bg-muted/60"
                  : "border-border/70 hover:bg-muted/40",
              )}
              onClick={() => applyPreset(item)}
            >
              {icon ? (
                <img src={icon} alt="" className="size-5 shrink-0" />
              ) : (
                <span className="flex size-5 shrink-0 items-center justify-center rounded bg-muted font-medium text-[10px]">
                  {item.name.slice(0, 1)}
                </span>
              )}
              <span className="truncate text-sm">{item.name}</span>
            </button>
          );
        })}
      </div>

      {preset && (
        <div className="mt-3 space-y-2">
          {canEditEndpoint && (
            <div className="grid gap-2 sm:grid-cols-2">
              {isCustom && (
                <Input
                  placeholder="Name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              )}
              <Input
                placeholder="Base URL"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
              />
            </div>
          )}
          <div className="grid gap-2 sm:grid-cols-2">
            <Input
              placeholder="API key"
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
            <Input
              placeholder="Model"
              value={model}
              onChange={(event) => setModel(event.target.value)}
            />
          </div>
          {preset.note && (
            <p className="text-muted-foreground text-xs">{preset.note}</p>
          )}
          <Button
            size="sm"
            disabled={
              !name.trim() || !baseUrl.trim() || !model.trim() || !apiKey.trim()
            }
            onClick={() => {
              onSave({
                name: name.trim(),
                apiKey: apiKey.trim(),
                baseUrl: baseUrl.trim(),
                apiFormat: preset.apiFormat,
                models: { main: model.trim() },
              });
              setApiKey("");
            }}
          >
            Save and set default
          </Button>
        </div>
      )}

      <ul className="mt-4 space-y-2">
        {cards.map((card) => (
          <li
            key={card.id}
            className="flex items-center justify-between gap-2 rounded-lg bg-muted/40 px-3 py-2"
          >
            <div>
              <p className="text-sm">{card.name}</p>
              <p className="text-muted-foreground text-xs">
                {card.accountLabel}
                {card.isActive ? " · Active" : ""}
              </p>
            </div>
            <div className="flex gap-2">
              {!card.isActive && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onActivate(card.id)}
                >
                  Set default
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onDelete(card.id)}
              >
                Delete
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
