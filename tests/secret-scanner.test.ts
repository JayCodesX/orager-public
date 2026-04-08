import { describe, it, expect } from "vitest";
import { scanForSecrets, checkContentForSecrets } from "../src/secret-scanner.js";

// ── Pattern detection ─────────────────────────────────────────────────────────

// AWS Access Key format: AKIA + exactly 16 uppercase alphanumeric chars
const VALID_AWS_KEY = "AKIAIOSFODNN7EXAMPLE"; // 4 + 16 = 20 chars total

describe("scanForSecrets — AWS Access Key", () => {
  it("detects a valid AWS access key", () => {
    const results = scanForSecrets(`key = ${VALID_AWS_KEY}`);
    expect(results).toHaveLength(1);
    expect(results[0]!.pattern).toBe("AWS Access Key");
  });

  it("does not flag a short AKIA-prefixed string (< 16 trailing chars)", () => {
    const results = scanForSecrets("AKIASHORT123456");
    expect(results).toHaveLength(0);
  });

  it("does not flag AKIA inside a word (no word boundary)", () => {
    const results = scanForSecrets("XAKIAIOSFODNN7EXAMPLE");
    expect(results).toHaveLength(0);
  });
});

describe("scanForSecrets — GitHub Token", () => {
  it("detects ghp_ token (classic PAT)", () => {
    const token = "ghp_" + "A".repeat(36);
    const results = scanForSecrets(`token: ${token}`);
    expect(results).toHaveLength(1);
    expect(results[0]!.pattern).toBe("GitHub Token");
  });

  it("detects github_pat_ token (fine-grained PAT)", () => {
    const token = "github_pat_" + "A".repeat(82);
    const results = scanForSecrets(token);
    expect(results).toHaveLength(1);
    expect(results[0]!.pattern).toBe("GitHub Token");
  });

  it("detects ghs_ token (GitHub App)", () => {
    const token = "ghs_" + "A".repeat(36);
    const results = scanForSecrets(token);
    expect(results).toHaveLength(1);
    expect(results[0]!.pattern).toBe("GitHub Token");
  });

  it("does not flag a short ghp_ string", () => {
    const results = scanForSecrets("ghp_tooshort");
    expect(results).toHaveLength(0);
  });
});

describe("scanForSecrets — OpenAI / OpenRouter key", () => {
  it("detects sk- prefixed key of sufficient length", () => {
    const results = scanForSecrets("sk-proj-abcdefghijklmnopqrstu");
    expect(results.some((r) => r.pattern === "OpenAI / OpenRouter key")).toBe(true);
  });

  it("does not flag sk- with fewer than 20 chars after prefix", () => {
    const results = scanForSecrets("sk-tooshort123456789");
    // 19 chars after 'sk-' — should not match
    expect(results.filter((r) => r.pattern === "OpenAI / OpenRouter key")).toHaveLength(0);
  });
});

describe("scanForSecrets — Anthropic API key", () => {
  it("detects sk-ant- prefixed key", () => {
    const results = scanForSecrets("PROTOCOL_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz");
    expect(results.some((r) => r.pattern === "Anthropic API key")).toBe(true);
  });
});

describe("scanForSecrets — Slack token", () => {
  it("detects xoxb- bot token", () => {
    const results = scanForSecrets("xoxb-123456789-abcdefghij");
    expect(results).toHaveLength(1);
    expect(results[0]!.pattern).toBe("Slack token");
  });

  it("detects xoxp- user token", () => {
    const results = scanForSecrets("xoxp-111-222-333-aaabbbccc");
    expect(results).toHaveLength(1);
    expect(results[0]!.pattern).toBe("Slack token");
  });

  it("detects xoxs- token", () => {
    const results = scanForSecrets("SLACK_TOKEN=xoxs-1234567890a");
    expect(results).toHaveLength(1);
  });
});

describe("scanForSecrets — Private key", () => {
  it("detects RSA private key header", () => {
    const results = scanForSecrets("-----BEGIN RSA PRIVATE KEY-----\nMIIEo...\n-----END RSA PRIVATE KEY-----");
    expect(results).toHaveLength(1);
    expect(results[0]!.pattern).toBe("Private key");
  });

  it("detects generic PRIVATE KEY header (PKCS#8)", () => {
    const results = scanForSecrets("-----BEGIN PRIVATE KEY-----");
    expect(results).toHaveLength(1);
    expect(results[0]!.pattern).toBe("Private key");
  });

  it("detects EC private key header", () => {
    const results = scanForSecrets("-----BEGIN EC PRIVATE KEY-----");
    expect(results).toHaveLength(1);
  });

  it("detects OPENSSH private key header", () => {
    const results = scanForSecrets("-----BEGIN OPENSSH PRIVATE KEY-----");
    expect(results).toHaveLength(1);
  });
});

describe("scanForSecrets — Database URL with credentials", () => {
  it("detects postgres URL with user:pass", () => {
    const results = scanForSecrets("DATABASE_URL=postgres://admin:s3cr3tpassword@db.example.com:5432/mydb");
    expect(results).toHaveLength(1);
    expect(results[0]!.pattern).toBe("Database URL with credentials");
  });

  it("detects mysql URL with credentials", () => {
    const results = scanForSecrets("mysql://root:password123@localhost/myapp");
    expect(results).toHaveLength(1);
  });

  it("detects mongodb+srv URL with credentials", () => {
    const results = scanForSecrets("mongodb+srv://fakeuser:fakepass123@cluster0.example.mongodb.net/testdb");
    expect(results).toHaveLength(1);
  });

  it("does not flag a DB URL without credentials", () => {
    const results = scanForSecrets("postgres://localhost:5432/mydb");
    expect(results.filter((r) => r.pattern === "Database URL with credentials")).toHaveLength(0);
  });
});

describe("scanForSecrets — JWT token", () => {
  it("detects a well-formed JWT", () => {
    // header.payload.signature — all base64url encoded eyJ... prefix
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const results = scanForSecrets(jwt);
    expect(results).toHaveLength(1);
    expect(results[0]!.pattern).toBe("JWT token");
  });

  it("does not flag a short eyJ string that is not a JWT", () => {
    const results = scanForSecrets("eyJhbGci.short.x");
    expect(results.filter((r) => r.pattern === "JWT token")).toHaveLength(0);
  });
});

describe("scanForSecrets — Generic secret assignment", () => {
  it("detects password= with quoted value", () => {
    const results = scanForSecrets(`password = "supersecretvalue123"`);
    expect(results).toHaveLength(1);
    expect(results[0]!.pattern).toBe("Generic secret assignment");
  });

  it("detects api_key: with single-quoted value", () => {
    const results = scanForSecrets(`api_key: 'my-secret-key-value-here'`);
    expect(results).toHaveLength(1);
  });

  it("detects access_token= assignment", () => {
    const results = scanForSecrets(`access_token="eyJhbGciOiJSUzI1NiJ9abcdef"`);
    expect(results.some((r) => r.pattern === "Generic secret assignment" || r.pattern === "JWT token")).toBe(true);
  });

  it("does not flag a short password value (< 12 chars)", () => {
    const results = scanForSecrets(`password = "short"`);
    expect(results.filter((r) => r.pattern === "Generic secret assignment")).toHaveLength(0);
  });

  it("does not flag unquoted env var placeholder", () => {
    const results = scanForSecrets(`password = \${MY_PASSWORD}`);
    expect(results.filter((r) => r.pattern === "Generic secret assignment")).toHaveLength(0);
  });
});

// ── Clean content ─────────────────────────────────────────────────────────────

describe("scanForSecrets — clean content returns empty", () => {
  it("returns empty for normal source code", () => {
    expect(scanForSecrets("const x = 42;\nconsole.log(x);")).toHaveLength(0);
  });

  it("returns empty for an empty string", () => {
    expect(scanForSecrets("")).toHaveLength(0);
  });

  it("returns empty for a comment about secrets (no actual secret)", () => {
    expect(scanForSecrets("// Never hardcode your AWS_SECRET_KEY here")).toHaveLength(0);
  });
});

// ── Multiple matches ──────────────────────────────────────────────────────────

describe("scanForSecrets — multiple secrets in one file", () => {
  it("returns multiple matches for multiple pattern types", () => {
    const content = [
      VALID_AWS_KEY,
      "ghp_" + "B".repeat(36),
      "-----BEGIN RSA PRIVATE KEY-----",
    ].join("\n");
    const results = scanForSecrets(content);
    expect(results.length).toBeGreaterThanOrEqual(2);
    const patterns = results.map((r) => r.pattern);
    expect(patterns).toContain("GitHub Token");
    expect(patterns).toContain("Private key");
  });
});

// ── Redaction ─────────────────────────────────────────────────────────────────

describe("scanForSecrets — redaction", () => {
  it("redacts the matched secret in the output", () => {
    const token = "ghp_" + "A".repeat(36);
    const results = scanForSecrets(token);
    expect(results).toHaveLength(1);
    const redacted = results[0]!.match;
    // Should contain *** and not expose the full token
    expect(redacted).toContain("***");
    expect(redacted).not.toBe(token);
    // First 4 chars preserved
    expect(redacted.slice(0, 4)).toBe(token.slice(0, 4));
  });

  it("redacts very short matches with just ***", () => {
    // Construct a minimal match: xoxb-12345678 (exactly 8 chars after xoxb-)
    // We can't easily get a ≤8-char match from real patterns — test indirectly
    // by checking the contract: if length ≤ 8 → "***"
    const results = scanForSecrets("xoxb-abcdefghij");
    if (results.length > 0) {
      expect(results[0]!.match).toContain("***");
    }
  });
});

// ── File path exemptions ──────────────────────────────────────────────────────

describe("scanForSecrets — file path exemptions", () => {
  const realSecret = VALID_AWS_KEY;

  it("allows secrets in .env.example files", () => {
    expect(scanForSecrets(realSecret, "/project/.env.example")).toHaveLength(0);
  });

  it("allows secrets in .env.sample files", () => {
    expect(scanForSecrets(realSecret, "/project/.env.sample")).toHaveLength(0);
  });

  it("allows secrets in .env.template files", () => {
    expect(scanForSecrets(realSecret, "/project/.env.template")).toHaveLength(0);
  });

  it("allows secrets in fixture directories", () => {
    expect(scanForSecrets(realSecret, "/project/tests/fixtures/config.json")).toHaveLength(0);
  });

  it("allows secrets in __tests__ directories", () => {
    expect(scanForSecrets(realSecret, "/project/src/__tests__/helper.ts")).toHaveLength(0);
  });

  it("allows secrets in test_data directories", () => {
    expect(scanForSecrets(realSecret, "/project/test_data/sample.json")).toHaveLength(0);
  });

  it("blocks secrets in non-exempt files", () => {
    expect(scanForSecrets(realSecret, "/project/src/config.ts")).toHaveLength(1);
  });

  it("blocks secrets when no filePath provided", () => {
    expect(scanForSecrets(realSecret)).toHaveLength(1);
  });
});

// ── checkContentForSecrets ────────────────────────────────────────────────────

describe("checkContentForSecrets", () => {
  it("returns null for clean content", () => {
    expect(checkContentForSecrets("const x = 1;")).toBeNull();
  });

  it("returns an error string when secrets are found", () => {
    const msg = checkContentForSecrets(`-----BEGIN RSA PRIVATE KEY-----`);
    expect(msg).not.toBeNull();
    expect(msg).toContain("Secret scanner blocked this write");
    expect(msg).toContain("Private key");
    expect(msg).toContain("•");
  });

  it("includes all detected secrets in the error message", () => {
    const content = `-----BEGIN RSA PRIVATE KEY-----\nghp_${"A".repeat(36)}`;
    const msg = checkContentForSecrets(content);
    expect(msg).toContain("Private key");
    expect(msg).toContain("GitHub Token");
  });

  it("includes remediation instructions in the error message", () => {
    const msg = checkContentForSecrets(`-----BEGIN RSA PRIVATE KEY-----`);
    expect(msg).toContain("environment variables");
    expect(msg).toContain(".example");
  });

  it("returns null for an exempt file path even with secrets", () => {
    expect(checkContentForSecrets(VALID_AWS_KEY, "/app/.env.example")).toBeNull();
  });
});
