import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { anchorStatus, resolveProjectIdentity, sameProjectIdentity, updateAnchor } from "../src/anchor.js";
import { claudeHookTemplate } from "../src/claude-hook-template.js";
import { pluginTemplate } from "../src/plugin-template.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "dcache-anchor-")));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("dcache anchor state machine", () => {
  it("keeps file anchors disabled by default until the state file explicitly enables them", () => {
    const root = tempRoot();
    const dataDir = join(root, ".dcache");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "cache-anchor.md"), "Legacy anchor\n", "utf8");

    expect(anchorStatus(dataDir, { projectRoot: root })).toMatchObject({
      enabled: false,
      stateEnabled: false,
      configured: true,
      generation: 0,
      resetCount: 0,
    });

    const enabled = updateAnchor(
      dataDir,
      { enabled: true },
      { projectRoot: root, reason: "manual_enable" },
    );

    expect(enabled.enabled).toBe(true);
    expect(enabled.stateEnabled).toBe(true);
    expect(enabled.generation).toBe(1);
    expect(enabled.resetCount).toBe(1);
    expect(enabled.lastResetReason).toBe("manual_enable");
  });

  it("detects same VCS roots and tolerant folder containment as the same project", () => {
    const gitRoot = tempRoot();
    mkdirSync(join(gitRoot, ".git"));
    mkdirSync(join(gitRoot, "packages", "api"), { recursive: true });
    const sameGitSubdir = join(gitRoot, "packages", "api");
    const otherGitRoot = tempRoot();
    mkdirSync(join(otherGitRoot, ".git"));

    expect(
      sameProjectIdentity(resolveProjectIdentity(gitRoot), resolveProjectIdentity(sameGitSubdir)),
    ).toBe(true);
    expect(
      sameProjectIdentity(resolveProjectIdentity(gitRoot), resolveProjectIdentity(otherGitRoot)),
    ).toBe(false);

    const folderRoot = tempRoot();
    const folderSubdir = join(folderRoot, "nested", "feature");
    mkdirSync(folderSubdir, { recursive: true });
    const folderSibling = tempRoot();
    expect(
      sameProjectIdentity(resolveProjectIdentity(folderRoot), resolveProjectIdentity(folderSubdir)),
    ).toBe(true);
    expect(
      sameProjectIdentity(resolveProjectIdentity(folderRoot), resolveProjectIdentity(folderSibling)),
    ).toBe(false);
  });

  it("resets generation for /new in the same window but not for a new window first session", async () => {
    const root = tempRoot();
    mkdirSync(join(root, ".git"));
    const dataDir = join(root, ".dcache");
    updateAnchor(dataDir, { enabled: true, content: "Stable project policy." }, { projectRoot: root });

    const firstWindow = await loadPlugin(root, dataDir);
    firstWindow.event({
      event: { type: "session.created", properties: { sessionID: "s1", directory: root } },
    });
    let state = readState(dataDir);
    expect(state.generation).toBe(1);

    const output = { system: [] as string[] };
    await firstWindow["experimental.chat.system.transform"](
      { sessionID: "s1", directory: root },
      output,
    );
    expect(output.system[0]).toContain("generation: 1");
    expect(output.system[0]).toContain("Stable project policy.");
    expect(output.system[0]).not.toContain("session:");
    expect(output.system[0]).not.toContain("window:");

    firstWindow.event({
      event: {
        type: "tui.command.execute",
        properties: { command: "/new", sessionID: "s1", directory: root },
      },
    });
    state = readState(dataDir);
    expect(state.generation).toBe(1);

    firstWindow.event({
      event: { type: "session.created", properties: { sessionID: "s2", directory: root } },
    });
    state = readState(dataDir);
    expect(state.generation).toBe(2);
    expect(state.lastResetReason).toBe("manual_new_session");
    expect(state.lastSessionId).toBe("s2");

    const secondWindow = await loadPlugin(root, dataDir);
    secondWindow.event({
      event: { type: "session.created", properties: { sessionID: "s3", directory: root } },
    });
    state = readState(dataDir);
    expect(state.generation).toBe(2);
    expect(state.lastResetReason).toBe("manual_new_session");
    expect(state.lastSessionId).toBe("s3");

    const events = readFileSync(join(dataDir, "events.ndjson"), "utf8");
    expect(events).toContain('"type":"tui.command.execute"');
    expect(events).toContain('"/new"');
    expect(events).toContain('"type":"cache_anchor.reset"');
    expect(events).toContain('"reason":"manual_new_session"');
  });

  it("generalizes /new handling to same-window session switches without resetting disabled anchors", async () => {
    const root = tempRoot();
    mkdirSync(join(root, ".git"));
    const dataDir = join(root, ".dcache");
    updateAnchor(dataDir, { content: "Stable project policy.", enabled: false }, { projectRoot: root });

    const disabledWindow = await loadPlugin(root, dataDir);
    disabledWindow.event({
      event: { type: "session.created", properties: { sessionID: "disabled-a", directory: root } },
    });
    disabledWindow.event({
      event: { type: "message.updated", properties: { sessionID: "disabled-b", directory: root } },
    });
    expect(readState(dataDir).generation).toBe(0);

    updateAnchor(dataDir, { enabled: true }, { projectRoot: root });
    const plugin = await loadPlugin(root, dataDir);
    plugin.event({
      event: { type: "session.created", properties: { sessionID: "resume-a", directory: root } },
    });
    plugin.event({
      event: { type: "session.updated", properties: { sessionID: "resume-a", directory: root } },
    });
    let state = readState(dataDir);
    expect(state.generation).toBe(1);
    expect(state.lastResetReason).toBe("manual_enable");

    plugin.event({
      event: { type: "message.updated", properties: { sessionID: "fork-or-switch-b", directory: root } },
    });
    state = readState(dataDir);
    expect(state.generation).toBe(2);
    expect(state.lastResetReason).toBe("manual_new_session");
    expect(state.lastSessionId).toBe("fork-or-switch-b");
  });

  it("does not reset for compact/summarize-style commands that keep the same session", async () => {
    const root = tempRoot();
    mkdirSync(join(root, ".git"));
    const dataDir = join(root, ".dcache");
    updateAnchor(dataDir, { enabled: true, content: "Stable project policy." }, { projectRoot: root });

    const plugin = await loadPlugin(root, dataDir);
    plugin.event({
      event: { type: "session.created", properties: { sessionID: "s1", directory: root } },
    });
    plugin.event({
      event: {
        type: "tui.command.execute",
        properties: { command: "/compact", sessionID: "s1", directory: root },
      },
    });
    plugin.event({
      event: { type: "session.compacted", properties: { sessionID: "s1", directory: root } },
    });
    plugin.event({
      event: {
        type: "command.executed",
        properties: { command: "/summarize", sessionID: "s1", directory: root },
      },
    });

    const state = readState(dataDir);
    expect(state.generation).toBe(1);
    expect(state.lastResetReason).toBe("manual_enable");
    const events = readFileSync(join(dataDir, "events.ndjson"), "utf8");
    expect(events).toContain('"type":"session.compacted"');
    expect(events).toContain('"/compact"');
    expect(events).toContain('"/summarize"');
    expect(events).not.toContain('"type":"cache_anchor.reset"');
  });

  it("resets for explicit CLI forks but not for fresh-process resumes or fresh windows", async () => {
    const root = tempRoot();
    mkdirSync(join(root, ".git"));
    const dataDir = join(root, ".dcache");
    updateAnchor(dataDir, { enabled: true, content: "Stable project policy." }, { projectRoot: root });

    const initial = await loadPlugin(root, dataDir);
    initial.event({
      event: { type: "session.created", properties: { sessionID: "s1", directory: root } },
    });
    expect(readState(dataDir)).toMatchObject({
      generation: 1,
      lastResetReason: "manual_enable",
      lastSessionId: "s1",
    });

    const resumeProcess = await loadPlugin(root, dataDir, ["run", "--session", "s2"]);
    resumeProcess.event({
      event: { type: "session.created", properties: { sessionID: "s2", directory: root } },
    });
    expect(readState(dataDir)).toMatchObject({
      generation: 1,
      lastResetReason: "manual_enable",
      lastSessionId: "s2",
    });

    const forkProcess = await loadPlugin(root, dataDir, ["run", "--session", "s2", "--fork"]);
    forkProcess.event({
      event: { type: "session.created", properties: { sessionID: "s3", directory: root } },
    });
    expect(readState(dataDir)).toMatchObject({
      generation: 2,
      lastResetReason: "forked_session",
      lastSessionId: "s3",
    });

    const freshWindow = await loadPlugin(root, dataDir);
    freshWindow.event({
      event: { type: "session.created", properties: { sessionID: "s4", directory: root } },
    });
    expect(readState(dataDir)).toMatchObject({
      generation: 2,
      lastResetReason: "forked_session",
      lastSessionId: "s4",
    });
  });

  it("resets generation for real project changes but not for subdirectories in the same repo", async () => {
    const root = tempRoot();
    mkdirSync(join(root, ".git"));
    const subdir = join(root, "apps", "web");
    mkdirSync(subdir, { recursive: true });
    const other = tempRoot();
    mkdirSync(join(other, ".git"));
    const dataDir = join(root, ".dcache");
    updateAnchor(dataDir, { enabled: true, content: "Stable project policy." }, { projectRoot: root });

    const plugin = await loadPlugin(root, dataDir);
    plugin.event({
      event: { type: "session.created", properties: { sessionID: "s1", directory: root } },
    });
    plugin.event({
      event: { type: "message.updated", properties: { sessionID: "s1", directory: subdir } },
    });
    let state = readState(dataDir);
    expect(state.generation).toBe(1);
    expect(state.lastResetReason).toBe("manual_enable");

    plugin.event({
      event: { type: "message.updated", properties: { sessionID: "s1", directory: other } },
    });
    state = readState(dataDir);
    expect(state.generation).toBe(2);
    expect(state.lastResetReason).toBe("project_changed");
    expect(state.project.root).toBe(resolveProjectIdentity(other).root);
  });

  it("injects Claude Code anchors once per session and resets on /clear-style starts", () => {
    const root = tempRoot();
    mkdirSync(join(root, ".git"));
    const dataDir = join(root, ".dcache");
    updateAnchor(dataDir, { enabled: true, content: "Stable Claude policy." }, { projectRoot: root });
    const hookPath = join(root, "dcache-claude-hook.mjs");
    writeFileSync(hookPath, claudeHookTemplate("http://127.0.0.1:9", dataDir), "utf8");

    const startup = runClaudeHook(hookPath, {
      hook_event_name: "SessionStart",
      session_id: "claude-a",
      cwd: root,
      source: "startup",
      model: "claude-sonnet-4-6",
    });
    expect(startup.status).toBe(0);
    expect(JSON.parse(startup.stdout)).toMatchObject({
      hookSpecificOutput: { hookEventName: "SessionStart" },
    });
    expect(startup.stdout).toContain("generation: 1");

    const prompt = runClaudeHook(hookPath, {
      hook_event_name: "UserPromptSubmit",
      session_id: "claude-a",
      cwd: root,
      prompt: "continue",
    });
    expect(prompt.status).toBe(0);
    expect(prompt.stdout).toBe("");
    expect(readState(dataDir)).toMatchObject({
      generation: 1,
      lastResetReason: "manual_enable",
      lastInjectedSessionId: "claude-a",
    });

    const clear = runClaudeHook(hookPath, {
      hook_event_name: "SessionStart",
      session_id: "claude-b",
      cwd: root,
      source: "clear",
      model: "claude-sonnet-4-6",
    });
    expect(clear.status).toBe(0);
    expect(clear.stdout).toContain("generation: 2");
    expect(readState(dataDir)).toMatchObject({
      generation: 2,
      lastResetReason: "claude_clear_session",
      lastSessionId: "claude-b",
    });

    runClaudeHook(hookPath, {
      hook_event_name: "PreCompact",
      session_id: "claude-b",
      cwd: root,
      trigger: "manual",
    });
    runClaudeHook(hookPath, {
      hook_event_name: "PostCompact",
      session_id: "claude-b",
      cwd: root,
      trigger: "manual",
      compact_summary: "summary",
    });
    expect(readState(dataDir).generation).toBe(2);
    const events = readFileSync(join(dataDir, "events.ndjson"), "utf8");
    expect(events).toContain('"type":"claude.SessionStart"');
    expect(events).toContain('"type":"claude.PreCompact"');
    expect(events).toContain('"reason":"claude_clear_session"');
  });
});

async function loadPlugin(root: string, dataDir: string, argv?: string[]): Promise<any> {
  const pluginPath = join(root, `.dcache-plugin-${Date.now()}-${Math.random()}.mjs`);
  writeFileSync(pluginPath, pluginTemplate("http://127.0.0.1:48731", dataDir), "utf8");
  const originalArgv = process.argv;
  if (argv) process.argv = [originalArgv[0] ?? "node", originalArgv[1] ?? "vitest", ...argv];
  let mod: any;
  try {
    mod = await import(`${pathToFileURL(pluginPath).href}?v=${Date.now()}-${Math.random()}`);
  } finally {
    process.argv = originalArgv;
  }
  return mod.DCacheOpenCodePlugin();
}

function readState(dataDir: string): any {
  return JSON.parse(readFileSync(join(dataDir, "cache-anchor.state.json"), "utf8"));
}

function runClaudeHook(hookPath: string, input: unknown): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(input),
    encoding: "utf8",
    windowsHide: true,
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}
