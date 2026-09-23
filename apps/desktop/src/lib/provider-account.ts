export interface ProviderAccountCard {
  id: string;
  authenticated: boolean;
  accountLabel: string | null;
}

/** Stable identity for the signed-in workspace account. */
export function providerAccountKey(status: {
  activeId: string | null;
  activeAuthenticated: boolean;
  cards: readonly ProviderAccountCard[];
}): string | null {
  if (!status.activeId || !status.activeAuthenticated) return null;
  const card = status.cards.find(
    (candidate) => candidate.id === status.activeId && candidate.authenticated,
  );
  if (!card) return null;
  return `${card.id}\0${card.accountLabel?.trim() ?? ""}`;
}

export function tabOpenedUnderOtherAccount(
  tab: { openedUnderAccountKey?: string | null },
  scope: {
    accountObserved: boolean;
    activeAccountKey: string | null;
  },
): boolean {
  return (
    scope.accountObserved &&
    tab.openedUnderAccountKey != null &&
    tab.openedUnderAccountKey !== scope.activeAccountKey
  );
}
