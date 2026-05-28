import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  claudeGatewayBaseUrl,
  isClaudeSettingsHooked,
  patchClaudeSettings,
  unpatchClaudeSettings,
} from "./claude-config.js";
import { claudeHookTemplate } from "./claude-hook-template.js";
import {
  newAnchorCodexSkillTemplate,
  newAnchorCommandTemplate,
  newAnchorScriptTemplate,
} from "./command-template.js";
import {
  isCodexConfigHooked,
  isManagedCodexProfile,
  patchCodexConfig,
  unpatchCodexConfig,
} from "./codex-config.js";
import { codexHookTemplate } from "./codex-hook-template.js";
import { isConfigHooked, patchOpencodeConfig, unpatchOpencodeConfig } from "./config.js";
import { detectOpencode } from "./detect.js";
import {
  defaultCodexHookPath,
  defaultCodexHooksPath,
  defaultCodexProfilePath,
  defaultCodexSkillPath,
  defaultClaudeCommandPath,
  defaultClaudeHookPath,
  defaultClaudeSettingsPath,
  defaultDataDir,
  defaultNewAnchorScriptPath,
  defaultOpencodeCommandPath,
  defaultOpencodeConfigPath,
  defaultProjectPluginPath,
  defaultProjectRoot,
} from "./paths.js";
import { pluginTemplate } from "./plugin-template.js";
import { writeJsonFile } from "./store.js";
import {
  DCACHE_VERSION,
  type DCacheManagedState,
  type InstallOptions,
  type InstallResult,
} from "./types.js";

const DEFAULT_SIDECAR_URL = "http://127.0.0.1:48731";
const DEFAULT_PROXY_BASE_URL = "http://127.0.0.1:11488/v1";

export function installHook(opts: InstallOptions = {}): InstallResult {
  const projectRoot = defaultProjectRoot(opts.projectRoot);
  const dataDir = opts.dataDir ?? defaultDataDir(projectRoot);
  const configPath = opts.configPath ?? defaultOpencodeConfigPath(projectRoot);
  const pluginPath = defaultProjectPluginPath(projectRoot);
  const newAnchorCommandPath = defaultOpencodeCommandPath(projectRoot);
  const newAnchorScriptPath = defaultNewAnchorScriptPath(dataDir);
  const sidecarUrl = opts.sidecarUrl ?? DEFAULT_SIDECAR_URL;
  const proxyBaseUrl = opts.proxyBaseUrl ?? DEFAULT_PROXY_BASE_URL;
  const routeProvider = opts.routeProvider === true;
  if (existsSync(pluginPath) && !isManagedPlugin(pluginPath)) {
    return {
      ok: false,
      action: "hook",
      projectRoot,
      dataDir,
      configPath,
      pluginPath,
      messages: [
        "plugin path exists but is not dcache-managed; left untouched",
        "provider routing skipped to avoid partial install",
      ],
    };
  }
  mkdirSync(dirname(pluginPath), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(pluginPath, pluginTemplate(sidecarUrl, dataDir), "utf8");
  const messages = [
    "dcache plugin installed",
    routeProvider
      ? "opencode deepseek provider baseURL points at the local dcache proxy"
      : "provider routing skipped; plugin-only hook installed",
  ];
  installNewAnchorCommand({
    runtime: "opencode",
    commandPath: newAnchorCommandPath,
    scriptPath: newAnchorScriptPath,
    dataDir,
    messages,
  });
  const previousInstall = readInstallState(dataDir);
  const patch = routeProvider
    ? patchOpencodeConfig({
        configPath,
        dataDir,
        pluginPath,
        sidecarUrl,
        proxyBaseUrl,
        version: DCACHE_VERSION,
        previousDeepseekProviderState: previousInstall
          ? { value: previousInstall.previousDeepseekProvider }
          : undefined,
      })
    : undefined;
  const installJson = {
    version: DCACHE_VERSION,
    installedAt: new Date().toISOString(),
    projectRoot,
    dataDir,
    configPath,
    pluginPath,
    newAnchorCommandPath,
    newAnchorScriptPath,
    sidecarUrl,
    proxyBaseUrl,
    routeProvider,
    backupPath: patch?.backupPath,
    previousDeepseekProvider: patch?.managed.previousDeepseekProvider,
    detection: detectOpencode(projectRoot),
  };
  writeJsonFile(`${dataDir}/install.json`, installJson);
  return {
    ok: true,
    action: "hook",
    projectRoot,
    dataDir,
    configPath,
    pluginPath,
    newAnchorCommandPath,
    newAnchorScriptPath,
    backupPath: patch?.backupPath,
    messages,
  };
}

export function installClaudeHook(opts: InstallOptions = {}): InstallResult {
  const projectRoot = defaultProjectRoot(opts.projectRoot);
  const dataDir = opts.dataDir ?? defaultDataDir(projectRoot);
  const configPath = opts.configPath ?? defaultClaudeSettingsPath(projectRoot);
  const pluginPath = defaultClaudeHookPath(projectRoot);
  const newAnchorCommandPath = defaultClaudeCommandPath(projectRoot);
  const newAnchorScriptPath = defaultNewAnchorScriptPath(dataDir);
  const sidecarUrl = opts.sidecarUrl ?? DEFAULT_SIDECAR_URL;
  const proxyBaseUrl = opts.proxyBaseUrl ?? DEFAULT_PROXY_BASE_URL;
  const routeProvider = opts.routeProvider === true;
  if (existsSync(pluginPath) && !isManagedClaudeHook(pluginPath)) {
    return {
      ok: false,
      action: "hook",
      projectRoot,
      dataDir,
      configPath,
      pluginPath,
      messages: [
        "claude hook path exists but is not dcache-managed; left untouched",
        "claude settings skipped to avoid partial install",
      ],
    };
  }
  mkdirSync(dirname(pluginPath), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(pluginPath, claudeHookTemplate(sidecarUrl, dataDir), "utf8");
  const messages = [
    "dcache claude hook installed",
    routeProvider
      ? "claude ANTHROPIC_BASE_URL points at the local dcache Anthropic proxy"
      : "claude provider routing skipped; hook-only install configured",
  ];
  installNewAnchorCommand({
    runtime: "claude",
    commandPath: newAnchorCommandPath,
    scriptPath: newAnchorScriptPath,
    dataDir,
    messages,
  });
  const previousInstall = readInstallState(dataDir, "install-claude.json");
  const patch = patchClaudeSettings({
    settingsPath: configPath,
    dataDir,
    hookPath: pluginPath,
    sidecarUrl,
    proxyBaseUrl,
    version: DCACHE_VERSION,
    routeProvider,
    previousClaudeEnv: previousInstall?.previousClaudeEnv,
  });
  writeJsonFile(`${dataDir}/install-claude.json`, {
    version: DCACHE_VERSION,
    installedAt: new Date().toISOString(),
    projectRoot,
    dataDir,
    configPath,
    pluginPath,
    newAnchorCommandPath,
    newAnchorScriptPath,
    sidecarUrl,
    proxyBaseUrl,
    claudeGatewayBaseUrl: claudeGatewayBaseUrl(proxyBaseUrl),
    routeProvider,
    backupPath: patch.backupPath,
    previousClaudeEnv: patch.previousClaudeEnv,
    detection: detectOpencode(projectRoot),
  });
  return {
    ok: true,
    action: "hook",
    projectRoot,
    dataDir,
    configPath,
    pluginPath,
    newAnchorCommandPath,
    newAnchorScriptPath,
    backupPath: patch.backupPath,
    messages,
  };
}

export function installCodexHook(opts: InstallOptions = {}): InstallResult {
  const projectRoot = defaultProjectRoot(opts.projectRoot);
  const dataDir = opts.dataDir ?? defaultDataDir(projectRoot);
  const configPath = opts.configPath ?? defaultCodexHooksPath();
  const profilePath = defaultCodexProfilePath();
  const pluginPath = defaultCodexHookPath(projectRoot);
  const newAnchorCommandPath = defaultCodexSkillPath(projectRoot);
  const newAnchorScriptPath = defaultNewAnchorScriptPath(dataDir);
  const sidecarUrl = opts.sidecarUrl ?? DEFAULT_SIDECAR_URL;
  const proxyBaseUrl = opts.proxyBaseUrl ?? DEFAULT_PROXY_BASE_URL;
  const routeProvider = opts.routeProvider === true;
  if (existsSync(pluginPath) && !isManagedCodexHook(pluginPath)) {
    return {
      ok: false,
      action: "hook",
      projectRoot,
      dataDir,
      configPath,
      pluginPath,
      messages: [
        "codex hook path exists but is not dcache-managed; left untouched",
        "codex hooks/profile skipped to avoid partial install",
      ],
    };
  }
  if (routeProvider && existsSync(profilePath) && !isManagedCodexProfile(profilePath)) {
    return {
      ok: false,
      action: "hook",
      projectRoot,
      dataDir,
      configPath,
      pluginPath,
      messages: [
        "codex dcache profile exists but is not dcache-managed; left untouched",
        "codex hooks skipped to avoid partial install",
      ],
    };
  }
  mkdirSync(dirname(pluginPath), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(pluginPath, codexHookTemplate(sidecarUrl, dataDir, projectRoot), "utf8");
  const messages = [
    "dcache codex hook installed",
    routeProvider
      ? "codex dcache profile points at the local Responses-to-DeepSeek proxy"
      : "codex provider routing skipped; hook-only install configured",
  ];
  installCodexNewAnchorSkill({
    commandPath: newAnchorCommandPath,
    scriptPath: newAnchorScriptPath,
    dataDir,
    messages,
  });
  const patch = patchCodexConfig({
    hooksPath: configPath,
    profilePath,
    dataDir,
    hookPath: pluginPath,
    sidecarUrl,
    proxyBaseUrl,
    version: DCACHE_VERSION,
    routeProvider,
  });
  if (routeProvider && patch.profileWritten) {
    messages.push("codex profile installed; run Codex with -p dcache");
  } else if (routeProvider && !patch.profileWritten) {
    messages.push("codex profile skipped because an unmanaged profile exists");
  }
  writeJsonFile(`${dataDir}/install-codex.json`, {
    version: DCACHE_VERSION,
    installedAt: new Date().toISOString(),
    projectRoot,
    dataDir,
    configPath,
    pluginPath,
    profilePath,
    newAnchorCommandPath,
    newAnchorScriptPath,
    sidecarUrl,
    proxyBaseUrl,
    routeProvider,
    backupPath: patch.backupPath,
    profileBackupPath: patch.profileBackupPath,
    detection: detectOpencode(projectRoot),
  });
  return {
    ok: true,
    action: "hook",
    projectRoot,
    dataDir,
    configPath,
    pluginPath,
    newAnchorCommandPath,
    newAnchorScriptPath,
    backupPath: patch.backupPath,
    messages,
  };
}

export function uninstallHook(opts: InstallOptions = {}): InstallResult {
  const projectRoot = defaultProjectRoot(opts.projectRoot);
  const dataDir = opts.dataDir ?? defaultDataDir(projectRoot);
  const configPath = opts.configPath ?? defaultOpencodeConfigPath(projectRoot);
  const pluginPath = defaultProjectPluginPath(projectRoot);
  const newAnchorCommandPath = defaultOpencodeCommandPath(projectRoot);
  const claudeNewAnchorCommandPath = defaultClaudeCommandPath(projectRoot);
  const codexNewAnchorCommandPath = defaultCodexSkillPath(projectRoot);
  const newAnchorScriptPath = defaultNewAnchorScriptPath(dataDir);
  const messages: string[] = [];
  const installState = readInstallState(dataDir);
  const proxyBaseUrl = opts.proxyBaseUrl ?? installState?.proxyBaseUrl ?? DEFAULT_PROXY_BASE_URL;
  if (
    existsSync(configPath) &&
    installState &&
    installState.routeProvider !== false &&
    isConfigHooked(configPath, proxyBaseUrl)
  ) {
    unpatchOpencodeConfig(configPath, installState.previousDeepseekProvider);
    messages.push("opencode config restored");
  } else if (existsSync(configPath) && isConfigHooked(configPath, proxyBaseUrl)) {
    messages.push("opencode config appears hooked but install metadata is missing; left untouched");
  } else {
    messages.push("opencode config was not dcache-managed");
  }
  const removed = removeManagedPluginFiles([pluginPath], messages, "plugin");
  if (!removed && !existsSync(pluginPath)) {
    messages.push("managed plugin already absent");
  }
  removeManagedNewAnchorCommand(newAnchorCommandPath, messages, "opencode");
  removeNewAnchorScriptIfUnused(
    newAnchorScriptPath,
    [newAnchorCommandPath, claudeNewAnchorCommandPath, codexNewAnchorCommandPath],
    messages,
  );
  mkdirSync(dataDir, { recursive: true });
  writeJsonFile(`${dataDir}/uninstall.json`, {
    version: DCACHE_VERSION,
    uninstalledAt: new Date().toISOString(),
    projectRoot,
    configPath,
    pluginPath,
    newAnchorCommandPath,
    newAnchorScriptPath,
  });
  return {
    ok: true,
    action: "uninstall",
    projectRoot,
    dataDir,
    configPath,
    pluginPath,
    newAnchorCommandPath,
    newAnchorScriptPath,
    messages,
  };
}

export function uninstallClaudeHook(opts: InstallOptions = {}): InstallResult {
  const projectRoot = defaultProjectRoot(opts.projectRoot);
  const dataDir = opts.dataDir ?? defaultDataDir(projectRoot);
  const configPath = opts.configPath ?? defaultClaudeSettingsPath(projectRoot);
  const pluginPath = defaultClaudeHookPath(projectRoot);
  const newAnchorCommandPath = defaultClaudeCommandPath(projectRoot);
  const opencodeNewAnchorCommandPath = defaultOpencodeCommandPath(projectRoot);
  const codexNewAnchorCommandPath = defaultCodexSkillPath(projectRoot);
  const newAnchorScriptPath = defaultNewAnchorScriptPath(dataDir);
  const messages: string[] = [];
  const installState = readInstallState(dataDir, "install-claude.json");
  const proxyBaseUrl = opts.proxyBaseUrl ?? installState?.proxyBaseUrl ?? DEFAULT_PROXY_BASE_URL;
  const settingsHooked =
    existsSync(configPath) &&
    isClaudeSettingsHooked(configPath, pluginPath);
  if (settingsHooked) {
    unpatchClaudeSettings(configPath, pluginPath, {
      previousClaudeEnv: installState?.previousClaudeEnv,
      proxyBaseUrl,
    });
    messages.push("claude settings restored");
  } else {
    messages.push("claude settings were not dcache-managed");
  }
  const removed = removeManagedPluginFiles([pluginPath], messages, "claude hook");
  if (!removed && !existsSync(pluginPath)) {
    messages.push("managed claude hook already absent");
  }
  removeManagedNewAnchorCommand(newAnchorCommandPath, messages, "claude");
  removeNewAnchorScriptIfUnused(
    newAnchorScriptPath,
    [opencodeNewAnchorCommandPath, newAnchorCommandPath, codexNewAnchorCommandPath],
    messages,
  );
  mkdirSync(dataDir, { recursive: true });
  writeJsonFile(`${dataDir}/uninstall-claude.json`, {
    version: DCACHE_VERSION,
    uninstalledAt: new Date().toISOString(),
    projectRoot,
    configPath,
    pluginPath,
    newAnchorCommandPath,
    newAnchorScriptPath,
  });
  return {
    ok: true,
    action: "uninstall",
    projectRoot,
    dataDir,
    configPath,
    pluginPath,
    newAnchorCommandPath,
    newAnchorScriptPath,
    messages,
  };
}

export function uninstallCodexHook(opts: InstallOptions = {}): InstallResult {
  const projectRoot = defaultProjectRoot(opts.projectRoot);
  const dataDir = opts.dataDir ?? defaultDataDir(projectRoot);
  const configPath = opts.configPath ?? defaultCodexHooksPath();
  const pluginPath = defaultCodexHookPath(projectRoot);
  const newAnchorCommandPath = defaultCodexSkillPath(projectRoot);
  const opencodeNewAnchorCommandPath = defaultOpencodeCommandPath(projectRoot);
  const claudeNewAnchorCommandPath = defaultClaudeCommandPath(projectRoot);
  const newAnchorScriptPath = defaultNewAnchorScriptPath(dataDir);
  const profilePath = defaultCodexProfilePath();
  const messages: string[] = [];
  if (existsSync(configPath) && isCodexConfigHooked(configPath, pluginPath)) {
    const unpatch = unpatchCodexConfig(configPath, pluginPath, { profilePath });
    messages.push("codex hooks restored");
    messages.push(unpatch.profileRemoved ? "codex dcache profile removed" : "codex dcache profile absent or unmanaged");
  } else {
    messages.push("codex hooks were not dcache-managed");
    if (existsSync(profilePath) && isManagedCodexProfile(profilePath)) {
      rmSync(profilePath, { force: true });
      messages.push("codex dcache profile removed");
    }
  }
  const removed = removeManagedPluginFiles([pluginPath], messages, "codex hook");
  if (!removed && !existsSync(pluginPath)) {
    messages.push("managed codex hook already absent");
  }
  removeManagedNewAnchorCommand(newAnchorCommandPath, messages, "codex");
  removeNewAnchorScriptIfUnused(
    newAnchorScriptPath,
    [opencodeNewAnchorCommandPath, claudeNewAnchorCommandPath, newAnchorCommandPath],
    messages,
  );
  mkdirSync(dataDir, { recursive: true });
  writeJsonFile(`${dataDir}/uninstall-codex.json`, {
    version: DCACHE_VERSION,
    uninstalledAt: new Date().toISOString(),
    projectRoot,
    configPath,
    pluginPath,
    profilePath,
    newAnchorCommandPath,
    newAnchorScriptPath,
  });
  return {
    ok: true,
    action: "uninstall",
    projectRoot,
    dataDir,
    configPath,
    pluginPath,
    newAnchorCommandPath,
    newAnchorScriptPath,
    messages,
  };
}

export function hookStatus(opts: InstallOptions = {}): {
  hooked: boolean;
  configPath: string;
  pluginPath: string;
  newAnchorCommandPath: string;
  newAnchorScriptPath: string;
  newAnchorCommandInstalled: boolean;
  dataDir: string;
  sidecarUrl: string;
  proxyBaseUrl: string;
} {
  const projectRoot = defaultProjectRoot(opts.projectRoot);
  const dataDir = opts.dataDir ?? defaultDataDir(projectRoot);
  const configPath = opts.configPath ?? defaultOpencodeConfigPath(projectRoot);
  const pluginPath = defaultProjectPluginPath(projectRoot);
  const newAnchorCommandPath = defaultOpencodeCommandPath(projectRoot);
  const newAnchorScriptPath = defaultNewAnchorScriptPath(dataDir);
  const installState = readInstallState(dataDir);
  const proxyBaseUrl = opts.proxyBaseUrl ?? installState?.proxyBaseUrl ?? DEFAULT_PROXY_BASE_URL;
  const pluginOk = existsSync(pluginPath) && isManagedPlugin(pluginPath);
  const configOk =
    installState?.routeProvider === false || isConfigHooked(configPath, proxyBaseUrl);
  return {
    hooked: pluginOk && configOk,
    configPath,
    pluginPath,
    newAnchorCommandPath,
    newAnchorScriptPath,
    newAnchorCommandInstalled:
      existsSync(newAnchorCommandPath) && isManagedNewAnchorCommand(newAnchorCommandPath),
    dataDir,
    sidecarUrl: opts.sidecarUrl ?? installState?.sidecarUrl ?? DEFAULT_SIDECAR_URL,
    proxyBaseUrl,
  };
}

export function claudeHookStatus(opts: InstallOptions = {}): {
  hooked: boolean;
  configPath: string;
  pluginPath: string;
  newAnchorCommandPath: string;
  newAnchorScriptPath: string;
  newAnchorCommandInstalled: boolean;
  dataDir: string;
  sidecarUrl: string;
  proxyBaseUrl: string;
} {
  const projectRoot = defaultProjectRoot(opts.projectRoot);
  const dataDir = opts.dataDir ?? defaultDataDir(projectRoot);
  const configPath = opts.configPath ?? defaultClaudeSettingsPath(projectRoot);
  const pluginPath = defaultClaudeHookPath(projectRoot);
  const newAnchorCommandPath = defaultClaudeCommandPath(projectRoot);
  const newAnchorScriptPath = defaultNewAnchorScriptPath(dataDir);
  const installState = readInstallState(dataDir, "install-claude.json");
  return {
    hooked:
      (existsSync(pluginPath) &&
        isManagedClaudeHook(pluginPath) &&
        isClaudeSettingsHooked(configPath, pluginPath)),
    configPath,
    pluginPath,
    newAnchorCommandPath,
    newAnchorScriptPath,
    newAnchorCommandInstalled:
      existsSync(newAnchorCommandPath) && isManagedNewAnchorCommand(newAnchorCommandPath),
    dataDir,
    sidecarUrl: opts.sidecarUrl ?? installState?.sidecarUrl ?? DEFAULT_SIDECAR_URL,
    proxyBaseUrl: opts.proxyBaseUrl ?? installState?.proxyBaseUrl ?? DEFAULT_PROXY_BASE_URL,
  };
}

export function codexHookStatus(opts: InstallOptions = {}): {
  hooked: boolean;
  configPath: string;
  pluginPath: string;
  profilePath: string;
  newAnchorCommandPath: string;
  newAnchorScriptPath: string;
  newAnchorCommandInstalled: boolean;
  dataDir: string;
  sidecarUrl: string;
  proxyBaseUrl: string;
} {
  const projectRoot = defaultProjectRoot(opts.projectRoot);
  const dataDir = opts.dataDir ?? defaultDataDir(projectRoot);
  const configPath = opts.configPath ?? defaultCodexHooksPath();
  const pluginPath = defaultCodexHookPath(projectRoot);
  const profilePath = defaultCodexProfilePath();
  const newAnchorCommandPath = defaultCodexSkillPath(projectRoot);
  const newAnchorScriptPath = defaultNewAnchorScriptPath(dataDir);
  const installState = readInstallState(dataDir, "install-codex.json");
  return {
    hooked:
      existsSync(pluginPath) &&
      isManagedCodexHook(pluginPath) &&
      isCodexConfigHooked(configPath, pluginPath),
    configPath,
    pluginPath,
    profilePath,
    newAnchorCommandPath,
    newAnchorScriptPath,
    newAnchorCommandInstalled:
      existsSync(newAnchorCommandPath) && isManagedNewAnchorCommand(newAnchorCommandPath),
    dataDir,
    sidecarUrl: opts.sidecarUrl ?? installState?.sidecarUrl ?? DEFAULT_SIDECAR_URL,
    proxyBaseUrl: opts.proxyBaseUrl ?? installState?.proxyBaseUrl ?? DEFAULT_PROXY_BASE_URL,
  };
}

function isManagedPlugin(pluginPath: string): boolean {
  const body = readFileSync(pluginPath, "utf8");
  return body.includes("dcache-managed-plugin");
}

function isManagedClaudeHook(hookPath: string): boolean {
  const body = readFileSync(hookPath, "utf8");
  return body.includes("dcache-managed-claude-hook");
}

function isManagedCodexHook(hookPath: string): boolean {
  const body = readFileSync(hookPath, "utf8");
  return body.includes("dcache-managed-codex-hook");
}

function installNewAnchorCommand(opts: {
  runtime: "opencode" | "claude";
  commandPath: string;
  scriptPath: string;
  dataDir: string;
  messages: string[];
}): void {
  if (existsSync(opts.commandPath) && !isManagedNewAnchorCommand(opts.commandPath)) {
    opts.messages.push(
      `${opts.runtime} newanchor command path exists but is not dcache-managed; left untouched`,
    );
    return;
  }
  if (existsSync(opts.scriptPath) && !isManagedNewAnchorScript(opts.scriptPath)) {
    opts.messages.push("newanchor script path exists but is not dcache-managed; left untouched");
    return;
  }
  mkdirSync(dirname(opts.commandPath), { recursive: true });
  mkdirSync(dirname(opts.scriptPath), { recursive: true });
  writeFileSync(opts.scriptPath, newAnchorScriptTemplate(opts.dataDir), "utf8");
  writeFileSync(
    opts.commandPath,
    newAnchorCommandTemplate(opts.scriptPath, opts.runtime),
    "utf8",
  );
  opts.messages.push(`${opts.runtime} /newanchor command installed`);
}

function installCodexNewAnchorSkill(opts: {
  commandPath: string;
  scriptPath: string;
  dataDir: string;
  messages: string[];
}): void {
  if (existsSync(opts.commandPath) && !isManagedNewAnchorCommand(opts.commandPath)) {
    opts.messages.push(
      "codex newanchor skill path exists but is not dcache-managed; left untouched",
    );
    return;
  }
  if (existsSync(opts.scriptPath) && !isManagedNewAnchorScript(opts.scriptPath)) {
    opts.messages.push("newanchor script path exists but is not dcache-managed; left untouched");
    return;
  }
  mkdirSync(dirname(opts.commandPath), { recursive: true });
  mkdirSync(dirname(opts.scriptPath), { recursive: true });
  writeFileSync(opts.scriptPath, newAnchorScriptTemplate(opts.dataDir), "utf8");
  writeFileSync(opts.commandPath, newAnchorCodexSkillTemplate(opts.scriptPath), "utf8");
  opts.messages.push("codex $newanchor skill installed");
}

function isManagedNewAnchorCommand(commandPath: string): boolean {
  const body = readFileSync(commandPath, "utf8");
  return body.includes("dcache-managed-newanchor-command");
}

function isManagedNewAnchorScript(scriptPath: string): boolean {
  const body = readFileSync(scriptPath, "utf8");
  return body.includes("dcache-managed-newanchor-script");
}

function removeManagedNewAnchorCommand(
  commandPath: string,
  messages: string[],
  runtime: "opencode" | "claude" | "codex",
): void {
  if (!existsSync(commandPath)) {
    messages.push(`${runtime} /newanchor command already absent`);
    return;
  }
  if (isManagedNewAnchorCommand(commandPath)) {
    rmSync(commandPath, { force: true });
    messages.push(`managed ${runtime} /newanchor command removed`);
  } else {
    messages.push(`${runtime} /newanchor command exists but is not dcache-managed; left untouched`);
  }
}

function removeNewAnchorScriptIfUnused(
  scriptPath: string,
  commandPaths: string[],
  messages: string[],
): void {
  const stillReferenced = [...new Set(commandPaths)].some(
    (commandPath) => existsSync(commandPath) && isManagedNewAnchorCommand(commandPath),
  );
  if (stillReferenced) {
    messages.push("managed /newanchor script kept because another command still references it");
    return;
  }
  if (!existsSync(scriptPath)) {
    messages.push("managed /newanchor script already absent");
    return;
  }
  if (isManagedNewAnchorScript(scriptPath)) {
    rmSync(scriptPath, { force: true });
    messages.push("managed /newanchor script removed");
  } else {
    messages.push("/newanchor script exists but is not dcache-managed; left untouched");
  }
}

function removeManagedPluginFiles(
  paths: string[],
  messages: string[],
  label: "plugin" | "claude hook" | "codex hook",
): boolean {
  let removed = false;
  for (const path of [...new Set(paths)]) {
    if (!existsSync(path)) continue;
    const managed =
      label === "plugin"
        ? isManagedPlugin(path)
        : label === "claude hook"
          ? isManagedClaudeHook(path)
          : isManagedCodexHook(path);
    if (managed) {
      rmSync(path, { force: true });
      messages.push(`managed ${label} removed`);
      removed = true;
    } else {
      messages.push(`${label} path exists but is not dcache-managed; left untouched`);
    }
  }
  return removed;
}

function readInstallState(dataDir: string, file = "install.json"):
  | (DCacheManagedState & {
      sidecarUrl?: string;
      proxyBaseUrl?: string;
      routeProvider?: boolean;
    })
  | undefined {
  const path = `${dataDir}/${file}`;
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as DCacheManagedState & {
      sidecarUrl?: string;
      proxyBaseUrl?: string;
      routeProvider?: boolean;
    };
    return parsed;
  } catch {
    return undefined;
  }
}
