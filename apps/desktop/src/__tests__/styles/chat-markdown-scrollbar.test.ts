import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  resolve(__dirname, "../../styles/globals.css"),
  "utf8",
);

const TARGETS = [
  ".chat-markdown .katex-display",
  ".chat-markdown pre.chat-markdown-code",
  ".chat-markdown .chat-latex-preview",
  ".chat-markdown :not(.katex-display) > .katex",
  ".chat-markdown .chat-markdown-table",
];

/** Declarations of the first rule whose selector list is exactly `selectors`. */
function ruleBody(selectors: string[]): string {
  const head = selectors.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(
    `(?:^|\\n)\\s*${head.join(",\\s*")}\\s*\\{([^}]*)\\}`,
  );
  const match = css.match(pattern);
  if (!match?.[1]) throw new Error(`missing rule for ${selectors.join(", ")}`);
  return match[1];
}

describe("chat markdown horizontal scrollbars", () => {
  it("lets wide math, code and tables scroll inside the bubble", () => {
    const body = ruleBody(TARGETS);
    expect(body).toMatch(/overflow-x:\s*auto/);
    expect(body).toMatch(/max-width:\s*100%/);
    expect(body).toMatch(/min-width:\s*0/);
  });

  it("styles an always-visible thin WebKit/Chromium scrollbar from theme colors", () => {
    const bar = ruleBody(TARGETS.map((s) => `${s}::-webkit-scrollbar`));
    expect(bar).toMatch(/height:\s*6px/);
    const thumb = ruleBody(TARGETS.map((s) => `${s}::-webkit-scrollbar-thumb`));
    expect(thumb).toMatch(/var\(--muted-foreground\)/);
    expect(thumb).not.toMatch(/oklch\(|#[0-9a-f]{3,6}\b/i);
  });

  it("keeps scrollbar-width thin as the fallback for engines without ::-webkit-scrollbar", () => {
    const fallback = css.match(
      /@supports not selector\(::-webkit-scrollbar\)\s*\{([\s\S]*?)\n\}/,
    )?.[1];
    expect(fallback).toBeTruthy();
    expect(fallback).toMatch(/scrollbar-width:\s*thin/);
    for (const target of TARGETS) expect(fallback).toContain(target);
  });
});
