import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";

import type { CacheAnchorStatus, ProjectIdentity } from "./types.js";

const ANCHOR_FILE = "cache-anchor.md";
const DISABLED_ANCHOR_FILE = "cache-anchor.disabled.md";
const ANCHOR_STATE_FILE = "cache-anchor.state.json";

interface CacheAnchorState {
  version: 1;
  enabled: boolean;
  generation: number;
  resetCount: number;
  updatedAt?: string;
  enabledAt?: string;
  disabledAt?: string;
  lastResetAt?: string;
  lastResetReason?: string;
  lastSessionId?: string;
  lastWindowId?: string;
  project?: ProjectIdentity;
}

export interface UpdateAnchorInput {
  enabled?: unknown;
  content?: unknown;
  reset?: unknown;
}

export interface UpdateAnchorOptions {
  projectRoot?: string;
  reason?: string;
  sessionId?: string;
  windowId?: string;
}

export function anchorPaths(dataDir: string): {
  anchorPath: string;
  disabledPath: string;
  statePath: string;
} {
  return {
    anchorPath: join(dataDir, ANCHOR_FILE),
    disabledPath: join(dataDir, DISABLED_ANCHOR_FILE),
    statePath: join(dataDir, ANCHOR_STATE_FILE),
  };
}

export function anchorStatus(
  dataDir: string,
  opts: { projectRoot?: string } = {},
): CacheAnchorStatus {
  const { anchorPath, disabledPath, statePath } = anchorPaths(dataDir);
  const disabledByEnv =
    process.env.DCACHE_DISABLE_CACHE_ANCHOR === "1";
  const state = readAnchorState(dataDir);
  const activeExists = existsSync(anchorPath);
  const disabledExists = existsSync(disabledPath);
  const configured = activeExists || disabledExists;
  const sourcePath = activeExists ? anchorPath : disabledExists ? disabledPath : anchorPath;
  const content = configured ? readFileSync(sourcePath, "utf8") : "";
  const bytes = configured ? statSync(sourcePath).size : 0;
  const fallbackProject = opts.projectRoot ? resolveProjectIdentity(opts.projectRoot) : undefined;
  return {
    enabled: state.enabled && activeExists && !disabledByEnv,
    stateEnabled: state.enabled,
    configured,
    disabledByEnv,
    anchorPath,
    disabledPath,
    statePath,
    bytes,
    content,
    generation: state.generation,
    resetCount: state.resetCount,
    updatedAt: state.updatedAt,
    enabledAt: state.enabledAt,
    disabledAt: state.disabledAt,
    lastResetAt: state.lastResetAt,
    lastResetReason: state.lastResetReason,
    lastSessionId: state.lastSessionId,
    lastWindowId: state.lastWindowId,
    project: state.project ?? fallbackProject,
  };
}

export function updateAnchor(
  dataDir: string,
  input: UpdateAnchorInput,
  opts: UpdateAnchorOptions = {},
): CacheAnchorStatus {
  const { anchorPath, disabledPath } = anchorPaths(dataDir);
  mkdirSync(dirname(anchorPath), { recursive: true });
  const now = new Date().toISOString();
  let state = readAnchorState(dataDir);
  const project = opts.projectRoot ? resolveProjectIdentity(opts.projectRoot) : state.project;
  let clearedContent = false;

  if (typeof input.content === "string") {
    const content = input.content.trim();
    if (content.length > 0) {
      writeFileSync(input.enabled === false ? disabledPath : anchorPath, `${content}\n`, "utf8");
      if (input.enabled === false) rmSync(anchorPath, { force: true });
      else rmSync(disabledPath, { force: true });
    } else {
      rmSync(anchorPath, { force: true });
      rmSync(disabledPath, { force: true });
      clearedContent = true;
      state = {
        ...state,
        enabled: false,
        updatedAt: now,
        disabledAt: now,
      };
    }
  }

  if (input.enabled === true && !existsSync(anchorPath) && existsSync(disabledPath)) {
    renameSync(disabledPath, anchorPath);
  }
  if (input.enabled === false && existsSync(anchorPath)) {
    rmSync(disabledPath, { force: true });
    renameSync(anchorPath, disabledPath);
  }

  if (input.enabled === true && !clearedContent && existsSync(anchorPath)) {
    state = resetAnchorStateValue(state, opts.reason ?? "manual_enable", {
      now,
      project,
      sessionId: opts.sessionId,
      windowId: opts.windowId,
    });
    state.enabled = true;
    state.enabledAt ??= now;
  } else if (input.enabled === false) {
    state = {
      ...state,
      enabled: false,
      updatedAt: now,
      disabledAt: now,
      lastSessionId: opts.sessionId ?? state.lastSessionId,
      lastWindowId: opts.windowId ?? state.lastWindowId,
      project: project ?? state.project,
    };
  } else if (input.reset === true) {
    state = resetAnchorStateValue(state, opts.reason ?? "manual_reset", {
      now,
      project,
      sessionId: opts.sessionId,
      windowId: opts.windowId,
    });
  } else if (project && !state.project) {
    state = { ...state, project, updatedAt: now };
  }

  writeAnchorState(dataDir, state);
  return anchorStatus(dataDir, { projectRoot: opts.projectRoot });
}

export function resolveProjectIdentity(startPath: string): ProjectIdentity {
  const root = normalizeExistingPath(startPath);
  const gitRoot = findUp(root, ".git");
  if (gitRoot) return makeProjectIdentity("git", gitRoot);
  const svnRoot = findUp(root, ".svn");
  if (svnRoot) return makeProjectIdentity("svn", svnRoot);
  return makeProjectIdentity("folder", root);
}

export function sameProjectIdentity(a?: ProjectIdentity, b?: ProjectIdentity): boolean {
  if (!a || !b) return false;
  if (a.id === b.id) return true;
  if (a.kind === "folder" || b.kind === "folder") {
    return pathContains(a.root, b.root) || pathContains(b.root, a.root);
  }
  return false;
}

function readAnchorState(dataDir: string): CacheAnchorState {
  const { statePath } = anchorPaths(dataDir);
  if (!existsSync(statePath)) return defaultAnchorState();
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as Partial<CacheAnchorState>;
    return {
      ...defaultAnchorState(),
      ...parsed,
      enabled: parsed.enabled === true,
      generation: numberOrZero(parsed.generation),
      resetCount: numberOrZero(parsed.resetCount),
    };
  } catch {
    return defaultAnchorState();
  }
}

function writeAnchorState(dataDir: string, state: CacheAnchorState): void {
  const { statePath } = anchorPaths(dataDir);
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function resetAnchorStateValue(
  state: CacheAnchorState,
  reason: string,
  opts: {
    now: string;
    project?: ProjectIdentity;
    sessionId?: string;
    windowId?: string;
  },
): CacheAnchorState {
  return {
    ...state,
    generation: state.generation + 1,
    resetCount: state.resetCount + 1,
    updatedAt: opts.now,
    lastResetAt: opts.now,
    lastResetReason: reason,
    lastSessionId: opts.sessionId ?? state.lastSessionId,
    lastWindowId: opts.windowId ?? state.lastWindowId,
    project: opts.project ?? state.project,
  };
}

function defaultAnchorState(): CacheAnchorState {
  return {
    version: 1,
    enabled: false,
    generation: 0,
    resetCount: 0,
  };
}

function normalizeExistingPath(input: string): string {
  const resolved = resolve(input);
  if (!existsSync(resolved)) return normalizePathForId(resolved);
  const stat = statSync(resolved);
  const directory = stat.isDirectory() ? resolved : dirname(resolved);
  return realpathSync.native(directory);
}

function findUp(start: string, marker: string): string | undefined {
  let current = start;
  while (true) {
    if (existsSync(join(current, marker))) return realpathSync.native(current);
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function makeProjectIdentity(kind: ProjectIdentity["kind"], root: string): ProjectIdentity {
  const normalizedRoot = normalizePathForId(root);
  const hash = createHash("sha256").update(normalizedRoot).digest("hex").slice(0, 16);
  return {
    id: `${kind}:${hash}`,
    kind,
    root: normalizedRoot,
    label: basename(normalizedRoot) || normalizedRoot,
  };
}

function pathContains(parent: string, child: string): boolean {
  const a = normalizePathForId(parent);
  const b = normalizePathForId(child);
  return b === a || b.startsWith(a.endsWith("/") ? a : `${a}/`);
}

function normalizePathForId(path: string): string {
  const normalized = resolve(path).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
