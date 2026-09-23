import { describe, expect, it } from "vitest";
import {
  providerAccountKey,
  tabOpenedUnderOtherAccount,
} from "@/lib/provider-account";

const card = (
  id: string,
  accountLabel: string | null,
  authenticated = true,
) => ({
  id,
  authenticated,
  accountLabel,
});

describe("provider account scope", () => {
  it("includes the signed-in label so a new login on the same provider is a new account", () => {
    const claude = {
      activeId: "official-claude",
      activeAuthenticated: true,
      cards: [card("official-claude", "a@example.com")],
    };
    expect(providerAccountKey(claude)).toBe("official-claude\0a@example.com");
    expect(
      providerAccountKey({
        ...claude,
        cards: [card("official-claude", "b@example.com")],
      }),
    ).not.toBe(providerAccountKey(claude));
  });

  it("ignores a provider that is not the authenticated active card", () => {
    expect(
      providerAccountKey({
        activeId: "official-claude",
        activeAuthenticated: false,
        cards: [card("official-claude", "a@example.com")],
      }),
    ).toBeNull();
    expect(
      providerAccountKey({
        activeId: null,
        activeAuthenticated: true,
        cards: [card("official-claude", "a@example.com")],
      }),
    ).toBeNull();
  });

  it("treats only a different observed account as foreign", () => {
    const scope = {
      accountObserved: true,
      activeAccountKey: "official-chatgpt\0b@example.com",
    };
    expect(
      tabOpenedUnderOtherAccount(
        { openedUnderAccountKey: "official-claude\0a@example.com" },
        scope,
      ),
    ).toBe(true);
    expect(
      tabOpenedUnderOtherAccount(
        { openedUnderAccountKey: scope.activeAccountKey },
        scope,
      ),
    ).toBe(false);
    expect(
      tabOpenedUnderOtherAccount({ openedUnderAccountKey: null }, scope),
    ).toBe(false);
    expect(
      tabOpenedUnderOtherAccount(
        { openedUnderAccountKey: "official-claude\0a@example.com" },
        { accountObserved: false, activeAccountKey: null },
      ),
    ).toBe(false);
  });
});
