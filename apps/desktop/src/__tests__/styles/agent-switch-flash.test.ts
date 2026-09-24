import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILTIN_AGENT_PRESETS } from "@/lib/agent-presets";

const css = readFileSync(
  resolve(__dirname, "../../styles/globals.css"),
  "utf8",
);

interface FlashColor {
  lightness: number;
  chroma: number;
  hue: number;
}

function hueDistance(left: number, right: number): number {
  const delta = Math.abs(left - right) % 360;
  return Math.min(delta, 360 - delta);
}

function colorIn(block: string): FlashColor {
  const match = block.match(/oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)/);
  if (!match) {
    throw new Error(`missing oklch color in:\n${block}`);
  }
  return {
    lightness: Number(match[1]),
    chroma: Number(match[2]),
    hue: Number(match[3]),
  };
}

function blockAfter(label: string): string {
  const start = css.indexOf(label);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = css.indexOf("\n}", start);
  return css.slice(start, next);
}

describe("agent switch flash colors", () => {
  it("binds each built-in preset id to its own saturated keyframe", () => {
    const hues = new Map<string, number[]>();

    for (const preset of BUILTIN_AGENT_PRESETS) {
      const rule = blockAfter(
        `.lp-agent-switch-flash[data-agent-flash="${preset.id}"]`,
      );
      const keyframeName = `lp-agent-switch-flash-${preset.id}`;
      expect(rule).toContain(`animation-name: ${keyframeName};`);
      const token = colorIn(rule);
      const painted = colorIn(blockAfter(`@keyframes ${keyframeName}`));
      expect(painted).toEqual(token);
      expect(painted.chroma).toBeGreaterThanOrEqual(0.2);

      const darkRule = blockAfter(
        `.dark .lp-agent-switch-flash[data-agent-flash="${preset.id}"]`,
      );
      expect(darkRule).toContain(`animation-name: ${keyframeName}-dark;`);
      const darkToken = colorIn(darkRule);
      const darkPainted = colorIn(
        blockAfter(`@keyframes ${keyframeName}-dark`),
      );
      expect(darkPainted).toEqual(darkToken);

      hues.set(preset.id, [painted.hue, darkPainted.hue]);
      expect(painted.hue).toBe(darkPainted.hue);
      expect(darkPainted.chroma).toBeGreaterThanOrEqual(0.16);
    }

    const ids = BUILTIN_AGENT_PRESETS.map((preset) => preset.id);
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const left = hues.get(ids[i])?.[0] ?? 0;
        const right = hues.get(ids[j])?.[0] ?? 0;
        expect(hueDistance(left, right)).toBeGreaterThanOrEqual(80);
      }
    }
  });
});
