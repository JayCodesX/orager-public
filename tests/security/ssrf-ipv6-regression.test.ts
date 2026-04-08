/**
 * Security regression tests: IPv4-mapped IPv6 SSRF bypass vectors.
 *
 * These tests verify that all forms of IPv4-embedded IPv6 addresses
 * are correctly identified as private/blocked, preventing SSRF attacks
 * via IPv6 notation tricks.
 */

import { describe, it, expect } from "vitest";
import { isBlockedHost } from "../../src/tools/web-fetch.js";
import { isPrivateIp } from "../../src/loop.js";

// ── isBlockedHost (web-fetch.ts) — full extractMappedIPv4 coverage ───────────

describe("isBlockedHost — IPv4-mapped IPv6 bypass vectors", () => {
  const blocked: [string, string][] = [
    // Loopback (127.0.0.1)
    ["::ffff:127.0.0.1", "compressed dotted-decimal loopback"],
    ["::ffff:7f00:1", "compressed hex loopback"],
    ["0:0:0:0:0:ffff:127.0.0.1", "expanded dotted-decimal loopback"],
    ["0:0:0:0:0:ffff:7f00:1", "expanded hex loopback"],
    ["::ffff:0:127.0.0.1", "SIIT prefix dotted-decimal loopback"],
    ["::ffff:0:7f00:1", "SIIT prefix hex loopback"],
    // RFC1918 class A (10.x)
    ["::ffff:10.0.0.1", "mapped 10.0.0.1"],
    ["::ffff:a00:1", "hex mapped 10.0.0.1"],
    ["0:0:0:0:0:ffff:10.0.0.1", "expanded 10.0.0.1"],
    // RFC1918 class C (192.168.x)
    ["::ffff:192.168.1.1", "mapped 192.168.1.1"],
    ["::ffff:c0a8:101", "hex mapped 192.168.1.1"],
    ["0:0:0:0:0:ffff:192.168.1.1", "expanded 192.168.1.1"],
    // AWS IMDS (169.254.169.254)
    ["::ffff:169.254.169.254", "mapped IMDS"],
    ["::ffff:a9fe:a9fe", "hex mapped IMDS"],
    ["0:0:0:0:0:ffff:169.254.169.254", "expanded IMDS"],
    // Native IPv6 private ranges
    ["::1", "loopback"],
    ["fe80::1", "link-local"],
    ["fd00::1", "ULA fd"],
    ["fc00::1", "ULA fc"],
  ];

  it.each(blocked)("blocks %s (%s)", async (ip) => {
    expect(await isBlockedHost(ip)).toBe(true);
  });

  const allowed: [string, string][] = [
    ["::ffff:8.8.8.8", "mapped Google DNS"],
    ["::ffff:808:808", "hex mapped Google DNS"],
    ["2001:4860:4860::8888", "native Google public IPv6"],
    ["::ffff:1.1.1.1", "mapped Cloudflare"],
  ];

  it.each(allowed)("allows %s (%s)", async (ip) => {
    expect(await isBlockedHost(ip)).toBe(false);
  });
});

// ── isPrivateIp (loop.ts) — webhook SSRF guard ──────────────────────────────

describe("isPrivateIp (loop.ts) — IPv4-mapped IPv6 bypass vectors", () => {
  it.each([
    // Basic IPv4
    ["127.0.0.1", true, "plain loopback"],
    ["10.0.0.1", true, "plain RFC1918 class A"],
    ["192.168.1.1", true, "plain RFC1918 class C"],
    ["169.254.169.254", true, "plain IMDS"],
    ["8.8.8.8", false, "plain public IPv4"],
    // Native IPv6
    ["::1", true, "native loopback"],
    ["fe80::1", true, "link-local"],
    ["fd00::1", true, "ULA fd"],
    ["fc00::1", true, "ULA fc"],
    ["ff02::1", true, "multicast"],
    // IPv4-mapped compressed
    ["::ffff:127.0.0.1", true, "compressed dotted-decimal loopback"],
    ["::ffff:7f00:1", true, "compressed hex loopback"],
    ["::ffff:10.0.0.1", true, "mapped RFC1918 class A"],
    ["::ffff:a00:1", true, "hex mapped RFC1918 class A"],
    ["::ffff:192.168.1.1", true, "mapped RFC1918 class C"],
    ["::ffff:c0a8:101", true, "hex mapped RFC1918 class C"],
    ["::ffff:169.254.169.254", true, "mapped AWS IMDS"],
    ["::ffff:a9fe:a9fe", true, "hex mapped AWS IMDS"],
    // IPv4-mapped expanded
    ["0:0:0:0:0:ffff:127.0.0.1", true, "expanded dotted-decimal loopback"],
    ["0:0:0:0:0:ffff:7f00:1", true, "expanded hex loopback"],
    // SIIT prefix (RFC 6145)
    ["::ffff:0:127.0.0.1", true, "SIIT prefix loopback"],
    // Public mapped (must NOT block)
    ["::ffff:8.8.8.8", false, "mapped public DNS"],
    ["::ffff:1.1.1.1", false, "mapped Cloudflare"],
    ["::ffff:808:808", false, "hex mapped Google DNS"],
    ["2001:4860:4860::8888", false, "native Google public IPv6"],
  ] as const)("isPrivateIp(%s) -> %s (%s)", (ip, expected) => {
    expect(isPrivateIp(ip)).toBe(expected);
  });
});
