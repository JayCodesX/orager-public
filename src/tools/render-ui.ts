/**
 * render_ui — Generative UI tool.
 *
 * Emits a ui_render event that instructs the frontend to render an interactive
 * component (confirm, form, select, table) and blocks until the user responds.
 *
 * Response mechanism:
 *   Browser (orager serve):  POST /api/run/:id/ui_response → resolveUiResponse()
 *   Desktop (sidecar):       agent/ui_response RPC → resolveUiResponse()
 *
 * Timeout: 120 s — after which the tool returns an error and the agent may
 * decide how to proceed (ask again, use a default, abort).
 */

import type { ToolExecutor, UiComponentSpec } from "../types.js";

// ── Pending request registry ─────────────────────────────────────────────────

/** Resolvers keyed by requestId. Populated when a render_ui call is in-flight. */
const pending = new Map<string, (value: string) => void>();

const UI_RESPONSE_TIMEOUT_MS = 120_000;

/**
 * Resolve a pending render_ui call from the frontend.
 * Returns true when the requestId was found and resolved, false otherwise.
 */
export function resolveUiResponse(requestId: string, value: string): boolean {
  const resolve = pending.get(requestId);
  if (typeof resolve !== "function") return false;
  pending.delete(requestId);
  resolve(value);
  return true;
}

// ── Tool definition ──────────────────────────────────────────────────────────

export const renderUiTool: ToolExecutor = {
  definition: {
    type: "function",
    function: {
      name: "render_ui",
      description:
        "Render an interactive UI component in the chat interface and wait for " +
        "the user's response. Use this to collect structured input (forms, " +
        "confirmations, selections) instead of asking free-text questions. " +
        "Returns the user's response as a JSON string.",
      parameters: {
        type: "object",
        properties: {
          spec: {
            type: "object",
            description: "The component specification. Must include a 'component' discriminator field.",
            properties: {
              component: {
                type: "string",
                enum: ["confirm", "form", "select", "table"],
                description: "Which component to render.",
              },
              title: { type: "string", description: "Optional heading shown above the component." },
              message: { type: "string", description: "Body text (confirm / select only)." },
              fields: {
                type: "array",
                description: "Form fields (form only).",
                items: {
                  type: "object",
                  properties: {
                    name:        { type: "string" },
                    label:       { type: "string" },
                    type:        { type: "string", enum: ["text", "number", "boolean", "select", "textarea"] },
                    placeholder: { type: "string" },
                    default:     { type: "string" },
                    required:    { type: "boolean" },
                    options: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: { value: { type: "string" }, label: { type: "string" } },
                        required: ["value", "label"],
                      },
                    },
                  },
                  required: ["name", "label", "type"],
                },
              },
              options: {
                type: "array",
                description: "Choices (select only).",
                items: {
                  type: "object",
                  properties: { value: { type: "string" }, label: { type: "string" } },
                  required: ["value", "label"],
                },
              },
              columns: {
                type: "array",
                description: "Column headers (table only).",
                items: { type: "string" },
              },
              rows: {
                type: "array",
                description: "Data rows (table only). Each row is an array of cell values.",
                items: { type: "array" },
              },
            },
            required: ["component"],
          },
        },
        required: ["spec"],
      },
    },
    // render_ui is not read-only (it collects user input), never cache it.
    readonly: false,
  },

  execute: async (input, _cwd, opts) => {
    const spec = input["spec"] as UiComponentSpec | undefined;
    if (!spec || typeof spec !== "object" || !("component" in spec)) {
      return { toolCallId: "", content: "render_ui: missing or invalid spec", isError: true };
    }

    const onEmit = opts?.onEmit;
    if (!onEmit) {
      return {
        toolCallId: "",
        content: "render_ui is not available in this context (no onEmit handler). " +
          "Use text-based questions instead.",
        isError: true,
      };
    }

    const requestId = crypto.randomUUID();

    // Emit the render event — frontends handle type "ui_render".
    onEmit({ type: "ui_render", requestId, spec });

    // Block until the frontend resolves the requestId or we time out.
    try {
      const value = await Promise.race([
        new Promise<string>((resolve) => { pending.set(requestId, resolve); }),
        new Promise<never>((_, reject) =>
          setTimeout(() => {
            pending.delete(requestId);
            reject(new Error(`render_ui timed out after ${UI_RESPONSE_TIMEOUT_MS / 1000}s — no response received`));
          }, UI_RESPONSE_TIMEOUT_MS),
        ),
      ]);
      return { toolCallId: "", content: value, isError: false };
    } catch (err) {
      return {
        toolCallId: "",
        content: err instanceof Error ? err.message : String(err),
        isError: true,
      };
    }
  },
};
