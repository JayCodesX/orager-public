/**
 * license.ts — Ed25519 license key verification for orager Pro/Cloud tiers.
 *
 * Key format:  base64(JSON payload) + "." + base64(Ed25519 signature)
 * Payload:     { tier: "pro"|"cloud", exp: "2027-01-01", seat: "user@email" }
 *
 * The public verification key is embedded in the binary.  The private signing
 * key lives only on the developer's machine (see scripts/sign-license.ts).
 *
 * Resolution order:
 *   1. ORAGER_LICENSE_KEY environment variable
 *   2. ~/.orager/license.json  →  { "key": "..." }
 *
 * If no key is found or the key is invalid/expired, the tier falls back to
 * "free" and the agent works normally — OMLS features simply stay disabled.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ── Types ────────────────────────────────────────────────────────────────────

export type LicenseTier = "free" | "pro" | "cloud";

export interface LicenseInfo {
  tier: LicenseTier;
  seat: string;
  exp: string;
  valid: boolean;
  reason?: string;
}

// ── Embedded public key (Ed25519 SPKI DER, base64) ───────────────────────────

const PUBLIC_KEY_B64 = "MCowBQYDK2VwAyEA87cxnvPBFg2QRMuVoUUf8M7NhTQUO5OV7+rs7k7cCSg=";

// ── Cache ────────────────────────────────────────────────────────────────────

let _cached: LicenseInfo | null = null;

// ── Helpers ──────────────────────────────────────────────────────────────────

function readKeyFromEnv(): string | null {
  const key = (process.env["ORAGER_LICENSE_KEY"] ?? "").trim();
  return key || null;
}

function readKeyFromFile(): string | null {
  try {
    const filePath = path.join(os.homedir(), ".orager", "license.json");
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    const key = (typeof parsed?.key === "string" ? parsed.key : "").trim();
    return key || null;
  } catch {
    return null;
  }
}

function resolveKey(): string | null {
  return readKeyFromEnv() ?? readKeyFromFile();
}

function verifyLicense(key: string): LicenseInfo {
  // Split into payload and signature
  const dotIdx = key.indexOf(".");
  if (dotIdx === -1) {
    return { tier: "free", seat: "", exp: "", valid: false, reason: "invalid key format" };
  }

  const payloadB64 = key.slice(0, dotIdx);
  const sigB64 = key.slice(dotIdx + 1);

  // Decode and parse payload
  let payload: { tier?: string; exp?: string; seat?: string };
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64").toString("utf8"));
  } catch {
    return { tier: "free", seat: "", exp: "", valid: false, reason: "invalid payload" };
  }

  // Verify Ed25519 signature
  try {
    const publicKey = crypto.createPublicKey({
      key: Buffer.from(PUBLIC_KEY_B64, "base64"),
      format: "der",
      type: "spki",
    });

    const valid = crypto.verify(
      null, // Ed25519 doesn't use a separate hash algorithm
      Buffer.from(payloadB64),
      publicKey,
      Buffer.from(sigB64, "base64"),
    );

    if (!valid) {
      return { tier: "free", seat: "", exp: "", valid: false, reason: "invalid signature" };
    }
  } catch {
    return { tier: "free", seat: "", exp: "", valid: false, reason: "signature verification failed" };
  }

  // Check expiry
  const exp = payload.exp ?? "";
  if (exp) {
    try {
      if (new Date(exp) < new Date()) {
        return {
          tier: "free",
          seat: payload.seat ?? "",
          exp,
          valid: false,
          reason: "license expired",
        };
      }
    } catch {
      // If date is unparseable, treat as unexpired
    }
  }

  // Validate tier
  const tier = payload.tier;
  if (tier !== "pro" && tier !== "cloud") {
    return { tier: "free", seat: payload.seat ?? "", exp, valid: false, reason: "unknown tier" };
  }

  return {
    tier,
    seat: payload.seat ?? "",
    exp,
    valid: true,
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Get full license information. Cached for the process lifetime.
 */
export function getLicenseInfo(): LicenseInfo {
  if (_cached) return _cached;

  const key = resolveKey();
  if (!key) {
    _cached = { tier: "free", seat: "", exp: "", valid: false, reason: "no license key" };
    return _cached;
  }

  _cached = verifyLicense(key);
  return _cached;
}

/**
 * Get the current license tier ("free", "pro", or "cloud").
 */
export function getLicenseTier(): LicenseTier {
  return getLicenseInfo().tier;
}

/**
 * Returns true if the license tier is "pro" or "cloud".
 */
export function isProOrAbove(): boolean {
  const tier = getLicenseTier();
  return tier === "pro" || tier === "cloud";
}

/**
 * Returns true if the license tier is "cloud".
 */
export function isCloud(): boolean {
  return getLicenseTier() === "cloud";
}

/**
 * Write a license key to ~/.orager/license.json.
 */
export function activateLicense(key: string): LicenseInfo {
  // Verify first
  const info = verifyLicense(key);

  // Write regardless (so user can inspect why it failed)
  const dir = path.join(os.homedir(), ".orager");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, "license.json");
  fs.writeFileSync(filePath, JSON.stringify({ key }, null, 2) + "\n", { mode: 0o600 });

  // Update cache
  _cached = info;
  return info;
}

/**
 * Remove the license key file and reset cache to free tier.
 */
export function deactivateLicense(): void {
  try {
    const filePath = path.join(os.homedir(), ".orager", "license.json");
    fs.unlinkSync(filePath);
  } catch {
    // File doesn't exist — fine
  }
  _cached = { tier: "free", seat: "", exp: "", valid: false, reason: "deactivated" };
}

/**
 * Reset the cached license info (useful for testing).
 */
export function _resetForTesting(): void {
  _cached = null;
}
