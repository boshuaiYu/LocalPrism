/**
 * Shared readiness for Settings → Providers.
 * The sidebar badge and each provider card must describe the same facts:
 * engine installed, provider connected, and a default model. Counting the two
 * legacy runtime accounts made the badge say "0/2 ready" while a connected
 * API provider (for example SiliconFlow) was already Active.
 */

export interface ProviderReadinessCard {
  kind: string;
  authenticated: boolean;
  isActive: boolean;
  accountLabel?: string | null;
}

export interface ProviderReadinessModel {
  isDefault?: boolean;
}

export interface ProviderReadinessInput {
  engineInstalled: boolean;
  cards: readonly ProviderReadinessCard[];
  models: readonly ProviderReadinessModel[];
}

export type ProviderCardStatus =
  | "Not connected"
  | "Connected"
  | "Active"
  | "Active · no model";

export function connectedProviderCount(
  cards: readonly ProviderReadinessCard[],
): number {
  return cards.filter((card) => card.authenticated).length;
}

export function activeConnectedProvider(
  cards: readonly ProviderReadinessCard[],
): ProviderReadinessCard | null {
  return cards.find((card) => card.isActive && card.authenticated) ?? null;
}

/** A usable model for the active provider, distinct from merely being connected. */
export function workspaceHasDefaultModel(
  input: Pick<ProviderReadinessInput, "cards" | "models">,
): boolean {
  const active = activeConnectedProvider(input.cards);
  if (!active) return false;
  if (input.models.length > 0) return true;
  return active.kind === "third-party" && Boolean(active.accountLabel?.trim());
}

export function providerCardStatusLabel(
  card: ProviderReadinessCard,
  models: readonly ProviderReadinessModel[],
): ProviderCardStatus {
  if (!card.authenticated) return "Not connected";
  if (!card.isActive) return "Connected";
  return workspaceHasDefaultModel({ cards: [card], models })
    ? "Active"
    : "Active · no model";
}

export function providerStatusDetail(
  card: ProviderReadinessCard,
  models: readonly ProviderReadinessModel[],
): string {
  const status = providerCardStatusLabel(card, models);
  if (card.kind === "third-party" && card.accountLabel?.trim()) {
    return `${card.accountLabel.trim()} · ${status}`;
  }
  return status;
}

export function providerReadinessBadge(input: ProviderReadinessInput): string {
  const engine = input.engineInstalled ? "Engine on" : "Engine off";
  const connected = `${connectedProviderCount(input.cards)} connected`;
  const model = workspaceHasDefaultModel(input) ? "Model set" : "No model";
  return `${engine} · ${connected} · ${model}`;
}
