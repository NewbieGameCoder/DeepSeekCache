import { createHash, randomUUID } from "node:crypto";

import type { RequestLog } from "./types.js";

export function sha256Short(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = sortValue((value as Record<string, unknown>)[key]);
  }
  return out;
}

export interface ExtractedRequestShape {
  model?: string;
  stream?: boolean;
  messages: unknown[];
  tools: unknown[];
  requestHash: string;
  toolsHash: string;
  messagesHash: string;
  byteLength: number;
}

export function extractRequestShape(bodyText: string): ExtractedRequestShape {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  const requestMessages = Array.isArray(parsed.messages)
    ? parsed.messages
    : normalizeResponsesInput(parsed.input);
  const system = parsed.system ?? parsed.instructions;
  const messages = system === undefined
    ? requestMessages
    : [{ role: "system", content: system }, ...requestMessages];
  const tools = Array.isArray(parsed.tools) ? parsed.tools : [];
  return {
    model: typeof parsed.model === "string" ? parsed.model : undefined,
    stream: typeof parsed.stream === "boolean" ? parsed.stream : undefined,
    messages,
    tools,
    requestHash: sha256Short(bodyText),
    toolsHash: sha256Short(stableJson(tools)),
    messagesHash: sha256Short(stableJson(messages)),
    byteLength: Buffer.byteLength(bodyText),
  };
}

export function countCommonPrefixMessages(a: unknown[], b: unknown[]): number {
  const max = Math.min(a.length, b.length);
  let count = 0;
  for (let i = 0; i < max; i++) {
    if (stableJson(a[i]) !== stableJson(b[i])) break;
    count++;
  }
  return count;
}

export function classifyPrefixStability(
  previous: ExtractedRequestShape | null,
  current: ExtractedRequestShape,
): {
  prefixStable: boolean | null;
  commonPrefixMessages: number;
  findings: string[];
} {
  if (!previous) {
    return { prefixStable: null, commonPrefixMessages: 0, findings: [] };
  }
  const commonPrefixMessages = countCommonPrefixMessages(previous.messages, current.messages);
  const findings: string[] = [];
  if (previous.model && current.model && previous.model !== current.model)
    findings.push("model_changed");
  if (previous.toolsHash !== current.toolsHash) findings.push("tool_schema_changed");
  if (commonPrefixMessages < previous.messages.length) findings.push("message_prefix_drift");
  return {
    prefixStable: findings.length === 0,
    commonPrefixMessages,
    findings,
  };
}

export function usageFromResponseText(
  text: string,
  contentType = "",
): {
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
} {
  let usage: Record<string, unknown> | undefined;
  if (contentType.includes("text/event-stream")) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice("data:".length).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const parsed = JSON.parse(data) as Record<string, unknown>;
        if (parsed.usage && typeof parsed.usage === "object") {
          usage = { ...(usage ?? {}), ...(parsed.usage as Record<string, unknown>) };
        } else if (parsed.message && typeof parsed.message === "object") {
          const messageUsage = (parsed.message as Record<string, unknown>).usage;
          if (messageUsage && typeof messageUsage === "object") {
            usage = { ...(usage ?? {}), ...(messageUsage as Record<string, unknown>) };
          }
        } else if (parsed.response && typeof parsed.response === "object") {
          const responseUsage = (parsed.response as Record<string, unknown>).usage;
          if (responseUsage && typeof responseUsage === "object") {
            usage = { ...(usage ?? {}), ...(responseUsage as Record<string, unknown>) };
          }
        }
      } catch {
        // Ignore malformed SSE frames.
      }
    }
  } else {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (parsed.usage && typeof parsed.usage === "object") {
        usage = parsed.usage as Record<string, unknown>;
      }
    } catch {
      // Non-JSON response.
    }
  }
  const promptTokens = numberField(usage, "prompt_tokens", "promptTokens", "input_tokens");
  const completionTokens = numberField(usage, "completion_tokens", "completionTokens", "output_tokens");
  const cacheHitTokens = numberField(
    usage,
    "prompt_cache_hit_tokens",
    "promptCacheHitTokens",
    "cached_tokens",
    "cache_read_input_tokens",
  ) || nestedNumberField(usage, "input_tokens_details", "cached_tokens");
  const cacheMissTokens =
    numberField(
      usage,
      "prompt_cache_miss_tokens",
      "promptCacheMissTokens",
      "cache_creation_input_tokens",
    ) ||
    Math.max(0, promptTokens - cacheHitTokens);
  return { promptTokens, completionTokens, cacheHitTokens, cacheMissTokens };
}

function normalizeResponsesInput(input: unknown): unknown[] {
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (!Array.isArray(input)) return [];
  return input.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const record = item as Record<string, unknown>;
    if (record.type === "message") {
      return {
        role: record.role,
        content: normalizeResponsesContent(record.content),
      };
    }
    return item;
  });
}

function normalizeResponsesContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return part;
    const record = part as Record<string, unknown>;
    if (typeof record.text === "string") return { type: record.type, text: record.text };
    return part;
  });
}

function numberField(obj: Record<string, unknown> | undefined, ...keys: string[]): number {
  if (!obj) return 0;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

function nestedNumberField(
  obj: Record<string, unknown> | undefined,
  parent: string,
  key: string,
): number {
  const nested = obj?.[parent];
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) return 0;
  const value = (nested as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function makeRequestLog(input: {
  method: string;
  path: string;
  bodyText: string;
  previous: ExtractedRequestShape | null;
  sessionId?: string;
  statusCode?: number;
  responseText?: string;
  responseContentType?: string;
}): { shape: ExtractedRequestShape; log: RequestLog } {
  const shape = extractRequestShape(input.bodyText);
  const stability = classifyPrefixStability(input.previous, shape);
  const usage = usageFromResponseText(input.responseText ?? "", input.responseContentType ?? "");
  const findings = [...stability.findings];
  if (!input.sessionId) findings.push("request_unmapped_to_session");
  if (shape.messages.length > 0 && usage.promptTokens === 0 && usage.cacheHitTokens === 0) {
    findings.push("missing_cache_usage");
  }
  const denom = usage.cacheHitTokens + usage.cacheMissTokens;
  const cacheHitRatio = denom > 0 ? usage.cacheHitTokens / denom : 0;
  return {
    shape,
    log: {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      method: input.method,
      path: input.path,
      model: shape.model,
      stream: shape.stream,
      sessionId: input.sessionId,
      requestHash: shape.requestHash,
      toolsHash: shape.toolsHash,
      messagesHash: shape.messagesHash,
      messageCount: shape.messages.length,
      byteLength: shape.byteLength,
      prefixStable: stability.prefixStable,
      commonPrefixMessages: stability.commonPrefixMessages,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      cacheHitTokens: usage.cacheHitTokens,
      cacheMissTokens: usage.cacheMissTokens,
      cacheHitRatio,
      statusCode: input.statusCode,
      findings,
    },
  };
}
