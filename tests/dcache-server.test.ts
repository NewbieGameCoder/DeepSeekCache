import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { dockerComposeTemplate, startDCacheServer } from "../src/server.js";

const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];
let previousCodexHome: string | undefined;

function tempRoot(): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "dcache-server-")));
  roots.push(root);
  return root;
}

afterEach(async () => {
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  previousCodexHome = undefined;
  await Promise.all(closers.splice(0).map((fn) => fn()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function useTempCodexHome(root: string): void {
  previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(root, ".codex-home");
}

describe("opencode dcache sidecar server", () => {
  it("serves hook/uninstall APIs, captures proxy requests, and reports effectiveness", async () => {
    const root = tempRoot();
    const upstream = await startMockDeepSeek();
    closers.push(upstream.close);
    const sidecar = await startDCacheServer({
      projectRoot: root,
      dataDir: join(root, ".dcache"),
      port: 0,
      proxyPort: 0,
      upstreamBaseUrl: upstream.url,
    });
    closers.push(sidecar.close);

    const hook = await fetch(`${sidecar.url}/api/hook`, { method: "POST" }).then((r) => r.json());
    expect(hook.ok).toBe(true);

    await fetch(`${sidecar.url}/api/opencode/event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "session.created", payload: { session: { id: "s1" } } }),
    });

    await postChat(sidecar.proxyUrl, [
      { role: "system", content: "stable" },
      { role: "user", content: "first" },
    ]);
    await postChat(sidecar.proxyUrl, [
      { role: "system", content: "stable" },
      { role: "user", content: "first" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "second" },
    ]);

    const report = await fetch(`${sidecar.url}/api/report`).then((r) => r.json());
    expect(report.summary.requests).toBe(2);
    expect(report.summary.mappedRequests).toBe(2);
    expect(report.summary.prefixStableRate).toBe(1);
    expect(report.summary.cacheHitRatio).toBeGreaterThan(0.5);
    expect(String(await fetch(sidecar.url).then((r) => r.text()))).toContain(
      "dcache DeepSeek cache report",
    );

    await postChat(sidecar.proxyUrl, [{ role: "user", content: "escape check" }], {
      model: "<script>alert(1)</script>",
    });
    const html = String(await fetch(sidecar.url).then((r) => r.text()));
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");

    const unhook = await fetch(`${sidecar.url}/api/uninstall`, { method: "POST" }).then((r) =>
      r.json(),
    );
    expect(unhook.ok).toBe(true);
  });

  it("blocks cross-origin web API access to hook and report endpoints", async () => {
    const root = tempRoot();
    const upstream = await startMockDeepSeek();
    closers.push(upstream.close);
    const sidecar = await startDCacheServer({
      projectRoot: root,
      dataDir: join(root, ".dcache"),
      port: 0,
      proxyPort: 0,
      upstreamBaseUrl: upstream.url,
    });
    closers.push(sidecar.close);

    const blockedReport = await fetch(`${sidecar.url}/api/report`, {
      headers: { origin: "https://evil.example" },
    });
    expect(blockedReport.status).toBe(403);

    const blockedHook = await fetch(`${sidecar.url}/api/claude/hook`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: "{}",
    });
    expect(blockedHook.status).toBe(403);
    expect(existsSync(join(root, ".claude", "hooks", "dcache.mjs"))).toBe(false);

    const sameOriginHook = await fetch(`${sidecar.url}/api/claude/hook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: new URL(sidecar.url).origin,
      },
      body: "{}",
    }).then((r) => r.json());
    expect(sameOriginHook.ok).toBe(true);
  });

  it("serves Claude hook APIs and captures Anthropic Messages cache telemetry", async () => {
    const root = tempRoot();
    const upstream = await startMockAnthropic();
    closers.push(upstream.close);
    const sidecar = await startDCacheServer({
      projectRoot: root,
      dataDir: join(root, ".dcache"),
      port: 0,
      proxyPort: 0,
      upstreamBaseUrl: upstream.url,
    });
    closers.push(sidecar.close);

    const hook = await fetch(`${sidecar.url}/api/claude/hook`, { method: "POST" }).then((r) =>
      r.json(),
    );
    expect(hook.ok).toBe(true);

    await fetch(`${sidecar.url}/api/claude/event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "claude.SessionStart",
        runtime: "claude",
        session_id: "claude-session",
        payload: { hook_event_name: "SessionStart", session_id: "claude-session", cwd: root },
      }),
    });

    await postMessages(sidecar.proxyUrl, [
      { role: "user", content: [{ type: "text", text: "first" }] },
    ]);
    await postMessages(sidecar.proxyUrl, [
      { role: "user", content: [{ type: "text", text: "first" }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: [{ type: "text", text: "second" }] },
    ]);

    const report = await fetch(`${sidecar.url}/api/report`).then((r) => r.json());
    expect(upstream.paths).toContain("/v1/messages");
    expect(report.summary.requests).toBe(2);
    expect(report.summary.mappedRequests).toBe(2);
    expect(report.summary.cacheHitTokens).toBe(260);
    expect(report.summary.cacheMissTokens).toBe(40);
    expect(report.requests[1].prefixStable).toBe(true);
    expect(String(await fetch(sidecar.url).then((r) => r.text()))).toContain("Hook Claude");

    const unhook = await fetch(`${sidecar.url}/api/claude/uninstall`, { method: "POST" }).then(
      (r) => r.json(),
    );
    expect(unhook.ok).toBe(true);
  });

  it("serves Codex hook APIs and translates Responses traffic to DeepSeek cache telemetry", async () => {
    const root = tempRoot();
    useTempCodexHome(root);
    const upstream = await startMockDeepSeek();
    closers.push(upstream.close);
    const sidecar = await startDCacheServer({
      projectRoot: root,
      dataDir: join(root, ".dcache"),
      port: 0,
      proxyPort: 0,
      upstreamBaseUrl: upstream.url,
    });
    closers.push(sidecar.close);

    const hook = await fetch(`${sidecar.url}/api/codex/hook`, { method: "POST" }).then((r) =>
      r.json(),
    );
    expect(hook.ok).toBe(true);

    await fetch(`${sidecar.url}/api/codex/event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "codex.SessionStart",
        runtime: "codex",
        session_id: "codex-session",
        payload: { hook_event_name: "SessionStart", session_id: "codex-session", cwd: root },
      }),
    });

    await postResponses(sidecar.proxyUrl, "codex-session", "first");
    await postResponses(sidecar.proxyUrl, "codex-session", "second", true, true);

    expect(upstream.paths).toEqual(["/v1/chat/completions", "/v1/chat/completions"]);
    const upstreamBody = JSON.parse(upstream.bodies[0] ?? "{}");
    expect(upstreamBody.messages[0]).toMatchObject({
      role: "system",
      content: "stable codex context",
    });
    expect(upstreamBody.messages[1]).toMatchObject({ role: "user", content: "first" });
    expect(upstreamBody.stream).toBe(false);

    const report = await fetch(`${sidecar.url}/api/report`).then((r) => r.json());
    expect(report.summary.requests).toBe(2);
    expect(report.summary.mappedRequests).toBe(2);
    expect(report.summary.codexSteps).toBeGreaterThan(0);
    expect(report.summary.cacheHitTokens).toBe(160);
    expect(report.requests[1].prefixStable).toBe(true);
    const html = await fetch(sidecar.url).then((r) => r.text());
    expect(html).toContain("Hook Codex");
    expect(html).toContain("Codex steps");

    const unhook = await fetch(`${sidecar.url}/api/codex/uninstall`, { method: "POST" }).then(
      (r) => r.json(),
    );
    expect(unhook.ok).toBe(true);
  });

  it("injects enabled anchors at the front of Claude proxy messages", async () => {
    const root = tempRoot();
    const dataDir = join(root, ".dcache");
    const upstream = await startMockAnthropic();
    closers.push(upstream.close);
    const sidecar = await startDCacheServer({
      projectRoot: root,
      dataDir,
      port: 0,
      proxyPort: 0,
      upstreamBaseUrl: upstream.url,
    });
    closers.push(sidecar.close);

    const enabled = await fetch(`${sidecar.url}/api/anchor`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        content: "Stable Claude proxy anchor context.",
      }),
    }).then((r) => r.json());
    expect(enabled.enabled).toBe(true);

    await fetch(`${sidecar.url}/api/claude/event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "claude.SessionStart",
        runtime: "claude",
        session_id: "claude-proxy-anchor-session",
        payload: {
          hook_event_name: "SessionStart",
          session_id: "claude-proxy-anchor-session",
          cwd: root,
        },
      }),
    });
    await postMessages(
      sidecar.proxyUrl,
      [{ role: "user", content: [{ type: "text", text: "first" }] }],
      { metadata: { user_id: "volatile-claude-session" } },
    );

    const body = JSON.parse(upstream.bodies[0] ?? "{}");
    expect(body.system).toContain("dcache stable cache anchor.");
    expect(body.system).toContain("runtime: claude-proxy");
    expect(body.system).toContain("Stable Claude proxy anchor context.");
    expect(body.system).toContain("stable claude context");
    expect(body.system.indexOf("dcache stable cache anchor.")).toBeLessThan(
      body.system.indexOf("stable claude context"),
    );
    expect(body.metadata.user_id).toMatch(/^dcache:/);
    expect(body.metadata.user_id).not.toBe("volatile-claude-session");

    const report = await fetch(`${sidecar.url}/api/report`).then((r) => r.json());
    expect(report.summary.requests).toBe(1);
    expect(report.summary.anchorEvents).toBeGreaterThanOrEqual(2);
    expect(report.anchorEvents.map((event: any) => event.type)).toContain(
      "cache_anchor.proxy_injected",
    );
  });

  it("auto-selects free ports when requested ports are occupied", async () => {
    const root = tempRoot();
    const webBlocker = await startBareServer();
    closers.push(webBlocker.close);

    const sidecar = await startDCacheServer({
      projectRoot: root,
      dataDir: join(root, ".dcache-web-conflict"),
      port: webBlocker.port,
      proxyPort: 0,
    });
    closers.push(sidecar.close);
    expect(new URL(sidecar.url).port).not.toBe(String(webBlocker.port));
    expect(await fetch(`${sidecar.url}/api/status`).then((r) => r.json())).toMatchObject({
      sidecarUrl: sidecar.url,
      proxyBaseUrl: sidecar.proxyUrl,
    });

    await expect(
      startDCacheServer({
        projectRoot: root,
        dataDir: join(root, ".dcache-web-conflict-strict"),
        port: webBlocker.port,
        proxyPort: 0,
        autoPort: false,
      }),
    ).rejects.toHaveProperty("code", "EADDRINUSE");

    const proxyBlocker = await startBareServer();
    closers.push(proxyBlocker.close);
    const webPort = await reservePort();

    const sidecarWithProxyFallback = await startDCacheServer({
      projectRoot: root,
      dataDir: join(root, ".dcache-proxy-conflict"),
      port: webPort,
      proxyPort: proxyBlocker.port,
    });
    closers.push(sidecarWithProxyFallback.close);
    expect(new URL(sidecarWithProxyFallback.url).port).toBe(String(webPort));
    expect(new URL(sidecarWithProxyFallback.proxyUrl).port).not.toBe(String(proxyBlocker.port));
  });

  it("emits Docker templates that keep remapped host URLs in hook metadata", () => {
    const template = dockerComposeTemplate();

    expect(template).toContain("restart: unless-stopped");
    expect(template).toContain("${DCACHE_WEB_PORT:-48731}:48731");
    expect(template).toContain("${DCACHE_PROXY_PORT:-11488}:11488");
    expect(template).toContain("http://127.0.0.1:${DCACHE_WEB_PORT:-48731}");
    expect(template).toContain("http://127.0.0.1:${DCACHE_PROXY_PORT:-11488}/v1");
  });

  it("manages cross-session cache anchor state from the Web API", async () => {
    const root = tempRoot();
    const dataDir = join(root, ".dcache");
    const sidecar = await startDCacheServer({
      projectRoot: root,
      dataDir,
      port: 0,
      proxyPort: 0,
    });
    closers.push(sidecar.close);

    const initial = await fetch(`${sidecar.url}/api/anchor`).then((r) => r.json());
    expect(initial).toMatchObject({
      enabled: false,
      stateEnabled: false,
      configured: false,
      bytes: 0,
      content: "",
      generation: 0,
    });

    writeFileSync(join(dataDir, "cache-anchor.md"), "Legacy context.\n", "utf8");
    const legacyFile = await fetch(`${sidecar.url}/api/anchor`).then((r) => r.json());
    expect(legacyFile).toMatchObject({
      enabled: false,
      stateEnabled: false,
      configured: true,
      content: "Legacy context.\n",
      generation: 0,
    });

    const enabled = await fetch(`${sidecar.url}/api/anchor`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, content: "Stable APAC cache context." }),
    }).then((r) => r.json());
    expect(enabled).toMatchObject({
      enabled: true,
      stateEnabled: true,
      configured: true,
      generation: 1,
      resetCount: 1,
      lastResetReason: "manual_enable",
    });
    expect(readFileSync(join(dataDir, "cache-anchor.md"), "utf8")).toContain(
      "Stable APAC cache context.",
    );

    const html = await fetch(sidecar.url).then((r) => r.text());
    expect(html).toContain("Cross-session cache anchor");
    expect(html).toContain("Stable APAC cache context.");

    const disabled = await fetch(`${sidecar.url}/api/anchor`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    }).then((r) => r.json());
    expect(disabled).toMatchObject({ enabled: false, stateEnabled: false, configured: true });
    expect(existsSync(join(dataDir, "cache-anchor.md"))).toBe(false);
    expect(readFileSync(join(dataDir, "cache-anchor.disabled.md"), "utf8")).toContain(
      "Stable APAC cache context.",
    );

    const reenabled = await fetch(`${sidecar.url}/api/anchor`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    }).then((r) => r.json());
    expect(reenabled).toMatchObject({
      enabled: true,
      stateEnabled: true,
      configured: true,
      generation: 2,
      resetCount: 2,
    });
    expect(existsSync(join(dataDir, "cache-anchor.disabled.md"))).toBe(false);

    const reset = await fetch(`${sidecar.url}/api/anchor`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reset: true }),
    }).then((r) => r.json());
    expect(reset).toMatchObject({
      enabled: true,
      generation: 3,
      resetCount: 3,
      lastResetReason: "manual_reset",
    });

    const report = await fetch(`${sidecar.url}/api/report`).then((r) => r.json());
    expect(report.summary.anchorEvents).toBe(4);
    expect(report.anchorEvents.map((event: any) => event.payload.action)).toEqual([
      "save_enable",
      "disable",
      "enable",
      "reset",
    ]);
    const updatedHtml = await fetch(sidecar.url).then((r) => r.text());
    expect(updatedHtml).toContain("Anchor change log");
    expect(updatedHtml).toContain("save_enable");
    expect(updatedHtml).toContain("manual_reset");
  });

  it("tracks realistic same-session and compact-like cache scenarios per session", async () => {
    const root = tempRoot();
    const upstream = await startMockDeepSeek();
    closers.push(upstream.close);
    const sidecar = await startDCacheServer({
      projectRoot: root,
      dataDir: join(root, ".dcache"),
      port: 0,
      proxyPort: 0,
      upstreamBaseUrl: upstream.url,
    });
    closers.push(sidecar.close);

    await recordSession(sidecar.url, "business-session");
    const longSystem = [
      "You are a strict enterprise architecture reviewer.",
      "Keep account, invoice, approval, and audit requirements stable.",
      "Prefer cache-friendly append-only context.",
    ].join(" ");
    const tools = [
      { type: "function", function: { name: "read_policy", parameters: { type: "object" } } },
    ];
    await postChat(sidecar.proxyUrl, [
      { role: "system", content: "Generate a short title for this session." },
      { role: "user", content: "APAC invoice approval controls." },
    ]);
    await postChat(sidecar.proxyUrl, [
      { role: "system", content: longSystem },
      { role: "user", content: "Design invoice approval controls for APAC subsidiaries." },
    ], { tools });
    await postChat(sidecar.proxyUrl, [
      { role: "system", content: longSystem },
      { role: "user", content: "Design invoice approval controls for APAC subsidiaries." },
      { role: "assistant", content: "Use maker-checker controls." },
      { role: "user", content: "Add SOX evidence retention and exception reporting." },
    ], { tools });

    await recordSession(sidecar.url, "fresh-session");
    await postChat(sidecar.proxyUrl, [
      { role: "system", content: "Different but valid session baseline." },
      { role: "user", content: "Summarize logistics risk." },
    ]);

    await recordSession(sidecar.url, "business-session");
    await postChat(sidecar.proxyUrl, [
      { role: "system", content: longSystem },
      {
        role: "user",
        content:
          "Compacted summary: APAC invoice controls, SOX evidence, exception reporting. Continue from this summary.",
      },
    ], { tools });

    const report = await fetch(`${sidecar.url}/api/report`).then((r) => r.json());
    expect(report.summary.requests).toBe(5);
    expect(report.summary.sessions).toBe(2);
    expect(report.requests[0].prefixStable).toBeNull();
    expect(report.requests[1].prefixStable).toBeNull();
    expect(report.requests[1].findings).toEqual([]);
    expect(report.requests[2].prefixStable).toBe(true);
    expect(report.requests[3].sessionId).toBe("fresh-session");
    expect(report.requests[3].prefixStable).toBeNull();
    expect(report.requests[4].sessionId).toBe("business-session");
    expect(report.requests[4].findings).toContain("message_prefix_drift");
    expect(report.summary.cacheHitTokens).toBeGreaterThan(0);
  });
});

async function postChat(
  baseUrl: string,
  messages: unknown[],
  opts: { model?: string; stream?: boolean; tools?: unknown[] } = {},
): Promise<void> {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test" },
    body: JSON.stringify({
      model: opts.model ?? "deepseek-chat",
      messages,
      stream: opts.stream,
      tools: opts.tools,
    }),
  });
  expect(res.status).toBe(200);
  await res.text();
}

async function postMessages(
  proxyBaseUrl: string,
  messages: unknown[],
  opts: { model?: string; stream?: boolean; tools?: unknown[]; metadata?: unknown } = {},
): Promise<void> {
  const base = proxyBaseUrl.replace(/\/v1\/?$/, "");
  const res = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": "test",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: opts.model ?? "claude-sonnet-4-6",
      system: "stable claude context",
      messages,
      stream: opts.stream,
      tools: opts.tools,
      metadata: opts.metadata,
      max_tokens: 64,
    }),
  });
  expect(res.status).toBe(200);
  await res.text();
}

async function postResponses(
  proxyBaseUrl: string,
  sessionId: string,
  prompt: string,
  stream = false,
  includePrior = false,
): Promise<void> {
  const res = await fetch(`${proxyBaseUrl}/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test",
      "session-id": sessionId,
    },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      instructions: "stable codex context",
      input: [
        ...(includePrior
          ? [
              {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: "first" }],
              },
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "ok" }],
              },
            ]
          : []),
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: prompt }],
        },
      ],
      stream,
      prompt_cache_key: sessionId,
    }),
  });
  expect(res.status).toBe(200);
  const text = await res.text();
  if (stream) expect(text).toContain("event: response.completed");
  else expect(JSON.parse(text).object).toBe("response");
}

async function recordSession(sidecarUrl: string, sessionId: string): Promise<void> {
  const res = await fetch(`${sidecarUrl}/api/opencode/event`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "session.updated", payload: { session: { id: sessionId } } }),
  });
  expect(res.status).toBe(200);
}

async function startMockDeepSeek(): Promise<{
  url: string;
  paths: string[];
  bodies: string[];
  close: () => Promise<void>;
}> {
  const paths: string[] = [];
  const bodies: string[] = [];
  const server = createServer(async (req, res) => {
    paths.push(req.url ?? "");
    if ((req.url ?? "").includes("/chat/completions")) {
      let body = "";
      for await (const chunk of req) body += String(chunk);
      bodies.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "ok" } }],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 5,
            prompt_cache_hit_tokens: 80,
            prompt_cache_miss_tokens: 20,
          },
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });
  await listenServer(server);
  return {
    url: `http://127.0.0.1:${serverPort(server)}/v1`,
    paths,
    bodies,
    close: () => closeServer(server),
  };
}

async function startMockAnthropic(): Promise<{
  url: string;
  paths: string[];
  bodies: string[];
  close: () => Promise<void>;
}> {
  const paths: string[] = [];
  const bodies: string[] = [];
  let calls = 0;
  const server = createServer(async (req, res) => {
    paths.push(req.url ?? "");
    const pathname = new URL(req.url ?? "/", "http://mock.local").pathname;
    if (pathname === "/v1/messages") {
      calls++;
      let body = "";
      for await (const chunk of req) body += String(chunk);
      bodies.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: `msg_dcache_${calls}`,
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 150,
            output_tokens: 8,
            cache_read_input_tokens: calls > 1 ? 140 : 120,
            cache_creation_input_tokens: calls > 1 ? 10 : 30,
          },
        }),
      );
      return;
    }
    if (pathname === "/v1/messages/count_tokens") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ input_tokens: 150 }));
      return;
    }
    if (pathname === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "claude-sonnet-4-6", display_name: "Sonnet" }] }));
      return;
    }
    res.writeHead(404).end();
  });
  await listenServer(server);
  return {
    url: `http://127.0.0.1:${serverPort(server)}`,
    paths,
    bodies,
    close: () => closeServer(server),
  };
}

async function startBareServer(
  port = 0,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((_req, res) => res.end("ok"));
  await listenServer(server, port);
  return { port: serverPort(server), close: () => closeServer(server) };
}

async function reservePort(): Promise<number> {
  const probe = await startBareServer();
  const port = probe.port;
  await probe.close();
  return port;
}

function listenServer(server: Server, port = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function serverPort(server: Server): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server has no TCP port");
  return (address as AddressInfo).port;
}
