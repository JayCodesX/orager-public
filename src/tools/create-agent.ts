/**
 * create-agent.ts — Tool that lets agents create other persistent agents.
 *
 * Gated by the `createAgents` permission in the calling agent's config.json.
 * Creates a full identity-backed agent: soul.md, operating-manual.md,
 * config.json, and auto-creates a DM channel.
 *
 * Can optionally use a template from the 143-template rolodex, or create
 * from scratch with custom soul/manual content.
 *
 * This tool is NOT in ALL_TOOLS — it's injected dynamically into the tool
 * set when an agent with `createAgents` permission runs.
 */

import type { ToolExecutor, ToolResult, ToolExecuteOptions } from "../types.js";
import { createIdentity, listIdentities } from "../agent-identity.js";
import { hasPermission, loadAgentConfig } from "../agent-config.js";
import { getTemplate } from "../agent-templates.js";
import { addMember, getChannelByName } from "../channel.js";

export const CREATE_AGENT_TOOL_NAME = "create_agent";

export const createAgentTool: ToolExecutor = {
  definition: {
    type: "function",
    function: {
      name: CREATE_AGENT_TOOL_NAME,
      description:
        "Create a new persistent agent with an identity, configuration, and DM channel. " +
        "Use a template ID from the rolodex or provide custom soul/manual content. " +
        "The new agent will be immediately available in the system. " +
        "Requires the create_agents permission.",
      parameters: {
        type: "object",
        properties: {
          agent_id: {
            type: "string",
            description:
              "Unique identifier for the new agent (kebab-case). " +
              "Example: 'security-auditor', 'frontend-lead'.",
          },
          template_id: {
            type: "string",
            description:
              "Optional template ID from the rolodex (e.g. 'cto', 'typescript-expert', " +
              "'security-auditor'). If provided, seeds soul, operating manual, and config " +
              "from the template. Custom fields below override template defaults.",
          },
          soul: {
            type: "string",
            description:
              "Custom soul.md content. If template_id is set, this overrides the template's soul.",
          },
          operating_manual: {
            type: "string",
            description:
              "Custom operating-manual.md content. Overrides template if set.",
          },
          role: {
            type: "string",
            description: "Agent role: 'primary' or 'specialist'. Default: 'specialist'.",
          },
          reports_to: {
            type: "string",
            description:
              "Agent ID this new agent reports to. If omitted, reports to user directly. " +
              "Typically set to the creating agent's ID.",
          },
          title: {
            type: "string",
            description: "Display title for the agent (e.g. 'Frontend Architect').",
          },
          channel_ids: {
            type: "array",
            items: { type: "string" },
            description: "Channel IDs to add the new agent to (in addition to the auto-created DM).",
          },
        },
        required: ["agent_id"],
      },
    },
  },

  async execute(
    input: Record<string, unknown>,
    _cwd: string,
    opts?: ToolExecuteOptions,
  ): Promise<ToolResult> {
    const toolCallId = (opts as { toolCallId?: string } | undefined)?.toolCallId ?? "";

    // ── Validate inputs ────────────────────────────────────────────────────
    const agentId = input["agent_id"] as string | undefined;
    if (!agentId || typeof agentId !== "string") {
      return { toolCallId, content: "[create_agent] Missing required parameter: agent_id", isError: true };
    }

    // Validate agent_id format
    if (!/^[a-zA-Z0-9_-]+$/.test(agentId)) {
      return {
        toolCallId,
        content: "[create_agent] agent_id must contain only alphanumeric characters, dashes, and underscores.",
        isError: true,
      };
    }

    // ── Permission check ───────────────────────────────────────────────────
    // The calling agent's ID is passed via opts.additionalEnv or a custom field.
    // In the executor wiring (subprocess.ts), the calling agent's ID is set
    // in ORAGER_AGENT_ID env var.
    const callingAgentId = opts?.additionalEnv?.["ORAGER_AGENT_ID"];
    if (callingAgentId && !hasPermission(callingAgentId, "createAgents")) {
      return {
        toolCallId,
        content: `[create_agent] Agent "${callingAgentId}" does not have the create_agents permission.`,
        isError: true,
      };
    }

    // ── Check if agent already exists ──────────────────────────────────────
    const existing = listIdentities().find((a) => a.id === agentId);
    if (existing) {
      return {
        toolCallId,
        content: `[create_agent] Agent "${agentId}" already exists.`,
        isError: true,
      };
    }

    // ── Resolve template ───────────────────────────────────────────────────
    const templateId = input["template_id"] as string | undefined;
    let templateSoul = "";
    let templateManual = "";
    let templatePatterns = "";
    let templateRole: "primary" | "specialist" = "specialist";
    let templateTitle = "";
    let templatePermissions: Record<string, boolean> = {};

    if (templateId) {
      const tmpl = getTemplate(templateId);
      if (!tmpl) {
        return {
          toolCallId,
          content: `[create_agent] Template "${templateId}" not found. Use agent/templates/list to see available templates.`,
          isError: true,
        };
      }
      templateSoul = tmpl.seed.soul;
      templateManual = tmpl.seed.operatingManual;
      templatePatterns = tmpl.seed.patterns ?? "";
      templateRole = tmpl.config.role;
      templateTitle = tmpl.config.title;
      if (tmpl.config.permissions) {
        templatePermissions = Object.fromEntries(
          Object.entries(tmpl.config.permissions).filter(([, v]) => v === true),
        );
      }
    }

    // ── Merge custom overrides with template defaults ──────────────────────
    const soul = (input["soul"] as string) || templateSoul;
    const operatingManual = (input["operating_manual"] as string) || templateManual;
    const role = (input["role"] as "primary" | "specialist") || templateRole;
    const title = (input["title"] as string) || templateTitle;
    const reportsTo = (input["reports_to"] as string) ?? callingAgentId ?? null;

    // ── Create the agent ───────────────────────────────────────────────────
    try {
      await createIdentity(
        agentId,
        {
          soul: soul || undefined,
          operatingManual: operatingManual || undefined,
          patterns: templatePatterns || undefined,
        },
        {
          role,
          reportsTo,
          title: title || undefined,
          permissions: Object.keys(templatePermissions).length > 0
            ? templatePermissions
            : { bash: true, fileSystem: true },
          templateId: templateId || undefined,
        },
      );
    } catch (err) {
      return {
        toolCallId,
        content: `[create_agent] Failed to create agent: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }

    // ── Add to additional channels ─────────────────────────────────────────
    const channelIds = input["channel_ids"] as string[] | undefined;
    const joinedChannels: string[] = [`dm-${agentId}`];

    if (channelIds && Array.isArray(channelIds)) {
      for (const chId of channelIds) {
        try {
          await addMember(chId, agentId);
          joinedChannels.push(chId);
        } catch {
          // Non-fatal — channel might not exist
        }
      }
    }

    // ── Build success response ─────────────────────────────────────────────
    const lines = [
      `Successfully created agent "${agentId}".`,
      "",
      `Role: ${role}`,
      `Title: ${title || "(none)"}`,
      `Reports to: ${reportsTo || "user (direct)"}`,
      `Template: ${templateId || "custom"}`,
      `Channels: ${joinedChannels.join(", ")}`,
      "",
      "The agent is now available in the system with a DM channel.",
      reportsTo
        ? `It reports to "${reportsTo}" in the hierarchy.`
        : "It reports directly to the user.",
    ];

    return { toolCallId, content: lines.join("\n"), isError: false };
  },
};

/**
 * Check if an agent should have the create_agent tool available.
 * Called during tool set construction for agent runs.
 */
export function shouldIncludeCreateAgentTool(agentId: string): boolean {
  return hasPermission(agentId, "createAgents");
}
