export function newAnchorCommandTemplate(scriptPath: string, runtime: "opencode" | "claude"): string {
  const shellSafeScriptPath = scriptPath.replace(/\\/g, "/");
  return `---
description: Switch, enable, disable, reset, or inspect the dcache cache anchor.
---

<!-- dcache-managed-newanchor-command -->

!${"`"}node ${JSON.stringify(shellSafeScriptPath)} "$ARGUMENTS"${"`"}

The command output above is the authoritative result. Summarize it briefly for the user.

Usage examples:
- /newanchor status
- /newanchor on Stable project context to pin across sessions.
- /newanchor off
- /newanchor reset

Runtime: ${runtime}
`;
}

export function newAnchorCodexSkillTemplate(scriptPath: string): string {
  const shellSafeScriptPath = scriptPath.replace(/\\/g, "/");
  return `---
name: newanchor
description: Switch, enable, disable, reset, or inspect the dcache cache anchor.
---

<!-- dcache-managed-newanchor-command -->

Run this local command with the user's arguments after \`$newanchor\`, then summarize the JSON result briefly:

\`\`\`powershell
node ${JSON.stringify(shellSafeScriptPath)} "<arguments>"
\`\`\`

Examples:
- $newanchor status
- $newanchor on Stable project context to pin across Codex sessions.
- $newanchor off
- $newanchor reset

The command output is authoritative. Do not invent anchor state.
Runtime: codex
`;
}

export function newAnchorScriptTemplate(dataDir: string): string {
  return `#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";

// Managed by dcache. Do not edit by hand.
// dcache-managed-newanchor-script
const DATA_DIR = process.env.DCACHE_DATA_DIR || ${JSON.stringify(dataDir)};
const ANCHOR_FILE = join(DATA_DIR, "cache-anchor.md");
const DISABLED_ANCHOR_FILE = join(DATA_DIR, "cache-anchor.disabled.md");
const STATE_FILE = join(DATA_DIR, "cache-anchor.state.json");
const EVENTS_FILE = join(DATA_DIR, "events.ndjson");

main();

function main() {
  const raw = process.argv.slice(2).join(" ").trim();
  const { action, content } = parseInput(raw);
  const now = new Date().toISOString();
  mkdirSync(DATA_DIR, { recursive: true });
  let state = readState();
  const project = projectIdentity(process.cwd());
  let changed = false;
  let message = "";

  if (action === "status") {
    message = "anchor status read";
  } else if (action === "off") {
    if (existsSync(ANCHOR_FILE)) {
      rmSync(DISABLED_ANCHOR_FILE, { force: true });
      renameSync(ANCHOR_FILE, DISABLED_ANCHOR_FILE);
    }
    state = {
      ...state,
      enabled: false,
      updatedAt: now,
      disabledAt: now,
      project: state.project || project
    };
    changed = true;
    message = "anchor disabled";
  } else if (action === "reset") {
    state = resetState(state, "manual_newanchor_reset", now, project);
    changed = true;
    message = "anchor generation reset";
  } else {
    if (content) {
      writeFileSync(ANCHOR_FILE, content.trim() + "\\n", "utf8");
      rmSync(DISABLED_ANCHOR_FILE, { force: true });
    } else if (!existsSync(ANCHOR_FILE) && existsSync(DISABLED_ANCHOR_FILE)) {
      renameSync(DISABLED_ANCHOR_FILE, ANCHOR_FILE);
    }
    if (!existsSync(ANCHOR_FILE)) {
      message = "no anchor content found; pass text after /newanchor on";
    } else {
      state = resetState(state, "manual_newanchor", now, project);
      state.enabled = true;
      state.enabledAt ||= now;
      changed = true;
      message = content ? "new anchor saved and enabled" : "existing anchor enabled";
    }
  }

  if (changed) writeState(state);
  const status = readStatus(state);
  if (changed) recordAnchorEvent(action, message, status);
  print({
    ok: action === "status" || changed,
    action,
    message,
    ...status
  });
}

function parseInput(raw) {
  if (!raw) return { action: "status", content: "" };
  const match = raw.match(/^\\s*(\\S+)(?:\\s+([\\s\\S]*))?$/);
  const first = String(match?.[1] || "").toLowerCase();
  const rest = String(match?.[2] || "").trim();
  if (["status", "show", "info"].includes(first)) return { action: "status", content: "" };
  if (["off", "disable", "disabled"].includes(first)) return { action: "off", content: "" };
  if (["reset", "renew"].includes(first)) return { action: "reset", content: "" };
  if (["on", "enable", "enabled", "set", "new"].includes(first)) {
    return { action: "on", content: rest };
  }
  return { action: "on", content: raw };
}

function readStatus(state = readState()) {
  const active = existsSync(ANCHOR_FILE);
  const disabled = existsSync(DISABLED_ANCHOR_FILE);
  const source = active ? ANCHOR_FILE : disabled ? DISABLED_ANCHOR_FILE : ANCHOR_FILE;
  const bytes = existsSync(source) ? statSync(source).size : 0;
  return {
    enabled: state.enabled === true && active,
    configured: active || disabled,
    dataDir: DATA_DIR,
    anchorPath: ANCHOR_FILE,
    disabledPath: DISABLED_ANCHOR_FILE,
    statePath: STATE_FILE,
    bytes,
    generation: numberOrZero(state.generation),
    resetCount: numberOrZero(state.resetCount),
    lastResetAt: state.lastResetAt,
    lastResetReason: state.lastResetReason,
    project: state.project
  };
}

function recordAnchorEvent(action, message, status) {
  try {
    mkdirSync(dirname(EVENTS_FILE), { recursive: true });
    const event = {
      timestamp: new Date().toISOString(),
      type: "cache_anchor.changed",
      runtime: "newanchor",
      payload: {
        source: "newanchor",
        action,
        message,
        enabled: status.enabled,
        configured: status.configured,
        generation: status.generation,
        resetCount: status.resetCount,
        lastResetReason: status.lastResetReason,
        project: status.project
      }
    };
    writeFileSync(EVENTS_FILE, JSON.stringify(event) + "\\n", { encoding: "utf8", flag: "a" });
  } catch {
    // Logging is best effort; /newanchor must still report the anchor result.
  }
}

function readState() {
  if (!existsSync(STATE_FILE)) return defaultState();
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      enabled: parsed?.enabled === true,
      generation: numberOrZero(parsed?.generation),
      resetCount: numberOrZero(parsed?.resetCount)
    };
  } catch {
    return defaultState();
  }
}

function writeState(state) {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\\n", "utf8");
}

function defaultState() {
  return { version: 1, enabled: false, generation: 0, resetCount: 0 };
}

function resetState(state, reason, now, project) {
  return {
    ...state,
    generation: numberOrZero(state.generation) + 1,
    resetCount: numberOrZero(state.resetCount) + 1,
    updatedAt: now,
    lastResetAt: now,
    lastResetReason: reason,
    project: project || state.project
  };
}

function projectIdentity(startPath) {
  const root = normalizeExistingPath(startPath);
  const gitRoot = findUp(root, ".git");
  if (gitRoot) return makeProjectIdentity("git", gitRoot);
  const svnRoot = findUp(root, ".svn");
  if (svnRoot) return makeProjectIdentity("svn", svnRoot);
  return makeProjectIdentity("folder", root);
}

function makeProjectIdentity(kind, root) {
  return {
    id: kind + ":" + hash(normalizePathForId(root)),
    kind,
    root,
    label: basename(root)
  };
}

function normalizeExistingPath(input) {
  const resolved = resolve(input);
  if (!existsSync(resolved)) return normalizePathForId(resolved);
  const stat = statSync(resolved);
  const directory = stat.isDirectory() ? resolved : dirname(resolved);
  return realpathSync.native(directory);
}

function findUp(start, marker) {
  let current = start;
  while (true) {
    if (existsSync(join(current, marker))) return realpathSync.native(current);
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function normalizePathForId(value) {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function numberOrZero(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function print(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + "\\n");
}
`;
}
