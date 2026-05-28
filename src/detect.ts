import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  defaultCodexHooksPath,
  defaultCodexProfilePath,
  defaultClaudeSettingsPath,
  defaultOpencodeConfigPath,
  globalOpencodeConfigPath,
} from "./paths.js";
import type { DetectionResult } from "./types.js";

export function detectOpencode(projectRoot = process.cwd()): DetectionResult {
  const command = findCommand("opencode");
  const version = command ? runVersion(command) : undefined;
  const claudeCommand = findCommand("claude");
  const claudeVersion = claudeCommand ? runVersion(claudeCommand) : undefined;
  const codexCommand = findCommand("codex");
  const codexVersion = codexCommand ? runVersion(codexCommand) : undefined;
  const docker = run("docker", ["ps", "--format", "{{.Names}} {{.Image}}"]);
  const dockerAvailable = docker.status === 0;
  const dockerOpencodeContainers = dockerAvailable
    ? docker.stdout
        .split(/\r?\n/)
        .filter((line) => /(opencode|dcache)/i.test(line))
        .map((line) => line.trim())
    : [];
  const candidates = [
    defaultOpencodeConfigPath(projectRoot),
    globalOpencodeConfigPath(),
    join(homedir(), ".config", "opencode", "opencode.jsonc"),
  ].filter((p, i, arr) => arr.indexOf(p) === i);
  const claudeSettingsCandidates = [
    defaultClaudeSettingsPath(projectRoot),
    join(projectRoot, ".claude", "settings.json"),
    join(homedir(), ".claude", "settings.json"),
  ].filter((p, i, arr) => arr.indexOf(p) === i);
  const codexConfigCandidates = [
    defaultCodexHooksPath(),
    defaultCodexProfilePath(),
    join(homedir(), ".codex", "config.toml"),
  ].filter((p, i, arr) => arr.indexOf(p) === i);
  return {
    opencodeCommand: command,
    opencodeVersion: version,
    claudeCommand,
    claudeVersion,
    codexCommand,
    codexVersion,
    dockerAvailable,
    dockerOpencodeContainers,
    configCandidates: candidates.filter((p) => existsSync(p)),
    claudeSettingsCandidates: claudeSettingsCandidates.filter((p) => existsSync(p)),
    codexConfigCandidates: codexConfigCandidates.filter((p) => existsSync(p)),
    platform: process.platform,
  };
}

function findCommand(binary: string): string | undefined {
  if (process.platform === "win32" && binary === "claude") {
    const realClaudePath = join(homedir(), ".cac", "real_claude");
    if (existsSync(realClaudePath)) {
      const realClaude = readFileSync(realClaudePath, "utf8").trim();
      if (existsSync(realClaude)) return realClaude;
    }
  }
  const cmd = process.platform === "win32" ? "where.exe" : "which";
  const res = run(cmd, [binary]);
  if (res.status !== 0) return undefined;
  return res.stdout
    .split(/\r?\n/)
    .find((line) => line.trim().length > 0)
    ?.trim();
}

function runVersion(command: string): string | undefined {
  const res = run(command, ["--version"]);
  return res.status === 0 ? res.stdout.trim().split(/\s+/)[0] : undefined;
}

function run(
  command: string,
  args: string[],
): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    shell: false,
  });
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}
