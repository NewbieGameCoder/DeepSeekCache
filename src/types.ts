export const DCACHE_VERSION = "0.1.0";

export const MANAGED_KEY = "x-dcache-managed";

export interface DCacheManagedState {
  version: string;
  installedAt: string;
  pluginPath: string;
  sidecarUrl: string;
  proxyBaseUrl: string;
  previousDeepseekProvider?: unknown;
  previousClaudeEnv?: Record<string, unknown>;
  codexHooksPath?: string;
  codexProfilePath?: string;
}

export interface InstallOptions {
  projectRoot?: string;
  dataDir?: string;
  sidecarUrl?: string;
  proxyBaseUrl?: string;
  configPath?: string;
  routeProvider?: boolean;
}

export interface InstallResult {
  ok: boolean;
  action: "hook" | "uninstall";
  projectRoot: string;
  dataDir: string;
  configPath: string;
  pluginPath: string;
  newAnchorCommandPath?: string;
  newAnchorScriptPath?: string;
  backupPath?: string;
  messages: string[];
}

export interface DetectionResult {
  opencodeCommand?: string;
  opencodeVersion?: string;
  claudeCommand?: string;
  claudeVersion?: string;
  codexCommand?: string;
  codexVersion?: string;
  dockerAvailable: boolean;
  dockerOpencodeContainers: string[];
  configCandidates: string[];
  claudeSettingsCandidates: string[];
  codexConfigCandidates: string[];
  platform: NodeJS.Platform;
}

export interface OpencodeHookEvent {
  timestamp?: string;
  type: string;
  project?: string;
  directory?: string;
  worktree?: string;
  sessionId?: string;
  session_id?: string;
  runtime?: "opencode" | "claude" | "codex";
  payload?: unknown;
}

export interface ProjectIdentity {
  id: string;
  kind: "git" | "svn" | "folder";
  root: string;
  label: string;
}

export interface RequestLog {
  id: string;
  timestamp: string;
  method: string;
  path: string;
  model?: string;
  stream?: boolean;
  sessionId?: string;
  requestHash: string;
  toolsHash: string;
  messagesHash: string;
  messageCount: number;
  byteLength: number;
  prefixStable: boolean | null;
  commonPrefixMessages: number;
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  cacheHitRatio: number;
  statusCode?: number;
  findings: string[];
}

export interface Finding {
  id: string;
  timestamp: string;
  type:
    | "request_unmapped_to_session"
    | "model_changed"
    | "tool_schema_changed"
    | "message_prefix_drift"
    | "missing_cache_usage"
    | "proxy_error"
    | "plugin_event";
  severity: "info" | "warn" | "error";
  requestId?: string;
  sessionId?: string;
  message: string;
  detail?: unknown;
}

export interface ReportSummary {
  generatedAt: string;
  requests: number;
  sessions: number;
  mappedRequests: number;
  unmappedRequests: number;
  prefixStableRate: number;
  cacheHitRatio: number;
  promptTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  completionTokens: number;
  findings: number;
  unhandledFindings: number;
  pluginEvents: number;
  anchorEvents: number;
  opencodeSteps: number;
  codexSteps: number;
  lastRequestAt?: string;
  lastAnchorEventAt?: string;
}

export interface CacheAnchorStatus {
  enabled: boolean;
  stateEnabled: boolean;
  configured: boolean;
  disabledByEnv: boolean;
  anchorPath: string;
  disabledPath: string;
  statePath: string;
  bytes: number;
  content: string;
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

export interface RuntimeStatus {
  version: string;
  hooked: boolean;
  claudeHooked: boolean;
  codexHooked: boolean;
  newAnchorCommandInstalled: boolean;
  claudeNewAnchorCommandInstalled: boolean;
  codexNewAnchorCommandInstalled: boolean;
  configPath?: string;
  pluginPath?: string;
  newAnchorCommandPath?: string;
  claudeConfigPath?: string;
  claudeHookPath?: string;
  claudeNewAnchorCommandPath?: string;
  codexConfigPath?: string;
  codexHooksPath?: string;
  codexHookPath?: string;
  codexNewAnchorCommandPath?: string;
  newAnchorScriptPath?: string;
  dataDir: string;
  sidecarUrl: string;
  proxyBaseUrl: string;
  anchor: CacheAnchorStatus;
  detection: DetectionResult;
  report: ReportSummary;
}
