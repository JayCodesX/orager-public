/**
 * Regression tests for webhook SSRF guard.
 *
 * Covers isPrivateIp() and isWebhookUrlSafe() — the two functions that
 * prevent the agent from being used as an SSRF proxy via webhookUrl.
 *
 * isWebhookUrlSafe() resolves DNS to catch rebinding attacks; DNS is mocked
 * here so these tests are deterministic and require no network access.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { isPrivateIp, isWebhookUrlSafe } from "../../src/loop.js";

// ── isPrivateIp ───────────────────────────────────────────────────────────────

describe("isPrivateIp", () => {
  it.each([
    ["127.0.0.1",        true],
    ["127.0.0.2",        true],  // full 127/8 loopback range
    ["::1",              true],  // IPv6 loopback
    ["0.0.0.0",          true],
    ["10.0.0.1",         true],  // RFC-1918 class A
    ["10.255.255.255",   true],
    ["172.16.0.1",       true],  // RFC-1918 class B lower bound
    ["172.31.255.255",   true],  // RFC-1918 class B upper bound
    ["172.15.255.255",   false], // just below RFC-1918 class B
    ["172.32.0.0",       false], // just above RFC-1918 class B
    ["192.168.0.1",      true],  // RFC-1918 class C
    ["192.168.255.255",  true],
    ["169.254.1.1",      true],  // link-local
    ["::ffff:127.0.0.1", true],  // IPv4-mapped loopback
    ["fe80::1",          true],  // IPv6 link-local
    ["ff02::1",          true],  // IPv6 multicast
    ["224.0.0.1",        true],  // IPv4 multicast
    ["239.255.255.255",  true],  // IPv4 multicast upper bound
    ["8.8.8.8",          false], // public DNS — must NOT block
    ["1.1.1.1",          false], // public DNS — must NOT block
    ["93.184.216.34",    false], // example.com — must NOT block
    ["192.169.0.1",      false], // looks like 192.168 but isn't
  ])("isPrivateIp(%s) → %s", (ip, expected) => {
    expect(isPrivateIp(ip)).toBe(expected);
  });
});

// ── isWebhookUrlSafe ─────────────────────────────────────────────────────────

// Mock dns so DNS resolution is deterministic and offline
vi.mock("node:dns", () => ({
  promises: {
    lookup: vi.fn(),
  },
}));

const { promises: dns } = await import("node:dns");

function mockDnsResolve(address: string) {
  (dns.lookup as ReturnType<typeof vi.fn>).mockResolvedValue({ address, family: 4 });
}

function mockDnsFail() {
  (dns.lookup as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("ENOTFOUND"));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("isWebhookUrlSafe — scheme validation", () => {
  it("accepts https:// URLs", async () => {
    mockDnsResolve("93.184.216.34");
    expect(await isWebhookUrlSafe("https://example.com/hook")).toBe(true);
  });

  it("accepts http:// URLs", async () => {
    mockDnsResolve("93.184.216.34");
    expect(await isWebhookUrlSafe("http://example.com/hook")).toBe(true);
  });

  it("rejects ftp:// URLs", async () => {
    expect(await isWebhookUrlSafe("ftp://example.com/hook")).toBe(false);
  });

  it("rejects javascript: URLs", async () => {
    expect(await isWebhookUrlSafe("javascript:alert(1)")).toBe(false);
  });

  it("rejects file:// URLs", async () => {
    expect(await isWebhookUrlSafe("file:///etc/passwd")).toBe(false);
  });

  it("rejects undefined", async () => {
    expect(await isWebhookUrlSafe(undefined)).toBe(false);
  });

  it("rejects empty string", async () => {
    expect(await isWebhookUrlSafe("")).toBe(false);
  });

  it("rejects malformed URLs", async () => {
    expect(await isWebhookUrlSafe("not a url")).toBe(false);
  });
});

describe("isWebhookUrlSafe — direct private IP in URL", () => {
  it("blocks 127.0.0.1", async () => {
    expect(await isWebhookUrlSafe("http://127.0.0.1/hook")).toBe(false);
  });

  it("blocks localhost hostname", async () => {
    expect(await isWebhookUrlSafe("http://localhost/hook")).toBe(false);
  });

  it("blocks 10.x private range", async () => {
    expect(await isWebhookUrlSafe("http://10.0.0.1/hook")).toBe(false);
  });

  it("blocks 192.168.x private range", async () => {
    expect(await isWebhookUrlSafe("http://192.168.1.1/hook")).toBe(false);
  });

  it("blocks 172.16–31 private range", async () => {
    expect(await isWebhookUrlSafe("http://172.16.0.1/hook")).toBe(false);
  });
});

describe("isWebhookUrlSafe — DNS rebinding prevention", () => {
  it("blocks public hostname that resolves to private IP (rebinding)", async () => {
    // Attacker registers evil.example.com → 192.168.1.1
    mockDnsResolve("192.168.1.1");
    expect(await isWebhookUrlSafe("https://evil.example.com/hook")).toBe(false);
  });

  it("blocks hostname resolving to loopback", async () => {
    mockDnsResolve("127.0.0.1");
    expect(await isWebhookUrlSafe("https://legit-looking.com/hook")).toBe(false);
  });

  it("rejects when DNS resolution fails (safe-fail)", async () => {
    mockDnsFail();
    expect(await isWebhookUrlSafe("https://unknown-host.example/hook")).toBe(false);
  });

  it("allows hostname that resolves to a public IP", async () => {
    mockDnsResolve("93.184.216.34");
    expect(await isWebhookUrlSafe("https://hooks.example.com/notify")).toBe(true);
  });
});
