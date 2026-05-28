import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { installHook } from "../src/installer.js";
import { startDCacheServer } from "../src/server.js";
import { REAL_CACHE_COMPARISON_CASES } from "./dcache-real-cases.js";

const runLocal = process.env.OPENCODE_E2E === "1";
const runRealDeepSeek = process.env.OPENCODE_REAL_E2E === "1";
const realModel = process.env.OPENCODE_REAL_MODEL || "deepseek/deepseek-v4-flash";
const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];

function tempRoot(): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "dcache-opencode-")));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(closers.splice(0).map((fn) => fn()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.skipIf(!runLocal)("opencode dcache local opencode integration", () => {
  it("routes real opencode DeepSeek traffic through dcache across complex same-session prompts", async () => {
    const opencodeCommand = resolveOpencodeCommand();
    expect(opencodeCommand).toBeTruthy();
    const root = tempRoot();
    const dataDir = join(root, ".dcache");
    const upstream = await startMockDeepSeek();
    closers.push(upstream.close);
    const sidecar = await startDCacheServer({
      projectRoot: root,
      dataDir,
      port: 0,
      proxyPort: 0,
      upstreamBaseUrl: upstream.url,
    });
    closers.push(sidecar.close);
    installHook({
      projectRoot: root,
      dataDir,
      sidecarUrl: sidecar.url,
      proxyBaseUrl: sidecar.proxyUrl,
      routeProvider: true,
    });

    const anchorInitial = await fetch(`${sidecar.url}/api/anchor`).then((r) => r.json());
    expect(anchorInitial.enabled).toBe(false);

    const sessionId = await runOpencode(opencodeCommand!, root, dataDir, sidecar.url, [
      "You are validating dcache in a business workflow. Do not edit files.",
      "In under 80 words, create a risk-control plan for invoice approvals across APAC subsidiaries.",
      "Include audit evidence, exception reporting, and data residency constraints.",
    ].join(" "));
    await runOpencode(
      opencodeCommand!,
      root,
      dataDir,
      sidecar.url,
      "In under 80 words, continue this session. Add ERP integration edge cases, approval fallback paths, and month-end reporting checks.",
      ["--session", sessionId],
    );
    await runOpencode(
      opencodeCommand!,
      root,
      dataDir,
      sidecar.url,
      "In under 80 words, compact-like continuation: prior context is APAC invoice controls, SOX evidence, ERP edge cases, and reporting. Explain whether prefix cache stability should survive summarized context.",
      ["--session", sessionId],
    );

    let report = await fetch(`${sidecar.url}/api/report`).then((r) => r.json());
    expect(JSON.stringify(report.events)).not.toContain("cache_anchor.injected");

    const enabled = await fetch(`${sidecar.url}/api/anchor`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        content:
          "Stable APAC finance project context: invoice approvals, SOX evidence, ERP exceptions, and reporting controls.",
      }),
    }).then((r) => r.json());
    expect(enabled.enabled).toBe(true);
    expect(enabled.generation).toBe(1);

    const anchoredSession = await runOpencode(opencodeCommand!, root, dataDir, sidecar.url, [
      "In under 80 words, start an anchored cache scenario for APAC invoice approvals.",
      "Keep the project context stable and add only a new approval exception.",
    ].join(" "));
    await runOpencode(
      opencodeCommand!,
      root,
      dataDir,
      sidecar.url,
      "In under 80 words, continue the anchored scenario and add reporting owners.",
      ["--session", anchoredSession],
    );
    const afterContinuation = readAnchorState(dataDir);
    expect(afterContinuation.generation).toBe(1);
    expect(afterContinuation.lastResetReason).toBe("manual_enable");

    const freshWindowSession = await runOpencode(
      opencodeCommand!,
      root,
      dataDir,
      sidecar.url,
      "In under 80 words, start a separate fresh-window anchored scenario for APAC controls.",
    );
    const afterFreshWindow = readAnchorState(dataDir);
    expect(afterFreshWindow.generation).toBe(1);
    expect(afterFreshWindow.lastSessionId).toBe(freshWindowSession);

    const forkedSession = await runOpencode(
      opencodeCommand!,
      root,
      dataDir,
      sidecar.url,
      "In under 80 words, fork the original anchored session into a new branch and add remediation owners.",
      ["--session", anchoredSession, "--fork"],
    );
    const afterFork = readAnchorState(dataDir);
    expect(afterFork.generation).toBe(2);
    expect(afterFork.lastResetReason).toBe("forked_session");
    expect(afterFork.lastSessionId).toBe(forkedSession);

    await runOpencode(
      opencodeCommand!,
      root,
      dataDir,
      sidecar.url,
      "In under 80 words, continue the forked session and verify the anchor generation remains stable.",
      ["--session", forkedSession],
    );
    const afterForkContinuation = readAnchorState(dataDir);
    expect(afterForkContinuation.generation).toBe(2);
    expect(afterForkContinuation.lastResetReason).toBe("forked_session");

    await waitForReportRequest(`${sidecar.url}/api/report`, 7);
    report = await fetch(`${sidecar.url}/api/report`).then((r) => r.json());
    expect(report.summary.pluginEvents).toBeGreaterThan(0);
    expect(report.summary.opencodeSteps).toBeGreaterThan(0);
    expect(report.summary.requests).toBeGreaterThanOrEqual(7);
    expect(report.summary.mappedRequests).toBeGreaterThan(0);
    expect(report.summary.cacheHitTokens).toBeGreaterThan(0);
    expect(JSON.stringify(report.events)).toContain("cache_anchor.injected");
    expect(afterForkContinuation.generation).toBe(2);
    process.stdout.write(
      `\ndcache local opencode E2E summary: ${JSON.stringify({
        requests: report.summary.requests,
        mappedRequests: report.summary.mappedRequests,
        sessions: report.summary.sessions,
        cacheHitRatio: report.summary.cacheHitRatio,
        cacheHitTokens: report.summary.cacheHitTokens,
        cacheMissTokens: report.summary.cacheMissTokens,
        pluginEvents: report.summary.pluginEvents,
        opencodeSteps: report.summary.opencodeSteps,
        anchorGeneration: afterForkContinuation.generation,
        freshWindowSession,
        forkedSession,
      })}\n`,
    );
  }, 360_000);
});

describe.skipIf(!runRealDeepSeek)("opencode dcache real DeepSeek comparison", () => {
  it("compares no-plugin proxy traffic against opt-in anchors with real DeepSeek cache usage", async () => {
    const opencodeCommand = resolveOpencodeCommand();
    expect(opencodeCommand).toBeTruthy();
    const root = tempRoot();
    const dataDir = join(root, ".dcache");
    const sidecar = await startDCacheServer({
      projectRoot: root,
      dataDir,
      port: 0,
      proxyPort: 0,
    });
    closers.push(sidecar.close);

    writeProviderProxyConfig(root, sidecar.proxyUrl);
    for (const testCase of REAL_CACHE_COMPARISON_CASES) {
      writeVariableProjectGuide(root, `baseline-${testCase.id}`);
      await runOpencode(
        opencodeCommand!,
        root,
        dataDir,
        sidecar.url,
        testCase.prompt,
        [],
        { model: realModel, useFallbackKey: false },
      );
      await sleep(5_000);
    }
    const afterBaseline = await fetch(`${sidecar.url}/api/report`).then((r) => r.json());
    const baselineRequests = afterBaseline.requests.slice();

    installHook({
      projectRoot: root,
      dataDir,
      sidecarUrl: sidecar.url,
      proxyBaseUrl: sidecar.proxyUrl,
      routeProvider: true,
    });
    const enabled = await fetch(`${sidecar.url}/api/anchor`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        content: longRealAnchor(),
      }),
    }).then((r) => r.json());
    expect(enabled.enabled).toBe(true);
    expect(enabled.generation).toBe(1);

    await sleep(3_000);
    writeStableProjectGuide(root);
    const anchoredSessionA = await runOpencode(
      opencodeCommand!,
      root,
      dataDir,
      sidecar.url,
      REAL_CACHE_COMPARISON_CASES[0].prompt,
      [],
      { model: realModel, useFallbackKey: false },
    );
    await sleep(8_000);
    const anchoredFreshWindowSession = await runOpencode(
      opencodeCommand!,
      root,
      dataDir,
      sidecar.url,
      REAL_CACHE_COMPARISON_CASES[1].prompt,
      [],
      { model: realModel, useFallbackKey: false },
    );
    const afterFreshAnchorWindow = readAnchorState(dataDir);
    expect(afterFreshAnchorWindow.generation).toBe(1);
    expect(afterFreshAnchorWindow.lastResetReason).toBe("manual_enable");
    expect(afterFreshAnchorWindow.lastSessionId).toBe(anchoredFreshWindowSession);

    await sleep(8_000);
    const forkedSession = await runOpencode(
      opencodeCommand!,
      root,
      dataDir,
      sidecar.url,
      "ANCHOR-FORK: In 45 words, fork the first APAC approval scenario and add remediation owner governance.",
      ["--session", anchoredSessionA, "--fork"],
      { model: realModel, useFallbackKey: false },
    );
    const afterForkAnchor = readAnchorState(dataDir);
    expect(afterForkAnchor.generation).toBe(2);
    expect(afterForkAnchor.lastResetReason).toBe("forked_session");
    expect(afterForkAnchor.lastSessionId).toBe(forkedSession);

    await sleep(8_000);
    await runOpencode(
      opencodeCommand!,
      root,
      dataDir,
      sidecar.url,
      "ANCHOR-FORK-CONTINUE: In 45 words, continue the forked APAC approval scenario and keep governance vocabulary stable.",
      ["--session", forkedSession],
      { model: realModel, useFallbackKey: false },
    );
    await sleep(8_000);
    await runOpencode(
      opencodeCommand!,
      root,
      dataDir,
      sidecar.url,
      REAL_CACHE_COMPARISON_CASES[2].prompt,
      ["--session", forkedSession],
      { model: realModel, useFallbackKey: false },
    );

    const report = await fetch(`${sidecar.url}/api/report`).then((r) => r.json());
    const anchoredRequests = report.requests.slice(baselineRequests.length);
    const baseline = summarizeRequests(baselineRequests);
    const anchored = summarizeRequests(anchoredRequests);
    const anchoredMapped = anchoredRequests.filter(
      (request: any) => typeof request.sessionId === "string",
    );
    const anchoredHot = summarizeRequests(
      anchoredMapped.filter((request: any) => Number(request.cacheHitRatio) >= 0.9),
    );
    const baselineCold = summarizeRequests(baselineRequests.slice(0, 1));
    const requestRows = report.requests.map((r: any, index: number) => ({
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
    const anchorState = readAnchorState(dataDir);
    const summary = {
      model: realModel,
      cases: REAL_CACHE_COMPARISON_CASES.map((item) => item.id),
      baseline,
      baselineCold,
      anchored,
      anchoredHot,
      final: report.summary,
      requestRows,
      anchorGeneration: anchorState.generation,
      freshWindowSession: anchoredFreshWindowSession,
      forkedSession,
    };

    process.stdout.write(
      `\ndcache real DeepSeek comparison summary: ${JSON.stringify(summary)}\n`,
    );
    expect(report.summary.cacheHitTokens).toBeGreaterThan(0);
    expect(anchoredRequests.some((r: any) => r.cacheHitRatio > 0.9)).toBe(true);
    expect(anchoredHot.requests).toBeGreaterThanOrEqual(2);
    expect(anchoredHot.cacheHitRatio).toBeGreaterThan(0.9);
    expect(baseline.cacheHitRatio).toBeLessThan(0.4);
    expect(anchoredHot.cacheHitRatio - baseline.cacheHitRatio).toBeGreaterThan(0.5);
    expect(anchoredHot.cacheHitRatio).toBeGreaterThan(baselineCold.cacheHitRatio);
    expect(anchorState.generation).toBe(2);
    expect(anchorState.lastResetReason).toBe("forked_session");
    expect(JSON.stringify(report.events)).toContain("cache_anchor.injected");
  }, 600_000);
});

function resolveOpencodeCommand(): string | undefined {
  const finder = process.platform === "win32" ? "where.exe" : "which";
  const where = spawnSync(finder, ["opencode"], {
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
    candidates
      .map((candidate) =>
        join(dirname(candidate), "node_modules", "opencode-ai", "bin", "opencode.exe"),
      )
      .find((candidate) => existsSync(candidate)) ??
    candidates.find((candidate) => candidate.endsWith(".exe")) ??
    candidates[0]
  );
}

async function runOpencode(
  command: string,
  cwd: string,
  dataDir: string,
  sidecarUrl: string,
  prompt: string,
  extraArgs: string[] = [],
  opts: { model?: string; useFallbackKey?: boolean } = {},
): Promise<string> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DCACHE_SIDECAR_URL: sidecarUrl,
    DCACHE_DATA_DIR: dataDir,
  };
  if (opts.useFallbackKey !== false && !env.DEEPSEEK_API_KEY) {
    env.DEEPSEEK_API_KEY = "dcache-test-key";
  }
  const child = spawn(
    command,
    [
      "run",
      prompt,
      ...extraArgs,
      "--model",
      opts.model ?? "deepseek/deepseek-chat",
      "--format",
      "json",
      "--print-logs",
      "--log-level",
      "INFO",
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
  child.on("error", (error) => {
    stderr += error.stack ?? error.message;
  });
  closers.push(
    () =>
      new Promise((resolve) => {
        if (!child.killed && child.exitCode === null) {
          killProcessTree(child.pid);
        }
        child.once("exit", () => resolve());
        setTimeout(resolve, 1000);
      }),
  );
  const code = await waitForExit(child, 240_000).catch((error: Error) => {
    throw new Error(`${error.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  });
  expect(code, `${stdout}\n${stderr}`).toBe(0);
  const stdoutSessionId = extractSessionId(stdout);
  if (stdoutSessionId) return stdoutSessionId;
  const reportSessionId = await latestSessionIdFromReport(`${sidecarUrl}/api/report`);
  if (reportSessionId) return reportSessionId;
  throw new Error(`opencode JSON output and telemetry did not include a sessionID:\n${stdout}`);
}

function writeProviderProxyConfig(root: string, proxyBaseUrl: string): void {
  writeFileSync(
    join(root, "opencode.json"),
    `${JSON.stringify(
      {
        provider: {
          deepseek: {
            options: {
              baseURL: proxyBaseUrl,
            },
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function readAnchorState(dataDir: string): any {
  return JSON.parse(readFileSync(join(dataDir, "cache-anchor.state.json"), "utf8"));
}

function longRealAnchor(): string {
  return [
    "dcache real DeepSeek V4 Flash validation anchor.",
    "Project: APAC enterprise finance controls platform.",
    "Stable policies: maker-checker approval, SOX evidence, data residency, exception queues, audit trails, ERP integration, segregation of duties, monthly close reporting, and incident rollback.",
    ...Array.from(
      { length: 140 },
      (_, i) =>
        `Stable domain note ${
          i + 1
        }: keep invoice approval controls, maker-checker approval gates, SOX audit evidence, ERP exception queues, data residency, incident rollback, reporting owners, evidence retention, integration failure handling, compliance vocabulary, and monthly-close governance unchanged across sessions.`,
    ),
  ].join("\n");
}

function writeVariableProjectGuide(root: string, label: string): void {
  const nonce = randomUUID();
  const content = [
    `# Volatile opencode project guide for ${label}`,
    "",
    "This file intentionally changes between real DeepSeek comparison runs.",
    "It simulates a business project whose repository guidance, local constraints, and request-specific notes move around while dcache keeps the stable cache anchor at the front.",
    "",
    ...Array.from(
      { length: 45 },
      (_, i) =>
        `Volatile project note ${
          i + 1
        } for ${label}/${nonce}: local rollout assumption, stakeholder list, exception detail, testing note, and operational wording are deliberately different from the previous run.`,
    ),
  ].join("\n");
  writeFileSync(join(root, "AGENTS.md"), `${content}\n`, "utf8");
}

function writeStableProjectGuide(root: string): void {
  const content = [
    "# Stable APAC finance project guide",
    "",
    "Keep the project framing stable for the anchored comparison phase.",
    "Business context: invoice approvals, SOX evidence, ERP exception queues, data residency, reporting ownership, maker-checker governance, and monthly close controls.",
    "Testing intent: user prompts vary, but repository guidance and anchor context stay stable so prefix-cache reuse can be observed across opencode sessions.",
  ].join("\n");
  writeFileSync(join(root, "AGENTS.md"), `${content}\n`, "utf8");
}

function summarizeRequests(requests: any[]): {
  requests: number;
  promptTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  cacheHitRatio: number;
} {
  const promptTokens = sumRequests(requests, "promptTokens");
  const cacheHitTokens = sumRequests(requests, "cacheHitTokens");
  const cacheMissTokens = sumRequests(requests, "cacheMissTokens");
  const denom = cacheHitTokens + cacheMissTokens;
  return {
    requests: requests.length,
    promptTokens,
    cacheHitTokens,
    cacheMissTokens,
    cacheHitRatio: denom > 0 ? cacheHitTokens / denom : 0,
  };
}

function sumRequests(requests: any[], key: string): number {
  return requests.reduce((sum, request) => sum + (Number(request[key]) || 0), 0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractSessionId(stdout: string): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { sessionID?: unknown };
      if (typeof event.sessionID === "string" && event.sessionID.length > 0) {
        return event.sessionID;
      }
    } catch {
      // Non-JSON stdout is included in failure output below.
    }
  }
  return undefined;
}

async function latestSessionIdFromReport(url: string): Promise<string | undefined> {
  const report = await fetch(url).then((r) => r.json());
  for (const request of [...(report.requests ?? [])].reverse()) {
    if (typeof request.sessionId === "string" && request.sessionId.length > 0) {
      return request.sessionId;
    }
  }
  for (const event of [...(report.events ?? [])].reverse()) {
    const sessionId = event.sessionId ?? event.session_id ?? event.payload?.session?.id;
    if (typeof sessionId === "string" && sessionId.length > 0) return sessionId;
  }
  return undefined;
}

async function waitForReportRequest(url: string, minRequests: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 30_000) {
    const report = await fetch(url).then((r) => r.json());
    if (report.summary.requests >= minRequests && report.summary.opencodeSteps > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("timed out waiting for opencode telemetry");
}

function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      killProcessTree(child.pid);
      reject(new Error("timed out waiting for opencode run"));
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

async function startMockDeepSeek(): Promise<{ url: string; close: () => Promise<void> }> {
  let calls = 0;
  const server = createServer(async (req, res) => {
    if ((req.url ?? "").includes("/chat/completions")) {
      calls++;
      let body = "";
      for await (const chunk of req) body += String(chunk);
      const anchored = body.includes("dcache stable cache anchor.");
      const cacheHit = anchored ? 92 : calls > 1 ? 35 : 5;
      const promptTokens = 120;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: `chatcmpl-dcache-${calls}`,
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Mock DeepSeek response for dcache." },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: 8,
            prompt_cache_hit_tokens: cacheHit,
            prompt_cache_miss_tokens: promptTokens - cacheHit,
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
