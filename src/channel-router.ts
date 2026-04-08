/**
 * channel-router.ts — @mention routing and agent wake dispatch.
 *
 * When a message is posted to a channel containing @agent-id mentions:
 * 1. Parse mentions from content
 * 2. For each mentioned agent: queue a wake event
 * 3. Wake triggers the agent's boot sequence with channel context
 * 4. Agent's response is posted back to the same channel
 *
 * The router supports both synchronous dispatch (await agent response)
 * and event-based dispatch (fire-and-forget with callback).
 */

import { parseMentions, postMessage, getMessages, type ChannelMessage } from "./channel.js";
import { loadIdentity, buildIdentityBlock } from "./agent-identity.js";
import { listIdentities } from "./agent-identity.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface WakeEvent {
  /** The message that triggered the wake. */
  message: ChannelMessage;
  /** The agent being woken. */
  agentId: string;
  /** Channel context: recent messages for the agent to see. */
  channelHistory: ChannelMessage[];
}

export type WakeHandler = (event: WakeEvent) => Promise<string | null>;

// ── Router state ─────────────────────────────────────────────────────────────

let _wakeHandler: WakeHandler | null = null;

/**
 * Register a handler that is called when an agent is @mentioned.
 * The handler receives the wake event and should return the agent's response
 * text (or null if the agent declines to respond).
 */
export function onAgentWake(handler: WakeHandler): void {
  _wakeHandler = handler;
}

/**
 * Clear the wake handler.
 */
export function clearWakeHandler(): void {
  _wakeHandler = null;
}

// ── Routing ──────────────────────────────────────────────────────────────────

/**
 * Route a posted message: detect @mentions and wake the relevant agents.
 * Returns the list of agents that were woken (and their responses, if synchronous).
 */
export async function routeMessage(
  message: ChannelMessage,
  opts?: { historyLimit?: number },
): Promise<Array<{ agentId: string; response: string | null }>> {
  if (message.mentions.length === 0) return [];
  if (!_wakeHandler) return [];

  // Resolve which mentions correspond to real identity-backed agents
  const knownAgents = new Set(listIdentities().map((a) => a.id));
  const agentsToWake = message.mentions.filter((id) => knownAgents.has(id));

  if (agentsToWake.length === 0) return [];

  // Fetch recent channel history for context
  const history = await getMessages(message.channelId, {
    limit: opts?.historyLimit ?? 20,
  });

  const results: Array<{ agentId: string; response: string | null }> = [];

  for (const agentId of agentsToWake) {
    // Don't wake an agent on its own messages (prevent loops)
    if (message.authorId === agentId) continue;

    const event: WakeEvent = {
      message,
      agentId,
      channelHistory: history,
    };

    try {
      const response = await _wakeHandler(event);
      results.push({ agentId, response });

      // If the agent responded, post it back to the channel
      if (response) {
        await postMessage(message.channelId, agentId, response, {
          threadId: message.threadId ?? message.id,
        });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[channel-router] wake failed for ${agentId}: ${errMsg}\n`);
      results.push({ agentId, response: null });
    }
  }

  return results;
}

/**
 * Build a prompt for an agent being woken by an @mention.
 * Includes channel history and the triggering message.
 */
export function buildWakePrompt(event: WakeEvent): string {
  const sections: string[] = [];

  // Channel context
  sections.push(`You were mentioned in a channel message. Here is the recent conversation:`);
  sections.push("");

  for (const msg of event.channelHistory) {
    const prefix = msg.id === event.message.id ? ">>> " : ""; // highlight trigger
    sections.push(`${prefix}[${msg.createdAt}] ${msg.authorId}: ${msg.content}`);
  }

  sections.push("");
  sections.push(
    `Respond to ${event.message.authorId}'s message. ` +
    `Be concise and relevant. If you don't have useful input, you may decline to respond.`,
  );

  return sections.join("\n");
}
