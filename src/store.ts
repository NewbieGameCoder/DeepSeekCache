import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";

import { type ExtractedRequestShape, extractRequestShape, makeRequestLog } from "./prefix.js";
import type {
  CacheAnchorStatus,
  Finding,
  OpencodeHookEvent,
  ReportSummary,
  RequestLog,
} from "./types.js";

export class DCacheStore {
  private previousUnmappedShape: ExtractedRequestShape | null = null;
  private readonly previousShapeBySession = new Map<string, ComparableRequestShapes>();
  private activeSessionId: string | undefined;

  constructor(readonly dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    const requests = this.readRequests();
    const last = requests[requests.length - 1];
    if (last) {
      // The exact prior shape is not persisted to avoid storing full prompts.
      // Runtime prefix checks are exact while the sidecar process is alive;
      // after restart the next request is treated as a new baseline.
      this.activeSessionId = last.sessionId;
    }
    this.activeSessionId ??= findLastSessionId(this.readEvents());
  }

  async recordHookEvent(event: OpencodeHookEvent): Promise<void> {
    const normalized = {
      ...event,
      timestamp: event.timestamp ?? new Date().toISOString(),
    };
    const sessionId = extractSessionId(normalized);
    if (sessionId) this.activeSessionId = sessionId;
    await this.appendJson("events.ndjson", normalized);
    if (normalized.type === "plugin.initialized") {
      await this.recordFinding({
        type: "plugin_event",
        severity: "info",
        sessionId,
        message: "opencode plugin initialized",
        detail: normalized.payload,
      });
    } else if (normalized.type === "claude.SessionStart") {
      await this.recordFinding({
        type: "plugin_event",
        severity: "info",
        sessionId,
        message: "claude hook initialized",
        detail: normalized.payload,
      });
    } else if (normalized.type === "codex.SessionStart") {
      await this.recordFinding({
        type: "plugin_event",
        severity: "info",
        sessionId,
        message: "codex hook initialized",
        detail: normalized.payload,
      });
    }
  }

  async recordAnchorChange(input: {
    source: "web" | "newanchor" | "hook";
    action: string;
    message: string;
    status: CacheAnchorStatus;
    runtime?: "opencode" | "claude";
    detail?: unknown;
  }): Promise<void> {
    await this.appendJson("events.ndjson", {
      timestamp: new Date().toISOString(),
      type: "cache_anchor.changed",
      runtime: input.runtime,
      payload: {
        source: input.source,
        action: input.action,
        message: input.message,
        enabled: input.status.enabled,
        stateEnabled: input.status.stateEnabled,
        configured: input.status.configured,
        generation: input.status.generation,
        resetCount: input.status.resetCount,
        lastResetAt: input.status.lastResetAt,
        lastResetReason: input.status.lastResetReason,
        project: input.status.project,
        detail: input.detail,
      },
    });
  }

  async recordProxyRequest(input: {
    method: string;
    path: string;
    bodyText: string;
    sessionId?: string;
    statusCode?: number;
    responseText?: string;
    responseContentType?: string;
  }): Promise<RequestLog> {
    const sessionId = input.sessionId ?? this.activeSessionId ?? findLastSessionId(this.readEvents());
    const currentShape = extractRequestShape(input.bodyText);
    const previous = sessionId
      ? previousComparableShape(this.previousShapeBySession.get(sessionId), currentShape)
      : this.previousUnmappedShape;
    const { shape, log } = makeRequestLog({
      ...input,
      previous,
      sessionId,
    });
    if (sessionId) rememberComparableShape(this.previousShapeBySession, sessionId, shape);
    else this.previousUnmappedShape = shape;
    await this.appendJson("requests.ndjson", log);
    for (const finding of log.findings) {
      await this.recordFinding({
        type: finding as Finding["type"],
        severity:
          finding === "missing_cache_usage" || finding === "request_unmapped_to_session"
            ? "warn"
            : "error",
        requestId: log.id,
        sessionId: log.sessionId,
        message: findingMessage(finding),
        detail: {
          path: log.path,
          model: log.model,
          commonPrefixMessages: log.commonPrefixMessages,
          messageCount: log.messageCount,
        },
      });
    }
    return log;
  }

  async recordFinding(input: Omit<Finding, "id" | "timestamp">): Promise<Finding> {
    const finding: Finding = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      ...input,
    };
    await this.appendJson("findings.ndjson", finding);
    return finding;
  }

  readEvents(): OpencodeHookEvent[] {
    return readNdjson<OpencodeHookEvent>(join(this.dataDir, "events.ndjson"));
  }

  readAnchorEvents(): OpencodeHookEvent[] {
    return this.readEvents().filter((event) => event.type?.startsWith("cache_anchor."));
  }

  readRequests(): RequestLog[] {
    return readNdjson<RequestLog>(join(this.dataDir, "requests.ndjson"));
  }

  readFindings(): Finding[] {
    return readNdjson<Finding>(join(this.dataDir, "findings.ndjson"));
  }

  report(): ReportSummary {
    const requests = this.readRequests();
    const events = this.readEvents();
    const anchorEvents = events.filter((event) => event.type?.startsWith("cache_anchor."));
    const codexEventSteps = events.filter((event) => event.type?.startsWith("codex.")).length;
    const codexRequestSteps = requests.filter((request) =>
      new URL(request.path, "http://dcache.local").pathname.endsWith("/responses"),
    ).length;
    const findings = this.readFindings();
    const eventUsage = summarizeEventUsage(events);
    const sessions = new Set<string>();
    let mappedRequests = 0;
    let stableKnown = 0;
    let stableCount = 0;
    let cacheHitTokens = 0;
    let cacheMissTokens = 0;
    let completionTokens = 0;
    let promptTokens = 0;
    for (const req of requests) {
      if (req.sessionId) {
        mappedRequests++;
        sessions.add(req.sessionId);
      }
      if (req.prefixStable !== null) {
        stableKnown++;
        if (req.prefixStable) stableCount++;
      }
      cacheHitTokens += req.cacheHitTokens;
      cacheMissTokens += req.cacheMissTokens;
      completionTokens += req.completionTokens;
      promptTokens += req.promptTokens;
    }
    if (requests.length === 0 && eventUsage.steps > 0) {
      promptTokens = eventUsage.inputTokens;
      completionTokens = eventUsage.outputTokens;
      cacheHitTokens = eventUsage.cacheReadTokens;
      cacheMissTokens = eventUsage.cacheWriteTokens;
      for (const sessionId of eventUsage.sessionIds) sessions.add(sessionId);
    }
    const denom = cacheHitTokens + cacheMissTokens;
    return {
      generatedAt: new Date().toISOString(),
      requests: requests.length,
      sessions: sessions.size,
      mappedRequests,
      unmappedRequests: requests.length - mappedRequests,
      prefixStableRate: stableKnown > 0 ? stableCount / stableKnown : 0,
      cacheHitRatio: denom > 0 ? cacheHitTokens / denom : 0,
      promptTokens,
      cacheHitTokens,
      cacheMissTokens,
      completionTokens,
      findings: findings.length,
      unhandledFindings: findings.filter((f) => f.severity !== "info").length,
      pluginEvents: events.length,
      anchorEvents: anchorEvents.length,
      opencodeSteps: eventUsage.steps,
      codexSteps: codexEventSteps + codexRequestSteps,
      lastRequestAt: requests[requests.length - 1]?.timestamp,
      lastAnchorEventAt: anchorEvents[anchorEvents.length - 1]?.timestamp,
    };
  }

  private async appendJson(file: string, value: unknown): Promise<void> {
    mkdirSync(this.dataDir, { recursive: true });
    await appendFile(join(this.dataDir, file), `${JSON.stringify(value)}\n`, "utf8");
  }
}

function readNdjson<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, "utf8");
  const out: T[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // Keep report generation resilient if a process died mid-write.
    }
  }
  return out;
}

function extractSessionId(event: OpencodeHookEvent): string | undefined {
  if (event.sessionId) return event.sessionId;
  if (event.session_id) return event.session_id;
  const payload = event.payload as Record<string, unknown> | undefined;
  const inner = payload?.event as Record<string, unknown> | undefined;
  const properties = [
    payload?.session_id,
    payload?.sessionID,
    payload?.sessionId,
    (payload?.session as Record<string, unknown> | undefined)?.id,
    inner?.sessionID,
    inner?.sessionId,
    (inner?.session as Record<string, unknown> | undefined)?.id,
    (inner?.properties as Record<string, unknown> | undefined)?.sessionID,
    (inner?.properties as Record<string, unknown> | undefined)?.sessionId,
  ];
  return properties.find((v): v is string => typeof v === "string" && v.length > 0);
}

function findLastSessionId(events: OpencodeHookEvent[]): string | undefined {
  for (const event of [...events].reverse()) {
    const sessionId = extractSessionId(event);
    if (sessionId) return sessionId;
  }
  return undefined;
}

function summarizeEventUsage(events: OpencodeHookEvent[]): {
  steps: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  sessionIds: Set<string>;
} {
  const out = {
    steps: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    sessionIds: new Set<string>(),
  };
  for (const event of events) {
    const sessionId = extractSessionId(event);
    if (sessionId) out.sessionIds.add(sessionId);
    const tokens = extractEventTokens(event);
    if (!tokens) continue;
    out.steps++;
    out.inputTokens += numberValue(tokens.input);
    out.outputTokens += numberValue(tokens.output);
    const cache = isRecord(tokens.cache) ? tokens.cache : {};
    out.cacheReadTokens += numberValue(cache.read);
    out.cacheWriteTokens += numberValue(cache.write);
  }
  return out;
}

function extractEventTokens(event: OpencodeHookEvent): Record<string, unknown> | undefined {
  const payload = event.payload as Record<string, unknown> | undefined;
  const inner = payload?.event as Record<string, unknown> | undefined;
  const tokens = inner?.tokens;
  return isRecord(tokens) ? tokens : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

interface ComparableRequestShapes {
  withTools?: ExtractedRequestShape;
  withoutTools?: ExtractedRequestShape;
}

function previousComparableShape(
  shapes: ComparableRequestShapes | undefined,
  current: ExtractedRequestShape,
): ExtractedRequestShape | null {
  if (!shapes) return null;
  return current.tools.length > 0
    ? (shapes.withTools ?? null)
    : (shapes.withoutTools ?? null);
}

function rememberComparableShape(
  bySession: Map<string, ComparableRequestShapes>,
  sessionId: string,
  shape: ExtractedRequestShape,
): void {
  const shapes = bySession.get(sessionId) ?? {};
  if (shape.tools.length > 0) shapes.withTools = shape;
  else shapes.withoutTools = shape;
  bySession.set(sessionId, shapes);
}

function findingMessage(type: string): string {
  switch (type) {
    case "request_unmapped_to_session":
      return "LLM request could not be correlated to a runtime session event.";
    case "model_changed":
      return "The model changed between adjacent requests; prefix cache may reset.";
    case "tool_schema_changed":
      return "The serialized tool schema changed between adjacent requests.";
    case "message_prefix_drift":
      return "The previous request messages are not an element-prefix of this request.";
    case "missing_cache_usage":
      return "Provider response did not expose DeepSeek cache usage fields.";
    default:
      return `Finding: ${type}`;
  }
}

export function writeJsonFile(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
