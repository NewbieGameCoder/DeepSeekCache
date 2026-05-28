export function pluginTemplate(sidecarUrl: string, dataDir: string): string {
  return `import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";

// Managed by dcache for opencode. Do not edit by hand.
// dcache-managed-plugin
const DATA_DIR = process.env.DCACHE_DATA_DIR || ${JSON.stringify(dataDir)};
const SIDECAR_URL = process.env.DCACHE_SIDECAR_URL || ${JSON.stringify(sidecarUrl)};
const CACHE_ANCHOR_FILE =
  process.env.DCACHE_CACHE_ANCHOR_FILE || join(DATA_DIR, "cache-anchor.md");
const CACHE_ANCHOR_STATE_FILE = join(DATA_DIR, "cache-anchor.state.json");
const WINDOW_ID = Date.now().toString(36) + "-" + randomUUID();
const STARTUP_ARGS = process.argv.slice(2);
const STARTUP_FORK_REQUESTED = STARTUP_ARGS.includes("--fork");
let currentSessionID = "";

function record(value) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(join(DATA_DIR, "events.ndjson"), JSON.stringify(value) + "\\n", "utf8");
  } catch {
    // Local telemetry is best effort; opencode must continue.
  }
}

function summarizeEvent(event) {
  const properties = event?.properties || {};
  const part = properties.part || {};
  return {
    type: event?.type,
    sessionID: properties.sessionID || part.sessionID,
    messageID: properties.messageID || part.messageID,
    partID: properties.partID || part.id,
    partType: part.type,
    tokens: part.tokens,
    command: event?.command || properties.command || properties.name,
    project: event?.project || properties.project,
    directory: event?.directory || properties.directory || properties.cwd,
    worktree: event?.worktree || properties.worktree
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
    // Anchor loading is best effort; opencode must continue.
  }
  return "";
}

function normalizeAnchor(value, state, project) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  return [
    "dcache stable cache anchor.",
    [
      "generation: " + String(state.generation || 0),
      "last_reset_at: " + String(state.lastResetAt || state.updatedAt || "not-reset"),
      "last_reset_reason: " + String(state.lastResetReason || "none"),
      "project: " + formatProject(project)
    ].join("\\n"),
    "Stable project context:",
    trimmed
  ].join("\\n\\n");
}

function observeRuntimeInput(value, source) {
  const sessionID = extractSessionID(value);
  const path = extractProjectPath(value);
  if (!sessionID && !path) return;
  reconcileAnchorContext({
    source,
    sessionID,
    project: projectIdentity(path || process.cwd())
  });
}

function reconcileAnchorContext(input) {
  const sessionID = input.sessionID || "";
  const project = input.project || projectIdentity(process.cwd());
  let state = readAnchorState();
  let reason = "";
  if (state.enabled === true) {
    if (state.project && project && !sameProjectIdentity(state.project, project)) {
      reason = "project_changed";
    }
    if (!reason && sessionID && currentSessionID && currentSessionID !== sessionID) {
      reason = "manual_new_session";
    }
    if (!reason && startupForkedIntoNewSession(sessionID, state)) {
      reason = "forked_session";
    }
  }
  if (sessionID && currentSessionID !== sessionID) currentSessionID = sessionID;
  if (state.enabled !== true) return;
  if (reason) {
    state = resetAnchorState(state, reason, project, sessionID);
    writeAnchorState(state);
    record({
      timestamp: new Date().toISOString(),
      type: "cache_anchor.reset",
      payload: {
        source: input.source,
        reason,
        generation: state.generation,
        sessionID: sessionID || undefined,
        windowID: WINDOW_ID,
        project
      }
    });
    return;
  }
  const next = {
    ...state,
    updatedAt: new Date().toISOString(),
    lastSessionId: sessionID || state.lastSessionId,
    lastWindowId: WINDOW_ID,
    project: state.project || project
  };
  writeAnchorState(next);
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
    lastWindowId: WINDOW_ID,
    project: project || state.project
  };
}

function startupForkedIntoNewSession(sessionID, state) {
  return (
    STARTUP_FORK_REQUESTED &&
    !currentSessionID &&
    Boolean(sessionID) &&
    Boolean(state.lastSessionId) &&
    state.lastSessionId !== sessionID
  );
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
    // State persistence is best effort; opencode must continue.
  }
}

function defaultAnchorState() {
  return { version: 1, enabled: false, generation: 0, resetCount: 0 };
}

function extractSessionID(value) {
  const payload = value?.payload || {};
  const inner = payload?.event || {};
  const properties = value?.properties || inner?.properties || {};
  const part = properties?.part || {};
  const session = value?.session || payload?.session || inner?.session || {};
  const candidates = [
    value?.sessionID,
    value?.sessionId,
    value?.session_id,
    properties?.sessionID,
    properties?.sessionId,
    properties?.session_id,
    part?.sessionID,
    part?.sessionId,
    session?.id,
    payload?.sessionID,
    payload?.sessionId,
    inner?.sessionID,
    inner?.sessionId
  ];
  return candidates.find((candidate) => typeof candidate === "string" && candidate.length > 0);
}

function extractProjectPath(value) {
  const payload = value?.payload || {};
  const inner = payload?.event || {};
  const properties = value?.properties || inner?.properties || {};
  const candidates = [
    value?.project,
    value?.directory,
    value?.cwd,
    value?.worktree,
    value?.root,
    properties?.project,
    properties?.directory,
    properties?.cwd,
    properties?.worktree,
    properties?.root,
    payload?.project,
    payload?.directory,
    payload?.cwd,
    payload?.worktree,
    inner?.project,
    inner?.directory,
    inner?.cwd,
    inner?.worktree
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

export const DCacheOpenCodePlugin = async () => {
  record({
    timestamp: new Date().toISOString(),
    type: "plugin.initialized",
    payload: { dataDir: DATA_DIR, sidecarUrl: SIDECAR_URL, windowID: WINDOW_ID }
  });
  return {
    "experimental.chat.system.transform": async (input, output) => {
      observeRuntimeInput(input, "system.transform");
      const anchor = cacheAnchor();
      if (!anchor) return;
      output.system.unshift(anchor);
      record({
        timestamp: new Date().toISOString(),
        type: "cache_anchor.injected",
        payload: {
          anchorBytes: anchor.length,
          systemCount: output.system.length,
          windowID: WINDOW_ID
        }
      });
    },
    event: ({ event }) => {
      const type = String(event?.type || "");
      if (isObservableEventType(type)) {
        observeRuntimeInput(event, type);
        record({
          timestamp: new Date().toISOString(),
          type,
          payload: { event: summarizeEvent(event), windowID: WINDOW_ID }
        });
      }
    }
  };
};

function isObservableEventType(type) {
  return (
    type.startsWith("session.") ||
    type.startsWith("message.") ||
    type === "tui.command.execute" ||
    type === "command.executed"
  );
}

export default DCacheOpenCodePlugin;
`;
}
