/**
 * secret-scanner.ts — built-in secret detection for Write/Edit tool calls.
 *
 * Scans file content before it is written to disk. If a high-confidence
 * secret pattern is found, returns a descriptive error string. Otherwise
 * returns null (no issue found).
 *
 * Always-on (no config required). Non-fatal: returns an error result that
 * the agent sees as a tool error, preventing the write and prompting it to
 * remove the secret before retrying.
 */

export interface SecretMatch {
  pattern: string;
  match: string; // redacted excerpt
}

const PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "AWS Access Key",      re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "AWS Secret Key",      re: /\baws[_\-]?secret[_\-]?(?:access[_\-]?)?key\s*[=:]\s*['"]?[A-Za-z0-9/+]{40}['"]?/i },
  { name: "GitHub Token",        re: /\b(ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{82}|ghs_[A-Za-z0-9]{36})\b/ },
  { name: "OpenAI / OpenRouter key", re: /\bsk-[A-Za-z0-9\-_]{20,}/ },
  { name: "Anthropic API key",   re: /\bsk-ant-[A-Za-z0-9\-_]{20,}/ },
  { name: "Slack token",         re: /\bxox[baprs]-[0-9A-Za-z\-]{10,}/ },
  { name: "Private key",         re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/ },
  { name: "Database URL with credentials", re: /\b(?:mysql|postgres(?:ql)?|mongodb(?:\+srv)?|redis(?:s)?):\/\/[^:@\s"']+:[^@\s"']+@/ },
  { name: "JWT token",           re: /\beyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/ },
  { name: "Generic secret assignment", re: /(?:password|passwd|secret|api[_\-]?key|access[_\-]?token|auth[_\-]?token)\s*[=:]\s*['"][A-Za-z0-9!@#$%^&*()\-_=+[\]{};:'",.<>?/\\|`~]{12,}['"]/i },
];

/** Files that should be exempt from scanning (env example files, test fixtures). */
const EXEMPT_PATTERNS: RegExp[] = [
  /\.env\.example$/i,
  /\.env\.sample$/i,
  /\.env\.template$/i,
  /\bfixtures?\b/i,
  /\b__tests__\b/i,
  /\btest[_\-]?data\b/i,
];

function isExempt(filePath: string): boolean {
  return EXEMPT_PATTERNS.some((p) => p.test(filePath));
}

function redact(s: string): string {
  if (s.length <= 8) return "***";
  return s.slice(0, 4) + "***" + s.slice(-2);
}

/**
 * Scan a string of content for secrets.
 * @returns Array of matches, empty if clean.
 */
export function scanForSecrets(content: string, filePath?: string): SecretMatch[] {
  if (filePath && isExempt(filePath)) return [];
  const found: SecretMatch[] = [];
  for (const { name, re } of PATTERNS) {
    const m = content.match(re);
    if (m) {
      found.push({ pattern: name, match: redact(m[0]) });
    }
  }
  return found;
}

/**
 * Returns a human-readable error message if secrets are found, null otherwise.
 */
export function checkContentForSecrets(content: string, filePath?: string): string | null {
  const matches = scanForSecrets(content, filePath);
  if (matches.length === 0) return null;
  const list = matches.map((m) => `  • ${m.pattern}: ${m.match}`).join("\n");
  return (
    `Secret scanner blocked this write — potential secret(s) detected:\n${list}\n\n` +
    `Remove the secret(s) and use environment variables or a secrets manager instead. ` +
    `If this is a test fixture or example file, rename it to include '.example', '.sample', or '.template'.`
  );
}
