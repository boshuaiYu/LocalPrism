import { describe, expect, it } from "vitest";
import {
  buildTokenMeterModel,
  catalogContextWindow,
  estimateContextWindow,
  formatTokenCount,
  lastTurnUsage,
  mergeTokenUsageSnapshots,
} from "@/lib/chat-token-usage";

describe("chat token usage", () => {
  it("reads the latest turn including cache tokens", () => {
    const last = lastTurnUsage([
      {
        type: "result",
        usage: { input_tokens: 10, output_tokens: 2 },
      },
      {
        type: "result",
        usage: {
          input_tokens: 3588,
          output_tokens: 100,
          cache_read_input_tokens: 20992,
          cache_creation_input_tokens: 0,
        },
      },
    ]);
    expect(last).toEqual({
      inputTokens: 3588,
      outputTokens: 100,
      cacheReadTokens: 20992,
      cacheCreationTokens: 0,
    });
  });

  it("estimates a GPT-5 family window and context percent", () => {
    const meter = buildTokenMeterModel({
      modelLabel: "gpt-5.6-terra",
      messages: [
        {
          type: "result",
          usage: {
            input_tokens: 3588,
            output_tokens: 100,
            cache_read_input_tokens: 17862,
          },
        },
      ],
    });
    expect(meter.windowTokens).toBe(272_000);
    expect(meter.usedTokens).toBe(21450);
    expect(meter.remainingTokens).toBe(250_550);
    expect(meter.percent).toBe(8);
    expect(meter.cacheReadTokens).toBe(17862);
    expect(meter.cacheCreationTokens).toBe(0);
    expect(formatTokenCount(meter.usedTokens)).toBe("21,450");
  });

  it("keeps prompt tokens when a later result is output-only", () => {
    const last = lastTurnUsage([
      {
        type: "result",
        usage: {
          input_tokens: 3588,
          output_tokens: 12,
          cache_read_input_tokens: 200,
        },
      },
      {
        type: "result",
        usage: { output_tokens: 80 },
      },
    ]);
    expect(last).toEqual({
      inputTokens: 3588,
      outputTokens: 80,
      cacheReadTokens: 200,
      cacheCreationTokens: 0,
    });
  });

  it("prefers result usage over a later incomplete assistant snapshot", () => {
    const last = lastTurnUsage([
      {
        type: "result",
        usage: {
          input_tokens: 3588,
          output_tokens: 100,
          cache_read_input_tokens: 20992,
        },
      },
      {
        type: "assistant",
        message: { usage: { output_tokens: 12 } },
      },
    ]);
    expect(last).toEqual({
      inputTokens: 3588,
      outputTokens: 100,
      cacheReadTokens: 20992,
      cacheCreationTokens: 0,
    });
  });

  it("uses the parsed catalog window for the selected model", () => {
    expect(estimateContextWindow("gpt-5.6-luna")).toBe(272_000);
    expect(estimateContextWindow("gpt-5.6-luna", 272_000)).toBe(272_000);
    expect(estimateContextWindow("gpt-5.6-terra", 400_000)).toBe(400_000);
    expect(
      catalogContextWindow(
        [
          {
            id: "gpt-5.6-luna",
            displayName: "GPT-5.6 Luna",
            contextWindow: 272000,
          },
          {
            id: "gpt-5.6-terra",
            displayName: "GPT-5.6 Terra",
            contextWindow: 400000,
          },
        ],
        "gpt-5.6-luna",
      ),
    ).toBe(272_000);
    expect(
      catalogContextWindow(
        [
          {
            id: "gpt-5.6-luna",
            displayName: "GPT-5.6 Luna",
            contextWindow: 272000,
          },
          {
            id: "gpt-5.6-terra",
            displayName: "GPT-5.6 Terra",
            contextWindow: 400000,
          },
        ],
        "GPT-5.6 Terra",
      ),
    ).toBe(400_000);
    expect(
      catalogContextWindow(
        [
          {
            id: "gpt-5.6-luna",
            displayName: "GPT-5.6 Luna",
            contextWindow: 272000,
          },
        ],
        "gpt-5.6-luna-high",
      ),
    ).toBe(272_000);
  });

  it("prefers the last-turn snapshot supplied by the store", () => {
    const meter = buildTokenMeterModel({
      modelLabel: "gpt-6-astra",
      windowTokens: 272_000,
      lastUsage: {
        inputTokens: 1200,
        outputTokens: 80,
        cacheReadTokens: 400,
        cacheCreationTokens: 0,
      },
    });
    expect(meter.usedTokens).toBe(1600);
    expect(meter.windowTokens).toBe(272_000);
    expect(meter.percent).toBe(1);
    expect(meter.estimated).toBe(false);
  });

  it("does not treat session totals as context occupancy", () => {
    expect(estimateContextWindow("sonnet")).toBe(200_000);
    const meter = buildTokenMeterModel({
      modelLabel: "sonnet",
    });
    expect(meter.usedTokens).toBe(0);
    expect(meter.inputTokens).toBe(0);
    expect(meter.outputTokens).toBe(0);
    expect(meter.percent).toBe(0);
    expect(meter.estimated).toBe(true);
  });

  it("does not let output-only snapshots erase prompt tokens", () => {
    const merged = mergeTokenUsageSnapshots(
      {
        inputTokens: 3588,
        outputTokens: 10,
        cacheReadTokens: 100,
        cacheCreationTokens: 0,
      },
      {
        inputTokens: 0,
        outputTokens: 80,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    );
    expect(merged).toEqual({
      inputTokens: 3588,
      outputTokens: 80,
      cacheReadTokens: 100,
      cacheCreationTokens: 0,
    });
  });

  it("replaces the previous turn cache when a new prompt snapshot arrives", () => {
    const merged = mergeTokenUsageSnapshots(
      {
        inputTokens: 500,
        outputTokens: 40,
        cacheReadTokens: 0,
        cacheCreationTokens: 18000,
      },
      {
        inputTokens: 400,
        outputTokens: 20,
        cacheReadTokens: 18000,
        cacheCreationTokens: 300,
      },
    );
    expect(merged).toEqual({
      inputTokens: 400,
      outputTokens: 20,
      cacheReadTokens: 18000,
      cacheCreationTokens: 300,
    });
    expect(
      mergeTokenUsageSnapshots(merged, {
        inputTokens: 410,
        outputTokens: 8,
        cacheReadTokens: 18300,
        cacheCreationTokens: 0,
      }).cacheCreationTokens,
    ).toBe(0);
  });

  it("keeps prompt tokens when the store snapshot later has output only", () => {
    const meter = buildTokenMeterModel({
      modelLabel: "sonnet",
      messages: [
        {
          type: "result",
          usage: {
            input_tokens: 3588,
            output_tokens: 12,
            cache_read_input_tokens: 200,
          },
        },
      ],
      lastUsage: {
        inputTokens: 0,
        outputTokens: 80,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    });
    expect(meter.inputTokens).toBe(3588);
    expect(meter.outputTokens).toBe(80);
    expect(meter.cacheReadTokens).toBe(200);
    expect(meter.usedTokens).toBe(3788);
  });

  it("treats exclusive input plus cache as occupancy, not a session sum", () => {
    const meter = buildTokenMeterModel({
      modelLabel: "gpt-5.6-luna",
      windowTokens: 272_000,
      lastUsage: {
        inputTokens: 66_121,
        outputTokens: 7_011,
        cacheReadTokens: 53_760,
        cacheCreationTokens: 0,
      },
    });
    expect(meter.usedTokens).toBe(119_881);
    expect(meter.inputTokens).toBe(66_121);
    expect(meter.cacheReadTokens).toBe(53_760);
    expect(meter.percent).toBe(44);
  });

  it("reads nested message.usage", () => {
    const last = lastTurnUsage([
      {
        type: "assistant",
        message: {
          usage: { input_tokens: 40, output_tokens: 9 },
        },
      },
    ]);
    expect(last?.inputTokens).toBe(40);
    expect(last?.outputTokens).toBe(9);
  });

  it("reads OpenAI-shaped usage aliases from conversation messages", () => {
    const meter = buildTokenMeterModel({
      modelLabel: "gpt-5.6-luna",
      windowTokens: 272_000,
      messages: [
        {
          type: "assistant",
          usage: {
            prompt_tokens: 1200,
            completion_tokens: 80,
            prompt_tokens_details: { cached_tokens: 400 },
          },
        },
      ],
    });
    expect(meter.inputTokens).toBe(800);
    expect(meter.outputTokens).toBe(80);
    expect(meter.cacheReadTokens).toBe(400);
    expect(meter.usedTokens).toBe(1200);
    expect(meter.estimated).toBe(false);
  });

  it("keeps Anthropic exclusive input when cache is reported separately", () => {
    const meter = buildTokenMeterModel({
      modelLabel: "sonnet",
      windowTokens: 200_000,
      messages: [
        {
          type: "result",
          usage: {
            input_tokens: 3588,
            output_tokens: 100,
            cache_read_input_tokens: 20992,
          },
        },
      ],
    });
    expect(meter.inputTokens).toBe(3588);
    expect(meter.cacheReadTokens).toBe(20992);
    expect(meter.usedTokens).toBe(24580);
  });

  it("uses this conversation's messages instead of a leftover snapshot", () => {
    const meter = buildTokenMeterModel({
      modelLabel: "sonnet",
      windowTokens: 200_000,
      lastUsage: {
        inputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      messages: [
        {
          type: "result",
          usage: {
            input_tokens: 3588,
            output_tokens: 100,
            cache_read_input_tokens: 20992,
          },
        },
      ],
    });
    expect(meter.usedTokens).toBe(24580);
    expect(meter.inputTokens).toBe(3588);
    expect(meter.cacheReadTokens).toBe(20992);
    expect(meter.outputTokens).toBe(100);
  });

  it("does not let a larger leftover snapshot cover this conversation", () => {
    const meter = buildTokenMeterModel({
      modelLabel: "sonnet",
      windowTokens: 200_000,
      lastUsage: {
        inputTokens: 99999,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      messages: [
        {
          type: "result",
          usage: {
            input_tokens: 3588,
            output_tokens: 100,
            cache_read_input_tokens: 20992,
          },
        },
      ],
    });
    expect(meter.usedTokens).toBe(24580);
    expect(meter.inputTokens).toBe(3588);
  });

  it("ignores leftover lastUsage when this conversation has no messages", () => {
    const meter = buildTokenMeterModel({
      modelLabel: "sonnet",
      messages: [],
      lastUsage: {
        inputTokens: 99999,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    });
    expect(meter.usedTokens).toBe(0);
    expect(meter.estimated).toBe(true);
  });
});
