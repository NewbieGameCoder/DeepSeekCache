import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { codexProfileTemplate } from "../src/codex-config.js";
import { installCodexHook } from "../src/installer.js";
import { defaultCodexProfilePath } from "../src/paths.js";
import { startDCacheServer } from "../src/server.js";
import { REAL_CACHE_COMPARISON_CASES } from "./dcache-real-cases.js";

const runLocal = process.env.CODEX_E2E === "1";
const runRealDeepSeek = process.env.CODEX_REAL_E2E === "1";
const realModel = process.env.CODEX_REAL_MODEL || "deepseek-v4-flash";
const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];
let previousCodexHome: string | undefined;
let codexHomeCaptured = false;

function tempRoot(prefix = "dcache-codex-"): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

afterEach(async () => {
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  previousCodexHome = undefined;
  codexHomeCaptured = false;
  await Promise.all(closers.splice(0).map((fn) => fn()));
  await Promise.all(roots.splice(0).map((root) => removeTempRoot(root)));
}, 90_000);

describe.skipIf(!runLocal)("dcache Codex CLI local integration", () => {
  it("routes real Codex Responses traffic through dcache and preserves anchor behavior across exec sessions", async () => {
    const codexCommand = resolveCodexCommand();
    expect(codexCommand).toBeTruthy();
    const root = tempRoot();
    const codexHome = useTempCodexHome(root);
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
    const install = installCodexHook({
      projectRoot: root,
      dataDir,
      sidecarUrl: sidecar.url,
      proxyBaseUrl: sidecar.proxyUrl,
      routeProvider: true,
    });
    expect(install.ok).toBe(true);

    writeStableCodexMemory(root);
    await runCodex(
      codexCommand!,
      root,
      codexHome,
      "In under 40 words, summarize APAC invoice controls. Do not edit files or use tools.",
      { model: "deepseek-v4-flash" },
    );
    await runCodex(
      codexCommand!,
      root,
      codexHome,
      "In under 40 words, continue the prior APAC invoice controls with audit evidence. Do not edit files or use tools.",
      { model: "deepseek-v4-flash", resumeLast: true },
    );

    const beforeAnchor = await fetch(`${sidecar.url}/api/report`).then((r) => r.json());
    expect(beforeAnchor.summary.requests).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(beforeAnchor.events)).not.toContain("cache_anchor.injected");

    const enabled = await fetch(`${sidecar.url}/api/anchor`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        content:
          "Stable Codex project context: APAC invoice approvals, SOX evidence, ERP exceptions, reporting owners, and monthly close.",
      }),
    }).then((r) => r.json());
    expect(enabled.enabled).toBe(true);

    await runCodex(
      codexCommand!,
      root,
      codexHome,
      "In under 40 words, start an anchored APAC invoice control scenario. Do not edit files or use tools.",
      { model: "deepseek-v4-flash" },
    );
    await runCodex(
      codexCommand!,
      root,
      codexHome,
      "In under 40 words, continue anchored controls and add reporting owners. Do not edit files or use tools.",
      { model: "deepseek-v4-flash", resumeLast: true },
    );
    await runCodex(
      codexCommand!,
      root,
      codexHome,
      "In under 40 words, start a fresh-window anchored Codex scenario. Do not edit files or use tools.",
      { model: "deepseek-v4-flash" },
    );

    const report = await fetch(`${sidecar.url}/api/report`).then((r) => r.json());
    const anchorState = readAnchorState(dataDir);
    expect(upstream.paths.some((path) => path.endsWith("/chat/completions"))).toBe(true);
    expect(upstream.bodies.some((body) => body.includes("dcache stable cache anchor."))).toBe(true);
    expect(report.summary.requests).toBeGreaterThanOrEqual(5);
    expect(report.summary.codexSteps).toBeGreaterThan(0);
    expect(report.summary.cacheHitTokens).toBeGreaterThan(0);
    expect(report.summary.anchorEvents).toBeGreaterThan(0);
    expect(JSON.stringify(report.events)).toContain("cache_anchor.proxy_injected");
    expect(anchorState.enabled).toBe(true);
    expect(anchorState.generation).toBe(1);
    expect(anchorState.lastResetReason).toBe("manual_enable");
    process.stdout.write(
      `\ndcache local Codex E2E summary: ${JSON.stringify({
        requests: report.summary.requests,
        mappedRequests: report.summary.mappedRequests,
        sessions: report.summary.sessions,
        cacheHitRatio: report.summary.cacheHitRatio,
        cacheHitTokens: report.summary.cacheHitTokens,
        cacheMissTokens: report.summary.cacheMissTokens,
        pluginEvents: report.summary.pluginEvents,
        codexSteps: report.summary.codexSteps,
        anchorGeneration: anchorState.generation,
      })}\n`,
    );
  }, 360_000);
});

describe.skipIf(!runRealDeepSeek)("dcache Codex CLI real DeepSeek comparison", () => {
  it("compares no-plugin Codex runs against dcache anchor runs with the same real cases", async () => {
    const codexCommand = resolveCodexCommand();
    expect(codexCommand).toBeTruthy();
    expect(process.env.DEEPSEEK_API_KEY).toBeTruthy();

    const baseline = await runRealCodexComparisonArm({
      codexCommand: codexCommand!,
      withPlugin: false,
      label: "baseline-no-plugin",
    });
    const plugin = await runRealCodexComparisonArm({
      codexCommand: codexCommand!,
      withPlugin: true,
      label: "plugin-anchor",
    });

    process.stdout.write(
      `\ndcache real Codex comparison summary: ${JSON.stringify({
        requestedModel: realModel,
        cases: REAL_CACHE_COMPARISON_CASES.map((item) => item.id),
        baseline,
        plugin,
      })}\n`,
    );
    expect(baseline.summary.requests).toBeGreaterThanOrEqual(REAL_CACHE_COMPARISON_CASES.length);
    expect(baseline.summary.pluginEvents).toBe(0);
    expect(plugin.summary.requests).toBeGreaterThanOrEqual(REAL_CACHE_COMPARISON_CASES.length);
    expect(plugin.summary.pluginEvents).toBeGreaterThan(0);
    expect(plugin.summary.anchorEvents).toBeGreaterThan(0);
    expect(plugin.hotCaseFirstRequests.requests).toBeGreaterThan(0);
    expect(plugin.hotCaseFirstRequests.cacheHitRatio).toBeGreaterThan(0.85);
    expect(plugin.hotCaseFirstRequests.cacheHitRatio).toBeGreaterThan(
      baseline.caseFirstRequests.cacheHitRatio,
    );
    expect(
      plugin.hotCaseFirstRequests.cacheHitRatio - baseline.caseFirstRequests.cacheHitRatio,
    ).toBeGreaterThan(0.25);
    expect(plugin.crossSessionFirstRequests.cacheHitRatio).toBeGreaterThan(0.85);
    expect(plugin.hasCodexActivity).toBe(true);
    expect(plugin.hasAnchorInjectedEvent).toBe(true);
  }, 600_000);
});

function useTempCodexHome(root: string): string {
  if (!codexHomeCaptured) {
    previousCodexHome = process.env.CODEX_HOME;
    codexHomeCaptured = true;
  }
  const codexHome = join(root, ".codex-home");
  process.env.CODEX_HOME = codexHome;
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, "config.toml"), "[features]\nhooks = true\n", "utf8");
  return codexHome;
}

function resolveCodexCommand(): string | undefined {
  const finder = process.platform === "win32" ? "where.exe" : "which";
  const where = spawnSync(finder, ["codex"], {
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

async function runCodex(
  command: string,
  cwd: string,
  codexHome: string,
  prompt: string,
  opts: {
    model?: string;
    resumeLast?: boolean;
    configOverrides?: string[];
    useRealKey?: boolean;
  } = {},
): Promise<void> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CODEX_HOME: codexHome,
    DEEPSEEK_API_KEY: opts.useRealKey ? process.env.DEEPSEEK_API_KEY : process.env.DEEPSEEK_API_KEY || "dcache-test-key",
  };
  if (opts.useRealKey) expect(env.DEEPSEEK_API_KEY).toBeTruthy();
  const globalArgs = ["-p", "dcache", "-m", opts.model ?? "deepseek-v4-flash"];
  for (const override of opts.configOverrides ?? []) {
    globalArgs.push("-c", override);
  }
  const execArgs = [
    "--json",
    "--enable",
    "hooks",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "--dangerously-bypass-hook-trust",
  ];
  const args = opts.resumeLast
    ? [...globalArgs, "exec", "resume", ...execArgs, "--last", "-"]
    : [...globalArgs, "exec", ...execArgs, "-"];
  const invocation = codexInvocation(command);
  const child = spawn(invocation.command, [...invocation.prefixArgs, ...args], {
    cwd,
    env,
    shell: invocation.shell,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  child.stdin.end(prompt);
  closers.push(
    () =>
      new Promise((resolve) => {
        if (!child.killed && child.exitCode === null) killProcessTree(child.pid);
        child.once("exit", () => resolve());
        setTimeout(resolve, 1000);
      }),
  );
  const code = await waitForExit(child, opts.useRealKey ? 240_000 : 180_000).catch((error: Error) => {
    throw new Error(`${error.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  });
  expect(code, `${stdout}\n${stderr}`).toBe(0);
}

async function removeTempRoot(root: string): Promise<void> {
  try {
    await rm(root, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
  } catch (err) {
    if (process.platform === "win32" && isBusyCleanupError(err)) {
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

function codexInvocation(command: string): {
  command: string;
  prefixArgs: string[];
  shell: boolean;
} {
  if (process.platform === "win32") {
    const scriptPath = join(dirname(command), "node_modules", "@openai", "codex", "bin", "codex.js");
    if (existsSync(scriptPath)) {
      return { command: process.execPath, prefixArgs: [scriptPath], shell: false };
    }
  }
  return {
    command,
    prefixArgs: [],
    shell: process.platform === "win32" && command.endsWith(".cmd"),
  };
}

async function runRealCodexComparisonArm(opts: {
  codexCommand: string;
  withPlugin: boolean;
  label: string;
}): Promise<any> {
  const root = tempRoot();
  const codexHome = useTempCodexHome(root);
  const dataDir = join(root, ".dcache");
  const sidecar = await startDCacheServer({
    projectRoot: root,
    dataDir,
    port: 0,
    proxyPort: 0,
  });
  closers.push(sidecar.close);
  if (opts.withPlugin) {
    writeStableCodexMemory(root);
    const install = installCodexHook({
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
        content: longCodexAnchor(),
      }),
    }).then((r) => r.json());
    expect(enabled.enabled).toBe(true);
  } else {
    writeCodexProfile(codexHome, sidecar.proxyUrl);
  }

  let requestCount = 0;
  const caseRuns: Array<{ id: string; requestIndexes: number[] }> = [];
  for (const [index, testCase] of REAL_CACHE_COMPARISON_CASES.entries()) {
    const beforeCount = requestCount;
    const volatileOverride = volatileDeveloperInstruction(`${opts.label}-${testCase.id}-${index}`);
    if (!opts.withPlugin) writeVolatileCodexMemory(root, `${opts.label}-${testCase.id}-${index}`);
    await runCodex(opts.codexCommand, root, codexHome, testCase.prompt, {
      model: realModel,
      useRealKey: true,
      configOverrides: opts.withPlugin ? [] : [`developer_instructions=${JSON.stringify(volatileOverride)}`],
    });
    await sleep(6_000);
    const interim = await fetch(`${sidecar.url}/api/report`).then((r) => r.json());
    requestCount = interim.requests.length;
    caseRuns.push({ id: testCase.id, requestIndexes: range(beforeCount, requestCount) });
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
    hasCodexActivity: report.summary.codexSteps > 0 || eventsText.includes("codex."),
    hasAnchorInjectedEvent:
      eventsText.includes("cache_anchor.injected") || eventsText.includes("cache_anchor.proxy_injected"),
  };
}

function writeCodexProfile(codexHome: string, proxyBaseUrl: string): void {
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(defaultCodexProfilePath(), codexProfileTemplate(proxyBaseUrl), "utf8");
}

function readAnchorState(dataDir: string): any {
  return JSON.parse(readFileSync(join(dataDir, "cache-anchor.state.json"), "utf8"));
}

function writeStableCodexMemory(root: string): void {
  writeFileSync(
    join(root, "AGENTS.md"),
    [
      "# Stable Codex comparison context",
      "",
      "Keep APAC invoice approvals, SOX evidence, ERP exception queues, reporting owners, and monthly-close governance stable for the plugin comparison arm.",
      "Prompts vary across sessions, but the project memory and dcache anchor remain stable.",
    ].join("\n") + "\n",
    "utf8",
  );
}

function writeVolatileCodexMemory(root: string, label: string): void {
  const nonce = randomUUID();
  writeFileSync(
    join(root, "AGENTS.md"),
    [
      `# Volatile Codex comparison context ${label}`,
      "",
      "This file intentionally changes before every no-plugin baseline prompt.",
      "It simulates a real project whose local instructions, rollout assumptions, and stakeholder wording drift between Codex sessions.",
      "",
      ...Array.from(
        { length: 36 },
        (_, index) =>
          `Volatile Codex note ${index + 1} for ${label}/${nonce}: local team, control wording, evidence owner, reporting lane, and exception taxonomy differ for this baseline run.`,
      ),
    ].join("\n") + "\n",
    "utf8",
  );
}

function volatileDeveloperInstruction(label: string): string {
  const nonce = randomUUID();
  return [
    `Volatile baseline-only Codex instruction ${label}/${nonce}.`,
    "The wording is intentionally different for each no-plugin baseline request.",
    ...Array.from(
      { length: 18 },
      (_, index) =>
        `Changing instruction ${index + 1}: reviewer, control lane, evidence path, exception detail, risk owner, and rollout assumption vary for ${label}/${nonce}.`,
    ),
  ].join("\n");
}

function longCodexAnchor(): string {
  return [
    "Stable Codex CLI DeepSeek comparison anchor.",
    "Project: APAC enterprise finance controls platform.",
    "Permanent vocabulary: invoice approvals, SOX evidence, ERP exception queues, reporting owners, data residency, maker-checker governance, and monthly close.",
    ...Array.from(
      { length: 120 },
      (_, index) =>
        `Stable Codex anchor note ${index + 1}: preserve APAC approval controls, audit evidence retention, ERP exception routing, reporting owner accountability, data residency constraints, and monthly-close governance across Codex sessions.`,
    ),
  ].join("\n");
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      killProcessTree(child.pid);
      reject(new Error("timed out waiting for codex"));
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

async function startMockDeepSeek(): Promise<{
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
    if ((req.url ?? "").includes("/chat/completions")) {
      calls++;
      let body = "";
      for await (const chunk of req) body += String(chunk);
      bodies.push(body);
      const anchored = body.includes("dcache stable cache anchor.");
      const promptTokens = 140;
      const cacheHit = anchored ? 125 : calls > 1 ? 45 : 8;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: `chatcmpl-dcache-codex-${calls}`,
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Mock Codex DeepSeek response." },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: 7,
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
    paths,
    bodies,
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
