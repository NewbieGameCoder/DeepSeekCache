import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function defaultProjectRoot(cwd = process.cwd()): string {
  const path = resolve(cwd);
  return existsSync(path) ? realpathSync.native(path) : path;
}

export function defaultDataDir(projectRoot = defaultProjectRoot()): string {
  return join(projectRoot, ".dcache");
}

export function defaultOpencodeConfigPath(projectRoot = defaultProjectRoot()): string {
  return join(projectRoot, "opencode.json");
}

export function defaultProjectPluginPath(projectRoot = defaultProjectRoot()): string {
  return join(projectRoot, ".opencode", "plugins", "dcache.js");
}

export function defaultOpencodeCommandPath(projectRoot = defaultProjectRoot()): string {
  return join(projectRoot, ".opencode", "commands", "newanchor.md");
}

export function defaultClaudeSettingsPath(projectRoot = defaultProjectRoot()): string {
  return join(projectRoot, ".claude", "settings.local.json");
}

export function defaultClaudeHookPath(projectRoot = defaultProjectRoot()): string {
  return join(projectRoot, ".claude", "hooks", "dcache.mjs");
}

export function defaultClaudeCommandPath(projectRoot = defaultProjectRoot()): string {
  return join(projectRoot, ".claude", "commands", "newanchor.md");
}

export function defaultCodexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

export function defaultCodexHooksPath(): string {
  return join(defaultCodexHome(), "hooks.json");
}

export function defaultCodexProfilePath(): string {
  return join(defaultCodexHome(), "dcache.config.toml");
}

export function defaultCodexHookPath(projectRoot = defaultProjectRoot()): string {
  return join(projectRoot, ".codex", "hooks", "dcache.mjs");
}

export function defaultCodexSkillPath(projectRoot = defaultProjectRoot()): string {
  return join(projectRoot, ".codex", "skills", "newanchor", "SKILL.md");
}

export function defaultNewAnchorScriptPath(dataDir: string): string {
  return join(dataDir, "commands", "newanchor.mjs");
}

export function globalOpencodeConfigPath(): string {
  return join(homedir(), ".config", "opencode", "opencode.json");
}

// ADDED: Scans common opencode config paths and returns the first one found.
// Used by autoDetectTargetsFunc to discover opencode installations without
// requiring --project flag.
export function defaultOpencodeConfigAny(projectRoot = defaultProjectRoot()): string {
  const local = join(projectRoot, "opencode.json");
  const global = globalOpencodeConfigPath();
  const xdg = join(homedir(), ".config", "opencode", "opencode.json");
  if (existsSync(local)) return local;
  if (existsSync(global)) return global;
  if (existsSync(xdg)) return xdg;
  return local;
}

export function normalizeFilePath(path: string): string {
  const resolved = resolve(path);
  return existsSync(resolved) ? realpathSync.native(resolved) : resolved;
}
