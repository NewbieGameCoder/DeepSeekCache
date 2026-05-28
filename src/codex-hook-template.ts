export function codexHookTemplate(sidecarUrl: string, dataDir: string, projectRoot: string): string {
  return `#!/usr/bin/env node
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";

// Managed by dcache for Codex CLI. Do not edit by hand.
// dcache-managed-codex-hook
const DATA_DIR = process.env.DCACHE_DATA_DIR || ${JSON.stringify(dataDir)};
const SIDECAR_URL = process.env.DCACHE_SIDECAR_URL || ${JSON.stringify(sidecarUrl)};
const PROJECT_ROOT = normalizePathForId(${JSON.stringify(projectRoot)});
const CACHE_ANCHOR_FILE =
  process.env.DCACHE_CACHE_ANCHOR_FILE || join(DATA_DIR, "cache-anchor.md");
const CACHE_ANCHOR_STATE_FILE = join(DATA_DIR, "cache-anchor.state.json");

const input = await readStdinJson();
const eventName = String(input?.hook_event_name || input?.hookEventName || input?.event || "unknown");
const sessionID = extractSessionID(input);
const projectPath = extractProjectPath(input) || process.cwd();
const project = projectIdentity(projectPath);

if (!pathContains(PROJECT_ROOT, normalizePathForId(projectPath))) {
  process.exit(0);
}

record({
  timestamp: new Date().toISOString(),
  type: "codex." + eventName,
  runtime: "codex",
  session_id: sessionID,
  project: project.root,
  payload: { ...summarizeInput(input), sidecarUrl: SIDECAR_URL }
});

reconcileAnchorContext({ eventName, sessionID, project, input });
const anchor = anchorContextForEvent(eventName, sessionID, project);
if (anchor) {
  record({
    timestamp: new Date().toISOString(),
    type: "cache_anchor.injected",
    runtime: "codex",
    session_id: sessionID,
    payload: { eventName, anchorBytes: anchor.length, project }
  });
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: anchor
    }
  }));
}

async function readStdinJson() {
  let raw = "";
  for await (const chunk of process.stdin) raw += String(chunk);
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { hook_event_name: "MalformedInput", raw };
  }
}

function record(value) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(join(DATA_DIR, "events.ndjson"), JSON.stringify(value) + "\\n", "utf8");
  } catch {
    // Local telemetry is best effort; Codex CLI must continue.
  }
}

function summarizeInput(value) {
  return {
    hook_event_name: value?.hook_event_name,
    hookEventName: value?.hookEventName,
    session_id: value?.session_id,
    sessionId: value?.sessionId,
    thread_id: value?.thread_id,
    turn_id: value?.turn_id,
    transcript_path: value?.transcript_path,
    cwd: value?.cwd,
    source: value?.source,
    trigger: value?.trigger,
    reason: value?.reason,
    promptBytes: typeof value?.prompt === "string" ? value.prompt.length : undefined
  };
}

function cacheAnchor() {
  if (process.env.DCACHE_DISABLE_CACHE_ANCHOR === "1") return "";
  const state = readAnchorState();
  const project = state.project || projectIdentity(process.cwd());
  const inline = process.env.DCACHE_CACHE_ANCHOR || "";
  if (inline.trim()) return normalizeAnchor(inline, state, project);
  if (state.enabled !== true) return "";
  try {
    if (existsSync(CACHE_ANCHOR_FILE)) {
      return normalizeAnchor(readFileSync(CACHE_ANCHOR_FILE, "utf8"), state, project);
    }
  } catch {
    // Anchor loading is best effort; Codex CLI must continue.
  }
  return "";
}

function anchorContextForEvent(eventName, sessionID, project) {
  if (eventName !== "SessionStart" && eventName !== "UserPromptSubmit" && eventName !== "PostCompact") return "";
  const state = readAnchorState();
  if (state.enabled !== true) return "";
  const injectOnceForSession =
    eventName === "UserPromptSubmit" && sessionID && state.lastInjectedSessionId === sessionID;
  if (injectOnceForSession) return "";
  const anchor = cacheAnchor();
  if (!anchor) return "";
  writeAnchorState({
    ...state,
    updatedAt: new Date().toISOString(),
    lastSessionId: sessionID || state.lastSessionId,
    lastInjectedSessionId: sessionID || state.lastInjectedSessionId,
    project: state.project || project
  });
  return anchor;
}

function normalizeAnchor(value, state, project) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  return [
    "dcache stable cache anchor.",
    [
      "runtime: codex",
      "generation: " + String(state.generation || 0),
      "last_reset_at: " + String(state.lastResetAt || state.updatedAt || "not-reset"),
      "last_reset_reason: " + String(state.lastResetReason || "none"),
      "project: " + formatProject(project)
    ].join("\\n"),
    "Stable project context:",
    trimmed
  ].join("\\n\\n");
}

function reconcileAnchorContext(input) {
  const sessionID = input.sessionID || "";
  const project = input.project || projectIdentity(process.cwd());
  const hook = input.input || {};
  let state = readAnchorState();
  let reason = "";
  if (state.enabled === true) {
    if (state.project && project && !sameProjectIdentity(state.project, project)) {
      reason = "project_changed";
    }
    if (!reason && input.eventName === "SessionStart" && isExplicitCodexForkOrResume(hook, state, sessionID)) {
      reason = "codex_fork_or_resume";
    }
    if (!reason && input.eventName === "PostCompact") {
      reason = "codex_post_compact";
    }
  }
  if (state.enabled !== true) return;
  if (reason) {
    state = resetAnchorState(state, reason, project, sessionID);
    writeAnchorState(state);
    record({
      timestamp: new Date().toISOString(),
      type: "cache_anchor.reset",
      runtime: "codex",
      session_id: sessionID,
      payload: { reason, generation: state.generation, eventName: input.eventName, project }
    });
    return;
  }
  writeAnchorState({
    ...state,
    updatedAt: new Date().toISOString(),
    lastSessionId: sessionID || state.lastSessionId,
    project: state.project || project
  });
}

function isExplicitCodexForkOrResume(input, state, sessionID) {
  const source = String(input.source || input.trigger || "");
  return (
    (source === "fork" || source === "resume" || input.fork_session === true || input.forkSession === true) &&
    Boolean(sessionID) &&
    Boolean(state.lastSessionId) &&
    state.lastSessionId !== sessionID
  );
}

function resetAnchorState(state, reason, project, sessionID) {
  const now = new Date().toISOString();
  return {
    ...state,
    generation: numberOrZero(state.generation) + 1,
    resetCount: numberOrZero(state.resetCount) + 1,
    updatedAt: now,
    lastResetAt: now,
    lastResetReason: reason,
    lastSessionId: sessionID || state.lastSessionId,
    lastInjectedSessionId: undefined,
    project: project || state.project
  };
}

function readAnchorState() {
  if (!existsSync(CACHE_ANCHOR_STATE_FILE)) return defaultAnchorState();
  try {
    const parsed = JSON.parse(readFileSync(CACHE_ANCHOR_STATE_FILE, "utf8"));
    return {
      ...defaultAnchorState(),
      ...parsed,
      enabled: parsed?.enabled === true,
      generation: numberOrZero(parsed?.generation),
      resetCount: numberOrZero(parsed?.resetCount)
    };
  } catch {
    return defaultAnchorState();
  }
}

function writeAnchorState(state) {
  try {
    mkdirSync(dirname(CACHE_ANCHOR_STATE_FILE), { recursive: true });
    writeFileSync(CACHE_ANCHOR_STATE_FILE, JSON.stringify(state, null, 2) + "\\n", "utf8");
  } catch {
    // State persistence is best effort; Codex CLI must continue.
  }
}

function defaultAnchorState() {
  return { version: 1, enabled: false, generation: 0, resetCount: 0 };
}

function extractSessionID(value) {
  const candidates = [
    value?.session_id,
    value?.sessionID,
    value?.sessionId,
    value?.thread_id,
    value?.threadId,
    value?.session?.id,
    value?.payload?.session_id,
    value?.payload?.sessionID,
    value?.payload?.sessionId
  ];
  return candidates.find((candidate) => typeof candidate === "string" && candidate.length > 0);
}

function extractProjectPath(value) {
  const candidates = [
    value?.cwd,
    value?.project,
    value?.directory,
    value?.new_cwd,
    value?.worktree_path,
    value?.payload?.cwd,
    value?.payload?.project,
    value?.payload?.directory
  ];
  return candidates.find((candidate) => typeof candidate === "string" && candidate.length > 0);
}

function projectIdentity(startPath) {
  const root = normalizeExistingPath(startPath || process.cwd());
  const gitRoot = findUp(root, ".git");
  if (gitRoot) return makeProjectIdentity("git", gitRoot);
  const svnRoot = findUp(root, ".svn");
  if (svnRoot) return makeProjectIdentity("svn", svnRoot);
  return makeProjectIdentity("folder", root);
}

function sameProjectIdentity(a, b) {
  if (!a || !b) return false;
  if (a.id === b.id) return true;
  if (a.kind === "folder" || b.kind === "folder") {
    return pathContains(a.root, b.root) || pathContains(b.root, a.root);
  }
  return false;
}

function normalizeExistingPath(input) {
  const resolved = resolve(String(input || process.cwd()));
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

function makeProjectIdentity(kind, root) {
  const normalizedRoot = normalizePathForId(root);
  const hash = createHash("sha256").update(normalizedRoot).digest("hex").slice(0, 16);
  return {
    id: kind + ":" + hash,
    kind,
    root: normalizedRoot,
    label: basename(normalizedRoot) || normalizedRoot
  };
}

function pathContains(parent, child) {
  const a = normalizePathForId(parent);
  const b = normalizePathForId(child);
  return b === a || b.startsWith(a.endsWith("/") ? a : a + "/");
}

function normalizePathForId(path) {
  const normalized = resolve(path).replace(/\\\\/g, "/").replace(/\\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function formatProject(project) {
  if (!project) return "unknown";
  return project.kind + ":" + project.label + ":" + project.id;
}

function numberOrZero(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
`;
}
