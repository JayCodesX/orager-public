/**
 * Tests for the dev_server tool — start/stop/status/logs actions.
 *
 * Uses a real lightweight child process (node -e "...") to test lifecycle.
 */

import { describe, it, expect, afterEach } from "vitest";
import { devServerTool, _clearDevServersForTesting } from "../../src/tools/dev-server.js";

const SESSION = "dev-server-test";
const OPTS = { sessionId: SESSION };
const CWD = "/tmp";

afterEach(() => {
  _clearDevServersForTesting();
});

describe("dev_server", () => {
  it("requires action parameter", async () => {
    const result = await devServerTool.execute!({}, CWD, OPTS);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unknown action");
  });

  it("start requires command parameter", async () => {
    const result = await devServerTool.execute!({ action: "start" }, CWD, OPTS);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("command is required");
  });

  it("starts a server and detects ready state", async () => {
    // Simple node server that prints "ready on" — triggers the default ready pattern
    const command = `node -e "setTimeout(() => console.log('Server ready on port 3456'), 100); setInterval(() => {}, 1000)"`;

    const result = await devServerTool.execute!({
      action: "start",
      command,
      port: 3456,
    }, CWD, OPTS);

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.status).toBe("ready");
    expect(parsed.pid).toBeGreaterThan(0);
    expect(parsed.url).toBe("http://localhost:3456");
  });

  it("returns existing server if already running", async () => {
    const command = `node -e "console.log('ready on'); setInterval(() => {}, 1000)"`;

    await devServerTool.execute!({ action: "start", command, port: 4000 }, CWD, OPTS);
    const result = await devServerTool.execute!({ action: "start", command: "different", port: 5000 }, CWD, OPTS);

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.message).toBe("Server already running");
    expect(parsed.url).toBe("http://localhost:4000");
  });

  it("reports status of running server", async () => {
    const command = `node -e "console.log('ready on'); setInterval(() => {}, 1000)"`;
    await devServerTool.execute!({ action: "start", command, port: 4001 }, CWD, OPTS);

    const result = await devServerTool.execute!({ action: "status" }, CWD, OPTS);
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.status).toBe("ready");
    expect(parsed.uptime_s).toBeGreaterThanOrEqual(0);
  });

  it("returns no server for status when none running", async () => {
    const result = await devServerTool.execute!({ action: "status" }, CWD, OPTS);
    expect(result.isError).toBe(false);
    expect(result.content).toBe("No server running");
  });

  it("stops a running server", async () => {
    const command = `node -e "console.log('ready on'); setInterval(() => {}, 1000)"`;
    await devServerTool.execute!({ action: "start", command, port: 4002 }, CWD, OPTS);

    const result = await devServerTool.execute!({ action: "stop" }, CWD, OPTS);
    expect(result.isError).toBe(false);
    expect(result.content).toBe("Server stopped");

    // Status should now say no server
    const status = await devServerTool.execute!({ action: "status" }, CWD, OPTS);
    expect(status.content).toBe("No server running");
  });

  it("returns gracefully when stopping with no server", async () => {
    const result = await devServerTool.execute!({ action: "stop" }, CWD, OPTS);
    expect(result.isError).toBe(false);
    expect(result.content).toBe("No server running");
  });

  it("captures and returns logs", async () => {
    const command = `node -e "console.log('line 1'); console.log('line 2'); console.log('ready on'); setInterval(() => {}, 1000)"`;
    await devServerTool.execute!({ action: "start", command, port: 4003 }, CWD, OPTS);

    const result = await devServerTool.execute!({ action: "logs" }, CWD, OPTS);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("line 1");
    expect(result.content).toContain("line 2");
  });

  it("filters logs by search string", async () => {
    const command = `node -e "console.log('info: starting'); console.log('error: something broke'); console.log('ready on'); setInterval(() => {}, 1000)"`;
    await devServerTool.execute!({ action: "start", command, port: 4004 }, CWD, OPTS);

    const result = await devServerTool.execute!({
      action: "logs",
      search: "error",
    }, CWD, OPTS);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("error: something broke");
    expect(result.content).not.toContain("info: starting");
  });

  it("limits log output lines", async () => {
    const command = `node -e "for(let i=0;i<20;i++) console.log('log line '+i); console.log('ready on'); setInterval(() => {}, 1000)"`;
    await devServerTool.execute!({ action: "start", command, port: 4005 }, CWD, OPTS);

    const result = await devServerTool.execute!({ action: "logs", lines: 5 }, CWD, OPTS);
    const lines = result.content.split("\n").filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(5);
  });

  it("auto-detects port from stdout", async () => {
    const command = `node -e "console.log('Server listening on http://localhost:7777'); setInterval(() => {}, 1000)"`;
    const result = await devServerTool.execute!({ action: "start", command }, CWD, OPTS);

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.url).toBe("http://localhost:7777");
  });

  it("emits browser event on server ready", async () => {
    const emitted: unknown[] = [];
    const optsWithEmit = {
      ...OPTS,
      onEmit: (event: unknown) => emitted.push(event),
    };

    const command = `node -e "console.log('ready on port 4006'); setInterval(() => {}, 1000)"`;
    await devServerTool.execute!({
      action: "start",
      command,
      port: 4006,
    }, CWD, optsWithEmit);

    const browserEvent = emitted.find(
      (e) => (e as Record<string, unknown>).type === "browser"
    ) as Record<string, unknown> | undefined;
    expect(browserEvent).toBeDefined();
    expect(browserEvent!.action).toBe("server_ready");
    expect(browserEvent!.port).toBe(4006);
  });
});
