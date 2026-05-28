import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { readJsoncObject } from "./config.js";
import { writeJsonFile } from "./store.js";

const CLAUDE_EVENTS: Array<{ name: string; matcher?: string; timeout?: number }> = [
  { name: "SessionStart", matcher: "startup|resume|clear|compact", timeout: 5 },
  { name: "UserPromptSubmit", timeout: 5 },
  { name: "PreCompact", matcher: "manual|auto", timeout: 5 },
  { name: "PostCompact", matcher: "manual|auto", timeout: 5 },
  { name: "SessionEnd", matcher: "clear|resume|logout|prompt_input_exit|bypass_permissions_disabled|other", timeout: 5 },
  { name: "CwdChanged", timeout: 5 },
];

export interface PatchClaudeSettingsOptions {
  settingsPath: string;
  dataDir: string;
  hookPath: string;
  proxyBaseUrl: string;
  sidecarUrl: string;
  version: string;
  routeProvider?: boolean;
  previousClaudeEnv?: Record<string, unknown>;
}

export interface PatchClaudeSettingsResult {
  config: Record<string, unknown>;
  backupPath?: string;
  previousClaudeEnv: Record<string, unknown>;
}

export function patchClaudeSettings(opts: PatchClaudeSettingsOptions): PatchClaudeSettingsResult {
  mkdirSync(dirname(opts.settingsPath), { recursive: true });
  mkdirSync(join(opts.dataDir, "backups"), { recursive: true });
  const existed = existsSync(opts.settingsPath);
  let backupPath: string | undefined;
  if (existed) {
    backupPath = join(opts.dataDir, "backups", `claude.settings.${Date.now()}.json.bak`);
    copyFileSync(opts.settingsPath, backupPath);
  }

  const config = readJsoncObject(opts.settingsPath);
  const command = claudeHookCommand(opts.hookPath);
  removeClaudeHookCommand(config, command);
  const hooks = ensureRecord(config, "hooks");
  for (const event of CLAUDE_EVENTS) {
    const entries = Array.isArray(hooks[event.name]) ? [...(hooks[event.name] as unknown[])] : [];
    entries.push({
      ...(event.matcher ? { matcher: event.matcher } : {}),
      hooks: [{ type: "command", command, timeout: event.timeout }],
    });
    hooks[event.name] = entries;
  }

  const env = ensureRecord(config, "env");
  const previousClaudeEnv = opts.previousClaudeEnv ?? {
    ANTHROPIC_BASE_URL: cloneJson(env.ANTHROPIC_BASE_URL),
  };
  env.DCACHE_DATA_DIR = opts.dataDir;
  env.DCACHE_SIDECAR_URL = opts.sidecarUrl;
  if (opts.routeProvider === true) {
    env.ANTHROPIC_BASE_URL = claudeGatewayBaseUrl(opts.proxyBaseUrl);
  }

  writeJsonFile(opts.settingsPath, config);
  return { config, backupPath, previousClaudeEnv };
}

export function unpatchClaudeSettings(
  settingsPath: string,
  hookPath: string,
  opts: {
    previousClaudeEnv?: Record<string, unknown>;
    proxyBaseUrl?: string;
  } = {},
): { config: Record<string, unknown> } {
  const config = readJsoncObject(settingsPath);
  removeClaudeHookCommand(config, claudeHookCommand(hookPath));

  if (isRecord(config.env)) {
    const env = config.env;
    delete env.DCACHE_DATA_DIR;
    delete env.DCACHE_SIDECAR_URL;
    const managedBaseUrl = opts.proxyBaseUrl ? claudeGatewayBaseUrl(opts.proxyBaseUrl) : undefined;
    if (!managedBaseUrl || env.ANTHROPIC_BASE_URL === managedBaseUrl) {
      if (opts.previousClaudeEnv && "ANTHROPIC_BASE_URL" in opts.previousClaudeEnv) {
        const previous = opts.previousClaudeEnv.ANTHROPIC_BASE_URL;
        if (previous === undefined) delete env.ANTHROPIC_BASE_URL;
        else env.ANTHROPIC_BASE_URL = previous;
      } else if (managedBaseUrl) {
        delete env.ANTHROPIC_BASE_URL;
      }
    }
    if (Object.keys(env).length === 0) delete config.env;
  }
  if (isRecord(config.hooks) && Object.keys(config.hooks).length === 0) delete config.hooks;

  writeJsonFile(settingsPath, config);
  return { config };
}

export function isClaudeSettingsHooked(settingsPath: string, hookPath: string): boolean {
  if (!existsSync(settingsPath)) return false;
  try {
    const config = readJsoncObject(settingsPath);
    return containsClaudeHookCommand(config, claudeHookCommand(hookPath));
  } catch {
    return false;
  }
}

export function claudeGatewayBaseUrl(proxyBaseUrl: string): string {
  return proxyBaseUrl.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
}

function claudeHookCommand(hookPath: string): string {
  return `node ${JSON.stringify(hookPath)}`;
}

function removeClaudeHookCommand(config: Record<string, unknown>, command: string): void {
  if (!isRecord(config.hooks)) return;
  for (const [event, value] of Object.entries(config.hooks)) {
    if (!Array.isArray(value)) continue;
    const groups = value
      .map((entry) => removeCommandFromGroup(entry, command))
      .filter((entry): entry is Record<string, unknown> => Boolean(entry));
    if (groups.length > 0) config.hooks[event] = groups;
    else delete config.hooks[event];
  }
}

function removeCommandFromGroup(value: unknown, command: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const hooks = Array.isArray(value.hooks) ? value.hooks : [];
  const keptHooks = hooks.filter(
    (hook) => !(isRecord(hook) && hook.type === "command" && hook.command === command),
  );
  if (keptHooks.length === 0) return undefined;
  return { ...value, hooks: keptHooks };
}

function containsClaudeHookCommand(config: Record<string, unknown>, command: string): boolean {
  if (!isRecord(config.hooks)) return false;
  for (const value of Object.values(config.hooks)) {
    if (!Array.isArray(value)) continue;
    for (const group of value) {
      if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
      if (
        group.hooks.some(
          (hook) => isRecord(hook) && hook.type === "command" && hook.command === command,
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

function ensureRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const current = parent[key];
  if (current && typeof current === "object" && !Array.isArray(current)) {
    return current as Record<string, unknown>;
  }
  const next: Record<string, unknown> = {};
  parent[key] = next;
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function cloneJson<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}
