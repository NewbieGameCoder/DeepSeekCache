import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { anchorStatus, updateAnchor } from "./anchor.js";
import { detectOpencode } from "./detect.js";
import {
  claudeHookStatus,
  codexHookStatus,
  hookStatus,
  installClaudeHook,
  installCodexHook,
  installHook,
  uninstallClaudeHook,
  uninstallCodexHook,
  uninstallHook,
} from "./installer.js";
import { defaultDataDir, defaultProjectRoot } from "./paths.js";
import { DCacheStore } from "./store.js";
import {
  DCACHE_VERSION,
  type InstallOptions,
  type RuntimeStatus,
} from "./types.js";
import { renderDashboard } from "./web.js";

export interface DCacheServerOptions extends InstallOptions {
  host?: string;
  port?: number;
  proxyPort?: number;
  upstreamBaseUrl?: string;
  anthropicUpstreamBaseUrl?: string;
  autoPort?: boolean;
  maxPortAttempts?: number;
}

export interface StartedDCacheServer {
  close: () => Promise<void>;
  url: string;
  proxyUrl: string;
  store: DCacheStore;
}

export async function startDCacheServer(
  opts: DCacheServerOptions = {},
): Promise<StartedDCacheServer> {
  const projectRoot = defaultProjectRoot(opts.projectRoot);
  const dataDir = opts.dataDir ?? defaultDataDir(projectRoot);
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 48731;
  const proxyPort = opts.proxyPort ?? 11488;
  const autoPort = opts.autoPort ?? true;
  const maxPortAttempts = opts.maxPortAttempts ?? 50;
  const upstreamBaseUrl =
    opts.upstreamBaseUrl ??
    process.env.DCACHE_UPSTREAM_BASE_URL ??
    "https://api.deepseek.com/v1";
  const anthropicUpstreamBaseUrl =
    opts.anthropicUpstreamBaseUrl ??
    process.env.DCACHE_ANTHROPIC_UPSTREAM_BASE_URL ??
    opts.upstreamBaseUrl ??
    "https://api.anthropic.com";
  const store = new DCacheStore(dataDir);
  const apiContext = {
    projectRoot,
    dataDir,
    sidecarUrl: opts.sidecarUrl ?? `http://${host}:${port}`,
    proxyBaseUrl: opts.proxyBaseUrl ?? `http://${host}:${proxyPort}/v1`,
    store,
  };

  const api = createServer(async (req, res) => {
    try {
      await handleApi(req, res, apiContext);
    } catch (err) {
      sendJson(res, 500, { ok: false, error: (err as Error).message });
    }
  });
  const proxy = createServer(async (req, res) => {
    try {
      await handleProxy(req, res, {
        store,
        upstreamBaseUrl,
        anthropicUpstreamBaseUrl,
        dataDir,
        projectRoot,
      });
    } catch (err) {
      await store.recordFinding({
        type: "proxy_error",
        severity: "error",
        message: (err as Error).message,
      });
      sendJson(res, 502, { error: (err as Error).message });
    }
  });

  try {
    await listenWithPortFallback(api, port, host, {
      autoPort,
      maxAttempts: maxPortAttempts,
    });
    const actualPort = listeningPort(api);
    apiContext.sidecarUrl = opts.sidecarUrl ?? `http://${host}:${actualPort}`;

    await listenWithPortFallback(proxy, proxyPort, host, {
      autoPort,
      maxAttempts: maxPortAttempts,
      unavailablePorts: new Set([actualPort]),
    });
    const actualProxyPort = listeningPort(proxy);
    apiContext.proxyBaseUrl = opts.proxyBaseUrl ?? `http://${host}:${actualProxyPort}/v1`;
  } catch (err) {
    await Promise.allSettled([closeServer(api), closeServer(proxy)]);
    throw err;
  }

  return {
    url: apiContext.sidecarUrl,
    proxyUrl: apiContext.proxyBaseUrl,
    store,
    close: async () => {
      await Promise.all([closeServer(api), closeServer(proxy)]);
    },
  };
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: {
    projectRoot: string;
    dataDir: string;
    sidecarUrl: string;
    proxyBaseUrl: string;
    store: DCacheStore;
  },
): Promise<void> {
  addCors(res);
  if (!isAllowedApiOrigin(req)) {
    sendJson(res, 403, {
      ok: false,
      error: "cross-origin API requests are blocked",
    });
    return;
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/") {
    const status = runtimeStatus(ctx);
    sendHtml(
      res,
      renderDashboard(status, ctx.store.readRequests(), ctx.store.readFindings(), ctx.store.readEvents()),
    );
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/status") {
    sendJson(res, 200, runtimeStatus(ctx));
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/anchor") {
    sendJson(res, 200, anchorStatus(ctx.dataDir, { projectRoot: ctx.projectRoot }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/anchor") {
    const body = await readBody(req);
    const input = JSON.parse(body || "{}") as {
      enabled?: unknown;
      content?: unknown;
      reset?: unknown;
    };
    const status = updateAnchor(ctx.dataDir, input, {
      projectRoot: ctx.projectRoot,
      reason: input.reset === true ? "manual_reset" : undefined,
    });
    await ctx.store.recordAnchorChange({
      source: "web",
      action: anchorAction(input),
      message: "anchor updated from web dashboard",
      status,
      detail: {
        enabled: typeof input.enabled === "boolean" ? input.enabled : undefined,
        hasContent: typeof input.content === "string" && input.content.trim().length > 0,
        reset: input.reset === true,
      },
    });
    sendJson(res, 200, status);
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/report") {
    sendJson(res, 200, {
      summary: ctx.store.report(),
      requests: ctx.store.readRequests(),
      findings: ctx.store.readFindings(),
      events: ctx.store.readEvents(),
      anchorEvents: ctx.store.readAnchorEvents(),
    });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/hook") {
    const body = await readBody(req);
    const input = JSON.parse(body || "{}") as { connectApi?: unknown; routeProvider?: unknown };
    const result = installHook({
      projectRoot: ctx.projectRoot,
      dataDir: ctx.dataDir,
      sidecarUrl: ctx.sidecarUrl,
      proxyBaseUrl: ctx.proxyBaseUrl,
      routeProvider: input.connectApi === true || input.routeProvider === true,
    });
    sendJson(res, 200, result);
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/claude/hook") {
    const body = await readBody(req);
    const input = JSON.parse(body || "{}") as { connectApi?: unknown; routeProvider?: unknown };
    const result = installClaudeHook({
      projectRoot: ctx.projectRoot,
      dataDir: ctx.dataDir,
      sidecarUrl: ctx.sidecarUrl,
      proxyBaseUrl: ctx.proxyBaseUrl,
      routeProvider: input.connectApi === true || input.routeProvider === true,
    });
    sendJson(res, 200, result);
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/codex/hook") {
    const body = await readBody(req);
    const input = JSON.parse(body || "{}") as { connectApi?: unknown; routeProvider?: unknown };
    const result = installCodexHook({
      projectRoot: ctx.projectRoot,
      dataDir: ctx.dataDir,
      sidecarUrl: ctx.sidecarUrl,
      proxyBaseUrl: ctx.proxyBaseUrl,
      routeProvider: input.connectApi === true || input.routeProvider === true,
    });
    sendJson(res, 200, result);
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/uninstall") {
    const result = uninstallHook({
      projectRoot: ctx.projectRoot,
      dataDir: ctx.dataDir,
      sidecarUrl: ctx.sidecarUrl,
      proxyBaseUrl: ctx.proxyBaseUrl,
    });
    sendJson(res, 200, result);
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/claude/uninstall") {
    const result = uninstallClaudeHook({
      projectRoot: ctx.projectRoot,
      dataDir: ctx.dataDir,
      sidecarUrl: ctx.sidecarUrl,
      proxyBaseUrl: ctx.proxyBaseUrl,
    });
    sendJson(res, 200, result);
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/codex/uninstall") {
    const result = uninstallCodexHook({
      projectRoot: ctx.projectRoot,
      dataDir: ctx.dataDir,
      sidecarUrl: ctx.sidecarUrl,
      proxyBaseUrl: ctx.proxyBaseUrl,
    });
    sendJson(res, 200, result);
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/opencode/event") {
    const body = await readBody(req);
    await ctx.store.recordHookEvent(JSON.parse(body || "{}"));
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/claude/event") {
    const body = await readBody(req);
    await ctx.store.recordHookEvent({ runtime: "claude", ...JSON.parse(body || "{}") });
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/codex/event") {
    const body = await readBody(req);
    await ctx.store.recordHookEvent({ runtime: "codex", ...JSON.parse(body || "{}") });
    sendJson(res, 200, { ok: true });
    return;
  }
  sendJson(res, 404, { ok: false, error: "not found" });
}

async function handleProxy(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: {
    store: DCacheStore;
    upstreamBaseUrl: string;
    anthropicUpstreamBaseUrl: string;
    dataDir: string;
    projectRoot: string;
  },
): Promise<void> {
  addCors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  const body = await readBody(req);
  const requestUrl = req.url ?? "/";
  const anthropic = isAnthropicRequest(requestUrl, req.headers);
  const responses = isOpenAIResponsesRequest(requestUrl);
  const bodyForUpstream = responses
    ? await buildCodexChatCompletionBody(body, ctx)
    : anthropic
      ? await maybeInjectClaudeProxyAnchor(body, requestUrl, ctx)
      : body;
  const upstreamUrl = buildUpstreamUrl(
    anthropic ? ctx.anthropicUpstreamBaseUrl : ctx.upstreamBaseUrl,
    responses ? "/v1/chat/completions" : requestUrl,
  );
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (!value || key.toLowerCase() === "host" || key.toLowerCase() === "content-length") continue;
    headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  const upstream = await fetch(upstreamUrl, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : bodyForUpstream,
  });
  const responseHeaders: Record<string, string> = {};
  upstream.headers.forEach((value, key) => {
    if (key.toLowerCase() !== "content-encoding" && key.toLowerCase() !== "content-length") {
      responseHeaders[key] = value;
    }
  });
  let responseText = "";
  let contentType = upstream.headers.get("content-type") ?? "";
  if (responses) {
    const upstreamText = await upstream.text();
    const translated = translateChatCompletionToResponses({
      statusCode: upstream.status,
      requestBodyText: body,
      upstreamText,
      upstreamContentType: contentType,
    });
    contentType = translated.contentType;
    responseText = translated.body;
    res.writeHead(upstream.status, {
      ...responseHeaders,
      "content-type": translated.contentType,
      "cache-control": "no-cache",
    });
    res.end(responseText);
  } else {
    res.writeHead(upstream.status, responseHeaders);
    const responseBuffer = await streamResponse(upstream, res);
    responseText = responseBuffer.toString("utf8");
    res.end();
  }
  if (shouldRecordProxyRequest(req.url ?? "")) {
    await ctx.store.recordProxyRequest({
      method: req.method ?? "GET",
      path: req.url ?? "/",
      bodyText: bodyForUpstream,
      sessionId: extractProxySessionId(req.headers),
      statusCode: upstream.status,
      responseText,
      responseContentType: contentType,
    });
  }
}

async function maybeInjectClaudeProxyAnchor(
  bodyText: string,
  requestUrl: string,
  ctx: { store: DCacheStore; dataDir: string; projectRoot: string },
): Promise<string> {
  if (process.env.DCACHE_DISABLE_CLAUDE_PROXY_ANCHOR === "1") return bodyText;
  if (!isAnthropicMessagesRequest(requestUrl)) return bodyText;
  const status = anchorStatus(ctx.dataDir, { projectRoot: ctx.projectRoot });
  if (!status.enabled || !status.content.trim()) return bodyText;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    return bodyText;
  }
  const anchor = formatProxyAnchor(status, "claude-proxy");
  const system = parsed.system;
  if (typeof system === "string" && system.startsWith("dcache stable cache anchor.")) {
    return bodyText;
  }
  if (
    Array.isArray(system) &&
    system.some((part) => isRecord(part) && String(part.text ?? "").startsWith("dcache stable cache anchor."))
  ) {
    return bodyText;
  }
  parsed.system = prependAnchorToSystemString(anchor, system);
  const metadataUserIdNormalized = normalizeClaudeProxyMetadata(parsed, status);
  await ctx.store.recordHookEvent({
    timestamp: new Date().toISOString(),
    type: "cache_anchor.proxy_injected",
    runtime: "claude",
    payload: {
      anchorBytes: anchor.length,
      generation: status.generation,
      project: status.project,
      metadataUserIdNormalized,
    },
  });
  return `${JSON.stringify(parsed)}\n`;
}

async function buildCodexChatCompletionBody(
  bodyText: string,
  ctx: { store: DCacheStore; dataDir: string; projectRoot: string },
): Promise<string> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    return bodyText;
  }
  const messages = responsesInputToChatMessages(parsed.input);
  const instructions = typeof parsed.instructions === "string" ? parsed.instructions.trim() : "";
  if (instructions) {
    messages.unshift({ role: "system", content: instructions });
  }

  const status = anchorStatus(ctx.dataDir, { projectRoot: ctx.projectRoot });
  if (status.enabled && status.content.trim()) {
    const anchor = formatProxyAnchor(status, "codex-proxy");
    if (messages[0]?.role === "system") {
      messages[0] = {
        ...messages[0],
        content: `${anchor}\n\n${String(messages[0].content ?? "")}`.trim(),
      };
    } else {
      messages.unshift({ role: "system", content: anchor });
    }
    await ctx.store.recordHookEvent({
      timestamp: new Date().toISOString(),
      type: "cache_anchor.proxy_injected",
      runtime: "codex",
      session_id: typeof parsed.prompt_cache_key === "string" ? parsed.prompt_cache_key : undefined,
      payload: {
        anchorBytes: anchor.length,
        generation: status.generation,
        project: status.project,
      },
    });
  }

  const chatBody: Record<string, unknown> = {
    model: typeof parsed.model === "string" ? parsed.model : "deepseek-v4-flash",
    messages,
    stream: false,
  };
  if (typeof parsed.temperature === "number") chatBody.temperature = parsed.temperature;
  if (typeof parsed.top_p === "number") chatBody.top_p = parsed.top_p;
  const tools = responsesToolsToChatTools(parsed.tools);
  if (tools.length > 0) chatBody.tools = tools;
  if (parsed.tool_choice) chatBody.tool_choice = responsesToolChoiceToChatToolChoice(parsed.tool_choice);
  return `${JSON.stringify(chatBody)}\n`;
}

function responsesInputToChatMessages(input: unknown): Array<{ role: string; content: string }> {
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (!Array.isArray(input)) return [];
  const messages: Array<{ role: string; content: string }> = [];
  for (const item of input) {
    if (!isRecord(item)) continue;
    if (item.type === "message") {
      const role = normalizeChatRole(item.role);
      const content = responsesContentToText(item.content);
      if (content) messages.push({ role, content });
    } else if (item.type === "function_call_output") {
      const content = typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "");
      if (content) messages.push({ role: "tool", content });
    }
  }
  return messages.length > 0 ? messages : [{ role: "user", content: "" }];
}

function normalizeChatRole(role: unknown): string {
  if (role === "assistant") return "assistant";
  if (role === "system" || role === "developer") return "system";
  if (role === "tool") return "tool";
  return "user";
}

function responsesContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!isRecord(part)) return "";
      if (typeof part.text === "string") return part.text;
      if (typeof part.output_text === "string") return part.output_text;
      return "";
    })
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n");
}

function responsesToolsToChatTools(tools: unknown): unknown[] {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((tool): tool is Record<string, unknown> => isRecord(tool) && tool.type === "function")
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters ?? {},
        ...(typeof tool.strict === "boolean" ? { strict: tool.strict } : {}),
      },
    }));
}

function responsesToolChoiceToChatToolChoice(value: unknown): unknown {
  if (value === "auto" || value === "none" || value === "required") return value;
  if (isRecord(value) && value.type === "function") {
    return { type: "function", function: { name: value.name } };
  }
  return value;
}

function translateChatCompletionToResponses(opts: {
  statusCode: number;
  requestBodyText: string;
  upstreamText: string;
  upstreamContentType: string;
}): { body: string; contentType: string } {
  const request = parseJsonObject(opts.requestBodyText);
  const upstream = parseJsonObject(opts.upstreamText);
  if (opts.statusCode >= 400 || upstream.error) {
    return {
      body: opts.upstreamText,
      contentType: opts.upstreamContentType || "application/json; charset=utf-8",
    };
  }
  const model = stringValue(upstream.model) ?? stringValue(request.model) ?? "deepseek-v4-flash";
  const choice = Array.isArray(upstream.choices) && isRecord(upstream.choices[0])
    ? upstream.choices[0]
    : {};
  const message = isRecord(choice.message) ? choice.message : {};
  const content = typeof message.content === "string" ? message.content : "";
  const usage = responsesUsageFromChatUsage(isRecord(upstream.usage) ? upstream.usage : {});
  const response = makeResponsesObject({ model, content, usage, message });
  if (request.stream === true) {
    return {
      body: responsesSseBody(response),
      contentType: "text/event-stream; charset=utf-8",
    };
  }
  return {
    body: `${JSON.stringify(response)}\n`,
    contentType: "application/json; charset=utf-8",
  };
}

function makeResponsesObject(opts: {
  model: string;
  content: string;
  usage: Record<string, unknown>;
  message: Record<string, unknown>;
}): Record<string, unknown> {
  const id = `resp_dcache_${Date.now().toString(36)}`;
  const outputItem = chatMessageToResponseOutput(opts.message, opts.content);
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model: opts.model,
    output: [outputItem],
    parallel_tool_calls: false,
    previous_response_id: null,
    reasoning: null,
    store: false,
    temperature: null,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    top_p: null,
    truncation: "disabled",
    usage: opts.usage,
    user: null,
    metadata: {},
  };
}

function chatMessageToResponseOutput(
  message: Record<string, unknown>,
  content: string,
): Record<string, unknown> {
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const firstToolCall = toolCalls.find((toolCall): toolCall is Record<string, unknown> =>
    isRecord(toolCall),
  );
  const fn = isRecord(firstToolCall?.function) ? firstToolCall.function : undefined;
  if (firstToolCall && fn) {
    return {
      id: stringValue(firstToolCall.id) ?? `fc_${Date.now().toString(36)}`,
      type: "function_call",
      status: "completed",
      call_id: stringValue(firstToolCall.id) ?? `call_${Date.now().toString(36)}`,
      name: stringValue(fn.name) ?? "unknown",
      arguments: stringValue(fn.arguments) ?? "{}",
    };
  }
  return {
    id: `msg_${Date.now().toString(36)}`,
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text: content, annotations: [] }],
  };
}

function responsesUsageFromChatUsage(usage: Record<string, unknown>): Record<string, unknown> {
  const inputTokens = numberValue(usage.prompt_tokens) || numberValue(usage.input_tokens);
  const outputTokens = numberValue(usage.completion_tokens) || numberValue(usage.output_tokens);
  const cachedTokens =
    numberValue(usage.prompt_cache_hit_tokens) ||
    numberValue(usage.cached_tokens) ||
    numberValue(usage.cache_read_input_tokens);
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
    input_tokens_details: { cached_tokens: cachedTokens },
    output_tokens_details: { reasoning_tokens: numberValue(usage.reasoning_tokens) },
  };
}

function responsesSseBody(response: Record<string, unknown>): string {
  const output = Array.isArray(response.output) && isRecord(response.output[0])
    ? response.output[0]
    : {};
  const content = Array.isArray(output.content) && isRecord(output.content[0])
    ? output.content[0]
    : undefined;
  const text = typeof content?.text === "string" ? content.text : "";
  const events: Array<[string, unknown]> = [
    ["response.created", { type: "response.created", response: { ...response, status: "in_progress", output: [] } }],
    ["response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { ...output, status: "in_progress", content: [] } }],
  ];
  if (output.type === "function_call") {
    events.push(["response.output_item.done", { type: "response.output_item.done", output_index: 0, item: output }]);
  } else {
    events.push(
      ["response.content_part.added", { type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }],
      ["response.output_text.delta", { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text }],
      ["response.output_text.done", { type: "response.output_text.done", output_index: 0, content_index: 0, text }],
      ["response.content_part.done", { type: "response.content_part.done", output_index: 0, content_index: 0, part: content ?? { type: "output_text", text, annotations: [] } }],
      ["response.output_item.done", { type: "response.output_item.done", output_index: 0, item: output }],
    );
  }
  events.push(["response.completed", { type: "response.completed", response }]);
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function formatProxyAnchor(status: ReturnType<typeof anchorStatus>, runtime: string): string {
  return [
    "dcache stable cache anchor.",
    [
      `runtime: ${runtime}`,
      `generation: ${status.generation}`,
      `last_reset_at: ${status.lastResetAt ?? status.updatedAt ?? "not-reset"}`,
      `last_reset_reason: ${status.lastResetReason ?? "none"}`,
      `project: ${formatProject(status.project)}`,
    ].join("\n"),
    "Stable project context:",
    status.content.trim(),
  ].join("\n\n");
}

function prependAnchorToSystemString(anchor: string, system: unknown): string {
  const existing = normalizeAnthropicSystemToText(system);
  return existing ? `${anchor}\n\n${existing}` : anchor;
}

function normalizeAnthropicSystemToText(system: unknown): string {
  if (typeof system === "string") return system.trim();
  if (!Array.isArray(system)) return "";
  return system
    .map((part) => {
      if (typeof part === "string") return part;
      if (isRecord(part) && typeof part.text === "string") return part.text;
      if (isRecord(part) && typeof part.content === "string") return part.content;
      return "";
    })
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n");
}

function formatProject(project: ReturnType<typeof anchorStatus>["project"]): string {
  if (!project) return "unknown";
  return `${project.kind}:${project.label}:${project.id}`;
}

function normalizeClaudeProxyMetadata(
  parsed: Record<string, unknown>,
  status: ReturnType<typeof anchorStatus>,
): boolean {
  if (process.env.DCACHE_KEEP_CLAUDE_METADATA_USER_ID === "1") return false;
  if (!isRecord(parsed.metadata)) return false;
  const metadata = { ...parsed.metadata };
  const stableUserId = stableClaudeProxyUserId(status);
  if (metadata.user_id === stableUserId) return false;
  metadata.user_id = stableUserId;
  parsed.metadata = metadata;
  return true;
}

function stableClaudeProxyUserId(status: ReturnType<typeof anchorStatus>): string {
  const projectId = status.project?.id ?? "unknown-project";
  return `dcache:${projectId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function runtimeStatus(ctx: {
  projectRoot: string;
  dataDir: string;
  sidecarUrl: string;
  proxyBaseUrl: string;
  store: DCacheStore;
}): RuntimeStatus {
  const status = hookStatus({
    projectRoot: ctx.projectRoot,
    dataDir: ctx.dataDir,
    sidecarUrl: ctx.sidecarUrl,
    proxyBaseUrl: ctx.proxyBaseUrl,
  });
  const claude = claudeHookStatus({
    projectRoot: ctx.projectRoot,
    dataDir: ctx.dataDir,
    sidecarUrl: ctx.sidecarUrl,
    proxyBaseUrl: ctx.proxyBaseUrl,
  });
  const codex = codexHookStatus({
    projectRoot: ctx.projectRoot,
    dataDir: ctx.dataDir,
    sidecarUrl: ctx.sidecarUrl,
    proxyBaseUrl: ctx.proxyBaseUrl,
  });
  return {
    version: DCACHE_VERSION,
    hooked: status.hooked,
    claudeHooked: claude.hooked,
    codexHooked: codex.hooked,
    newAnchorCommandInstalled: status.newAnchorCommandInstalled,
    claudeNewAnchorCommandInstalled: claude.newAnchorCommandInstalled,
    codexNewAnchorCommandInstalled: codex.newAnchorCommandInstalled,
    configPath: status.configPath,
    pluginPath: status.pluginPath,
    newAnchorCommandPath: status.newAnchorCommandPath,
    claudeConfigPath: claude.configPath,
    claudeHookPath: claude.pluginPath,
    claudeNewAnchorCommandPath: claude.newAnchorCommandPath,
    codexConfigPath: codex.profilePath,
    codexHooksPath: codex.configPath,
    codexHookPath: codex.pluginPath,
    codexNewAnchorCommandPath: codex.newAnchorCommandPath,
    newAnchorScriptPath: status.newAnchorScriptPath,
    dataDir: ctx.dataDir,
    sidecarUrl: ctx.sidecarUrl,
    proxyBaseUrl: ctx.proxyBaseUrl,
    anchor: anchorStatus(ctx.dataDir, { projectRoot: ctx.projectRoot }),
    detection: detectOpencode(ctx.projectRoot),
    report: ctx.store.report(),
  };
}

function anchorAction(input: {
  enabled?: unknown;
  content?: unknown;
  reset?: unknown;
}): string {
  if (input.reset === true) return "reset";
  if (input.enabled === false) return "disable";
  if (input.enabled === true && typeof input.content === "string" && input.content.trim()) {
    return "save_enable";
  }
  if (input.enabled === true) return "enable";
  if (typeof input.content === "string") return input.content.trim() ? "save" : "clear";
  return "update";
}

function shouldRecordProxyRequest(requestUrl: string): boolean {
  const pathname = new URL(requestUrl, "http://dcache.local").pathname;
  return (
    pathname.endsWith("/chat/completions") ||
    pathname.endsWith("/messages") ||
    pathname.endsWith("/responses")
  );
}

function isOpenAIResponsesRequest(requestUrl: string): boolean {
  const pathname = new URL(requestUrl, "http://dcache.local").pathname;
  return pathname === "/v1/responses" || pathname === "/responses";
}

function extractProxySessionId(headers: IncomingMessage["headers"]): string | undefined {
  const direct = headers["session-id"] ?? headers["thread-id"] ?? headers["x-codex-window-id"];
  if (typeof direct === "string" && direct.trim()) return direct.trim().split(":")[0];
  const metadata = headers["x-codex-turn-metadata"];
  const raw = Array.isArray(metadata) ? metadata[0] : metadata;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const sessionId = parsed.session_id ?? parsed.thread_id;
      if (typeof sessionId === "string" && sessionId.trim()) return sessionId.trim();
    } catch {
      // Ignore malformed metadata.
    }
  }
  return undefined;
}

function isAnthropicRequest(
  requestUrl: string,
  headers: IncomingMessage["headers"],
): boolean {
  const pathname = new URL(requestUrl, "http://dcache.local").pathname;
  return (
    pathname === "/v1/messages" ||
    pathname === "/v1/messages/count_tokens" ||
    Boolean(headers["anthropic-version"] || headers["x-claude-code-session-id"])
  );
}

function isAnthropicMessagesRequest(requestUrl: string): boolean {
  const pathname = new URL(requestUrl, "http://dcache.local").pathname;
  return pathname === "/v1/messages";
}

function buildUpstreamUrl(upstreamBaseUrl: string, requestUrl: string): string {
  const incoming = new URL(requestUrl, "http://dcache.local");
  const base = new URL(upstreamBaseUrl.endsWith("/") ? upstreamBaseUrl : `${upstreamBaseUrl}/`);
  const basePath = base.pathname.replace(/\/+$/, "");
  const stripVersion = basePath.endsWith("/v1") || base.hostname.includes("deepseek");
  const path = stripVersion && incoming.pathname.startsWith("/v1/")
    ? incoming.pathname.slice("/v1/".length)
    : incoming.pathname.replace(/^\//, "");
  const out = new URL(path, base);
  out.search = incoming.search;
  return out.toString();
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  addCors(res);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value, null, 2));
}

function sendHtml(res: ServerResponse, html: string): void {
  addCors(res);
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

function addCors(res: ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader(
    "access-control-allow-headers",
    "content-type,authorization,x-api-key,anthropic-version,anthropic-beta,x-claude-code-session-id,x-claude-code-agent-id,x-claude-code-parent-agent-id",
  );
}

function isAllowedApiOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (process.env.DCACHE_ALLOW_CROSS_ORIGIN_API === "1") return true;
  const host = req.headers.host;
  if (!host) return false;
  try {
    const originUrl = new URL(Array.isArray(origin) ? origin[0] : origin);
    return originUrl.host.toLowerCase() === String(host).toLowerCase();
  } catch {
    return false;
  }
}

async function streamResponse(upstream: Response, res: ServerResponse): Promise<Buffer> {
  if (!upstream.body) {
    return Buffer.alloc(0);
  }
  const chunks: Buffer[] = [];
  const reader = upstream.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value ?? new Uint8Array();
    const buffer = Buffer.from(chunk);
    chunks.push(buffer);
    res.write(buffer);
  }
  return Buffer.concat(chunks);
}

function listen(
  server: ReturnType<typeof createServer>,
  port: number,
  host: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onListening = () => {
      cleanup();
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    try {
      server.listen(port, host);
    } catch (err) {
      cleanup();
      reject(err);
    }
  });
}

async function listenWithPortFallback(
  server: ReturnType<typeof createServer>,
  requestedPort: number,
  host: string,
  opts: { autoPort: boolean; maxAttempts: number; unavailablePorts?: Set<number> },
): Promise<void> {
  const ports = candidatePorts(requestedPort, opts.maxAttempts);
  let lastError: unknown;
  for (const port of ports) {
    if (opts.unavailablePorts?.has(port)) {
      lastError = Object.assign(new Error(`Port ${port} is already reserved by dcache.`), {
        code: "EADDRINUSE",
      });
      if (!opts.autoPort) break;
      continue;
    }
    try {
      await listen(server, port, host);
      return;
    } catch (err) {
      lastError = err;
      if (!opts.autoPort || requestedPort === 0 || !isAddressInUse(err)) throw err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("No available port found.");
}

function candidatePorts(requestedPort: number, maxAttempts: number): number[] {
  if (requestedPort === 0) return [0];
  const attempts = Math.max(1, maxAttempts);
  const ports: number[] = [];
  for (let port = requestedPort; port <= 65535 && ports.length < attempts; port++) {
    ports.push(port);
  }
  return ports;
}

function isAddressInUse(err: unknown): boolean {
  return Boolean(
    err && typeof err === "object" && (err as NodeJS.ErrnoException).code === "EADDRINUSE",
  );
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function listeningPort(server: ReturnType<typeof createServer>): number {
  const address = server.address();
  if (address && typeof address === "object") return (address as AddressInfo).port;
  throw new Error("dcache server is not listening on a TCP port.");
}

export function dockerComposeTemplate(): string {
  return `services:
  dcache:
    build: .
    image: dcache:local
    restart: unless-stopped
    environment:
      DCACHE_UPSTREAM_BASE_URL: https://api.deepseek.com/v1
      DCACHE_ANTHROPIC_UPSTREAM_BASE_URL: https://api.anthropic.com
    ports:
      - "\${DCACHE_WEB_PORT:-48731}:48731"
      - "\${DCACHE_PROXY_PORT:-11488}:11488"
    volumes:
      - ./:/workspace
      - dcache-data:/data
    command:
      - serve
      - --project
      - /workspace
      - --data-dir
      - /data
      - --host
      - 0.0.0.0
      - --sidecar-url
      - http://127.0.0.1:\${DCACHE_WEB_PORT:-48731}
      - --proxy-base-url
      - http://127.0.0.1:\${DCACHE_PROXY_PORT:-11488}/v1
      - --port
      - "48731"
      - --proxy-port
      - "11488"

volumes:
  dcache-data:
`;
}
