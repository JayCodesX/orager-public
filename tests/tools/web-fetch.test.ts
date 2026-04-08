/**
 * Tests for src/tools/web-fetch.ts
 *
 * Covers: isBlockedHost (SSRF guard), tool input validation, URL scheme
 * enforcement, method validation, SSRF blocking, HTML-to-text conversion,
 * raw mode, output truncation, and HTTP error handling.
 *
 * Network is mocked via vi.stubGlobal("fetch", ...) so no real requests are made.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { webFetchTool, isBlockedHost } from "../../src/tools/web-fetch.js";

// ── isBlockedHost — direct IP addresses (no DNS needed) ───────────────────────

describe("isBlockedHost — direct private IPs", () => {
  it("blocks loopback 127.0.0.1", async () => {
    expect(await isBlockedHost("127.0.0.1")).toBe(true);
  });

  it("blocks RFC-1918 10.0.0.1", async () => {
    expect(await isBlockedHost("10.0.0.1")).toBe(true);
  });

  it("blocks RFC-1918 192.168.1.1", async () => {
    expect(await isBlockedHost("192.168.1.1")).toBe(true);
  });

  it("blocks RFC-1918 172.16.0.1", async () => {
    expect(await isBlockedHost("172.16.0.1")).toBe(true);
  });

  it("blocks link-local 169.254.1.1", async () => {
    expect(await isBlockedHost("169.254.1.1")).toBe(true);
  });

  it("blocks IPv6 loopback ::1", async () => {
    expect(await isBlockedHost("::1")).toBe(true);
  });

  it("does not block a public IP (8.8.8.8)", async () => {
    expect(await isBlockedHost("8.8.8.8")).toBe(false);
  });

  it("does not block 1.1.1.1 (public Cloudflare DNS)", async () => {
    expect(await isBlockedHost("1.1.1.1")).toBe(false);
  });
});

// ── Tool input validation ──────────────────────────────────────────────────────

describe("web_fetch — input validation", () => {
  it("returns error for empty url", async () => {
    const r = await webFetchTool.execute({ url: "" }, "/tmp");
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/url must be a non-empty string/);
  });

  it("returns error when url is not a string", async () => {
    const r = await webFetchTool.execute({ url: 42 }, "/tmp");
    expect(r.isError).toBe(true);
  });

  it("returns error for invalid URL syntax", async () => {
    const r = await webFetchTool.execute({ url: "not a url" }, "/tmp");
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/Invalid URL/);
  });

  it("returns error for non-http scheme (ftp://)", async () => {
    const r = await webFetchTool.execute({ url: "ftp://example.com/file" }, "/tmp");
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/Unsupported URL scheme/);
  });

  it("returns error for file:// scheme", async () => {
    const r = await webFetchTool.execute({ url: "file:///etc/passwd" }, "/tmp");
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/Unsupported URL scheme/);
  });

  it("returns error for unsupported HTTP method", async () => {
    const r = await webFetchTool.execute({ url: "https://example.com", method: "TRACE" }, "/tmp");
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/Unsupported HTTP method/);
  });
});

// ── SSRF blocking ─────────────────────────────────────────────────────────────

describe("web_fetch — SSRF blocking", () => {
  it("blocks requests to 127.0.0.1", async () => {
    const r = await webFetchTool.execute({ url: "http://127.0.0.1/secret" }, "/tmp");
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/SSRF blocked/);
  });

  it("blocks requests to 10.x.x.x", async () => {
    const r = await webFetchTool.execute({ url: "http://10.0.0.1/internal" }, "/tmp");
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/SSRF blocked/);
  });

  it("blocks requests to 192.168.x.x", async () => {
    const r = await webFetchTool.execute({ url: "http://192.168.1.100/api" }, "/tmp");
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/SSRF blocked/);
  });

  it("blocks requests to link-local 169.254.x.x (AWS IMDS)", async () => {
    const r = await webFetchTool.execute({ url: "http://169.254.169.254/latest/meta-data/" }, "/tmp");
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/SSRF blocked/);
  });

  it("allows private IP when allowPrivateUrls context is set", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      url: "http://10.0.0.1/health",
      headers: { get: () => "text/plain" },
      text: async () => "OK",
    }));

    const r = await webFetchTool.execute(
      { url: "http://10.0.0.1/health" },
      "/tmp",
      undefined,
      { allowPrivateUrls: true },
    );
    expect(r.isError).toBe(false);
    expect(r.content).toContain("OK");
    vi.unstubAllGlobals();
  });
});

// ── Successful fetch ───────────────────────────────────────────────────────────

function mockFetch(body: string, contentType = "text/plain", status = 200) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    url: "https://example.com/page",
    headers: { get: (h: string) => h === "content-type" ? contentType : null },
    text: async () => body,
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("web_fetch — plain text response", () => {
  it("returns body content for a plain text response", async () => {
    mockFetch("Hello, world!");
    const r = await webFetchTool.execute({ url: "https://example.com/data" }, "/tmp");
    expect(r.isError).toBe(false);
    expect(r.content).toContain("Hello, world!");
  });

  it("truncates response at max_chars", async () => {
    mockFetch("a".repeat(200));
    const r = await webFetchTool.execute(
      { url: "https://example.com/data", max_chars: 50 },
      "/tmp",
    );
    expect(r.isError).toBe(false);
    expect(r.content).toContain("truncated at 50 chars");
    // Actual content before note should be 50 chars
    const bodyPart = r.content.split("\n[")[0];
    expect(bodyPart.length).toBe(50);
  });

  it("does not truncate when response fits within max_chars", async () => {
    mockFetch("short response");
    const r = await webFetchTool.execute({ url: "https://example.com/data" }, "/tmp");
    expect(r.content).not.toContain("truncated");
  });
});

describe("web_fetch — HTML conversion", () => {
  it("strips HTML tags for text/html responses", async () => {
    mockFetch("<html><body><h1>Title</h1><p>Content here.</p></body></html>", "text/html");
    const r = await webFetchTool.execute({ url: "https://example.com/page" }, "/tmp");
    expect(r.isError).toBe(false);
    expect(r.content).toContain("Title");
    expect(r.content).toContain("Content here.");
    expect(r.content).not.toContain("<h1>");
    expect(r.content).not.toContain("<p>");
  });

  it("raw=true skips HTML-to-text conversion", async () => {
    mockFetch("<h1>Raw HTML</h1>", "text/html");
    const r = await webFetchTool.execute(
      { url: "https://example.com/page", raw: true },
      "/tmp",
    );
    expect(r.isError).toBe(false);
    expect(r.content).toContain("<h1>Raw HTML</h1>");
  });

  it("decodes &quot; HTML entity in text/html response", async () => {
    mockFetch("<p>&quot;quoted text&quot;</p>", "text/html");
    const r = await webFetchTool.execute({ url: "https://example.com/page" }, "/tmp");
    expect(r.content).toContain('"quoted text"');
  });

  it("does not reconstruct angle brackets from entities", async () => {
    // &#60; is < and &#62; is > — should be stripped, not rendered
    mockFetch("<p>&#60;script&#62;alert(1)&#60;/script&#62;</p>", "text/html");
    const r = await webFetchTool.execute({ url: "https://example.com/page" }, "/tmp");
    expect(r.content).not.toContain("<script>");
    expect(r.content).not.toContain("</script>");
  });
});

describe("web_fetch — HTTP errors", () => {
  it("returns isError=true for 404 response", async () => {
    mockFetch("Not Found", "text/plain", 404);
    const r = await webFetchTool.execute({ url: "https://example.com/missing" }, "/tmp");
    expect(r.isError).toBe(true);
    expect(r.content).toContain("404");
  });

  it("returns isError=true for 500 response", async () => {
    mockFetch("Internal Server Error", "text/plain", 500);
    const r = await webFetchTool.execute({ url: "https://example.com/broken" }, "/tmp");
    expect(r.isError).toBe(true);
    expect(r.content).toContain("500");
  });
});

describe("web_fetch — method and headers", () => {
  it("passes custom headers to fetch", async () => {
    const mockFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      url: "https://api.example.com",
      headers: { get: () => "application/json" },
      text: async () => '{"ok":true}',
    });
    vi.stubGlobal("fetch", mockFn);

    await webFetchTool.execute(
      {
        url: "https://api.example.com",
        method: "POST",
        body: '{"key":"value"}',
        headers: { Authorization: "Bearer token123", "Content-Type": "application/json" },
      },
      "/tmp",
    );

    const [calledUrl, calledOpts] = mockFn.mock.calls[0];
    expect(calledUrl).toBe("https://api.example.com");
    expect((calledOpts as RequestInit).method).toBe("POST");
    expect((calledOpts as RequestInit & { headers: Record<string, string> }).headers["Authorization"]).toBe("Bearer token123");
  });

  it("method is case-normalised to uppercase", async () => {
    const mockFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      url: "https://example.com",
      headers: { get: () => "text/plain" },
      text: async () => "ok",
    });
    vi.stubGlobal("fetch", mockFn);

    await webFetchTool.execute({ url: "https://example.com", method: "get" }, "/tmp");
    const [, opts] = mockFn.mock.calls[0];
    expect((opts as RequestInit).method).toBe("GET");
  });
});
