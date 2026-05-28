#!/usr/bin/env node
import { writeFileSync } from "node:fs";
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
  .option("--sidecar-url <url>", "public sidecar URL used in hook/install metadata")
  .option("--proxy-base-url <url>", "public LLM proxy base URL used in hook/install metadata")
  .option("--upstream <url>", "upstream DeepSeek-compatible base URL", "https://api.deepseek.com/v1")
  .option("--anthropic-upstream <url>", "upstream Anthropic Messages base URL", "https://api.anthropic.com")
  .action(async (opts) => {
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
