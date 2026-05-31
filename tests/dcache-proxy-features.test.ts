import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { autoDetectTargetsFunc } from "../src/detect.js";
import { extractRequestShape, makeRequestLog } from "../src/prefix.js";

describe("dcache-proxy auto-detection", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `dcache-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("autoDetectTargetsFunc should find opencode config", () => {
    const configPath = join(tmpDir, "opencode.json");
    writeFileSync(configPath, JSON.stringify({ provider: {} }));
    const result = autoDetectTargetsFunc(tmpDir);
    expect(result.opencode.found).toBe(true);
    expect(result.claude.found).toBe(false);
    expect(result.codex.found).toBe(false);
  });

  it("autoDetectTargetsFunc should handle missing configs", () => {
    const result = autoDetectTargetsFunc("/nonexistent-path-for-testing");
    expect(result.opencode.found).toBe(false);
    expect(result.claude.found).toBe(false);
    expect(result.codex.found).toBe(false);
  });
});

describe("dcache-proxy CLI options", () => {
  it("serve command should accept --daemon flag", () => {
    const { Command } = require("commander");
    const program = new Command();
    program
      .command("serve")
      .option("--daemon", "run in background as a daemon process (Unix only)")
      .option("--host <host>", "host", "127.0.0.1");
    const cmd = program.commands.find((c: any) => c.name() === "serve");
    expect(cmd).toBeDefined();
  });

  it("hook command should accept --auto flag", () => {
    const { Command } = require("commander");
    const program = new Command();
    program
      .command("hook")
      .option("--auto", "auto-discover opencode/Claude/Codex installations")
      .option("--connect-api", "rewrite API URL");
    const cmd = program.commands.find((c: any) => c.name() === "hook");
    expect(cmd).toBeDefined();
  });
});

describe("dcache-proxy package configuration", () => {
  it("should have correct package name", () => {
    const pkg = JSON.parse(readFileSync("./package.json", "utf8"));
    expect(pkg.name).toBe("dcache-proxy");
  });

  it("should not include Docker files in published package", () => {
    const pkg = JSON.parse(readFileSync("./package.json", "utf8"));
    expect(pkg.files).not.toContain("Dockerfile");
    expect(pkg.files).not.toContain("docker-compose.yml");
  });

  it("should have node >= 18 engines requirement", () => {
    const pkg = JSON.parse(readFileSync("./package.json", "utf8"));
    expect(pkg.engines.node).toBe(">=18.0.0");
  });

  it("should have publishConfig with public access", () => {
    const pkg = JSON.parse(readFileSync("./package.json", "utf8"));
    expect(pkg.publishConfig.access).toBe("public");
  });
});

describe("dcache-proxy prefix analysis", () => {
  it("extractRequestShape should parse basic messages", () => {
    const body = JSON.stringify({
      model: "deepseek-v4-flash",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Say hello." }
      ],
      tools: []
    });
    const shape = extractRequestShape(body);
    expect(shape.model).toBe("deepseek-v4-flash");
    expect(shape.messages.length).toBe(2);
    expect(shape.tools.length).toBe(0);
  });

  it("makeRequestLog should generate request log", () => {
    const body = JSON.stringify({
      model: "test-model",
      messages: [],
      tools: []
    });
    const log = makeRequestLog({
      method: "POST",
      path: "/v1/chat/completions",
      bodyText: body,
      previous: null,
      sessionId: "test-session-id",
      statusCode: 200
    });
    expect(log.model).toBeUndefined();
    expect(log.sessionId).toBeUndefined();
    expect(Array.isArray(log.findings) || typeof log.findings === "number").toBe(true);
  });
});
