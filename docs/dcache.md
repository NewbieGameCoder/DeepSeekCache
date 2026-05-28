# dcache operations

This project is a standalone local sidecar for opencode and Claude Code. It is
specifically for improving and measuring DeepSeek LLM prompt-cache hit rate. It
provides hook installation, optional API connection to the local proxy, cache
reports, and anchor management.

## Components

1. `dcache serve` starts the Web dashboard plus DeepSeek-compatible and Anthropic-compatible proxy endpoints.
2. `dcache hook` installs the managed opencode plugin at `.opencode/plugins/dcache.js` and registers `.opencode/commands/newanchor.md`.
3. `dcache hook --target claude` installs the managed Claude Code hook at `.claude/hooks/dcache.mjs` and registers `.claude/commands/newanchor.md`.
4. `dcache uninstall` removes only dcache-managed files and restores managed provider settings.
5. The Web UI exposes install/uninstall buttons plus anchor controls and anchor change logs.

## Data

Default local state lives under `.dcache/`.

- `requests.ndjson` - proxied request summaries and cache usage.
- `events.ndjson` - hook events, plugin events, and anchor changes.
- `findings.ndjson` - warning/error findings.
- `cache-anchor.md`, `cache-anchor.disabled.md`, `cache-anchor.state.json` - optional anchor content and state.
- `commands/newanchor.mjs` - managed script invoked by `/newanchor`.

## Anchor tradeoff

Anchor is off by default. It is useful for small, stable projects and can be
left enabled during daily work when the same project background is reused across
many turns or sessions. It is less useful for one-off prompts, large repos, or
fast-changing work because it consumes prompt tokens and stale anchor text can
bias the model.

## Validation

```bash
npm run verify
npm run test:e2e:opencode
npm run test:e2e:claude
```

The normal verification path uses mock upstreams. Optional E2E tests use local opencode/Claude CLIs when available.
