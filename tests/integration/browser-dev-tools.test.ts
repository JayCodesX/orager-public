/**
 * Tests for browser dev-workflow tools: console_logs, network, inspect,
 * snapshot, resize, fill.
 *
 * Shares the same Playwright mock as browser-tools.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Playwright mock ──────────────────────────────────────────────────────────

const _consoleListeners: Array<(msg: unknown) => void> = [];
const _requestListeners: Array<(req: unknown) => void> = [];
const _responseListeners: Array<(res: unknown) => void> = [];
const _requestFailedListeners: Array<(req: unknown) => void> = [];

const mockPage = {
  goto: vi.fn().mockResolvedValue({}),
  title: vi.fn().mockResolvedValue("Test Page"),
  url: vi.fn().mockReturnValue("https://example.com"),
  screenshot: vi.fn().mockResolvedValue(Buffer.from("PNG")),
  waitForLoadState: vi.fn().mockResolvedValue(undefined),
  click: vi.fn().mockResolvedValue(undefined),
  fill: vi.fn().mockResolvedValue(undefined),
  keyboard: {
    press: vi.fn().mockResolvedValue(undefined),
    type: vi.fn().mockResolvedValue(undefined),
  },
  mouse: {
    click: vi.fn().mockResolvedValue(undefined),
    wheel: vi.fn().mockResolvedValue(undefined),
  },
  evaluate: vi.fn().mockResolvedValue(null),
  close: vi.fn().mockResolvedValue(undefined),
  on: vi.fn().mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
    if (event === "console") _consoleListeners.push(handler);
    if (event === "request") _requestListeners.push(handler);
    if (event === "response") _responseListeners.push(handler);
    if (event === "requestfailed") _requestFailedListeners.push(handler);
  }),
  setViewportSize: vi.fn().mockResolvedValue(undefined),
  emulateMedia: vi.fn().mockResolvedValue(undefined),
  viewportSize: vi.fn().mockReturnValue({ width: 1280, height: 720 }),
  selectOption: vi.fn().mockResolvedValue(["option1"]),
  check: vi.fn().mockResolvedValue(undefined),
  uncheck: vi.fn().mockResolvedValue(undefined),
  accessibility: {
    snapshot: vi.fn().mockResolvedValue({
      role: "WebArea",
      name: "Test Page",
      children: [
        { role: "heading", name: "Hello World", level: 1 },
        { role: "button", name: "Click me" },
      ],
    }),
  },
};

const mockContext = { newPage: vi.fn().mockResolvedValue(mockPage) };
const mockBrowser = {
  newContext: vi.fn().mockResolvedValue(mockContext),
  close: vi.fn().mockResolvedValue(undefined),
};

vi.mock("playwright", () => ({
  chromium: { launch: vi.fn().mockResolvedValue(mockBrowser) },
}));

// ── Tool imports ─────────────────────────────────────────────────────────────

import {
  browserConsoleLogsTool,
  browserNetworkTool,
  browserInspectTool,
  browserSnapshotTool,
  browserResizeTool,
  browserFillTool,
} from "../../src/tools/browser-dev.js";
import { _clearBrowserSessionsForTesting } from "../../src/tools/browser.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const SESSION = "dev-test";
const OPTS = { sessionId: SESSION };
const CWD = "/tmp";

function clearListeners() {
  _consoleListeners.length = 0;
  _requestListeners.length = 0;
  _responseListeners.length = 0;
  _requestFailedListeners.length = 0;
}

/** Simulate a console message via the attached listener. */
function emitConsole(type: string, text: string) {
  for (const fn of _consoleListeners) fn({ type: () => type, text: () => text });
}

/** Simulate a network request via the attached listener. */
function emitRequest(method: string, url: string) {
  for (const fn of _requestListeners) fn({ method: () => method, url: () => url });
}

/** Simulate a network response via the attached listener. */
function emitResponse(url: string, status: number, contentType = "text/html") {
  for (const fn of _responseListeners) fn({
    url: () => url,
    status: () => status,
    headers: () => ({ "content-type": contentType }),
    request: () => ({ method: () => "GET" }),
    text: vi.fn().mockResolvedValue("<html>response body</html>"),
  });
}

/** Simulate a failed request via the attached listener. */
function emitRequestFailed(url: string, errorText: string) {
  for (const fn of _requestFailedListeners) fn({
    url: () => url,
    failure: () => ({ errorText }),
  });
}

beforeEach(() => {
  clearListeners();
  mockPage.evaluate.mockReset().mockResolvedValue(null);
});

afterEach(async () => {
  await _clearBrowserSessionsForTesting();
});

// ── browser_console_logs ─────────────────────────────────────────────────────

describe("browser_console_logs", () => {
  it("returns empty message when no logs captured", async () => {
    const result = await browserConsoleLogsTool.execute!({}, CWD, OPTS);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("no console messages");
  });

  it("captures and returns console messages", async () => {
    // First call initializes the session and attaches listeners
    await browserConsoleLogsTool.execute!({ clear: false }, CWD, OPTS);

    emitConsole("log", "Hello world");
    emitConsole("error", "Something broke");
    emitConsole("warning", "Deprecated API");

    const result = await browserConsoleLogsTool.execute!({ clear: false }, CWD, OPTS);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("LOG] Hello world");
    expect(result.content).toContain("ERROR] Something broke");
    expect(result.content).toContain("WARN] Deprecated API");
  });

  it("filters by error level", async () => {
    await browserConsoleLogsTool.execute!({ clear: false }, CWD, OPTS);

    emitConsole("log", "info message");
    emitConsole("error", "error message");

    const result = await browserConsoleLogsTool.execute!({ level: "error", clear: false }, CWD, OPTS);
    expect(result.content).toContain("error message");
    expect(result.content).not.toContain("info message");
  });

  it("clears buffer by default", async () => {
    await browserConsoleLogsTool.execute!({ clear: false }, CWD, OPTS);

    emitConsole("log", "message 1");
    await browserConsoleLogsTool.execute!({}, CWD, OPTS); // clears by default

    const result = await browserConsoleLogsTool.execute!({}, CWD, OPTS);
    expect(result.content).toContain("no console messages");
  });

  it("respects line limit", async () => {
    await browserConsoleLogsTool.execute!({ clear: false }, CWD, OPTS);

    for (let i = 0; i < 10; i++) emitConsole("log", `msg ${i}`);

    const result = await browserConsoleLogsTool.execute!({ lines: 3, clear: false }, CWD, OPTS);
    const lines = result.content.split("\n");
    expect(lines).toHaveLength(3);
    expect(result.content).toContain("msg 9");
    expect(result.content).toContain("msg 7");
  });
});

// ── browser_network ──────────────────────────────────────────────────────────

describe("browser_network", () => {
  it("returns empty message when no requests", async () => {
    const result = await browserNetworkTool.execute!({}, CWD, OPTS);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("no network requests");
  });

  it("captures requests and responses", async () => {
    await browserNetworkTool.execute!({}, CWD, OPTS);

    emitRequest("GET", "https://api.example.com/data");
    emitResponse("https://api.example.com/data", 200, "application/json");

    const result = await browserNetworkTool.execute!({}, CWD, OPTS);
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].method).toBe("GET");
    expect(parsed[0].status).toBe(200);
    expect(parsed[0].contentType).toBe("application/json");
  });

  it("filters failed requests", async () => {
    await browserNetworkTool.execute!({}, CWD, OPTS);

    emitRequest("GET", "https://example.com/ok");
    emitResponse("https://example.com/ok", 200);
    emitRequest("GET", "https://example.com/fail");
    emitResponse("https://example.com/fail", 500);

    const result = await browserNetworkTool.execute!({ filter: "failed" }, CWD, OPTS);
    const parsed = JSON.parse(result.content);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].url).toContain("/fail");
    expect(parsed[0].status).toBe(500);
  });

  it("filters by URL pattern", async () => {
    await browserNetworkTool.execute!({}, CWD, OPTS);

    emitRequest("GET", "https://example.com/api/users");
    emitResponse("https://example.com/api/users", 200);
    emitRequest("GET", "https://example.com/static/style.css");
    emitResponse("https://example.com/static/style.css", 200);

    const result = await browserNetworkTool.execute!({ url_pattern: "/api/" }, CWD, OPTS);
    const parsed = JSON.parse(result.content);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].url).toContain("/api/users");
  });

  it("retrieves response body by request_id", async () => {
    await browserNetworkTool.execute!({}, CWD, OPTS);

    emitRequest("GET", "https://example.com/page");
    emitResponse("https://example.com/page", 200);

    // Get the listing to find the request_id
    const listing = await browserNetworkTool.execute!({}, CWD, OPTS);
    const entries = JSON.parse(listing.content);
    const id = entries[0].id;

    const body = await browserNetworkTool.execute!({ request_id: id }, CWD, OPTS);
    expect(body.isError).toBe(false);
    expect(body.content).toContain("response body");
  });

  it("handles request failures", async () => {
    await browserNetworkTool.execute!({}, CWD, OPTS);

    emitRequest("GET", "https://example.com/timeout");
    emitRequestFailed("https://example.com/timeout", "net::ERR_TIMED_OUT");

    const result = await browserNetworkTool.execute!({ filter: "failed" }, CWD, OPTS);
    const parsed = JSON.parse(result.content);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].error).toBe("net::ERR_TIMED_OUT");
  });
});

// ── browser_inspect ──────────────────────────────────────────────────────────

describe("browser_inspect", () => {
  it("returns element info for valid selector", async () => {
    mockPage.evaluate.mockResolvedValueOnce({
      tagName: "button",
      id: "submit-btn",
      className: "btn primary",
      textContent: "Submit",
      boundingBox: { x: 100, y: 200, width: 150, height: 40 },
      computedStyles: { color: "rgb(255, 255, 255)", "background-color": "rgb(0, 123, 255)" },
    });

    const result = await browserInspectTool.execute!({ selector: "#submit-btn" }, CWD, OPTS);
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.tagName).toBe("button");
    expect(parsed.id).toBe("submit-btn");
    expect(parsed.computedStyles.color).toBe("rgb(255, 255, 255)");
  });

  it("returns error for missing element", async () => {
    mockPage.evaluate.mockResolvedValueOnce(null);

    const result = await browserInspectTool.execute!({ selector: "#nonexistent" }, CWD, OPTS);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("No element found");
  });

  it("requires selector parameter", async () => {
    const result = await browserInspectTool.execute!({}, CWD, OPTS);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("selector is required");
  });
});

// ── browser_snapshot ─────────────────────────────────────────────────────────

describe("browser_snapshot", () => {
  it("returns accessibility tree", async () => {
    const result = await browserSnapshotTool.execute!({}, CWD, OPTS);
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.role).toBe("WebArea");
    expect(parsed.children).toHaveLength(2);
    expect(parsed.children[0].role).toBe("heading");
  });
});

// ── browser_resize ───────────────────────────────────────────────────────────

describe("browser_resize", () => {
  it("sets viewport from preset", async () => {
    const result = await browserResizeTool.execute!({ preset: "mobile" }, CWD, OPTS);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("375");
    expect(result.content).toContain("812");
    expect(mockPage.setViewportSize).toHaveBeenCalledWith({ width: 375, height: 812 });
  });

  it("sets custom dimensions", async () => {
    const result = await browserResizeTool.execute!({ width: 1920, height: 1080 }, CWD, OPTS);
    expect(result.isError).toBe(false);
    expect(mockPage.setViewportSize).toHaveBeenCalledWith({ width: 1920, height: 1080 });
  });

  it("sets color scheme", async () => {
    const result = await browserResizeTool.execute!({ color_scheme: "dark" }, CWD, OPTS);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("dark");
    expect(mockPage.emulateMedia).toHaveBeenCalledWith({ colorScheme: "dark" });
  });

  it("returns current viewport when no params given", async () => {
    const result = await browserResizeTool.execute!({}, CWD, OPTS);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("1280");
  });

  it("rejects unknown preset", async () => {
    const result = await browserResizeTool.execute!({ preset: "tv" }, CWD, OPTS);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unknown preset");
  });
});

// ── browser_fill ─────────────────────────────────────────────────────────────

describe("browser_fill", () => {
  it("fills a text input", async () => {
    mockPage.evaluate.mockResolvedValueOnce({ tag: "input", type: "text" });

    const result = await browserFillTool.execute!({ selector: "#name", value: "John" }, CWD, OPTS);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Filled");
    expect(mockPage.fill).toHaveBeenCalledWith("#name", "John");
  });

  it("selects a dropdown option", async () => {
    mockPage.evaluate.mockResolvedValueOnce({ tag: "select", type: "" });

    const result = await browserFillTool.execute!({ selector: "#country", value: "US" }, CWD, OPTS);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Selected");
    expect(mockPage.selectOption).toHaveBeenCalledWith("#country", "US");
  });

  it("checks a checkbox", async () => {
    mockPage.evaluate.mockResolvedValueOnce({ tag: "input", type: "checkbox" });

    const result = await browserFillTool.execute!({ selector: "#agree", value: "true" }, CWD, OPTS);
    expect(result.isError).toBe(false);
    expect(mockPage.check).toHaveBeenCalledWith("#agree");
  });

  it("unchecks a checkbox", async () => {
    mockPage.evaluate.mockResolvedValueOnce({ tag: "input", type: "checkbox" });

    const result = await browserFillTool.execute!({ selector: "#agree", value: "false" }, CWD, OPTS);
    expect(result.isError).toBe(false);
    expect(mockPage.uncheck).toHaveBeenCalledWith("#agree");
  });

  it("checks a radio button", async () => {
    mockPage.evaluate.mockResolvedValueOnce({ tag: "input", type: "radio" });

    const result = await browserFillTool.execute!({ selector: "#option-a", value: "a" }, CWD, OPTS);
    expect(result.isError).toBe(false);
    expect(mockPage.check).toHaveBeenCalledWith("#option-a");
  });

  it("returns error for missing element", async () => {
    mockPage.evaluate.mockResolvedValueOnce(null);

    const result = await browserFillTool.execute!({ selector: "#missing", value: "x" }, CWD, OPTS);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("No element found");
  });

  it("requires selector", async () => {
    const result = await browserFillTool.execute!({ value: "test" }, CWD, OPTS);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("selector is required");
  });
});
