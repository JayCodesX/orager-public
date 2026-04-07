# Custom Tools

orager's tool system is extensible. You can register tools programmatically, load them from JSON files, connect MCP servers, and use built-in browser and UI tools.

## ToolDefinition Interface

Every tool in orager conforms to the `ToolDefinition` interface:

```typescript
interface ToolDefinition {
  type: "function";
  readonly?: boolean;           // If true, tool cannot modify state
  function: {
    name: string;               // Unique tool name
    description: string;        // Shown to the model
    parameters: ToolParameterSchema;
  };
}
```

### Parameter Schema

Tool parameters use a JSON Schema subset:

```typescript
interface ToolParameterSchema {
  type: "object";
  properties: Record<string, ToolParameterProperty>;
  required?: string[];
}

interface ToolParameterProperty {
  type: string;                 // "string", "number", "boolean", "array", "object"
  description?: string;
  enum?: string[];              // Allowed values
  items?: ToolParameterProperty;       // For array types
  properties?: Record<string, ToolParameterProperty>;  // For object types
  required?: string[];          // For object types
}
```

## Registering Tools Programmatically

Pass custom tools via the `extraTools` option on `AgentLoopOptions`:

```typescript
import { runAgentLoop } from "orager";

const myTool: ToolDefinition = {
  type: "function",
  function: {
    name: "lookup_user",
    description: "Look up a user by email address",
    parameters: {
      type: "object",
      properties: {
        email: {
          type: "string",
          description: "The email address to look up",
        },
      },
      required: ["email"],
    },
  },
};

await runAgentLoop({
  prompt: "Find the user with email test@example.com",
  extraTools: [myTool],
  toolHandler: async (toolName, params) => {
    if (toolName === "lookup_user") {
      const user = await db.users.findByEmail(params.email);
      return JSON.stringify(user);
    }
  },
});
```

## Loading Tools from JSON Files

For tools that wrap shell commands, define them in a JSON file and load with the `--tools-file` flag:

```bash
orager run --tools-file ./my-tools.json "Deploy the staging environment"
```

### JSON Tool Spec Format

```json
[
  {
    "name": "deploy_staging",
    "description": "Deploy the application to the staging environment",
    "parameters": {
      "type": "object",
      "properties": {
        "branch": {
          "type": "string",
          "description": "Git branch to deploy"
        },
        "skipTests": {
          "type": "boolean",
          "description": "Skip test suite before deploying"
        }
      },
      "required": ["branch"]
    },
    "exec": "bash scripts/deploy.sh --branch {{branch}} --env staging {{#skipTests}}--skip-tests{{/skipTests}}"
  }
]
```

The `exec` field is a shell command template. Parameters are substituted using `{{paramName}}` syntax. The default execution timeout is **30,000 ms** (30 seconds).

Tools are loaded by `loadToolsFromFile` in `src/tools/load-tools.ts`.

## MCP Server Integration

orager supports Model Context Protocol (MCP) servers for tool discovery and execution.

### Configuration via AgentLoopOptions

```typescript
await runAgentLoop({
  prompt: "Check the database status",
  mcpServers: [
    {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-postgres"],
      env: { DATABASE_URL: "postgres://..." },
    },
  ],
});
```

### Auto-Loading from Config

MCP servers defined in `~/.claude/claude_desktop_config.json` are auto-loaded:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]
    },
    "postgres": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres"],
      "env": {
        "DATABASE_URL": "postgres://localhost/mydb"
      }
    }
  }
}
```

MCP tools appear alongside built-in tools in the model's tool list. They support the full MCP lifecycle including resource discovery and prompt templates.

## Browser Tools

Browser tools are opt-in and provide Playwright-based browser automation. Enable them with the `--enable-browser-tools` flag:

```bash
orager run --enable-browser-tools "Scrape the pricing page"
```

Eight browser tools are available:

| Tool | Description |
|---|---|
| `browser_navigate` | Navigate to a URL |
| `browser_click` | Click an element by selector |
| `browser_type` | Type text into an input |
| `browser_screenshot` | Capture a screenshot |
| `browser_read` | Extract page text content |
| `browser_scroll` | Scroll the page |
| `browser_wait` | Wait for a selector or timeout |
| `browser_eval` | Execute JavaScript in the page |

Browser tools require Playwright to be installed (`npx playwright install chromium`).

## Generative UI: render_ui

The `render_ui` tool enables agents to render interactive UI components in the browser interface. It supports forms, tables, and confirmation dialogs with blocking semantics -- the agent pauses until the user interacts.

```typescript
// The agent can call render_ui to show a confirmation
await tools.render_ui({
  type: "confirm",
  title: "Delete 15 files?",
  message: "This will permanently remove the selected files.",
  confirmLabel: "Delete",
  cancelLabel: "Keep",
});
// Agent blocks here until the user clicks Delete or Keep
```

Supported component types:

- **`form`** -- Render input fields; returns the submitted values.
- **`table`** -- Display tabular data with optional row selection.
- **`confirm`** -- Yes/no dialog; returns the user's choice.

## Tool Aliases

For compatibility with Claude CLI tool names, orager supports aliases. A tool registered as `Read` can also be invoked as `file_read`, for example. Aliases are defined in the tool registry and are transparent to the model.

## Custom Approval Hooks

Use `requireApproval` to add a custom approval gate before tool execution:

```typescript
await runAgentLoop({
  prompt: "Clean up old log files",
  requireApproval: async (toolName, params) => {
    // Block destructive operations
    if (toolName === "Bash" && params.command?.includes("rm ")) {
      // Return "ask" to prompt the user, "allow" to proceed, "deny" to block
      return "ask";
    }
    return "allow";
  },
});
```

Approval modes:

- **`tty`** -- Prompts in the terminal. The user types `y` or `n`.
- **`question`** -- Emits an event. The caller (e.g., a UI) handles the approval flow.

See the [Security and Permissions guide](./security-permissions.md) for the full permission model.
