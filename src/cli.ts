#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { Command, Option } from "commander";

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
import { dockerComposeTemplate, startDCacheServer } from "./server.js";
import { DCacheStore } from "./store.js";
import { DCACHE_VERSION } from "./types.js";

const program = new Command();

program
  .name("dcache")
  .description("DeepSeek LLM prompt-cache hit-rate optimizer for opencode, Claude Code, and Codex CLI.")
  .version(DCACHE_VERSION);

program
  .command("serve")
  .description("Start the dcache Web report and DeepSeek cache telemetry proxy.")
  .option("--project <dir>", "project root", process.cwd())
  .option("--data-dir <dir>", "data directory")
  .option("--host <host>", "host", "127.0.0.1")
  .option("--port <port>", "web/report port", parseNumber, 48731)
  .option("--proxy-port <port>", "LLM proxy port", parseNumber, 11488)
  .option("--no-auto-port", "fail instead of selecting the next free port when a port is occupied")
  // ADDED: --daemon forks the process into background (Unix only)
  .option("--daemon", "run in background as a daemon process (Unix only)")
  .option("--sidecar-url <url>", "public sidecar URL used in hook/install metadata")
  .option("--proxy-base-url <url>", "public LLM proxy base URL used in hook/install metadata")
  .option("--upstream <url>", "upstream DeepSeek-compatible base URL", "https://api.deepseek.com/v1")
  .option("--anthropic-upstream <url>", "upstream Anthropic Messages base URL", "https://api.anthropic.com")
  .action(async (opts) => {
    startDaemonIfRequested(opts);
    const projectRoot = defaultProjectRoot(opts.project);
    const dataDir = opts.dataDir ?? defaultDataDir(projectRoot);
    const started = await startDCacheServer({
      projectRoot,
      dataDir,
      host: opts.host,
      port: opts.port,
      proxyPort: opts.proxyPort,
      upstreamBaseUrl: opts.upstream,
      anthropicUpstreamBaseUrl: opts.anthropicUpstream,
      autoPort: opts.autoPort,
      sidecarUrl: opts.sidecarUrl,
      proxyBaseUrl: opts.proxyBaseUrl,
    });
    process.stdout.write(`dcache report UI: ${started.url}\n`);
    process.stdout.write(`dcache LLM proxy: ${started.proxyUrl}\n`);
    process.stdout.write("Press Ctrl+C to stop.\n");
  });

program
  .command("hook")
  .description(
    "Install the managed opencode, Claude Code, or Codex CLI hook; add --connect-api to measure cache hits through the local proxy.",
  )
  .option("--project <dir>", "project root", process.cwd())
  .option("--data-dir <dir>", "data directory")
  .option("--sidecar-url <url>", "sidecar URL", "http://127.0.0.1:48731")
  .option("--proxy-base-url <url>", "proxy base URL", "http://127.0.0.1:11488/v1")
  // ADDED: --auto scans common config paths and auto-installs to each detected tool
  .option("--auto", "auto-discover opencode/Claude/Codex installations and configs")
  .option("--connect-api", "rewrite the AI client's API URL to the local dcache proxy")
  .addOption(new Option("--route-provider").hideHelp())
  .option("--target <target>", "opencode, claude, codex, both, or all", "opencode")
  .action((opts) => {
    const projectRoot = defaultProjectRoot(opts.project);
    const base = {
      projectRoot,
      dataDir: opts.dataDir ?? defaultDataDir(projectRoot),
      sidecarUrl: opts.sidecarUrl,
      proxyBaseUrl: opts.proxyBaseUrl,
      routeProvider: opts.connectApi || opts.routeProvider,
    };
    // ADDED: --auto flag triggers auto-discovery for all supported tools
    if (opts.auto) {
      autoInstallAll(projectRoot, base as Parameters<typeof installHook>[0] & { sidecarUrl: string; proxyBaseUrl: string; routeProvider: boolean });
      return;
    }
    const result = installTarget(opts.target, base);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  });

program
  .command("uninstall")
  .description("Remove managed opencode, Claude Code, and/or Codex CLI hook.")
  .option("--project <dir>", "project root", process.cwd())
  .option("--data-dir <dir>", "data directory")
  .option("--target <target>", "opencode, claude, codex, both, or all", "opencode")
  .action((opts) => {
    const projectRoot = defaultProjectRoot(opts.project);
    const base = {
      projectRoot,
      dataDir: opts.dataDir ?? defaultDataDir(projectRoot),
    };
    const result = uninstallTarget(opts.target, base);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  });

program
  .command("doctor")
  .description(
    "Inspect opencode/Claude/Codex installs, Docker visibility, hook state, and collected report stats.",
  )
  .option("--project <dir>", "project root", process.cwd())
  .option("--data-dir <dir>", "data directory")
  .action((opts) => {
    const projectRoot = defaultProjectRoot(opts.project);
    const dataDir = opts.dataDir ?? defaultDataDir(projectRoot);
    const store = new DCacheStore(dataDir);
    const status = hookStatus({ projectRoot, dataDir });
    const claude = claudeHookStatus({ projectRoot, dataDir });
    const codex = codexHookStatus({ projectRoot, dataDir });
    const payload = {
      detection: detectOpencode(projectRoot),
      hook: status,
      claudeHook: claude,
      codexHook: codex,
      report: store.report(),
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  });

program
  .command("report")
  .description("Print the report JSON, or write it to a file.")
  .option("--project <dir>", "project root", process.cwd())
  .option("--data-dir <dir>", "data directory")
  .option("--out <file>", "write JSON report to file")
  .action((opts) => {
    const projectRoot = defaultProjectRoot(opts.project);
    const dataDir = opts.dataDir ?? defaultDataDir(projectRoot);
    const store = new DCacheStore(dataDir);
    const payload = {
      summary: store.report(),
      requests: store.readRequests(),
      findings: store.readFindings(),
      events: store.readEvents(),
    };
    const text = `${JSON.stringify(payload, null, 2)}\n`;
    if (opts.out) writeFileSync(opts.out, text, "utf8");
    else process.stdout.write(text);
  });

program
  .command("docker-template")
  .description("Print a Docker Compose template for sidecar deployment.")
  .option("--out <file>", "write template to file")
  .action((opts) => {
    const text = dockerComposeTemplate();
    if (opts.out) writeFileSync(opts.out, text, "utf8");
    else process.stdout.write(text);
  });

// ADDED: If --daemon is passed, fork the process to background and exit the parent.
function startDaemonIfRequested(opts: Record<string, unknown>): void {
  if (!opts.daemon) return;
  const args = process.argv.slice(2).filter((a) => a !== "--daemon");
  const child = spawn(process.argv[0] || "node", [process.argv[1]!, ...args], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, DCACHE_DAEMONIZED: "1" },
  });
  child.unref();
  process.stdout.write(`dcache daemon started (PID ${child.pid})\n`);
  process.exit(0);
}

// ADDED: --auto discovers opencode/Claude/Codex configs and installs hooks on each.
function autoInstallAll(
  projectRoot: string,
  base: Parameters<typeof installHook>[0] & { sidecarUrl: string; proxyBaseUrl: string; routeProvider: boolean }
): void {
  const { autoDetectTargetsFunc } = require("./detect.js") as {
    autoDetectTargetsFunc: (root: string) => Record<string, { found: boolean; configPath?: string; dataDir?: string }>;
  };
  const targets = autoDetectTargetsFunc(projectRoot);
  const results: Record<string, unknown> = {};
  for (const [target, detected] of Object.entries(targets) as [string, { found: boolean; configPath?: string; dataDir?: string }][]) {
    if (!detected.found) continue;
    try {
      if (target === "opencode") {
        results[target] = installHook({ ...base, configPath: detected.configPath, dataDir: detected.dataDir || base.dataDir });
      } else if (target === "claude") {
        results[target] = installClaudeHook({ ...base, configPath: detected.configPath, dataDir: detected.dataDir || base.dataDir });
      } else if (target === "codex") {
        results[target] = installCodexHook({ ...base, configPath: detected.configPath, dataDir: detected.dataDir || base.dataDir });
      }
    } catch (err) {
      results[target] = { ok: false, error: (err as Error).message };
    }
  }
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
}

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`${(err as Error).stack ?? (err as Error).message}\n`);
  process.exitCode = 1;
});

function parseNumber(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`invalid number: ${value}`);
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`invalid port number: ${value}`);
  }
  return n;
}

function installTarget(target: string, base: Parameters<typeof installHook>[0]): unknown {
  switch (target) {
    case "claude":
      return installClaudeHook(base);
    case "codex":
      return installCodexHook(base);
    case "both":
      return [installHook(base), installClaudeHook(base)];
    case "all":
      return [installHook(base), installClaudeHook(base), installCodexHook(base)];
    case "opencode":
      return installHook(base);
    default:
      throw new Error(`unknown target: ${target}`);
  }
}

function uninstallTarget(target: string, base: Parameters<typeof uninstallHook>[0]): unknown {
  switch (target) {
    case "claude":
      return uninstallClaudeHook(base);
    case "codex":
      return uninstallCodexHook(base);
    case "both":
      return [uninstallHook(base), uninstallClaudeHook(base)];
    case "all":
      return [uninstallHook(base), uninstallClaudeHook(base), uninstallCodexHook(base)];
    case "opencode":
      return uninstallHook(base);
    default:
      throw new Error(`unknown target: ${target}`);
  }
}
