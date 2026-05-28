import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { installClaudeHook } from "../src/installer.js";
import { startDCacheServer } from "../src/server.js";
import { REAL_CACHE_COMPARISON_CASES } from "./dcache-real-cases.js";

const runLocal = process.env.CLAUDE_E2E === "1";
const runRealDeepSeek = process.env.CLAUDE_REAL_E2E === "1";
const realModel = process.env.CLAUDE_REAL_MODEL || "haiku";
const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];
const REAL_CLAUDE_CASES = REAL_CACHE_COMPARISON_CASES;

function tempRoot(): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "dcache-claude-")));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(closers.splice(0).map((fn) => fn()));
  await Promise.all(roots.splice(0).map((root) => removeTempRoot(root)));
});

describe.skipIf(!runLocal)("dcache Claude Code integration", () => {
  it("routes real Claude CLI through dcache hooks and Anthropic Messages proxy", async () => {
    const claudeCommand = resolveClaudeCommand();
    expect(claudeCommand).toBeTruthy();
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
    const install = installClaudeHook({
      projectRoot: root,
      dataDir,
      sidecarUrl: sidecar.url,
      proxyBaseUrl: sidecar.proxyUrl,
      routeProvider: true,
    });
    expect(install.ok).toBe(true);

    const enabled = await fetch(`${sidecar.url}/api/anchor`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        content: "Stable Claude project context: billing controls, audit evidence, and support SLAs.",
      }),
    }).then((r) => r.json());
    expect(enabled.enabled).toBe(true);

    await runClaude(
      claudeCommand!,
      root,
      join(root, ".claude", "settings.local.json"),
      sidecar.proxyUrl.replace(/\/v1\/?$/, ""),
      "In under 30 words, summarize billing escalation controls.",
    );
    await runClaude(
      claudeCommand!,
      root,
      join(root, ".claude", "settings.local.json"),
      sidecar.proxyUrl.replace(/\/v1\/?$/, ""),
      "In under 30 words, summarize billing escalation controls and add audit evidence.",
    );

    const report = await fetch(`${sidecar.url}/api/report`).then((r) => r.json());
    expect(upstream.messages).toBeGreaterThanOrEqual(2);
    expect(report.summary.requests).toBeGreaterThanOrEqual(2);
    expect(report.summary.pluginEvents).toBeGreaterThan(0);
    expect(report.summary.cacheHitTokens).toBeGreaterThan(0);
    expect(JSON.stringify(report.events)).toContain("claude.SessionStart");
    expect(JSON.stringify(report.events)).toContain("cache_anchor.injected");
    process.stdout.write(
      `\ndcache local Claude E2E summary: ${JSON.stringify({
        requests: report.summary.requests,
        mappedRequests: report.summary.mappedRequests,
        sessions: report.summary.sessions,
        cacheHitRatio: report.summary.cacheHitRatio,
        cacheHitTokens: report.summary.cacheHitTokens,
        cacheMissTokens: report.summary.cacheMissTokens,
        pluginEvents: report.summary.pluginEvents,
        upstreamMessages: upstream.messages,
      })}\n`,
    );
  }, 240_000);
});

describe.skipIf(!runRealDeepSeek)("dcache Claude Code real DeepSeek integration", () => {
  it("compares no-plugin, plugin, and cross-session cache hits with the same real Claude cases", async () => {
    const claudeCommand = resolveClaudeCommand();
    expect(claudeCommand).toBeTruthy();

    const baseline = await runRealClaudeComparisonArm({
      claudeCommand: claudeCommand!,
      withPlugin: false,
      label: "baseline-no-plugin",
    });
    const plugin = await runRealClaudeComparisonArm({
      claudeCommand: claudeCommand!,
      withPlugin: true,
      label: "plugin-anchor",
    });

    process.stdout.write(
      `\ndcache real Claude Code comparison summary: ${JSON.stringify({
        requestedModel: realModel,
        cases: REAL_CLAUDE_CASES.map((item) => item.id),
        baseline,
        plugin,
      })}\n`,
    );
    expect(baseline.summary.requests).toBeGreaterThanOrEqual(REAL_CLAUDE_CASES.length);
    expect(baseline.summary.pluginEvents).toBe(0);
    expect(plugin.summary.requests).toBeGreaterThanOrEqual(REAL_CLAUDE_CASES.length);
    expect(plugin.summary.pluginEvents).toBeGreaterThan(0);
    expect(plugin.summary.anchorEvents).toBeGreaterThan(0);
    expect(plugin.crossSession.requests).toBeGreaterThan(0);
    expect(plugin.summary.cacheHitTokens).toBeGreaterThan(baseline.summary.cacheHitTokens);
    expect(plugin.summary.cacheHitRatio).toBeGreaterThan(baseline.summary.cacheHitRatio);
    expect(baseline.caseFirstRequests.cacheHitRatio).toBeLessThan(0.2);
    expect(plugin.hotCaseFirstRequests.cacheHitRatio).toBeGreaterThan(0.9);
    expect(
      plugin.hotCaseFirstRequests.cacheHitRatio - baseline.caseFirstRequests.cacheHitRatio,
    ).toBeGreaterThan(0.5);
    expect(plugin.crossSession.cacheHitTokens).toBeGreaterThan(0);
    expect(plugin.crossSessionFirstRequests.cacheHitRatio).toBeGreaterThan(0.9);
    expect(plugin.hasSessionStartEvent).toBe(true);
    expect(plugin.hasAnchorInjectedEvent).toBe(true);
  }, 420_000);
});

async function removeTempRoot(root: string): Promise<void> {
  try {
    await rm(root, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
  } catch (err) {
    if (process.platform === "win32" && isBusyCleanupError(err)) {
      // Claude Code can leave a short-lived process with cwd under the test root.
      // Do not turn a successful live-provider comparison into a cleanup failure.
      console.warn(`dcache cleanup warning: ${root} is still busy`);
      return;
    }
    throw err;
  }
}

function isBusyCleanupError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "EBUSY"
  );
}

function resolveClaudeCommand(): string | undefined {
  if (process.platform === "win32") {
    const realClaudePath = join(process.env.USERPROFILE ?? "", ".cac", "real_claude");
    if (existsSync(realClaudePath)) {
      const realClaude = readFileSync(realClaudePath, "utf8").trim();
      if (existsSync(realClaude)) return realClaude;
    }
  }
  const finder = process.platform === "win32" ? "where.exe" : "which";
  const where = spawnSync(finder, ["claude"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (where.status !== 0) return undefined;
  const candidates = where.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return (
    candidates.find((candidate) => candidate.endsWith(".cmd")) ??
    candidates.find((candidate) => candidate.endsWith(".exe")) ??
    candidates[0]
  );
}

async function runClaude(
  command: string,
  cwd: string,
  settingsPath: string,
  anthropicBaseUrl: string,
  prompt: string,
  opts: { model?: string; useRealKey?: boolean } = {},
): Promise<void> {
  const realKey = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
  if (opts.useRealKey) expect(realKey).toBeTruthy();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ANTHROPIC_AUTH_TOKEN: opts.useRealKey ? realKey : "dcache-test-token",
    ANTHROPIC_API_KEY: opts.useRealKey ? realKey : "dcache-test-key",
    ANTHROPIC_BASE_URL: anthropicBaseUrl,
    ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-v4-pro[1m]",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-v4-pro[1m]",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "deepseek-v4-flash",
    CLAUDE_CODE_SUBAGENT_MODEL: "deepseek-v4-flash",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
  };
  const child = spawn(
    command,
    [
      "-p",
      prompt,
      "--settings",
      settingsPath,
      "--model",
      opts.model ?? "sonnet",
      "--output-format",
      "stream-json",
      "--include-hook-events",
      "--verbose",
    ],
    {
      cwd,
      env,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  closers.push(
    () =>
      new Promise((resolve) => {
        if (!child.killed && child.exitCode === null) killProcessTree(child.pid);
        child.once("exit", () => resolve());
        setTimeout(resolve, 1000);
      }),
  );
  const code = await waitForExit(child, 180_000).catch((error: Error) => {
    throw new Error(`${error.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  });
  expect(code, `${stdout}\n${stderr}`).toBe(0);
}

async function runRealClaudeComparisonArm(opts: {
  claudeCommand: string;
  withPlugin: boolean;
  label: string;
}): Promise<any> {
  const root = tempRoot();
  const dataDir = join(root, ".dcache");
  const sidecar = await startDCacheServer({
    projectRoot: root,
    dataDir,
    port: 0,
    proxyPort: 0,
    anthropicUpstreamBaseUrl: "https://api.deepseek.com/anthropic",
  });
  closers.push(sidecar.close);
  const settingsPath = join(root, ".claude", "settings.local.json");
  mkdirSync(dirname(settingsPath), { recursive: true });
  if (!existsSync(settingsPath)) writeFileSync(settingsPath, "{}\n", "utf8");
  if (opts.withPlugin) {
    writeStableClaudeMemory(root);
    const install = installClaudeHook({
      projectRoot: root,
      dataDir,
      sidecarUrl: sidecar.url,
      proxyBaseUrl: sidecar.proxyUrl,
      routeProvider: true,
    });
    expect(install.ok).toBe(true);
    const initial = await fetch(`${sidecar.url}/api/anchor`).then((r) => r.json());
    expect(initial.enabled).toBe(false);
    const enabled = await fetch(`${sidecar.url}/api/anchor`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        content: longClaudeAnchor(),
      }),
    }).then((r) => r.json());
    expect(enabled.enabled).toBe(true);
  }

  let requestCount = 0;
  const caseRuns: Array<{
    id: string;
    requestIndexes: number[];
  }> = [];
  for (const [index, testCase] of REAL_CLAUDE_CASES.entries()) {
    const beforeCount = requestCount;
    if (!opts.withPlugin) {
      writeVolatileClaudeMemory(root, `${opts.label}-${testCase.id}-${index}`);
    }
    await runClaude(
      opts.claudeCommand,
      root,
      settingsPath,
      sidecar.proxyUrl.replace(/\/v1\/?$/, ""),
      testCase.prompt,
      { model: realModel, useRealKey: true },
    );
    await sleep(5_000);
    const interim = await fetch(`${sidecar.url}/api/report`).then((r) => r.json());
    requestCount = interim.requests.length;
    caseRuns.push({
      id: testCase.id,
      requestIndexes: range(beforeCount, requestCount),
    });
  }

  const report = await fetch(`${sidecar.url}/api/report`).then((r) => r.json());
  const rows = requestRows(report);
  const sessionMetrics = summarizeSessionReuse(rows);
  const caseRunRows = caseRuns.map((run) => ({
    id: run.id,
    requestIndexes: run.requestIndexes,
    firstRequest: rows[run.requestIndexes[0]],
    summary: summarizeRequests(run.requestIndexes.map((requestIndex) => rows[requestIndex]).filter(Boolean)),
  }));
  const caseFirstRows = caseRunRows.map((run) => run.firstRequest).filter(Boolean);
  const eventsText = JSON.stringify(report.events);
  return {
    label: opts.label,
    withPlugin: opts.withPlugin,
    summary: report.summary,
    allRequests: summarizeRequests(rows),
    caseRuns: caseRunRows,
    caseFirstRequests: summarizeRequests(caseFirstRows),
    hotCaseFirstRequests: summarizeRequests(caseFirstRows.slice(1)),
    crossSession: sessionMetrics.crossSession,
    crossSessionFirstRequests: sessionMetrics.crossSessionFirstRequests,
    rows,
    hasSessionStartEvent: eventsText.includes("claude.SessionStart"),
    hasAnchorInjectedEvent: eventsText.includes("cache_anchor.injected"),
  };
}

function range(start: number, end: number): number[] {
  return Array.from({ length: Math.max(0, end - start) }, (_, index) => start + index);
}

function requestRows(report: any): any[] {
  return report.requests.map((r: any, index: number) => ({
    index,
    sessionId: r.sessionId,
    model: r.model,
    prefixStable: r.prefixStable,
    promptTokens: r.promptTokens,
    cacheHitTokens: r.cacheHitTokens,
    cacheMissTokens: r.cacheMissTokens,
    cacheHitRatio: r.cacheHitRatio,
    findings: r.findings,
  }));
}

function summarizeSessionReuse(rows: any[]): {
  crossSession: ReturnType<typeof summarizeRequests>;
  crossSessionFirstRequests: ReturnType<typeof summarizeRequests>;
} {
  const orderedSessions = rows
    .map((row) => row.sessionId)
    .filter((sessionId, index, values) => sessionId && values.indexOf(sessionId) === index);
  const firstSession = orderedSessions[0];
  const firstRequestBySession = orderedSessions
    .map((sessionId) => rows.find((row) => row.sessionId === sessionId))
    .filter(Boolean);
  return {
    crossSession: summarizeRequests(
      firstSession ? rows.filter((row) => row.sessionId && row.sessionId !== firstSession) : [],
    ),
    crossSessionFirstRequests: summarizeRequests(firstRequestBySession.slice(1)),
  };
}

function summarizeRequests(rows: any[]): {
  requests: number;
  promptTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  cacheHitRatio: number;
} {
  const promptTokens = sumRows(rows, "promptTokens");
  const cacheHitTokens = sumRows(rows, "cacheHitTokens");
  const cacheMissTokens = sumRows(rows, "cacheMissTokens");
  const denom = cacheHitTokens + cacheMissTokens;
  return {
    requests: rows.length,
    promptTokens,
    cacheHitTokens,
    cacheMissTokens,
    cacheHitRatio: denom > 0 ? cacheHitTokens / denom : 0,
  };
}

function sumRows(rows: any[], key: string): number {
  return rows.reduce((sum, row) => sum + (Number(row[key]) || 0), 0);
}

function writeVolatileClaudeMemory(root: string, label: string): void {
  const nonce = randomUUID();
  writeFileSync(
    join(root, "CLAUDE.md"),
    [
      `# Volatile Claude comparison context ${label}`,
      "",
      "This file intentionally changes before every no-plugin baseline prompt.",
      "It simulates a real project whose local instructions, rollout assumptions, and stakeholder wording drift between Claude Code sessions.",
      "",
      ...Array.from(
        { length: 35 },
        (_, index) =>
          `Volatile note ${index + 1} for ${label}/${nonce}: local team, control wording, evidence owner, reporting lane, and exception taxonomy differ for this baseline run.`,
      ),
    ].join("\n") + "\n",
    "utf8",
  );
}

function writeStableClaudeMemory(root: string): void {
  writeFileSync(
    join(root, "CLAUDE.md"),
    [
      "# Stable Claude comparison context",
      "",
      "Keep APAC invoice approvals, SOX evidence, ERP exception queues, reporting owners, and monthly-close governance stable for the plugin comparison arm.",
      "Prompts vary across sessions, but the project memory and dcache anchor remain stable.",
    ].join("\n") + "\n",
    "utf8",
  );
}

function longClaudeAnchor(): string {
  return [
    "Stable Claude Code DeepSeek comparison anchor.",
    "Project: APAC enterprise finance controls platform.",
    "Permanent vocabulary: invoice approvals, SOX evidence, ERP exception queues, reporting owners, data residency, maker-checker governance, and monthly close.",
    ...Array.from(
      { length: 80 },
      (_, index) =>
        `Stable anchor note ${index + 1}: preserve APAC approval controls, audit evidence retention, ERP exception routing, reporting owner accountability, data residency constraints, and monthly-close governance across Claude Code sessions.`,
    ),
  ].join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      killProcessTree(child.pid);
      reject(new Error("timed out waiting for claude"));
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function killProcessTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      encoding: "utf8",
      windowsHide: true,
    });
  } else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      // best effort cleanup
    }
  }
}

async function startMockAnthropic(): Promise<{
  url: string;
  messages: number;
  close: () => Promise<void>;
}> {
  const state = { messages: 0 };
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url ?? "/", "http://mock.local").pathname;
    if (pathname === "/v1/messages") {
      state.messages++;
      let body = "";
      for await (const chunk of req) body += String(chunk);
      const parsed = JSON.parse(body || "{}") as { stream?: boolean };
      if (parsed.stream === true) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          `event: message_start\ndata: ${JSON.stringify({
            type: "message_start",
            message: {
              id: `msg_dcache_${state.messages}`,
              type: "message",
              role: "assistant",
              model: "claude-sonnet-4-6",
              content: [],
              stop_reason: null,
              usage: {
                input_tokens: 180,
                cache_read_input_tokens: state.messages > 1 ? 150 : 120,
                cache_creation_input_tokens: state.messages > 1 ? 30 : 60,
              },
            },
          })}\n\n`,
        );
        res.write(
          `event: content_block_start\ndata: ${JSON.stringify({
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          })}\n\n`,
        );
        res.write(
          `event: content_block_delta\ndata: ${JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Mock Claude response." },
          })}\n\n`,
        );
        res.write(
          `event: content_block_stop\ndata: ${JSON.stringify({
            type: "content_block_stop",
            index: 0,
          })}\n\n`,
        );
        res.write(
          `event: message_delta\ndata: ${JSON.stringify({
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 5 },
          })}\n\n`,
        );
        res.end(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: `msg_dcache_${state.messages}`,
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "Mock Claude response." }],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 180,
            output_tokens: 5,
            cache_read_input_tokens: state.messages > 1 ? 150 : 120,
            cache_creation_input_tokens: state.messages > 1 ? 30 : 60,
          },
        }),
      );
      return;
    }
    if (pathname === "/v1/messages/count_tokens") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ input_tokens: 180 }));
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
    get messages() {
      return state.messages;
    },
    close: () => closeServer(server),
  };
}

function listenServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
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
