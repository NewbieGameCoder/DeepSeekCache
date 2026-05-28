import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readJsoncObject } from "../src/config.js";
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
} from "../src/installer.js";
import {
  defaultCodexHookPath,
  defaultCodexHooksPath,
  defaultCodexProfilePath,
  defaultCodexSkillPath,
  defaultClaudeCommandPath,
  defaultClaudeHookPath,
  defaultDataDir,
  defaultNewAnchorScriptPath,
  defaultOpencodeCommandPath,
  defaultProjectPluginPath,
} from "../src/paths.js";

const roots: string[] = [];
let previousCodexHome: string | undefined;

function tempRoot(): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "dcache-")));
  roots.push(root);
  return root;
}

afterEach(async () => {
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  previousCodexHome = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function useTempCodexHome(root: string): string {
  previousCodexHome = process.env.CODEX_HOME;
  const codexHome = join(root, ".codex-home");
  process.env.CODEX_HOME = codexHome;
  return codexHome;
}

describe("opencode dcache installer", () => {
  it("uses dcache default names", () => {
    const root = tempRoot();
    expect(defaultDataDir(root)).toBe(join(root, ".dcache"));
    expect(defaultProjectPluginPath(root)).toBe(join(root, ".opencode", "plugins", "dcache.js"));
    expect(defaultOpencodeCommandPath(root)).toBe(join(root, ".opencode", "commands", "newanchor.md"));
    expect(defaultClaudeHookPath(root)).toBe(join(root, ".claude", "hooks", "dcache.mjs"));
    expect(defaultClaudeCommandPath(root)).toBe(join(root, ".claude", "commands", "newanchor.md"));
    const codexHome = useTempCodexHome(root);
    expect(defaultCodexHooksPath()).toBe(join(codexHome, "hooks.json"));
    expect(defaultCodexProfilePath()).toBe(join(codexHome, "dcache.config.toml"));
    expect(defaultCodexHookPath(root)).toBe(join(root, ".codex", "hooks", "dcache.mjs"));
    expect(defaultCodexSkillPath(root)).toBe(join(root, ".codex", "skills", "newanchor", "SKILL.md"));
    expect(defaultNewAnchorScriptPath(defaultDataDir(root))).toBe(
      join(root, ".dcache", "commands", "newanchor.mjs"),
    );
  });

  it("installs a managed local plugin and patches deepseek baseURL", () => {
    const root = tempRoot();
    const configPath = join(root, "opencode.json");
    const dataDir = join(root, ".dcache");
    const result = installHook({
      projectRoot: root,
      dataDir,
      sidecarUrl: "http://127.0.0.1:4000",
      proxyBaseUrl: "http://127.0.0.1:5000/v1",
      routeProvider: true,
    });

    expect(result.ok).toBe(true);
    expect(existsSync(result.pluginPath)).toBe(true);
    const plugin = readFileSync(result.pluginPath, "utf8");
    expect(plugin).toContain("dcache-managed-plugin");
    expect(plugin).toContain("plugin.initialized");
    expect(plugin).toContain("experimental.chat.system.transform");
    expect(plugin).toContain('join(DATA_DIR, "cache-anchor.md")');
    expect(plugin).toContain("DCACHE_DISABLE_CACHE_ANCHOR");
    expect(result.newAnchorCommandPath).toBe(defaultOpencodeCommandPath(root));
    expect(result.newAnchorScriptPath).toBe(defaultNewAnchorScriptPath(dataDir));
    const command = readFileSync(defaultOpencodeCommandPath(root), "utf8");
    expect(command).toContain("dcache-managed-newanchor-command");
    expect(command).toContain("/newanchor status");
    expect(command).toContain("newanchor.mjs");
    const script = readFileSync(defaultNewAnchorScriptPath(dataDir), "utf8");
    expect(script).toContain("dcache-managed-newanchor-script");
    expect(script).toContain("cache_anchor.changed");
    const manual = spawnSync(
      process.execPath,
      [defaultNewAnchorScriptPath(dataDir), "on", "Stable test anchor"],
      { cwd: root, encoding: "utf8", windowsHide: true },
    );
    expect(manual.status).toBe(0);
    expect(JSON.parse(manual.stdout)).toMatchObject({
      ok: true,
      action: "on",
      enabled: true,
      generation: 1,
    });
    expect(readFileSync(join(dataDir, "cache-anchor.md"), "utf8")).toContain(
      "Stable test anchor",
    );
    expect(readFileSync(join(dataDir, "events.ndjson"), "utf8")).toContain(
      "cache_anchor.changed",
    );
    const cfg = readJsoncObject(configPath);
    expect((cfg.provider as any).deepseek.options.baseURL).toBe("http://127.0.0.1:5000/v1");
    expect(cfg["x-dcache-managed"]).toBeUndefined();
    expect(JSON.parse(readFileSync(join(dataDir, "install.json"), "utf8"))).toMatchObject({
      proxyBaseUrl: "http://127.0.0.1:5000/v1",
    });
    expect(hookStatus({ projectRoot: root, dataDir }).hooked).toBe(true);
  });

  it("is idempotent and uninstall restores the previous provider shape", () => {
    const root = tempRoot();
    const configPath = join(root, "opencode.json");
    const dataDir = join(root, ".dcache");
    const original = {
      provider: {
        deepseek: {
          options: {
            baseURL: "https://api.deepseek.com/v1",
            apiKey: "{env:DEEPSEEK_API_KEY}",
          },
        },
      },
    };
    writeFileSync(configPath, `${JSON.stringify(original, null, 2)}\n`, "utf8");

    installHook({ projectRoot: root, dataDir, routeProvider: true });
    installHook({ projectRoot: root, dataDir, routeProvider: true });
    uninstallHook({ projectRoot: root, dataDir });
    uninstallHook({ projectRoot: root, dataDir });

    const cfg = readJsoncObject(configPath);
    expect(cfg).toEqual(original);
    expect(hookStatus({ projectRoot: root, dataDir }).hooked).toBe(false);
    expect(existsSync(defaultOpencodeCommandPath(root))).toBe(false);
    expect(existsSync(defaultNewAnchorScriptPath(dataDir))).toBe(false);
  });

  it("keeps plugin-only installs off the provider route and preserves non-managed plugins", () => {
    const root = tempRoot();
    const configPath = join(root, "opencode.json");
    const dataDir = join(root, ".dcache");
    const otherPluginPath = join(root, ".opencode", "plugins", "other-listener.js");
    const original = {
      provider: {
        deepseek: {
          options: {
            baseURL: "https://api.deepseek.com/v1",
            apiKey: "{env:DEEPSEEK_API_KEY}",
          },
        },
      },
    };
    writeFileSync(configPath, `${JSON.stringify(original, null, 2)}\n`, "utf8");
    mkdirSync(join(root, ".opencode", "plugins"), { recursive: true });
    writeFileSync(otherPluginPath, "export const otherListener = true;", "utf8");

    const result = installHook({ projectRoot: root, dataDir });
    expect(readJsoncObject(configPath)).toEqual(original);
    expect(hookStatus({ projectRoot: root, dataDir }).hooked).toBe(true);
    expect(readFileSync(otherPluginPath, "utf8")).toBe("export const otherListener = true;");

    writeFileSync(result.pluginPath, "export default {}", "utf8");
    const uninstall = uninstallHook({ projectRoot: root, dataDir });

    expect(uninstall.messages).toContain(
      "plugin path exists but is not dcache-managed; left untouched",
    );
    expect(existsSync(result.pluginPath)).toBe(true);
    expect(readFileSync(result.pluginPath, "utf8")).toBe("export default {}");
    expect(readFileSync(otherPluginPath, "utf8")).toBe("export const otherListener = true;");
    expect(readJsoncObject(configPath)).toEqual(original);
  });

  it("refuses to overwrite a pre-existing non-managed dcache plugin", () => {
    const root = tempRoot();
    const configPath = join(root, "opencode.json");
    const dataDir = join(root, ".dcache");
    const pluginPath = join(root, ".opencode", "plugins", "dcache.js");
    const original = {
      provider: {
        deepseek: {
          options: {
            baseURL: "https://api.deepseek.com/v1",
            apiKey: "{env:DEEPSEEK_API_KEY}",
          },
        },
      },
    };
    writeFileSync(configPath, `${JSON.stringify(original, null, 2)}\n`, "utf8");
    mkdirSync(join(root, ".opencode", "plugins"), { recursive: true });
    writeFileSync(pluginPath, "export const userPlugin = true;", "utf8");

    const result = installHook({ projectRoot: root, dataDir, routeProvider: true });

    expect(result.ok).toBe(false);
    expect(result.messages).toEqual([
      "plugin path exists but is not dcache-managed; left untouched",
      "provider routing skipped to avoid partial install",
    ]);
    expect(readFileSync(pluginPath, "utf8")).toBe("export const userPlugin = true;");
    expect(readJsoncObject(configPath)).toEqual(original);
    expect(existsSync(join(dataDir, "install.json"))).toBe(false);
    expect(hookStatus({ projectRoot: root, dataDir }).hooked).toBe(false);
  });

  it("preserves a pre-existing non-managed /newanchor command", () => {
    const root = tempRoot();
    const dataDir = join(root, ".dcache");
    const commandPath = defaultOpencodeCommandPath(root);
    mkdirSync(join(root, ".opencode", "commands"), { recursive: true });
    writeFileSync(commandPath, "# user-owned newanchor\n", "utf8");

    const result = installHook({ projectRoot: root, dataDir });

    expect(result.ok).toBe(true);
    expect(result.messages).toContain(
      "opencode newanchor command path exists but is not dcache-managed; left untouched",
    );
    expect(readFileSync(commandPath, "utf8")).toBe("# user-owned newanchor\n");
    expect(existsSync(defaultNewAnchorScriptPath(dataDir))).toBe(false);
    expect(hookStatus({ projectRoot: root, dataDir }).newAnchorCommandInstalled).toBe(false);
  });

  it("keeps the shared /newanchor script until both runtimes are uninstalled", () => {
    const root = tempRoot();
    useTempCodexHome(root);
    const dataDir = join(root, ".dcache");

    installHook({ projectRoot: root, dataDir });
    installClaudeHook({ projectRoot: root, dataDir });
    installCodexHook({ projectRoot: root, dataDir });

    expect(existsSync(defaultOpencodeCommandPath(root))).toBe(true);
    expect(existsSync(defaultClaudeCommandPath(root))).toBe(true);
    expect(existsSync(defaultCodexSkillPath(root))).toBe(true);
    expect(existsSync(defaultNewAnchorScriptPath(dataDir))).toBe(true);

    const opencodeUninstall = uninstallHook({ projectRoot: root, dataDir });
    expect(opencodeUninstall.messages).toContain(
      "managed /newanchor script kept because another command still references it",
    );
    expect(existsSync(defaultOpencodeCommandPath(root))).toBe(false);
    expect(existsSync(defaultClaudeCommandPath(root))).toBe(true);
    expect(existsSync(defaultCodexSkillPath(root))).toBe(true);
    expect(existsSync(defaultNewAnchorScriptPath(dataDir))).toBe(true);

    const claudeUninstall = uninstallClaudeHook({ projectRoot: root, dataDir });
    expect(claudeUninstall.messages).toContain(
      "managed /newanchor script kept because another command still references it",
    );
    expect(existsSync(defaultClaudeCommandPath(root))).toBe(false);
    expect(existsSync(defaultCodexSkillPath(root))).toBe(true);
    expect(existsSync(defaultNewAnchorScriptPath(dataDir))).toBe(true);

    const codexUninstall = uninstallCodexHook({ projectRoot: root, dataDir });
    expect(codexUninstall.messages).toContain("managed /newanchor script removed");
    expect(existsSync(defaultCodexSkillPath(root))).toBe(false);
    expect(existsSync(defaultNewAnchorScriptPath(dataDir))).toBe(false);
  });

  it("installs a managed Claude Code hook and optional Anthropic gateway env", () => {
    const root = tempRoot();
    const dataDir = join(root, ".dcache");
    const settingsPath = join(root, ".claude", "settings.local.json");
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(
      settingsPath,
      `${JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" } }, null, 2)}\n`,
      "utf8",
    );

    const result = installClaudeHook({
      projectRoot: root,
      dataDir,
      sidecarUrl: "http://127.0.0.1:4000",
      proxyBaseUrl: "http://127.0.0.1:5000/v1",
      routeProvider: true,
    });

    expect(result.ok).toBe(true);
    expect(existsSync(result.pluginPath)).toBe(true);
    const hook = readFileSync(result.pluginPath, "utf8");
    expect(hook).toContain("dcache-managed-claude-hook");
    expect(hook).toContain("UserPromptSubmit");
    expect(hook).toContain("cache_anchor.injected");
    const cfg = readJsoncObject(settingsPath);
    expect((cfg.env as any).ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:5000");
    expect((cfg.env as any).DCACHE_SIDECAR_URL).toBe("http://127.0.0.1:4000");
    expect(JSON.stringify(cfg.hooks)).toContain("SessionStart");
    expect(JSON.stringify(cfg.hooks)).toContain("PreCompact");
    expect(claudeHookStatus({ projectRoot: root, dataDir }).hooked).toBe(true);

    installClaudeHook({
      projectRoot: root,
      dataDir,
      sidecarUrl: "http://127.0.0.1:4000",
      proxyBaseUrl: "http://127.0.0.1:5000/v1",
      routeProvider: true,
    });
    const afterSecondInstall = JSON.stringify(readJsoncObject(settingsPath).hooks);
    expect(afterSecondInstall.match(/dcache\.mjs/g)?.length).toBe(6);

    uninstallClaudeHook({ projectRoot: root, dataDir, proxyBaseUrl: "http://127.0.0.1:5000/v1" });
    const restored = readJsoncObject(settingsPath);
    expect((restored.env as any).ANTHROPIC_BASE_URL).toBe("https://api.anthropic.com");
    expect(JSON.stringify(restored.hooks ?? {})).not.toContain("dcache.mjs");
    expect(existsSync(result.pluginPath)).toBe(false);
    expect(claudeHookStatus({ projectRoot: root, dataDir }).hooked).toBe(false);
  });

  it("preserves existing Claude Code hook listeners during install and uninstall", () => {
    const root = tempRoot();
    const dataDir = join(root, ".dcache");
    const settingsPath = join(root, ".claude", "settings.local.json");
    mkdirSync(join(root, ".claude"), { recursive: true });
    const original = {
      env: {
        ANTHROPIC_BASE_URL: "https://api.anthropic.com",
        EXISTING_VAR: "keep-me",
      },
      hooks: {
        SessionStart: [
          {
            matcher: "startup",
            hooks: [{ type: "command", command: "node ./existing-startup.mjs", timeout: 9 }],
          },
        ],
        UserPromptSubmit: [
          {
            hooks: [{ type: "command", command: "node ./existing-prompt.mjs", timeout: 7 }],
          },
        ],
        Stop: [
          {
            hooks: [{ type: "command", command: "node ./existing-stop.mjs", timeout: 3 }],
          },
        ],
      },
    };
    writeFileSync(settingsPath, `${JSON.stringify(original, null, 2)}\n`, "utf8");

    const result = installClaudeHook({
      projectRoot: root,
      dataDir,
      proxyBaseUrl: "http://127.0.0.1:5000/v1",
      routeProvider: true,
    });

    expect(result.ok).toBe(true);
    const installed = readJsoncObject(settingsPath);
    const installedHooks = JSON.stringify(installed.hooks);
    expect(installedHooks).toContain("existing-startup.mjs");
    expect(installedHooks).toContain("existing-prompt.mjs");
    expect(installedHooks).toContain("existing-stop.mjs");
    expect(installedHooks.match(/dcache\.mjs/g)?.length).toBe(6);
    expect((installed.env as any).EXISTING_VAR).toBe("keep-me");
    expect((installed.env as any).ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:5000");

    uninstallClaudeHook({ projectRoot: root, dataDir, proxyBaseUrl: "http://127.0.0.1:5000/v1" });

    const restored = readJsoncObject(settingsPath);
    const restoredHooks = JSON.stringify(restored.hooks);
    expect(restoredHooks).toContain("existing-startup.mjs");
    expect(restoredHooks).toContain("existing-prompt.mjs");
    expect(restoredHooks).toContain("existing-stop.mjs");
    expect(restoredHooks).not.toContain("dcache.mjs");
    expect((restored.env as any).EXISTING_VAR).toBe("keep-me");
    expect((restored.env as any).ANTHROPIC_BASE_URL).toBe("https://api.anthropic.com");
  });

  it("refuses to overwrite a pre-existing non-managed Claude hook", () => {
    const root = tempRoot();
    const dataDir = join(root, ".dcache");
    const hookPath = join(root, ".claude", "hooks", "dcache.mjs");
    mkdirSync(join(root, ".claude", "hooks"), { recursive: true });
    writeFileSync(hookPath, "console.log('mine')", "utf8");

    const result = installClaudeHook({ projectRoot: root, dataDir, routeProvider: true });

    expect(result.ok).toBe(false);
    expect(readFileSync(hookPath, "utf8")).toBe("console.log('mine')");
    expect(existsSync(join(dataDir, "install-claude.json"))).toBe(false);
    expect(claudeHookStatus({ projectRoot: root, dataDir }).hooked).toBe(false);
  });

  it("installs managed Codex hooks, a dcache profile, and preserves existing hook listeners", () => {
    const root = tempRoot();
    const codexHome = useTempCodexHome(root);
    const dataDir = join(root, ".dcache");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(
      defaultCodexHooksPath(),
      `${JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                matcher: "startup",
                hooks: [{ type: "command", command: "node ./existing-codex-hook.mjs", timeout: 3 }],
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = installCodexHook({
      projectRoot: root,
      dataDir,
      sidecarUrl: "http://127.0.0.1:4000",
      proxyBaseUrl: "http://127.0.0.1:5000/v1",
      routeProvider: true,
    });

    expect(result.ok).toBe(true);
    expect(existsSync(defaultCodexHookPath(root))).toBe(true);
    expect(readFileSync(defaultCodexHookPath(root), "utf8")).toContain(
      "dcache-managed-codex-hook",
    );
    const hooks = JSON.parse(readFileSync(defaultCodexHooksPath(), "utf8"));
    const hooksText = JSON.stringify(hooks.hooks);
    expect(hooksText).toContain("existing-codex-hook.mjs");
    expect(hooksText.match(/dcache\.mjs/g)?.length).toBe(5);
    expect(readFileSync(defaultCodexProfilePath(), "utf8")).toContain(
      "dcache-managed-codex-profile",
    );
    expect(readFileSync(defaultCodexProfilePath(), "utf8")).toContain(
      'wire_api = "responses"',
    );
    expect(readFileSync(defaultCodexSkillPath(root), "utf8")).toContain(
      "dcache-managed-newanchor-command",
    );
    expect(codexHookStatus({ projectRoot: root, dataDir }).hooked).toBe(true);
    const manualAnchor = spawnSync(
      process.execPath,
      [defaultNewAnchorScriptPath(dataDir), "on", "Stable Codex hook anchor"],
      { cwd: root, encoding: "utf8", windowsHide: true },
    );
    expect(manualAnchor.status).toBe(0);
    const hookRun = spawnSync(process.execPath, [defaultCodexHookPath(root)], {
      cwd: root,
      input: JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: "codex-test-session",
        cwd: root,
      }),
      encoding: "utf8",
      windowsHide: true,
    });
    expect(hookRun.status).toBe(0);
    expect(JSON.parse(hookRun.stdout)).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
      },
    });
    expect(hookRun.stdout).toContain("Stable Codex hook anchor");
    expect(readFileSync(join(dataDir, "events.ndjson"), "utf8")).toContain(
      "codex.SessionStart",
    );
    expect(readFileSync(join(dataDir, "events.ndjson"), "utf8")).toContain(
      "cache_anchor.injected",
    );

    installCodexHook({
      projectRoot: root,
      dataDir,
      sidecarUrl: "http://127.0.0.1:4000",
      proxyBaseUrl: "http://127.0.0.1:5000/v1",
      routeProvider: true,
    });
    const afterSecondInstall = JSON.stringify(JSON.parse(readFileSync(defaultCodexHooksPath(), "utf8")).hooks);
    expect(afterSecondInstall.match(/dcache\.mjs/g)?.length).toBe(5);

    const uninstall = uninstallCodexHook({ projectRoot: root, dataDir });
    expect(uninstall.ok).toBe(true);
    const restored = JSON.stringify(JSON.parse(readFileSync(defaultCodexHooksPath(), "utf8")).hooks);
    expect(restored).toContain("existing-codex-hook.mjs");
    expect(restored).not.toContain("dcache.mjs");
    expect(existsSync(defaultCodexProfilePath())).toBe(false);
    expect(existsSync(defaultCodexHookPath(root))).toBe(false);
    expect(codexHookStatus({ projectRoot: root, dataDir }).hooked).toBe(false);
  });

  it("refuses to overwrite non-managed Codex hook or profile files", () => {
    const root = tempRoot();
    useTempCodexHome(root);
    const dataDir = join(root, ".dcache");
    const hookPath = defaultCodexHookPath(root);
    mkdirSync(dirname(hookPath), { recursive: true });
    writeFileSync(hookPath, "console.log('mine')", "utf8");

    const hookConflict = installCodexHook({ projectRoot: root, dataDir, routeProvider: true });
    expect(hookConflict.ok).toBe(false);
    expect(readFileSync(hookPath, "utf8")).toBe("console.log('mine')");
    expect(existsSync(join(dataDir, "install-codex.json"))).toBe(false);

    rmSync(hookPath, { force: true });
    mkdirSync(dirname(defaultCodexProfilePath()), { recursive: true });
    writeFileSync(defaultCodexProfilePath(), "# user-owned dcache profile\n", "utf8");
    const profileConflict = installCodexHook({ projectRoot: root, dataDir, routeProvider: true });

    expect(profileConflict.ok).toBe(false);
    expect(readFileSync(defaultCodexProfilePath(), "utf8")).toBe("# user-owned dcache profile\n");
    expect(existsSync(defaultCodexHookPath(root))).toBe(false);
    expect(codexHookStatus({ projectRoot: root, dataDir }).hooked).toBe(false);
  });
});
