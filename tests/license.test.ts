/**
 * license.test.ts — Tests for Ed25519 license key verification.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  getLicenseInfo,
  getLicenseTier,
  isProOrAbove,
  isCloud,
  activateLicense,
  deactivateLicense,
  _resetForTesting,
} from "../src/license.js";

// A valid Pro key signed with the embedded public key's corresponding private key.
// Generated via: bun run scripts/sign-license.ts --tier pro --seat test@orager.dev --exp 2027-01-01
const VALID_PRO_KEY =
  "eyJ0aWVyIjoicHJvIiwic2VhdCI6InRlc3RAb3JhZ2VyLmRldiIsImV4cCI6IjIwMjctMDEtMDEifQ==.4UVDOVi16EBK53vFlXOYI4vg4fY0nGw8GLPZN8u0UZ00u3nx+k4kWPug44edQtIkPYF4iZY/+7y/sVPHFUrRBQ==";

describe("license", () => {
  beforeEach(() => {
    _resetForTesting();
    delete process.env["ORAGER_LICENSE_KEY"];
  });

  afterEach(() => {
    _resetForTesting();
    delete process.env["ORAGER_LICENSE_KEY"];
    deactivateLicense();
  });

  it("returns free tier when no key is set", () => {
    const info = getLicenseInfo();
    expect(info.tier).toBe("free");
    expect(info.valid).toBe(false);
    expect(info.reason).toBe("no license key");
    expect(getLicenseTier()).toBe("free");
    expect(isProOrAbove()).toBe(false);
    expect(isCloud()).toBe(false);
  });

  it("validates a correct Pro key from env", () => {
    process.env["ORAGER_LICENSE_KEY"] = VALID_PRO_KEY;
    const info = getLicenseInfo();
    expect(info.tier).toBe("pro");
    expect(info.valid).toBe(true);
    expect(info.seat).toBe("test@orager.dev");
    expect(info.exp).toBe("2027-01-01");
    expect(isProOrAbove()).toBe(true);
    expect(isCloud()).toBe(false);
  });

  it("rejects a tampered payload", () => {
    process.env["ORAGER_LICENSE_KEY"] = VALID_PRO_KEY.replace("cHJv", "xxxx");
    const info = getLicenseInfo();
    expect(info.tier).toBe("free");
    expect(info.valid).toBe(false);
  });

  it("rejects a tampered signature", () => {
    const [payload] = VALID_PRO_KEY.split(".");
    process.env["ORAGER_LICENSE_KEY"] = `${payload}.AAAAAAAAAAAAAAAAAAAAAA==`;
    const info = getLicenseInfo();
    expect(info.tier).toBe("free");
    expect(info.valid).toBe(false);
    expect(info.reason).toBe("invalid signature");
  });

  it("rejects a key without a dot separator", () => {
    process.env["ORAGER_LICENSE_KEY"] = "nodothere";
    const info = getLicenseInfo();
    expect(info.tier).toBe("free");
    expect(info.valid).toBe(false);
    expect(info.reason).toBe("invalid key format");
  });

  it("rejects a key with invalid base64 payload", () => {
    process.env["ORAGER_LICENSE_KEY"] = "!!!notbase64!!!.AAAA";
    const info = getLicenseInfo();
    expect(info.tier).toBe("free");
    expect(info.valid).toBe(false);
  });

  it("caches the result for the process lifetime", () => {
    process.env["ORAGER_LICENSE_KEY"] = VALID_PRO_KEY;
    const first = getLicenseInfo();
    expect(first.tier).toBe("pro");

    // Change env — should NOT affect cached result
    process.env["ORAGER_LICENSE_KEY"] = "garbage";
    const second = getLicenseInfo();
    expect(second.tier).toBe("pro");
    expect(second).toBe(first); // same object reference
  });

  it("activateLicense writes and validates", () => {
    const info = activateLicense(VALID_PRO_KEY);
    expect(info.tier).toBe("pro");
    expect(info.valid).toBe(true);

    // Verify it persists by resetting cache and reading from file
    _resetForTesting();
    delete process.env["ORAGER_LICENSE_KEY"];
    const fromFile = getLicenseInfo();
    expect(fromFile.tier).toBe("pro");
    expect(fromFile.valid).toBe(true);
  });

  it("deactivateLicense resets to free", () => {
    activateLicense(VALID_PRO_KEY);
    expect(getLicenseTier()).toBe("pro");

    deactivateLicense();
    expect(getLicenseTier()).toBe("free");
  });

  it("activateLicense with invalid key saves but reports invalid", () => {
    const info = activateLicense("bad.key");
    expect(info.valid).toBe(false);
    expect(info.tier).toBe("free");
  });
});
