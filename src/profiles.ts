/**
 * Built-in agent profiles — opinionated presets for common task types.
 *
 * A profile bundles: system prompt addendum, recommended tools to enable/disable,
 * suggested model tier, maxTurns, bashPolicy, and other AgentLoopOptions defaults.
 *
 * Usage:
 *   import { applyProfile } from "./profiles.js";
 *   const opts = applyProfile("code-review", { apiKey, model, prompt, onEmit });
 */
import type { AgentLoopOptions, BashPolicy } from "./types.js";

export type ProfileName =
  | "code-review"
  | "bug-fix"
  | "research"
  | "refactor"
  | "test-writer"
  | "devops"
  | "dev"
  | "deploy";

interface ProfileDefaults {
  appendSystemPrompt: string;
  description: string;
  maxTurns?: number;
  bashPolicy?: BashPolicy;
  tagToolOutputs?: boolean;
  trackFileChanges?: boolean;
  maxIdenticalToolCallTurns?: number;
  summarizeAt?: number;
  planMode?: boolean;
  requireApproval?: string[] | "all";
  models?: string[];
  summarizeModel?: string;
  summarizePrompt?: string;
  webhookUrl?: string;
  webhookFormat?: "discord";
}

const PROFILES: Record<ProfileName, ProfileDefaults> = {
  "code-review": {
    description: "Read-only analysis: review code for bugs, style, and improvements.",
    appendSystemPrompt:
      "You are performing a thorough code review. READ and ANALYZE only — do NOT modify any files.\n\n" +
      "## Review checklist\n" +
      "1. **Correctness** — Logic errors, off-by-one, null/undefined paths, race conditions\n" +
      "2. **Security** — Injection risks (SQL, XSS, command), hardcoded secrets, missing auth checks, unsafe deserialization\n" +
      "3. **Performance** — N+1 queries, unbounded allocations, missing indexes, unnecessary re-renders\n" +
      "4. **Error handling** — Empty catch blocks, swallowed errors, missing validation at system boundaries\n" +
      "5. **Style & readability** — Naming, dead code, overly complex control flow, missing types\n" +
      "6. **Test coverage** — Untested branches, missing edge case tests, brittle assertions\n\n" +
      "## Output format\n" +
      "Classify each finding as CRITICAL / HIGH / MEDIUM / LOW.\n" +
      "For each finding: cite the file and line, explain the issue, and suggest a concrete fix.\n" +
      "Limit output to the top 15 most impactful findings. End with a summary verdict.",
    maxTurns: 20,
    bashPolicy: {
      blockedCommands: ["curl", "wget", "ssh", "nc", "socat", "git push", "rm", "mv"],
      stripEnvKeys: ["AWS_", "GITHUB_TOKEN", "SSH_AUTH_SOCK", "NPM_TOKEN"],
    },
    tagToolOutputs: true,
    maxIdenticalToolCallTurns: 3,
  },

  "bug-fix": {
    description: "Diagnose and fix a specific bug. Writes code, runs tests.",
    appendSystemPrompt:
      "You are diagnosing and fixing a bug. Follow this structured process:\n\n" +
      "## Phase 1 — Reproduce\n" +
      "- Read the relevant source code and test files\n" +
      "- Run the failing test or reproduce the error condition\n" +
      "- Confirm you can trigger the bug before changing anything\n\n" +
      "## Phase 2 — Diagnose\n" +
      "- Form hypotheses ranked by likelihood: data issue > logic error > state issue > environment\n" +
      "- Trace the execution path from input to failure point\n" +
      "- Identify the root cause (not just the symptom)\n\n" +
      "## Phase 3 — Fix\n" +
      "- Implement a minimal, targeted fix — prefer surgical edits (edit_file) over full rewrites\n" +
      "- Do NOT refactor adjacent code in the same change\n" +
      "- Add a regression test that fails without the fix and passes with it\n\n" +
      "## Phase 4 — Verify\n" +
      "- Run the full test suite for the affected module\n" +
      "- Confirm the original bug is fixed and no tests regressed\n" +
      "- Report: what was the root cause, what was changed, and why this fix is correct",
    maxTurns: 30,
    bashPolicy: {
      blockedCommands: ["curl", "wget", "ssh"],
      stripEnvKeys: ["AWS_", "SSH_AUTH_SOCK"],
    },
    trackFileChanges: true,
    tagToolOutputs: true,
    maxIdenticalToolCallTurns: 4,
    summarizeAt: 0.7,
  },

  "research": {
    description: "Web research and information gathering. Summarizes findings.",
    appendSystemPrompt:
      "You are a research agent gathering information from the web and local files.\n\n" +
      "## Research methodology\n" +
      "1. **Scope** — Before searching, define what you need to find and what 'done' looks like\n" +
      "2. **Search broadly** — Use web_search with varied query phrasings; don't rely on one query\n" +
      "3. **Read deeply** — Use web_fetch on promising URLs to get full content, not just snippets\n" +
      "4. **Cross-reference** — Be skeptical of single-source claims; verify key facts across 2+ sources\n" +
      "5. **Recency** — Note publication dates; prefer recent sources for fast-moving topics\n\n" +
      "## Output format\n" +
      "- Structured summary with clear sections\n" +
      "- Every key claim has a citation (URL + publication date when available)\n" +
      "- Separate facts from opinions; flag areas of disagreement between sources\n" +
      "- End with confidence assessment: what's well-established vs. uncertain\n\n" +
      "Do NOT modify any local files unless explicitly asked.",
    maxTurns: 25,
    bashPolicy: {
      blockedCommands: ["rm", "mv", "cp", "git"],
      isolateEnv: true,
    },
    tagToolOutputs: true,
    maxIdenticalToolCallTurns: 3,
  },

  "refactor": {
    description: "Large-scale code refactoring across multiple files.",
    appendSystemPrompt:
      "You are performing a code refactoring. Preserve all existing behavior unless explicitly asked to change it.\n\n" +
      "## Process\n" +
      "1. **Understand first** — Read all relevant files before making any edits. Map the dependency graph.\n" +
      "2. **Plan the changes** — List every file that needs modification and the nature of each change. Share the plan before starting.\n" +
      "3. **Work in batches** — Group related changes into logical batches. Use edit_files for multi-file atomic changes where possible.\n" +
      "4. **Test after each batch** — Run the test suite after each logical batch. Do not proceed if tests fail.\n" +
      "5. **Keep commits small** — Each batch should be a single coherent commit.\n\n" +
      "## Guardrails\n" +
      "- Never rename and restructure in the same batch — do renames first, then structural changes\n" +
      "- Update all import/require paths when moving files\n" +
      "- Check for string references (config files, scripts, docs) that may reference moved symbols\n" +
      "- If the refactor touches public API, update all callers in the same batch",
    maxTurns: 50,
    bashPolicy: {
      blockedCommands: ["curl", "wget"],
      stripEnvKeys: ["AWS_", "SSH_AUTH_SOCK"],
    },
    trackFileChanges: true,
    tagToolOutputs: true,
    maxIdenticalToolCallTurns: 5,
    summarizeAt: 0.65,
  },

  "test-writer": {
    description: "Write tests for existing code. Coverage-focused.",
    appendSystemPrompt:
      "You are writing tests. Do NOT modify source files — only create or edit test files.\n\n" +
      "## Process\n" +
      "1. **Read the source** — Understand the module's public API, branching paths, and edge cases\n" +
      "2. **Read existing tests** — Match the testing framework, assertion style, mock patterns, and file naming conventions already in use\n" +
      "3. **Plan coverage** — List the test cases before writing: happy path, edge cases (empty input, boundary values, null/undefined), error conditions, concurrency (if applicable)\n" +
      "4. **Write tests** — Follow Arrange-Act-Assert pattern. One assertion focus per test. Descriptive test names that read as behavior specs.\n" +
      "5. **Run and verify** — All new tests must pass. Check that they fail meaningfully when the source logic is broken.\n\n" +
      "## Quality rules\n" +
      "- Test behavior, not implementation details — avoid asserting on internal state\n" +
      "- Prefer real implementations over mocks when feasible; mock only at system boundaries (network, filesystem, clock)\n" +
      "- Target the testing pyramid: ~70% unit, ~20% integration, ~10% e2e\n" +
      "- No flaky tests: avoid timing-dependent assertions, use deterministic test data",
    maxTurns: 30,
    bashPolicy: {
      blockedCommands: ["curl", "wget", "ssh", "git push"],
      stripEnvKeys: ["AWS_", "SSH_AUTH_SOCK"],
    },
    trackFileChanges: true,
    maxIdenticalToolCallTurns: 4,
  },

  "devops": {
    description: "Infrastructure, deployment, and operational tasks.",
    appendSystemPrompt:
      "You are performing infrastructure and operational tasks. Safety is paramount.\n\n" +
      "## Safety rules\n" +
      "- Always use dry-run flags first (--dry-run, -n, --check, --plan) when available\n" +
      "- Never run destructive commands (delete, destroy, force-push) without confirming the target\n" +
      "- Log every significant action and its outcome\n" +
      "- For production systems: read current state → plan changes → confirm plan → apply\n\n" +
      "## Checklist for infrastructure changes\n" +
      "1. Verify you're targeting the correct environment (dev/staging/prod)\n" +
      "2. Check current state before modifying (terraform plan, kubectl get, docker ps)\n" +
      "3. Apply changes incrementally — one resource or service at a time\n" +
      "4. Verify health after each change (health checks, log inspection, metric dashboards)\n" +
      "5. Document what was changed and why for the ops runbook\n\n" +
      "## Common patterns\n" +
      "- Docker: always pin image tags, never use :latest in production\n" +
      "- Terraform: review plan output line-by-line before apply\n" +
      "- K8s: use rollout status to watch deployments, rollback on failure\n" +
      "- DNS/TLS: changes may take time to propagate — verify with dig/curl, not just the dashboard",
    maxTurns: 40,
    trackFileChanges: true,
    tagToolOutputs: true,
    maxIdenticalToolCallTurns: 5,
    summarizeAt: 0.7,
  },

  "dev": {
    description: "Active development mode. Build features incrementally with tests.",
    appendSystemPrompt:
      "You are in active development mode — building features, writing code, and iterating.\n\n" +
      "## Development workflow\n" +
      "1. **Understand the task** — Read the relevant code, understand the architecture, identify the right files to modify\n" +
      "2. **Plan before coding** — For non-trivial changes, outline your approach first. Identify risks and dependencies.\n" +
      "3. **Implement incrementally** — Make small, testable changes. Verify each step works before moving to the next.\n" +
      "4. **Test as you go** — Run related tests after each significant change. Write new tests for new behavior.\n" +
      "5. **Clean up** — Remove debug code, add comments for non-obvious logic, ensure consistent style.\n\n" +
      "## Code quality standards\n" +
      "- Follow existing project conventions (naming, file structure, patterns) — read before you write\n" +
      "- Prefer edit_file for modifications, write_file only for new files\n" +
      "- Handle errors explicitly — no empty catch blocks, no swallowed promises\n" +
      "- Keep functions focused — if a function does two things, split it\n" +
      "- Type everything (in typed languages) — avoid `any`, `unknown` only at boundaries\n\n" +
      "## Avoid\n" +
      "- Do not refactor unrelated code while building a feature\n" +
      "- Do not add dependencies without checking if an existing one covers the need\n" +
      "- Do not skip tests to move faster — they save time in the next iteration",
    maxTurns: 50,
    trackFileChanges: true,
    tagToolOutputs: true,
    maxIdenticalToolCallTurns: 5,
    summarizeAt: 0.7,
  },

  "deploy": {
    description: "Deployment-focused: release preparation, migrations, rollout verification.",
    appendSystemPrompt:
      "You are managing a deployment. Treat every action as potentially production-impacting.\n\n" +
      "## Pre-deployment checklist\n" +
      "1. Verify the branch/tag is correct and all CI checks have passed\n" +
      "2. Review database migrations — are they backward-compatible? Can they be rolled back?\n" +
      "3. Check for environment variable changes — are they set in the target environment?\n" +
      "4. Review breaking changes — are downstream services and clients prepared?\n" +
      "5. Confirm rollback plan — how do you revert if something goes wrong?\n\n" +
      "## During deployment\n" +
      "- Deploy to staging first; verify before promoting to production\n" +
      "- Run database migrations before deploying application code (backward-compatible migrations)\n" +
      "- Monitor logs and error rates during rollout — halt on spike\n" +
      "- Use canary or blue-green deployment when available\n\n" +
      "## Post-deployment\n" +
      "- Verify health checks pass on all instances\n" +
      "- Run smoke tests against the live environment\n" +
      "- Check key metrics (latency p50/p99, error rate, throughput) for regression\n" +
      "- Update deployment log with version, timestamp, and any incidents\n\n" +
      "## Safety rules\n" +
      "- Never deploy on Fridays or before holidays without explicit approval\n" +
      "- Always have a rollback command ready before starting\n" +
      "- Use --dry-run, --plan, -n flags before any destructive operation",
    maxTurns: 30,
    bashPolicy: {
      blockedCommands: ["rm -rf /", "dd if="],
      stripEnvKeys: ["AWS_SECRET", "DATABASE_URL", "SSH_"],
    },
    trackFileChanges: true,
    tagToolOutputs: true,
    maxIdenticalToolCallTurns: 4,
    summarizeAt: 0.7,
  },
};

/**
 * Return the defaults for a named profile.
 */
export function getProfile(name: ProfileName): ProfileDefaults {
  return PROFILES[name];
}

/**
 * Apply a profile's defaults to an AgentLoopOptions object.
 * Explicit values in `opts` take precedence over profile defaults.
 */
export function applyProfile(
  profileName: ProfileName | string,
  opts: AgentLoopOptions,
): AgentLoopOptions {
  const profile = PROFILES[profileName as ProfileName];
  if (!profile) {
    // Unknown built-in profile — return opts unchanged (caller may have custom profile)
    return opts;
  }
  const mergedAppendSystemPrompt = [profile.appendSystemPrompt, opts.appendSystemPrompt]
    .filter(Boolean)
    .join("\n\n");

  // Build profile defaults object first, then spread caller opts on top.
  // Caller opts win for all fields except appendSystemPrompt which is always merged.
  const profileDefaults: Partial<AgentLoopOptions> = {
    maxTurns:                  profile.maxTurns,
    bashPolicy:                profile.bashPolicy ? JSON.parse(JSON.stringify(profile.bashPolicy)) as BashPolicy : undefined,
    tagToolOutputs:            profile.tagToolOutputs,
    trackFileChanges:          profile.trackFileChanges,
    maxIdenticalToolCallTurns: profile.maxIdenticalToolCallTurns,
    summarizeAt:               profile.summarizeAt,
    planMode:                  profile.planMode,
    requireApproval:           Array.isArray(profile.requireApproval) ? [...profile.requireApproval] : profile.requireApproval,
    models:                    profile.models ? [...profile.models] : undefined,
    summarizeModel:            profile.summarizeModel,
    summarizePrompt:           profile.summarizePrompt,
    webhookUrl:                profile.webhookUrl,
    webhookFormat:             profile.webhookFormat,
    appendSystemPrompt:        mergedAppendSystemPrompt,
  };
  // Spread: profile defaults first, then caller opts override, then fix appendSystemPrompt
  const result: AgentLoopOptions = Object.assign({}, profileDefaults, opts, {
    appendSystemPrompt: mergedAppendSystemPrompt,
  }) as AgentLoopOptions;
  return result;
}

/**
 * Async variant of applyProfile that also searches custom profiles from
 * ~/.orager/profiles/ (or ORAGER_PROFILES_DIR).
 * Built-in profiles take precedence over custom ones with the same name.
 */
export async function applyProfileAsync(
  profileName: string,
  opts: AgentLoopOptions,
): Promise<AgentLoopOptions> {
  // Check built-in first
  if (profileName in PROFILES) {
    return applyProfile(profileName as ProfileName, opts);
  }
  // Check custom profiles
  const { loadCustomProfiles } = await import("./profile-loader.js");
  const customs = await loadCustomProfiles();
  const custom = customs[profileName];
  if (!custom) {
    // Log to stderr so operators can catch typos in profile names
    process.stderr.write(`[orager] WARNING: unknown profile '${profileName}' — no built-in or custom profile found. Running without profile.\n`);
    return opts;
  }
  const mergedAppendSystemPrompt = [custom.appendSystemPrompt, opts.appendSystemPrompt]
    .filter(Boolean)
    .join("\n\n");

  const profileDefaults: Partial<AgentLoopOptions> = {
    maxTurns:                  custom.maxTurns,
    bashPolicy:                custom.bashPolicy,
    tagToolOutputs:            custom.tagToolOutputs,
    trackFileChanges:          custom.trackFileChanges,
    maxIdenticalToolCallTurns: custom.maxIdenticalToolCallTurns,
    summarizeAt:               custom.summarizeAt,
    planMode:                  custom.planMode,
    requireApproval:           custom.requireApproval,
    models:                    custom.models,
    summarizeModel:            custom.summarizeModel,
    summarizePrompt:           custom.summarizePrompt,
    webhookUrl:                custom.webhookUrl,
    webhookFormat:             custom.webhookFormat,
    appendSystemPrompt:        mergedAppendSystemPrompt,
  };
  return Object.assign({}, profileDefaults, opts, {
    appendSystemPrompt: mergedAppendSystemPrompt,
  }) as AgentLoopOptions;
}

/** List all available profiles with their descriptions. */
export function listProfiles(): Array<{ name: ProfileName; description: string }> {
  return (Object.entries(PROFILES) as Array<[ProfileName, ProfileDefaults]>).map(
    ([name, p]) => ({ name, description: p.description }),
  );
}

/** List all profiles (built-in and custom) with their descriptions. */
export async function listAllProfiles(): Promise<Array<{ name: string; description: string; builtin: boolean }>> {
  const { loadCustomProfiles } = await import("./profile-loader.js");
  const customs = await loadCustomProfiles();
  const builtins = listProfiles().map((p) => ({ ...p, builtin: true }));
  const customList = Object.entries(customs)
    .filter(([name]) => !(name in PROFILES)) // don't duplicate built-ins
    .map(([name, p]) => ({ name, description: p.description, builtin: false }));
  return [...builtins, ...customList];
}
