import { describe, expect, it } from "vitest";
import {
  buildTokenMeterModel,
  catalogContextWindow,
  estimateContextWindow,
  formatTokenCount,
  isSubagentUsageMessage,
  lastTurnUsage,
  mergeTokenUsageSnapshots,
  streamEventCountsAsReplyProgress,
  usageFromAnthropicStreamEvent,
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
    expect(meter.usedTokens).toBe(21550);
    expect(meter.remainingTokens).toBe(250_450);
    expect(meter.percent).toBe(8);
    expect(meter.cacheReadTokens).toBe(17862);
    expect(meter.cacheCreationTokens).toBe(0);
    expect(formatTokenCount(meter.usedTokens)).toBe("21,550");
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
      cacheCreationKnown: false,
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
      cacheCreationKnown: false,
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
    expect(meter.usedTokens).toBe(1680);
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
    expect(meter.usedTokens).toBe(3868);
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
    expect(meter.usedTokens).toBe(126_892);
    expect(meter.inputTokens).toBe(66_121);
    expect(meter.cacheReadTokens).toBe(53_760);
    expect(meter.percent).toBe(47);
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
    expect(meter.usedTokens).toBe(1280);
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
    expect(meter.usedTokens).toBe(24680);
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
    expect(meter.usedTokens).toBe(24680);
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
    expect(meter.usedTokens).toBe(24680);
    expect(meter.inputTokens).toBe(3588);
  });

  it("uses the latest assistant request instead of cumulative result usage", () => {
    const meter = buildTokenMeterModel({
      modelLabel: "sonnet",
      windowTokens: 200_000,
      messages: [
        {
          type: "assistant",
          message: {
            usage: {
              input_tokens: 4_000,
              output_tokens: 80,
              cache_read_input_tokens: 1_000,
            },
          },
        },
        {
          type: "assistant",
          message: {
            usage: {
              input_tokens: 12_000,
              output_tokens: 200,
              cache_read_input_tokens: 3_000,
            },
          },
        },
        {
          type: "result",
          usage: {
            input_tokens: 90_000,
            output_tokens: 4_000,
            cache_read_input_tokens: 180_000,
          },
        },
      ],
    });
    expect(meter.inputTokens).toBe(12_000);
    expect(meter.cacheReadTokens).toBe(3_000);
    expect(meter.usedTokens).toBe(15_200);
    expect(meter.percent).toBe(8);
  });

  it("shows the rewritten result usage instead of the summed turn", () => {
    // Device run: one turn, two upstream calls (18,894 then 22,400). Claude's
    // raw result.usage is the sum. These assistant messages carry no usage, so
    // the meter can only display result.usage. The proxy rewrite is what
    // replaces the sum with the last call before this fixture exists. Leaving
    // the sum in result.usage fails the assertion below.
    const lastRequest = {
      input_tokens: 22_400,
      output_tokens: 63,
      cache_read_input_tokens: 0,
    };
    const summedResult = {
      input_tokens: 18_894 + 22_400,
      output_tokens: 32 + 63,
      cache_read_input_tokens: 0,
    };
    const meter = buildTokenMeterModel({
      modelLabel: "gpt-6-luna",
      windowTokens: 272_000,
      messages: [
        { type: "user" },
        { type: "assistant", message: {} },
        { type: "user" },
        { type: "assistant", message: {} },
        { type: "result", usage: lastRequest },
      ],
    });
    expect(meter.inputTokens).toBe(lastRequest.input_tokens);
    expect(meter.outputTokens).toBe(lastRequest.output_tokens);
    expect(meter.cacheReadTokens).toBe(0);
    expect(meter.usedTokens).toBe(22_463);
    expect(meter.inputTokens).not.toBe(summedResult.input_tokens);
    expect(meter.outputTokens).not.toBe(summedResult.output_tokens);

    const unrewritten = buildTokenMeterModel({
      modelLabel: "gpt-6-luna",
      windowTokens: 272_000,
      messages: [
        { type: "assistant", message: {} },
        { type: "result", usage: summedResult },
      ],
    });
    expect(unrewritten.inputTokens).toBe(summedResult.input_tokens);
    expect(unrewritten.outputTokens).toBe(summedResult.output_tokens);
  });

  it("ignores subagent usage when measuring the root context", () => {
    const meter = buildTokenMeterModel({
      modelLabel: "sonnet",
      windowTokens: 200_000,
      messages: [
        {
          type: "assistant",
          message: {
            usage: {
              input_tokens: 2_000,
              cache_read_input_tokens: 500,
              output_tokens: 10,
            },
          },
        },
        {
          type: "assistant",
          parent_tool_use_id: "toolu_sub",
          message: {
            usage: {
              input_tokens: 80_000,
              cache_read_input_tokens: 80_000,
              output_tokens: 20,
            },
          },
        },
      ],
    });
    expect(meter.usedTokens).toBe(2_510);
  });

  it("does not count an unread Read result before a later request reports it", () => {
    const meter = buildTokenMeterModel({
      modelLabel: "tencent/Hy4-preview",
      windowTokens: 200_000,
      messages: [
        { type: "user" },
        {
          type: "assistant",
          message: {
            usage: { input_tokens: 800, output_tokens: 20 },
          },
        },
        { type: "user" },
      ],
    });
    expect(meter.usedTokens).toBe(820);
    expect(meter.percent).toBe(0);
  });

  it("counts the manuscript only after a later request includes it", () => {
    const meter = buildTokenMeterModel({
      modelLabel: "tencent/Hy4-preview",
      windowTokens: 200_000,
      messages: [
        {
          type: "assistant",
          message: {
            usage: { input_tokens: 800, output_tokens: 20 },
          },
        },
        { type: "user" },
        {
          type: "assistant",
          message: {
            usage: { input_tokens: 20_000, output_tokens: 30 },
          },
        },
      ],
    });
    expect(meter.usedTokens).toBe(20_030);
    expect(meter.percent).toBe(10);
  });

  it("uses the latest Codex request instead of summing tool-loop inputs", () => {
    const meter = buildTokenMeterModel({
      modelLabel: "gpt-6-luna",
      windowTokens: 272_000,
      messages: [
        { type: "user" },
        {
          type: "assistant",
          message: {
            usage: {
              input_tokens: 94_800,
              cached_input_tokens: 80_000,
              output_tokens: 1_000,
            },
          },
        },
        { type: "user" },
        {
          type: "assistant",
          message: {
            usage: {
              input_tokens: 99_600,
              cached_input_tokens: 90_000,
              output_tokens: 1_965,
            },
          },
        },
      ],
    });
    expect(meter.inputTokens).toBe(9_600);
    expect(meter.cacheReadTokens).toBe(90_000);
    expect(meter.outputTokens).toBe(1_965);
    expect(meter.usedTokens).toBe(101_565);
    expect(meter.usedTokens).not.toBe(189_600);
  });

  it("reads DeepSeek, Gemini, and Codex cache fields", () => {
    const deepseek = buildTokenMeterModel({
      modelLabel: "deepseek-v4-pro",
      windowTokens: 1_000_000,
      messages: [
        {
          type: "assistant",
          usage: {
            prompt_tokens: 4_000,
            completion_tokens: 20,
            prompt_cache_hit_tokens: 3_200,
          },
        },
      ],
    });
    expect(deepseek.cacheReadTokens).toBe(3_200);
    expect(deepseek.inputTokens).toBe(800);
    expect(deepseek.usedTokens).toBe(4_020);

    const gemini = buildTokenMeterModel({
      modelLabel: "gemini-2.5-pro",
      windowTokens: 1_000_000,
      messages: [
        {
          type: "assistant",
          usage: {
            promptTokenCount: 5_000,
            output_tokens: 30,
            cachedContentTokenCount: 4_100,
          },
        },
      ],
    });
    expect(gemini.cacheReadTokens).toBe(4_100);
    expect(gemini.inputTokens).toBe(900);
    expect(gemini.usedTokens).toBe(5_030);
  });

  it("does not let a missing cache field wipe a value from the same request", () => {
    const merged = mergeTokenUsageSnapshots(
      {
        inputTokens: 8_000,
        outputTokens: 10,
        cacheReadTokens: 90_000,
        cacheCreationTokens: 100,
      },
      {
        inputTokens: 8_000,
        outputTokens: 40,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        cacheReadKnown: false,
        cacheCreationKnown: false,
      },
    );
    expect(merged.cacheReadTokens).toBe(90_000);
    expect(merged.cacheCreationTokens).toBe(100);
    expect(merged.outputTokens).toBe(40);
    expect(merged.cacheReadKnown).toBeUndefined();
  });

  it("keeps exclusive input of 0 when the whole prompt was cached", () => {
    const merged = mergeTokenUsageSnapshots(
      {
        inputTokens: 500,
        outputTokens: 10,
        cacheReadTokens: 1_000,
        cacheCreationTokens: 0,
      },
      {
        inputTokens: 0,
        outputTokens: 20,
        cacheReadTokens: 18_000,
        cacheCreationTokens: 0,
      },
    );
    expect(merged.inputTokens).toBe(0);
    expect(merged.cacheReadTokens).toBe(18_000);
    expect(merged.outputTokens).toBe(20);
  });

  it("zeros cache when a later turn omits the cache fields", () => {
    const merged = mergeTokenUsageSnapshots(
      {
        inputTokens: 8_000,
        outputTokens: 10,
        cacheReadTokens: 90_000,
        cacheCreationTokens: 100,
      },
      {
        inputTokens: 12_000,
        outputTokens: 40,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        cacheReadKnown: false,
        cacheCreationKnown: false,
      },
    );
    expect(merged.inputTokens).toBe(12_000);
    expect(merged.cacheReadTokens).toBe(0);
    expect(merged.cacheCreationTokens).toBe(0);
    expect(merged.outputTokens).toBe(40);
    expect(merged.cacheReadKnown).toBe(false);
    expect(merged.cacheCreationKnown).toBe(false);
  });

  it("publishes the known flag when a snapshot omits cache write", () => {
    const last = lastTurnUsage([
      {
        type: "assistant",
        message: {
          usage: {
            input_tokens: 10,
            output_tokens: 2,
            cache_read_input_tokens: 4,
          },
        },
      },
    ]);
    expect(last).toEqual({
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 4,
      cacheCreationTokens: 0,
      cacheCreationKnown: false,
    });
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

  it("keeps a folded cache split when the inclusive total matches", () => {
    const split = {
      inputTokens: 1_406,
      outputTokens: 0,
      cacheReadTokens: 22_912,
      cacheCreationTokens: 0,
    };
    const folded = {
      inputTokens: 24_318,
      outputTokens: 71,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
    expect(mergeTokenUsageSnapshots(folded, split)).toEqual({
      inputTokens: 1_406,
      outputTokens: 71,
      cacheReadTokens: 22_912,
      cacheCreationTokens: 0,
    });
    expect(mergeTokenUsageSnapshots(split, folded)).toEqual({
      inputTokens: 1_406,
      outputTokens: 71,
      cacheReadTokens: 22_912,
      cacheCreationTokens: 0,
    });
    expect(
      mergeTokenUsageSnapshots(split, {
        inputTokens: 27_553,
        outputTokens: 71,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      }),
    ).toEqual({
      inputTokens: 27_553,
      outputTokens: 71,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });

  it("shows the last request output when assistant snapshots still say zero", () => {
    const meter = buildTokenMeterModel({
      modelLabel: "Qwen/Qwen3.5-35B-A3B",
      windowTokens: 262_144,
      messages: [
        {
          type: "assistant",
          message: {
            usage: {
              input_tokens: 22_933,
              output_tokens: 0,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          },
        },
        {
          type: "assistant",
          message: {
            usage: {
              input_tokens: 31_511,
              output_tokens: 0,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          },
        },
        {
          type: "result",
          usage: {
            input_tokens: 54_444,
            output_tokens: 111,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      ],
      lastUsage: {
        inputTokens: 31_511,
        outputTokens: 64,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    });
    expect(meter.inputTokens).toBe(31_511);
    expect(meter.outputTokens).toBe(64);
    expect(meter.cacheReadTokens).toBe(0);
    expect(meter.usedTokens).toBe(31_575);
  });

  it("parses anthropic passthrough usage without summing start and delta", () => {
    const start = usageFromAnthropicStreamEvent({
      type: "message_start",
      message: {
        usage: {
          input_tokens: 1_406,
          output_tokens: 0,
          cache_read_input_tokens: 22_912,
          cache_creation_input_tokens: 0,
        },
      },
    });
    const delta = usageFromAnthropicStreamEvent({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 80 },
    });
    expect(start?.outputTokens).toBe(0);
    expect(delta?.inputTokens).toBe(0);
    const merged = mergeTokenUsageSnapshots(start, delta!);
    expect(merged).toEqual({
      inputTokens: 1_406,
      outputTokens: 80,
      cacheReadTokens: 22_912,
      cacheCreationTokens: 0,
    });
    expect(
      streamEventCountsAsReplyProgress({
        type: "content_block_delta",
        delta: { type: "thinking_delta", thinking: "..." },
      }),
    ).toBe(true);
    expect(streamEventCountsAsReplyProgress({ type: "ping" })).toBe(false);
    expect(usageFromAnthropicStreamEvent({ type: "ping" })).toBeNull();
  });

  it("replaces output when the next request's message_start still says zero", () => {
    const merged = mergeTokenUsageSnapshots(
      {
        inputTokens: 22_933,
        outputTokens: 47,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        requestKey: "msg_1",
      },
      {
        inputTokens: 31_511,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        requestKey: "msg_2",
      },
    );
    expect(merged).toEqual({
      inputTokens: 31_511,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      requestKey: "msg_2",
    });
    expect(
      mergeTokenUsageSnapshots(
        {
          inputTokens: 22_933,
          outputTokens: 47,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
        {
          inputTokens: 31_511,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        },
      ).outputTokens,
    ).toBe(0);
  });

  it("takes the later snapshot when two requests share an inclusive total", () => {
    expect(
      mergeTokenUsageSnapshots(
        {
          inputTokens: 1_406,
          outputTokens: 80,
          cacheReadTokens: 22_912,
          cacheCreationTokens: 0,
        },
        {
          inputTokens: 2_000,
          outputTokens: 10,
          cacheReadTokens: 22_318,
          cacheCreationTokens: 0,
        },
      ),
    ).toEqual({
      inputTokens: 2_000,
      outputTokens: 10,
      cacheReadTokens: 22_318,
      cacheCreationTokens: 0,
    });
  });

  it("shows the in-flight request instead of the previous assistant", () => {
    const meter = buildTokenMeterModel({
      modelLabel: "Qwen/Qwen3.5-35B-A3B",
      windowTokens: 200_000,
      inFlight: true,
      messages: [
        {
          type: "assistant",
          message: {
            usage: {
              input_tokens: 23_267,
              output_tokens: 94,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          },
        },
        { type: "user" },
      ],
      lastUsage: {
        inputTokens: 27_350,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        requestKey: "msg_next",
      },
    });
    expect(meter.inputTokens).toBe(27_350);
    expect(meter.outputTokens).toBe(0);
    expect(meter.usedTokens).toBe(27_350);
  });

  it("treats agent_id and user_id JSON as sub-agent traffic", () => {
    expect(isSubagentUsageMessage({ parent_tool_use_id: "toolu_1" })).toBe(
      true,
    );
    expect(isSubagentUsageMessage({ agent_id: "writer" })).toBe(true);
    expect(
      isSubagentUsageMessage({
        metadata: { user_id: '{"parent_tool_use_id":"toolu_parent"}' },
      }),
    ).toBe(true);
    expect(
      isSubagentUsageMessage({
        user_id: '{"agent_id":"writer"}',
        message: { content: "not scanned" },
      }),
    ).toBe(true);
    expect(isSubagentUsageMessage({ user_id: "session-user" })).toBe(false);
    expect(
      lastTurnUsage([
        {
          type: "assistant",
          message: {
            usage: {
              input_tokens: 100,
              output_tokens: 8,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          },
        },
        {
          type: "assistant",
          agent_id: "writer",
          message: {
            usage: {
              input_tokens: 9_000,
              output_tokens: 999,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          },
        },
      ]),
    ).toEqual({
      inputTokens: 100,
      outputTokens: 8,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });
});
