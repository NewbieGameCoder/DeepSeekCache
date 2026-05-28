import { describe, expect, it } from "vitest";

import {
  classifyPrefixStability,
  extractRequestShape,
  makeRequestLog,
  usageFromResponseText,
} from "../src/prefix.js";

describe("opencode dcache prefix analysis", () => {
  it("treats the first request as a baseline and the next append-only request as stable", () => {
    const first = extractRequestShape(
      JSON.stringify({
        model: "deepseek-chat",
        messages: [
          { role: "system", content: "s" },
          { role: "user", content: "one" },
        ],
        tools: [{ type: "function", function: { name: "read" } }],
      }),
    );
    const second = extractRequestShape(
      JSON.stringify({
        model: "deepseek-chat",
        messages: [
          { role: "system", content: "s" },
          { role: "user", content: "one" },
          { role: "assistant", content: "two" },
          { role: "user", content: "three" },
        ],
        tools: [{ type: "function", function: { name: "read" } }],
      }),
    );

    expect(classifyPrefixStability(null, first)).toEqual({
      prefixStable: null,
      commonPrefixMessages: 0,
      findings: [],
    });
    expect(classifyPrefixStability(first, second)).toEqual({
      prefixStable: true,
      commonPrefixMessages: 2,
      findings: [],
    });
  });

  it("flags model, tool, and message prefix drift independently", () => {
    const first = extractRequestShape(
      JSON.stringify({
        model: "deepseek-chat",
        messages: [
          { role: "system", content: "stable" },
          { role: "user", content: "one" },
        ],
        tools: [{ function: { name: "read" } }],
      }),
    );
    const second = extractRequestShape(
      JSON.stringify({
        model: "deepseek-reasoner",
        messages: [
          { role: "system", content: "changed" },
          { role: "user", content: "one" },
        ],
        tools: [{ function: { name: "write" } }],
      }),
    );

    const verdict = classifyPrefixStability(first, second);
    expect(verdict.prefixStable).toBe(false);
    expect(verdict.findings).toEqual([
      "model_changed",
      "tool_schema_changed",
      "message_prefix_drift",
    ]);
  });

  it("extracts DeepSeek cache usage from JSON and SSE responses", () => {
    expect(
      usageFromResponseText(
        JSON.stringify({
          usage: {
            prompt_tokens: 100,
            completion_tokens: 5,
            prompt_cache_hit_tokens: 90,
            prompt_cache_miss_tokens: 10,
          },
        }),
        "application/json",
      ),
    ).toEqual({
      promptTokens: 100,
      completionTokens: 5,
      cacheHitTokens: 90,
      cacheMissTokens: 10,
    });

    const sse = [
      "data: {}",
      'data: {"usage":{"prompt_tokens":80,"completion_tokens":3,"prompt_cache_hit_tokens":60}}',
      "data: [DONE]",
      "",
    ].join("\n\n");
    expect(usageFromResponseText(sse, "text/event-stream").cacheMissTokens).toBe(20);
  });

  it("extracts Anthropic Messages system shape and cache usage", () => {
    const first = extractRequestShape(
      JSON.stringify({
        model: "claude-sonnet-4-6",
        system: [{ type: "text", text: "stable claude system" }],
        messages: [{ role: "user", content: [{ type: "text", text: "one" }] }],
        tools: [{ name: "read_policy", input_schema: { type: "object" } }],
      }),
    );
    const second = extractRequestShape(
      JSON.stringify({
        model: "claude-sonnet-4-6",
        system: [{ type: "text", text: "stable claude system" }],
        messages: [
          { role: "user", content: [{ type: "text", text: "one" }] },
          { role: "assistant", content: [{ type: "text", text: "ok" }] },
          { role: "user", content: [{ type: "text", text: "two" }] },
        ],
        tools: [{ input_schema: { type: "object" }, name: "read_policy" }],
      }),
    );

    expect(classifyPrefixStability(first, second)).toEqual({
      prefixStable: true,
      commonPrefixMessages: 2,
      findings: [],
    });
    expect(
      usageFromResponseText(
        JSON.stringify({
          usage: {
            input_tokens: 200,
            output_tokens: 12,
            cache_read_input_tokens: 160,
            cache_creation_input_tokens: 40,
          },
        }),
        "application/json",
      ),
    ).toEqual({
      promptTokens: 200,
      completionTokens: 12,
      cacheHitTokens: 160,
      cacheMissTokens: 40,
    });
  });

  it("creates request logs with actionable findings", () => {
    const first = makeRequestLog({
      method: "POST",
      path: "/v1/chat/completions",
      bodyText: JSON.stringify({ model: "m", messages: [{ role: "user", content: "a" }] }),
      previous: null,
      responseText: JSON.stringify({ usage: { prompt_tokens: 10, prompt_cache_hit_tokens: 0 } }),
      responseContentType: "application/json",
    });
    const second = makeRequestLog({
      method: "POST",
      path: "/v1/chat/completions",
      bodyText: JSON.stringify({ model: "m", messages: [{ role: "user", content: "b" }] }),
      previous: first.shape,
      responseText: JSON.stringify({
        usage: { prompt_tokens: 10, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 10 },
      }),
      responseContentType: "application/json",
    });

    expect(second.log.findings).toContain("message_prefix_drift");
    expect(second.log.findings).toContain("request_unmapped_to_session");
  });

  it("models realistic long-system, append-only, tool-change, and compact-like drift", () => {
    const longSystem = [
      "You are a finance transformation architect.",
      "Keep the ERP rollout, audit, data residency, and approval policy context stable.",
      "Respond with concise implementation controls and measurable risk signals.",
    ].join(" ");
    const baseline = extractRequestShape(
      JSON.stringify({
        model: "deepseek-chat",
        messages: [
          { role: "system", content: longSystem },
          { role: "user", content: "Assess invoice approval controls for five subsidiaries." },
        ],
        tools: [{ type: "function", function: { name: "read_policy", parameters: { type: "object" } } }],
      }),
    );
    const appended = extractRequestShape(
      JSON.stringify({
        model: "deepseek-chat",
        messages: [
          { role: "system", content: longSystem },
          { role: "user", content: "Assess invoice approval controls for five subsidiaries." },
          { role: "assistant", content: "Use maker-checker controls and exception logs." },
          { role: "user", content: "Add SOX evidence retention and quarterly reporting." },
        ],
        tools: [{ function: { parameters: { type: "object" }, name: "read_policy" }, type: "function" }],
      }),
    );
    const compacted = extractRequestShape(
      JSON.stringify({
        model: "deepseek-chat",
        messages: [
          { role: "system", content: longSystem },
          {
            role: "user",
            content:
              "Compacted summary: invoice controls, SOX evidence, and exception reporting. Continue from this summary.",
          },
        ],
        tools: [{ type: "function", function: { name: "read_policy", parameters: { type: "object" } } }],
      }),
    );
    const changedTools = extractRequestShape(
      JSON.stringify({
        model: "deepseek-chat",
        messages: appended.messages,
        tools: [{ type: "function", function: { name: "read_ledger", parameters: { type: "object" } } }],
      }),
    );

    expect(classifyPrefixStability(baseline, appended)).toEqual({
      prefixStable: true,
      commonPrefixMessages: 2,
      findings: [],
    });
    expect(classifyPrefixStability(appended, compacted).findings).toContain("message_prefix_drift");
    expect(classifyPrefixStability(appended, changedTools).findings).toEqual([
      "tool_schema_changed",
    ]);
  });
});

