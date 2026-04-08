/**
 * mcp-presets.ts — curated MCP server preset bundles.
 *
 * Each preset is a named collection of MCP server configs for a specific
 * development workflow (frontend, devops, data-science, etc.). Presets are
 * merged into the user's ~/.orager/config.json mcpServers block via
 * `orager mcp add --preset <name>`.
 *
 * Sourced from: https://github.com/rohitg00/awesome-claude-code-toolkit/tree/main/mcp-configs
 */

export interface McpPresetServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Human-readable description for `orager mcp list` */
  description?: string;
}

export interface McpPreset {
  name: string;
  description: string;
  servers: Record<string, McpPresetServer>;
}

// ── Shared server fragments ──────────────────────────────────────────────────

const filesystem = (paths: string[]): McpPresetServer => ({
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-filesystem", ...paths],
  description: "Local filesystem access (scoped to allowed paths)",
});

const github: McpPresetServer = {
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-github"],
  env: { GITHUB_PERSONAL_ACCESS_TOKEN: "<your-github-token>" },
  description: "GitHub repos, issues, PRs, and actions",
};

const fetch: McpPresetServer = {
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-fetch"],
  description: "Fetch web content for the agent",
};

const memory: McpPresetServer = {
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-memory"],
  description: "Persistent knowledge graph for agent memory",
};

const puppeteer: McpPresetServer = {
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-puppeteer"],
  description: "Browser automation for testing and screenshots",
};

// ── Presets ──────────────────────────────────────────────────────────────────

export const MCP_PRESETS: Record<string, McpPreset> = {
  recommended: {
    name: "recommended",
    description: "Kitchen-sink preset — filesystem, GitHub, fetch, memory, and browser automation",
    servers: {
      filesystem: filesystem(["."]),
      github,
      fetch,
      memory,
      puppeteer,
    },
  },

  fullstack: {
    name: "fullstack",
    description: "Full-stack web dev — filesystem, GitHub, PostgreSQL, Redis, browser, fetch, memory",
    servers: {
      filesystem: filesystem(["."]),
      github,
      postgres: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-postgres"],
        env: { POSTGRES_CONNECTION_STRING: "<your-postgres-url>" },
        description: "PostgreSQL database queries and schema inspection",
      },
      redis: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-redis"],
        env: { REDIS_URL: "redis://localhost:6379" },
        description: "Redis cache inspection and management",
      },
      puppeteer,
      fetch,
      memory,
    },
  },

  frontend: {
    name: "frontend",
    description: "Frontend development — browser, Figma, Storybook, filesystem, GitHub, fetch",
    servers: {
      puppeteer,
      figma: {
        command: "npx",
        args: ["-y", "@anthropic/mcp-server-figma"],
        env: { FIGMA_PERSONAL_ACCESS_TOKEN: "<your-figma-token>" },
        description: "Figma design file inspection and component extraction",
      },
      storybook: {
        command: "npx",
        args: ["-y", "mcp-storybook"],
        env: { STORYBOOK_URL: "http://localhost:6006" },
        description: "Storybook component browser",
      },
      filesystem: filesystem(["."]),
      github,
      fetch,
    },
  },

  devops: {
    name: "devops",
    description: "Infrastructure & deployment — AWS, Docker, Terraform, kubectl, Sentry, GitHub",
    servers: {
      aws: {
        command: "uvx",
        args: ["awslabs.aws-mcp-server"],
        env: { AWS_PROFILE: "default", AWS_REGION: "us-east-1" },
        description: "AWS service management (EC2, S3, Lambda, etc.)",
      },
      docker: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-docker"],
        description: "Docker container and image management",
      },
      terraform: {
        command: "npx",
        args: ["-y", "mcp-terraform"],
        description: "Terraform plan, apply, and state inspection",
      },
      kubectl: {
        command: "npx",
        args: ["-y", "kubectl-mcp-server"],
        description: "Kubernetes cluster management (270+ tools)",
      },
      sentry: {
        command: "npx",
        args: ["-y", "@sentry/mcp-server"],
        env: { SENTRY_AUTH_TOKEN: "<your-sentry-token>" },
        description: "Sentry error tracking and issue management",
      },
      github,
      filesystem: filesystem(["."]),
    },
  },

  "data-science": {
    name: "data-science",
    description: "Data analysis — Jupyter, SQLite, PostgreSQL, filesystem, fetch, memory",
    servers: {
      jupyter: {
        command: "uvx",
        args: ["jupyter-mcp-server"],
        description: "Jupyter notebook creation and execution",
      },
      sqlite: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-sqlite"],
        description: "SQLite database queries and management",
      },
      postgres: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-postgres"],
        env: { POSTGRES_CONNECTION_STRING: "<your-postgres-url>" },
        description: "PostgreSQL database queries and schema inspection",
      },
      filesystem: filesystem(["."]),
      fetch,
      memory,
    },
  },

  research: {
    name: "research",
    description: "Research & documentation — web search, fetch, memory, filesystem",
    servers: {
      "brave-search": {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-brave-search"],
        env: { BRAVE_API_KEY: "<your-brave-api-key>" },
        description: "Brave web search API",
      },
      fetch,
      memory,
      filesystem: filesystem(["."]),
    },
  },
};

/** Return sorted list of preset names. */
export function listPresetNames(): string[] {
  return Object.keys(MCP_PRESETS).sort();
}

/** Return a preset by name, or undefined. */
export function getPreset(name: string): McpPreset | undefined {
  return MCP_PRESETS[name];
}

/**
 * Extract env var placeholders that need user input from a preset.
 * Returns a map of server name → list of env var keys with placeholder values.
 */
export function getRequiredEnvVars(preset: McpPreset): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const [serverName, server] of Object.entries(preset.servers)) {
    if (!server.env) continue;
    const placeholders = Object.entries(server.env)
      .filter(([, v]) => v.startsWith("<") && v.endsWith(">"))
      .map(([k]) => k);
    if (placeholders.length > 0) {
      result.set(serverName, placeholders);
    }
  }
  return result;
}
