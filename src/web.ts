import type {
  Finding,
  OpencodeHookEvent,
  ReportSummary,
  RequestLog,
  RuntimeStatus,
} from "./types.js";

export function renderDashboard(
  status: RuntimeStatus,
  requests: RequestLog[],
  findings: Finding[],
  events: OpencodeHookEvent[] = [],
): string {
  const report = status.report;
  const anchorEvents = events.filter((event) => event.type?.startsWith("cache_anchor."));
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>dcache DeepSeek cache report</title>
  <style>
    :root { color-scheme: dark; --bg:#0d1117; --panel:#161b22; --panel2:#0f172a; --text:#e6edf3; --muted:#8b949e; --ok:#3fb950; --warn:#d29922; --err:#f85149; --line:#30363d; --blue:#58a6ff; --violet:#a78bfa; }
    * { box-sizing: border-box; }
    body { margin:0; font:14px/1.45 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif; background:var(--bg); color:var(--text); }
    header { padding:24px 28px; border-bottom:1px solid var(--line); background:linear-gradient(90deg,#111827,#0d1117); }
    h1 { margin:0 0 6px; font-size:24px; }
    .muted { color:var(--muted); }
    main { padding:24px 28px; max-width:1280px; margin:0 auto; }
    .actions { display:flex; gap:12px; margin:18px 0 22px; }
    .actions.wrap { flex-wrap:wrap; }
    button { border:0; border-radius:10px; padding:11px 18px; font-weight:700; cursor:pointer; color:#081018; background:var(--blue); }
    button.secondary { background:var(--violet); color:#081018; }
    button.danger { background:var(--err); color:#fff; }
    button:disabled { opacity:.55; cursor:not-allowed; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:12px; }
    .card { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:15px; }
    .card .label { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.06em; }
    .card .value { font-size:24px; margin-top:5px; font-weight:800; }
    .ok { color:var(--ok); } .warn { color:var(--warn); } .err { color:var(--err); }
    table { width:100%; border-collapse:collapse; margin-top:12px; overflow:hidden; border-radius:10px; }
    th,td { padding:9px 10px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; }
    th { color:var(--muted); font-size:12px; }
    code { color:#a5d6ff; }
    section { margin-top:24px; }
    pre { white-space:pre-wrap; background:#0b1220; border:1px solid var(--line); border-radius:10px; padding:12px; color:#c9d1d9; }
    textarea { width:100%; min-height:150px; resize:vertical; border-radius:10px; border:1px solid var(--line); background:#0b1220; color:var(--text); padding:12px; font:13px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace; }
    .pill { display:inline-flex; align-items:center; gap:6px; border:1px solid var(--line); border-radius:999px; padding:3px 9px; background:var(--panel2); font-size:12px; }
    .timeline { display:grid; gap:10px; margin-top:12px; }
    .event { border:1px solid var(--line); border-radius:12px; padding:12px; background:linear-gradient(135deg,#101827,#0b1220); }
    .event .top { display:flex; flex-wrap:wrap; gap:8px; justify-content:space-between; margin-bottom:8px; }
    .event strong { color:var(--violet); }
  </style>
</head>
<body>
  <header>
    <h1>dcache DeepSeek cache report</h1>
    <p class="muted">Focused on improving and measuring DeepSeek LLM prompt-cache hit rate for opencode, Claude Code, and Codex CLI.</p>
    <div class="muted">Hook status, real proxy telemetry, cache usage, and drift findings.</div>
  </header>
  <main>
    <div class="actions wrap">
      <button id="hook">Hook opencode</button>
      <button id="claudeHook">Hook Claude</button>
      <button id="codexHook">Hook Codex</button>
      <button id="hookApi" class="secondary">Hook opencode + connect API</button>
      <button id="claudeHookApi" class="secondary">Hook Claude + connect API</button>
      <button id="codexHookApi" class="secondary">Hook Codex + connect API</button>
      <button id="uninstall" class="danger">Uninstall opencode</button>
      <button id="claudeUninstall" class="danger">Uninstall Claude</button>
      <button id="codexUninstall" class="danger">Uninstall Codex</button>
      <button id="refresh">Refresh</button>
    </div>
    <p class="muted">Plain Hook only installs listeners and the manual anchor helper. "connect API" also routes the client through this local proxy so cache-hit reports can be measured automatically. Codex uses a <code>-p dcache</code> profile for this route.</p>
    <div id="actionResult" class="muted"></div>
    ${renderCards(report, status.hooked, status.claudeHooked, status.codexHooked, status.anchor.enabled)}
    <section class="card">
      <h2>Runtime</h2>
      <p>opencode hooked: <strong class="${status.hooked ? "ok" : "warn"}">${status.hooked ? "yes" : "no"}</strong></p>
      <p>opencode config: <code>${escapeHtml(status.configPath ?? "")}</code></p>
      <p>opencode plugin: <code>${escapeHtml(status.pluginPath ?? "")}</code></p>
      <p>opencode /newanchor: <strong class="${status.newAnchorCommandInstalled ? "ok" : "warn"}">${status.newAnchorCommandInstalled ? "installed" : "not installed"}</strong> <code>${escapeHtml(status.newAnchorCommandPath ?? "")}</code></p>
      <p>Claude hooked: <strong class="${status.claudeHooked ? "ok" : "warn"}">${status.claudeHooked ? "yes" : "no"}</strong></p>
      <p>Claude settings: <code>${escapeHtml(status.claudeConfigPath ?? "")}</code></p>
      <p>Claude hook: <code>${escapeHtml(status.claudeHookPath ?? "")}</code></p>
      <p>Claude /newanchor: <strong class="${status.claudeNewAnchorCommandInstalled ? "ok" : "warn"}">${status.claudeNewAnchorCommandInstalled ? "installed" : "not installed"}</strong> <code>${escapeHtml(status.claudeNewAnchorCommandPath ?? "")}</code></p>
      <p>Codex hooked: <strong class="${status.codexHooked ? "ok" : "warn"}">${status.codexHooked ? "yes" : "no"}</strong></p>
      <p>Codex hooks: <code>${escapeHtml(status.codexHooksPath ?? "")}</code></p>
      <p>Codex profile: <code>${escapeHtml(status.codexConfigPath ?? "")}</code></p>
      <p>Codex hook: <code>${escapeHtml(status.codexHookPath ?? "")}</code></p>
      <p>Codex $newanchor: <strong class="${status.codexNewAnchorCommandInstalled ? "ok" : "warn"}">${status.codexNewAnchorCommandInstalled ? "installed" : "not installed"}</strong> <code>${escapeHtml(status.codexNewAnchorCommandPath ?? "")}</code></p>
      <p>Data: <code>${escapeHtml(status.dataDir)}</code></p>
      <p>Command script: <code>${escapeHtml(status.newAnchorScriptPath ?? "")}</code></p>
      <p>Proxy: <code>${escapeHtml(status.proxyBaseUrl)}</code></p>
      <p>opencode: <code>${escapeHtml(status.detection.opencodeCommand ?? "not found")}</code> ${escapeHtml(status.detection.opencodeVersion ?? "")}</p>
      <p>Claude: <code>${escapeHtml(status.detection.claudeCommand ?? "not found")}</code> ${escapeHtml(status.detection.claudeVersion ?? "")}</p>
      <p>Codex: <code>${escapeHtml(status.detection.codexCommand ?? "not found")}</code> ${escapeHtml(status.detection.codexVersion ?? "")}</p>
    </section>
    <section class="card">
      <h2>Cross-session cache anchor</h2>
      <p>Status: <strong class="${status.anchor.enabled ? "ok" : status.anchor.configured ? "warn" : "muted"}">${status.anchor.enabled ? "enabled" : status.anchor.configured ? "configured but disabled" : "not configured"}</strong></p>
      ${status.anchor.disabledByEnv ? `<p class="warn">Disabled by <code>DCACHE_DISABLE_CACHE_ANCHOR=1</code>.</p>` : ""}
      <p>Active file: <code>${escapeHtml(status.anchor.anchorPath)}</code></p>
      <p>Disabled file: <code>${escapeHtml(status.anchor.disabledPath)}</code></p>
      <p>State file: <code>${escapeHtml(status.anchor.statePath)}</code></p>
      <p>Bytes: <strong>${status.anchor.bytes}</strong></p>
      <p>Generation: <strong>${status.anchor.generation}</strong> · Resets: <strong>${status.anchor.resetCount}</strong> · Last reset: <code>${escapeHtml(status.anchor.lastResetAt ?? "never")}</code> <span class="muted">${escapeHtml(status.anchor.lastResetReason ?? "")}</span></p>
      <p>Project: <code>${escapeHtml(formatProject(status.anchor.project))}</code></p>
      <p><strong>Anchor tradeoff:</strong> good for small, stable projects where the same background is reused often; in that case it is reasonable to leave anchor enabled during daily work. It can improve cross-session prefix-cache hits, but costs prompt tokens and stale text can bias the model. Keep it off for short one-off work, rapidly changing context, or large repos where stale background may distract the model.</p>
      <textarea id="anchorContent" placeholder="Stable project context to prepend before variable user turns.">${escapeHtml(status.anchor.content)}</textarea>
      <div class="actions">
        <button id="anchorSave">Save & Enable anchor</button>
        <button id="anchorDisable" class="danger">Disable anchor</button>
        <button id="anchorEnable">Enable existing anchor</button>
        <button id="anchorReset">Reset generation</button>
      </div>
      <p class="muted">Default is off. When enabled, dcache adds deterministic generation, reset, and project metadata. opencode /new, Claude /clear, Codex compact/resume/fork-like events, explicit fork events, and real project changes reset generation programmatically.</p>
    </section>
    <section class="card">
      <h2>Anchor change log</h2>
      <p class="muted">Manual Web edits, /newanchor operations, and programmatic project/session resets are recorded here.</p>
      ${renderAnchorEvents(anchorEvents)}
    </section>
    <section class="card">
      <h2>Recent requests</h2>
      ${renderRequests(requests)}
    </section>
    <section class="card">
      <h2>Findings</h2>
      ${renderFindings(findings)}
    </section>
  </main>
  <script>
    async function call(path, payload = undefined) {
      const res = await fetch(path, {
        method: 'POST',
        headers: payload ? { 'content-type': 'application/json' } : undefined,
        body: payload ? JSON.stringify(payload) : undefined
      });
      const json = await res.json();
      document.getElementById('actionResult').textContent = JSON.stringify(json, null, 2);
      setTimeout(() => location.reload(), 500);
    }
    document.getElementById('hook').onclick = () => call('/api/hook');
    document.getElementById('claudeHook').onclick = () => call('/api/claude/hook');
    document.getElementById('codexHook').onclick = () => call('/api/codex/hook');
    document.getElementById('hookApi').onclick = () => call('/api/hook', { connectApi: true });
    document.getElementById('claudeHookApi').onclick = () => call('/api/claude/hook', { connectApi: true });
    document.getElementById('codexHookApi').onclick = () => call('/api/codex/hook', { connectApi: true });
    document.getElementById('uninstall').onclick = () => call('/api/uninstall');
    document.getElementById('claudeUninstall').onclick = () => call('/api/claude/uninstall');
    document.getElementById('codexUninstall').onclick = () => call('/api/codex/uninstall');
    document.getElementById('refresh').onclick = () => location.reload();
    async function saveAnchor(payload) {
      const res = await fetch('/api/anchor', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const json = await res.json();
      document.getElementById('actionResult').textContent = JSON.stringify(json, null, 2);
      setTimeout(() => location.reload(), 500);
    }
    document.getElementById('anchorSave').onclick = () => saveAnchor({ enabled: true, content: document.getElementById('anchorContent').value });
    document.getElementById('anchorDisable').onclick = () => saveAnchor({ enabled: false });
    document.getElementById('anchorEnable').onclick = () => saveAnchor({ enabled: true });
    document.getElementById('anchorReset').onclick = () => saveAnchor({ reset: true });
  </script>
</body>
</html>`;
}

function renderCards(
  report: ReportSummary,
  hooked: boolean,
  claudeHooked: boolean,
  codexHooked: boolean,
  anchorEnabled: boolean,
): string {
  const stable = pct(report.prefixStableRate);
  const cache = pct(report.cacheHitRatio);
  return `<div class="grid">
    ${card("opencode hook", hooked ? "Active" : "Inactive", hooked ? "ok" : "warn")}
    ${card("Claude hook", claudeHooked ? "Active" : "Inactive", claudeHooked ? "ok" : "warn")}
    ${card("Codex hook", codexHooked ? "Active" : "Inactive", codexHooked ? "ok" : "warn")}
    ${card("Anchor", anchorEnabled ? "Enabled" : "Off", anchorEnabled ? "ok" : "warn")}
    ${card("Requests", String(report.requests))}
    ${card("Runtime steps", String(report.opencodeSteps))}
    ${card("Codex steps", String(report.codexSteps))}
    ${card("Plugin events", String(report.pluginEvents))}
    ${card("Anchor events", String(report.anchorEvents))}
    ${card("Coverage", report.requests ? pct(report.mappedRequests / report.requests) : "0.0%")}
    ${card("Prefix stable", stable, report.prefixStableRate >= 0.9 ? "ok" : "warn")}
    ${card("Cache hit", cache, report.cacheHitRatio >= 0.8 ? "ok" : "warn")}
    ${card("Unhandled", String(report.unhandledFindings), report.unhandledFindings ? "err" : "ok")}
  </div>`;
}

function card(label: string, value: string, cls = ""): string {
  return `<div class="card"><div class="label">${escapeHtml(label)}</div><div class="value ${cls}">${escapeHtml(value)}</div></div>`;
}

function renderAnchorEvents(events: OpencodeHookEvent[]): string {
  if (events.length === 0) {
    return `<p class="muted">No anchor changes recorded yet.</p>`;
  }
  return `<div class="timeline">${events
    .slice(-30)
    .reverse()
    .map((event) => {
      const payload = isRecord(event.payload) ? event.payload : {};
      const reason = textValue(payload.reason) ?? textValue(payload.lastResetReason);
      const action = textValue(payload.action);
      const generation = numberValue(payload.generation);
      const resetCount = numberValue(payload.resetCount);
      const project = isRecord(payload.project)
        ? [textValue(payload.project.kind), textValue(payload.project.label), textValue(payload.project.id)]
            .filter(Boolean)
            .join(":")
        : "";
      return `<div class="event">
        <div class="top">
          <span><strong>${escapeHtml(action ?? reason ?? event.type)}</strong> <span class="muted">${escapeHtml(event.timestamp ?? "")}</span></span>
          <span class="pill">${escapeHtml(String(event.runtime ?? textValue(payload.source) ?? "runtime"))}</span>
        </div>
        <div>
          <span class="pill">type: ${escapeHtml(event.type)}</span>
          ${generation === undefined ? "" : `<span class="pill">generation: ${generation}</span>`}
          ${resetCount === undefined ? "" : `<span class="pill">resets: ${resetCount}</span>`}
          ${reason ? `<span class="pill">reason: ${escapeHtml(reason)}</span>` : ""}
          ${textValue(payload.sessionID) || event.sessionId || event.session_id ? `<span class="pill">session: ${escapeHtml(textValue(payload.sessionID) ?? event.sessionId ?? event.session_id ?? "")}</span>` : ""}
        </div>
        ${project ? `<p class="muted">Project: <code>${escapeHtml(project)}</code></p>` : ""}
        ${textValue(payload.message) ? `<p>${escapeHtml(textValue(payload.message) ?? "")}</p>` : ""}
      </div>`;
    })
    .join("")}</div>`;
}

function renderRequests(requests: RequestLog[]): string {
  if (requests.length === 0) return `<p class="muted">No proxy requests captured yet.</p>`;
  const rows = requests
    .slice(-30)
    .reverse()
    .map(
      (r) => `<tr>
        <td>${escapeHtml(r.timestamp)}</td>
        <td><code>${escapeHtml(r.model ?? "")}</code></td>
        <td>${r.messageCount}</td>
        <td class="${r.prefixStable === false ? "err" : r.prefixStable === true ? "ok" : "muted"}">${r.prefixStable === null ? "baseline" : r.prefixStable ? "stable" : "drift"}</td>
        <td>${pct(r.cacheHitRatio)}</td>
        <td>${r.cacheHitTokens}/${r.cacheMissTokens}</td>
        <td>${escapeHtml(r.findings.join(", "))}</td>
      </tr>`,
    )
    .join("");
  return `<table><thead><tr><th>Time</th><th>Model</th><th>Msgs</th><th>Prefix</th><th>Cache</th><th>Hit/Miss</th><th>Findings</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderFindings(findings: Finding[]): string {
  if (findings.length === 0) return `<p class="muted">No findings.</p>`;
  const rows = findings
    .slice(-50)
    .reverse()
    .map(
      (f) => `<tr>
        <td>${escapeHtml(f.timestamp)}</td>
        <td class="${f.severity === "error" ? "err" : f.severity === "warn" ? "warn" : "muted"}">${escapeHtml(f.severity)}</td>
        <td>${escapeHtml(f.type)}</td>
        <td>${escapeHtml(f.message)}</td>
      </tr>`,
    )
    .join("");
  return `<table><thead><tr><th>Time</th><th>Severity</th><th>Type</th><th>Message</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function formatProject(project: RuntimeStatus["anchor"]["project"]): string {
  if (!project) return "unknown";
  return `${project.kind}:${project.label}:${project.id}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
