import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { readJsoncObject } from "./config.js";
import { writeJsonFile } from "./store.js";

const CODEX_EVENTS: Array<{ name: string; matcher?: string; timeout?: number }> = [
  { name: "SessionStart", matcher: "startup|resume", timeout: 5 },
  { name: "UserPromptSubmit", timeout: 5 },
  { name: "PreCompact", matcher: "manual|auto", timeout: 5 },
  { name: "PostCompact", matcher: "manual|auto", timeout: 5 },
  { name: "Stop", timeout: 5 },
];

const PROFILE_MARKER = "# dcache-managed-codex-profile";

export interface PatchCodexOptions {
  hooksPath: string;
  profilePath: string;
  dataDir: string;
  hookPath: string;
  proxyBaseUrl: string;
  sidecarUrl: string;
  version: string;
  routeProvider?: boolean;
}

export interface PatchCodexResult {
  hooksConfig: Record<string, unknown>;
  backupPath?: string;
  profileBackupPath?: string;
  profileWritten: boolean;
}

export function patchCodexConfig(opts: PatchCodexOptions): PatchCodexResult {
  mkdirSync(dirname(opts.hooksPath), { recursive: true });
  mkdirSync(join(opts.dataDir, "backups"), { recursive: true });
  const existed = existsSync(opts.hooksPath);
  let backupPath: string | undefined;
  if (existed) {
    backupPath = join(opts.dataDir, "backups", `codex.hooks.${Date.now()}.json.bak`);
    copyFileSync(opts.hooksPath, backupPath);
  }

  const hooksConfig = readJsoncObject(opts.hooksPath);
  const command = codexHookCommand(opts.hookPath);
  removeCodexHookCommand(hooksConfig, command);
  const hooks = ensureRecord(hooksConfig, "hooks");
  for (const event of CODEX_EVENTS) {
    const entries = Array.isArray(hooks[event.name]) ? [...(hooks[event.name] as unknown[])] : [];
    entries.push({
      ...(event.matcher ? { matcher: event.matcher } : {}),
      hooks: [{ type: "command", command, timeout: event.timeout }],
    });
    hooks[event.name] = entries;
  }
  writeJsonFile(opts.hooksPath, hooksConfig);

  const profile = opts.routeProvider === true
    ? writeCodexProfile({
        profilePath: opts.profilePath,
        dataDir: opts.dataDir,
        proxyBaseUrl: opts.proxyBaseUrl,
      })
    : { backupPath: undefined, written: false };

  return {
    hooksConfig,
    backupPath,
    profileBackupPath: profile.backupPath,
    profileWritten: profile.written,
  };
}

export function unpatchCodexConfig(
  hooksPath: string,
  hookPath: string,
  opts: { profilePath?: string } = {},
): { hooksConfig: Record<string, unknown>; profileRemoved: boolean } {
  const hooksConfig = readJsoncObject(hooksPath);
  removeCodexHookCommand(hooksConfig, codexHookCommand(hookPath));
  if (isRecord(hooksConfig.hooks) && Object.keys(hooksConfig.hooks).length === 0) {
    delete hooksConfig.hooks;
  }
  writeJsonFile(hooksPath, hooksConfig);

  let profileRemoved = false;
  if (opts.profilePath && existsSync(opts.profilePath) && isManagedCodexProfile(opts.profilePath)) {
    rmSync(opts.profilePath, { force: true });
    profileRemoved = true;
  }

  return { hooksConfig, profileRemoved };
}

export function isCodexConfigHooked(hooksPath: string, hookPath: string): boolean {
  if (!existsSync(hooksPath)) return false;
  try {
    const config = readJsoncObject(hooksPath);
    return containsCodexHookCommand(config, codexHookCommand(hookPath));
  } catch {
    return false;
  }
}

export function isManagedCodexProfile(profilePath: string): boolean {
  if (!existsSync(profilePath)) return false;
  return readFileSync(profilePath, "utf8").includes(PROFILE_MARKER);
}

export function codexProfileTemplate(proxyBaseUrl: string): string {
  const baseUrl = proxyBaseUrl.replace(/\/+$/, "");
  return [
    PROFILE_MARKER,
    "# Use with: codex -p dcache -m deepseek-v4-flash",
    'model_provider = "dcache-deepseek"',
    'model = "deepseek-v4-flash"',
    "",
    "[model_providers.dcache-deepseek]",
    'name = "dcache DeepSeek"',
    `base_url = ${JSON.stringify(baseUrl)}`,
    'env_key = "DEEPSEEK_API_KEY"',
    'wire_api = "responses"',
    "",
  ].join("\n");
}

function writeCodexProfile(opts: {
  profilePath: string;
  dataDir: string;
  proxyBaseUrl: string;
}): { backupPath?: string; written: boolean } {
  mkdirSync(dirname(opts.profilePath), { recursive: true });
  let backupPath: string | undefined;
  if (existsSync(opts.profilePath)) {
    if (!isManagedCodexProfile(opts.profilePath)) {
      return { written: false };
    }
    backupPath = join(opts.dataDir, "backups", `codex.profile.${Date.now()}.toml.bak`);
    copyFileSync(opts.profilePath, backupPath);
  }
  writeFileSync(opts.profilePath, codexProfileTemplate(opts.proxyBaseUrl), "utf8");
  return { backupPath, written: true };
}

function codexHookCommand(hookPath: string): string {
  return `node ${JSON.stringify(hookPath)}`;
}

function removeCodexHookCommand(config: Record<string, unknown>, command: string): void {
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

function containsCodexHookCommand(config: Record<string, unknown>, command: string): boolean {
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
