# Security and Permissions

orager provides a layered security model: tool-level permissions, bash sandboxing, secret scanning, hook-based policy enforcement, and sub-agent isolation.

## Permission Matrix

Configure per-tool permissions in `settings.json`:

```json
{
  "permissions": {
    "Bash": "ask",
    "Read": "allow",
    "Write": "ask",
    "browser_navigate": "deny"
  }
}
```

Three permission levels:

| Level | Behavior |
|---|---|
| `allow` | Tool executes without prompting. |
| `ask` | User is prompted for approval before execution. |
| `deny` | Tool call is rejected. The model receives an error. |

## CLI Flags

```bash
# Skip all permission checks (use only in trusted, sandboxed environments)
orager run --dangerously-skip-permissions "task"

# Require approval for all tools
orager run --require-approval "task"

# Require approval for specific tools only
orager run --require-approval-for Bash,Write "task"
```

## Approval Modes

When a tool requires approval (`ask` permission or `--require-approval`), orager uses one of two modes:

- **`tty`** -- Interactive terminal prompt. The user sees the tool name and parameters and types `y` or `n`. This is the default for CLI usage.
- **`question`** -- Event-based. orager emits an approval event that a UI or SDK consumer can handle programmatically.

## Bash Policy

The `bashPolicy` configuration controls what shell commands agents can execute:

```json
{
  "bashPolicy": {
    "blockedCommands": ["rm -rf /", "mkfs", "dd if="],
    "stripEnvKeys": ["PROTOCOL_API_KEY", "ANTHROPIC_API_KEY", "AWS_SECRET_ACCESS_KEY"],
    "allowedEnvKeys": ["PATH", "HOME", "SHELL", "TERM"],
    "isolateEnv": true,
    "osSandbox": true,
    "allowNetwork": true
  }
}
```

| Field | Description |
|---|---|
| `blockedCommands` | Command patterns that are rejected outright. |
| `stripEnvKeys` | Environment variables stripped from the subprocess environment. |
| `allowedEnvKeys` | Allowlist of environment variables passed through (when `isolateEnv` is true). |
| `isolateEnv` | If true, only `allowedEnvKeys` are passed to subprocesses. |
| `osSandbox` | If true, uses OS-level sandboxing (macOS sandbox-exec, Linux seccomp). |
| `allowNetwork` | If false, network access is blocked in sandboxed subprocesses. |

## Sandbox Root

Restrict all file operations (Read, Write, Glob, Grep) to a specific directory:

```bash
orager run --sandbox-root /path/to/project "Refactor the codebase"
```

Any file operation targeting a path outside the sandbox root is rejected. This prevents agents from reading or modifying files elsewhere on the system.

## Secret Scanner

The secret scanner (`src/secret-scanner.ts`) monitors tool outputs for accidentally leaked secrets. It checks for patterns matching:

- API keys (various provider formats)
- Private keys (RSA, EC, SSH)
- Tokens (JWT, OAuth)
- Connection strings with embedded credentials
- AWS access keys and secret keys

When a secret is detected in a tool output, the scanner redacts it before the output reaches the model or logs. A warning is emitted so the user knows a secret was caught.

## Hook System

Hooks run custom scripts before or after tool calls, providing policy enforcement beyond static permissions:

```json
{
  "hooks": {
    "pre_tool_call": [
      {
        "tool": "Bash",
        "command": "python3 scripts/validate-bash-command.py"
      }
    ],
    "post_tool_call": [
      {
        "tool": "*",
        "command": "python3 scripts/audit-log.py"
      }
    ]
  }
}
```

### Hook Types

- **`pre_tool_call`** -- Runs before the tool executes. Can block execution by returning a non-zero exit code.
- **`post_tool_call`** -- Runs after the tool executes. Receives the tool output on stdin. Useful for auditing and logging.

### Hook Error Modes

Control what happens when a hook script fails:

```bash
orager run --hook-error-mode fail "task"    # Abort the tool call (default)
orager run --hook-error-mode warn "task"    # Log a warning, continue
orager run --hook-error-mode ignore "task"  # Silently continue
```

The hook receives the tool name and parameters as JSON on stdin and environment variables.

## Tool Denylist on Sub-Agents

When spawning sub-agents, use the `denyTools` field on `AgentDefinition` to restrict which tools the sub-agent can access:

```typescript
const result = await agentTool.execute({
  description: "Analyze code quality",
  denyTools: ["Bash", "Write"],  // Read-only analysis
  maxTurns: 10,
});
```

This is enforced at the tool dispatch layer. If the sub-agent attempts to call a denied tool, it receives an error message.

## Sub-Agent Permission Inheritance

Sub-agents inherit the parent's permission matrix by default. Additional restrictions can be layered on:

- The parent's `deny` permissions are always inherited (a sub-agent cannot escalate).
- The parent's `ask` permissions remain `ask` unless the sub-agent's `denyTools` blocks the tool entirely.
- `allow` permissions from the parent can be downgraded to `ask` or `deny` on the sub-agent.

This ensures sub-agents never have more access than their parent.

## Known Limitations and Hardening

Security audits have identified and addressed the following vectors:

### SSRF Vectors (Fixed)

Server-Side Request Forgery vectors in the browser tools and HTTP-based tool handlers have been hardened. URL validation now rejects private IP ranges, link-local addresses, and DNS rebinding attempts. See the changelog for details.

### Bash Blocklist Escape Vectors (Hardened)

The bash command blocklist has been strengthened against common bypass techniques including:

- Unicode homoglyph substitution
- Shell variable expansion (`$'\x72\x6d'`)
- Backtick and `$()` subshell nesting
- Alias and function redefinition

The blocklist is a defense-in-depth layer. For high-security environments, combine it with `osSandbox: true` and `--sandbox-root` for stronger isolation.

## Recommended Security Configurations

### Development (Trusted Environment)

```json
{
  "permissions": { "Bash": "ask", "Read": "allow", "Write": "ask" },
  "bashPolicy": { "stripEnvKeys": ["PROTOCOL_API_KEY"] }
}
```

### CI/CD (Automated, Sandboxed)

```json
{
  "permissions": { "Bash": "allow", "Read": "allow", "Write": "allow" },
  "bashPolicy": {
    "osSandbox": true,
    "isolateEnv": true,
    "allowedEnvKeys": ["PATH", "HOME", "CI"],
    "allowNetwork": false
  }
}
```

### Production (Strict)

```json
{
  "permissions": { "Bash": "deny", "Read": "allow", "Write": "deny" },
  "bashPolicy": { "osSandbox": true, "isolateEnv": true }
}
```

Use `--sandbox-root` and `--require-approval` for maximum safety.
