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
import {
  providerCardStatusLabel,
  providerReadinessBadge,
  providerStatusDetail,
} from "@/lib/provider-readiness";
import { cn } from "@/lib/utils";
import type { MessageKey } from "@/lib/i18n";
import { useI18n } from "@/lib/use-i18n";

const STATUS_KEYS: Record<string, MessageKey> = {
  "Not connected": "providers.status.notConnected",
  Connected: "providers.status.connected",
  Active: "providers.status.active",
  "Active · no model": "providers.status.activeNoModel",
};

function localizedStatus(
  status: string,
  t: (key: MessageKey, vars?: Record<string, string | number>) => string,
): string {
  const key = STATUS_KEYS[status];
  return key ? t(key) : status;
}

function localizedDetail(
  detail: string,
  status: string,
  t: (key: MessageKey, vars?: Record<string, string | number>) => string,
): string {
  if (!detail.endsWith(status)) return detail;
  return `${detail.slice(0, detail.length - status.length)}${localizedStatus(status, t)}`;
}

function localizedBadge(
  badge: string,
  t: (key: MessageKey, vars?: Record<string, string | number>) => string,
): string {
  return badge
    .split("Engine on")
    .join(t("providers.engineOn"))
    .split("Engine off")
    .join(t("providers.engineOff"))
    .split("Model set")
    .join(t("providers.modelSet"))
    .split("No model")
    .join(t("providers.noModel"))
    .split("connected")
    .join(t("providers.connectedWord"));
}

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
  const { t } = useI18n();
  const refresh = useProviderStore((state) => state.refresh);
  const cards = useProviderStore((state) => state.cards);
  const engineInstalled = useProviderStore((state) => state.engineInstalled);
  const missingGit = useProviderStore((state) => state.missingGit);
  const error = useProviderStore((state) => state.error);
  const oauthBusy = useProviderStore((state) => state.oauthBusy);
  const oauthUrl = useProviderStore((state) => state.oauthUrl);
  const activate = useProviderStore((state) => state.activate);
  const startOAuth = useProviderStore((state) => state.startOAuth);
  const logout = useProviderStore((state) => state.logout);
  const upsertThirdParty = useProviderStore((state) => state.upsertThirdParty);
  const remove = useProviderStore((state) => state.remove);
  const models = useProviderStore((state) => state.models);
  const readinessBadge = providerReadinessBadge({
    engineInstalled,
    cards,
    models,
  });
  const activeName =
    cards.find((card) => card.isActive)?.name ?? t("providers.activeFallback");
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
              ? t("providers.gitRequired")
              : isInstalling
                ? t("providers.installingCli")
                : t("providers.cliNeeded")}
          </p>
          <Button
            className="mt-3"
            disabled={isInstalling || missingGit}
            onClick={() => void installEngine()}
          >
            {isInstalling
              ? t("providers.installing")
              : t("providers.installCli")}
          </Button>
        </section>
      )}

      <ThirdPartySection
        cards={thirdParty}
        models={models}
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
              {t("providers.officialTitle")}
            </span>
            <span className="mt-0.5 block text-muted-foreground text-xs">
              {t("providers.officialHelp")}
            </span>
          </span>
          <span className="text-muted-foreground text-xs">
            {officialOpen ? t("providers.hide") : t("providers.show")}
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
                models={models}
                onActivate={() => void activate(card.id)}
              />
            ))}
          </div>
        )}
      </section>

      {error && <p className="text-destructive text-sm">{error}</p>}
      <p className="text-muted-foreground text-xs">
        {t("providers.apiKeyEnough", {
          badge: localizedBadge(readinessBadge, t),
        })}
        {models.length > 0
          ? ` ${t("providers.modelCount", { count: models.length, name: activeName })}`
          : ""}
      </p>
    </div>
  );
}

function OfficialCard({
  card,
  models,
  busy,
  oauthUrl,
  onLogin,
  onLogout,
  onActivate,
}: {
  card: ProviderCard;
  models: { isDefault?: boolean }[];
  busy: boolean;
  oauthUrl: string | null;
  onLogin: () => void;
  onLogout: () => void;
  onActivate: () => void;
}) {
  const { t } = useI18n();
  const status = providerCardStatusLabel(card, models);
  return (
    <section className="rounded-lg bg-muted/30 p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-medium text-sm">{card.name}</h3>
          <p className="mt-1 text-muted-foreground text-sm">
            {card.authenticated
              ? card.accountLabel || t("providers.signedIn")
              : t("providers.browserSignIn")}
          </p>
        </div>
        <span className="text-muted-foreground text-xs">
          {localizedStatus(status, t)}
        </span>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {card.authenticated ? (
          <>
            {!card.isActive && (
              <Button size="sm" onClick={onActivate}>
                {t("providers.setAsDefault")}
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={onLogout}>
              {t("providers.signOut")}
            </Button>
          </>
        ) : (
          <Button size="sm" disabled={busy} onClick={onLogin}>
            {busy
              ? t("providers.waitingBrowser")
              : t("providers.signInTo", { name: card.name })}
          </Button>
        )}
      </div>
      {oauthUrl && (
        <p className="mt-2 break-all text-muted-foreground text-xs">
          {t("providers.oauthFallback", { url: oauthUrl })}
        </p>
      )}
    </section>
  );
}

function ThirdPartySection({
  cards,
  models,
  onActivate,
  onDelete,
  onSave,
}: {
  cards: ProviderCard[];
  models: { isDefault?: boolean }[];
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
  const { t } = useI18n();
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
      <h3 className="font-medium text-sm">{t("providers.useApiKey")}</h3>
      <p className="mt-1 text-muted-foreground text-sm">
        {t("providers.apiKeyHelp")}
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
                  placeholder={t("providers.name")}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              )}
              <Input
                placeholder={t("providers.baseUrl")}
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
              />
            </div>
          )}
          <div className="grid gap-2 sm:grid-cols-2">
            <Input
              placeholder={t("providers.apiKey")}
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
            <Input
              placeholder={t("providers.model")}
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
            {t("providers.saveDefault")}
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
                {localizedDetail(
                  providerStatusDetail(card, models),
                  providerCardStatusLabel(card, models),
                  t,
                )}
              </p>
            </div>
            <div className="flex gap-2">
              {!card.isActive && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onActivate(card.id)}
                >
                  {t("providers.setDefault")}
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onDelete(card.id)}
              >
                {t("providers.delete")}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
