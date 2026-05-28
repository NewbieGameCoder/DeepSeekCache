export { readJsoncObject, stripJsonComments } from "./config.js";
export { claudeGatewayBaseUrl } from "./claude-config.js";
export { detectOpencode } from "./detect.js";
export {
  claudeHookStatus,
  codexHookStatus,
  hookStatus,
  installClaudeHook,
  installCodexHook,
  installHook,
  uninstallClaudeHook,
  uninstallCodexHook,
  uninstallHook,
} from "./installer.js";
export {
  defaultCodexHome,
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
  defaultProjectRoot,
} from "./paths.js";
export {
  classifyPrefixStability,
  extractRequestShape,
  makeRequestLog,
  usageFromResponseText,
} from "./prefix.js";
export { dockerComposeTemplate, startDCacheServer } from "./server.js";
export { DCacheStore } from "./store.js";
export type * from "./types.js";
