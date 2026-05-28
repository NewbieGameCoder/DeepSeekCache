import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { DCacheManagedState } from "./types.js";

export interface PatchConfigOptions {
  configPath: string;
  dataDir: string;
  pluginPath: string;
  sidecarUrl: string;
  proxyBaseUrl: string;
  version: string;
  previousDeepseekProviderState?: { value: unknown };
}

export interface PatchConfigResult {
  config: Record<string, unknown>;
  backupPath?: string;
  managed: DCacheManagedState;
}

export function readJsoncObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return {};
  return JSON.parse(stripJsonComments(raw)) as Record<string, unknown>;
}

export function patchOpencodeConfig(opts: PatchConfigOptions): PatchConfigResult {
  mkdirSync(dirname(opts.configPath), { recursive: true });
  mkdirSync(join(opts.dataDir, "backups"), { recursive: true });
  const existed = existsSync(opts.configPath);
  let backupPath: string | undefined;
  if (existed) {
    backupPath = join(opts.dataDir, "backups", `opencode.${Date.now()}.json.bak`);
    copyFileSync(opts.configPath, backupPath);
  }
  const config = readJsoncObject(opts.configPath);
  const provider = ensureRecord(config, "provider");
  const previousDeepseekProvider = opts.previousDeepseekProviderState
    ? opts.previousDeepseekProviderState.value
    : cloneJson(provider.deepseek);
  const deepseek = ensureRecord(provider, "deepseek");
  const options = ensureRecord(deepseek, "options");
  options.baseURL = opts.proxyBaseUrl;
  const managed: DCacheManagedState = {
    version: opts.version,
    installedAt: new Date().toISOString(),
    pluginPath: opts.pluginPath,
    sidecarUrl: opts.sidecarUrl,
    proxyBaseUrl: opts.proxyBaseUrl,
    previousDeepseekProvider,
  };
  writeConfig(opts.configPath, config);
  return { config, backupPath, managed };
}

export function unpatchOpencodeConfig(
  configPath: string,
  previousDeepseekProvider: unknown,
): { config: Record<string, unknown> } {
  const config = readJsoncObject(configPath);
  const provider = isRecord(config.provider) ? config.provider : {};
  const nextProvider =
    previousDeepseekProvider === undefined
      ? withoutKey(provider, "deepseek")
      : { ...provider, deepseek: previousDeepseekProvider };
  const nextConfig =
    Object.keys(nextProvider).length === 0
      ? withoutKey(config, "provider")
      : { ...config, provider: nextProvider };
  writeConfig(configPath, nextConfig);
  return { config: nextConfig };
}

export function isConfigHooked(configPath: string, proxyBaseUrl?: string): boolean {
  if (!existsSync(configPath)) return false;
  try {
    const config = readJsoncObject(configPath);
    const provider = isRecord(config.provider) ? config.provider : {};
    const deepseek = isRecord(provider.deepseek) ? provider.deepseek : {};
    const options = isRecord(deepseek.options) ? deepseek.options : {};
    const baseURL = options.baseURL;
    if (typeof baseURL !== "string") return false;
    if (proxyBaseUrl) return baseURL === proxyBaseUrl;
    return /^http:\/\/(127\.0\.0\.1|localhost):\d+\/v1\/?$/.test(baseURL);
  } catch {
    return false;
  }
}

function writeConfig(path: string, config: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
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

function withoutKey(source: Record<string, unknown>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(source).filter(([entryKey]) => entryKey !== key));
}

function cloneJson<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

export function stripJsonComments(input: string): string {
  let out = "";
  let inString = false;
  let quote = "";
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    const next = input[i + 1];
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        inString = false;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < input.length && input[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += ch;
  }
  return out.replace(/,\s*([}\]])/g, "$1");
}
