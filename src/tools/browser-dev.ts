/**
 * Dev-workflow browser tools — console logs, network inspection, DOM inspection,
 * accessibility snapshots, viewport management, and smart form fills.
 *
 * These tools extend the base browser tools in browser.ts and share the same
 * session pool. They are gated behind `enableBrowserTools` alongside the base set.
 */

import type { ToolExecuteOptions, ToolExecutor, ToolResult } from "../types.js";
import {
  getSession,
  sessionKey,
  type BrowserState,
  type ConsoleEntry,
  type NetworkEntry,
} from "./browser.js";

function notInstalled(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("not installed");
}

async function resolveSession(opts?: ToolExecuteOptions): Promise<BrowserState | ToolResult> {
  try {
    return await getSession(sessionKey(opts));
  } catch (err) {
    return { toolCallId: "", content: String(err), isError: !notInstalled(err) };
  }
}

function isError(v: BrowserState | ToolResult): v is ToolResult {
  return "toolCallId" in v;
}

// ── Tool: browser_console_logs ───────────────────────────────────────────────

export const browserConsoleLogsTool: ToolExecutor = {
  definition: {
    type: "function",
    readonly: true,
    function: {
      name: "browser_console_logs",
      description:
        "Return captured browser console messages (log, warn, error, info, debug). " +
        "Messages are collected automatically from page load onward. " +
        "Call browser_navigate first if no session is open.",
      parameters: {
        type: "object",
        properties: {
          level: {
            type: "string",
            enum: ["all", "error", "warn"],
            description:
              'Filter by level: "all" (default), "error" (errors only), "warn" (warnings + errors)',
          },
          lines: {
            type: "number",
            description: "Max entries to return (default 50, max 200)",
          },
          clear: {
            type: "boolean",
            description: "Clear the buffer after reading (default true)",
          },
        },
        required: [],
      },
    },
  },

  async execute(input, _cwd, opts): Promise<ToolResult> {
    const result = await resolveSession(opts);
    if (isError(result)) return result;
    const state = result;

    const level = typeof input["level"] === "string" ? input["level"] : "all";
    const maxLines = Math.min(typeof input["lines"] === "number" ? input["lines"] : 50, 200);
    const clear = input["clear"] !== false; // default true

    let entries: ConsoleEntry[];
    if (level === "error") {
      entries = state.consoleLogs.filter((e) => e.level === "error");
    } else if (level === "warn") {
      entries = state.consoleLogs.filter((e) => e.level === "error" || e.level === "warn");
    } else {
      entries = state.consoleLogs;
    }

    const sliced = entries.slice(-maxLines);
    if (clear) state.consoleLogs.length = 0;

    if (sliced.length === 0) {
      return { toolCallId: "", content: "(no console messages)", isError: false };
    }

    const lines = sliced.map((e) => {
      const ts = new Date(e.timestamp).toISOString().slice(11, 23); // HH:mm:ss.SSS
      return `[${ts} ${e.level.toUpperCase()}] ${e.text}`;
    });
    return { toolCallId: "", content: lines.join("\n"), isError: false };
  },
};

// ── Tool: browser_network ────────────────────────────────────────────────────

export const browserNetworkTool: ToolExecutor = {
  definition: {
    type: "function",
    readonly: true,
    function: {
      name: "browser_network",
      description:
        "Return captured network requests and responses. " +
        "Requests are recorded automatically from page load onward. " +
        "Use request_id to retrieve the response body for a specific request.",
      parameters: {
        type: "object",
        properties: {
          filter: {
            type: "string",
            enum: ["all", "failed"],
            description: '"all" (default) or "failed" (4xx/5xx/network errors only)',
          },
          url_pattern: {
            type: "string",
            description: "Show only entries whose URL contains this substring",
          },
          request_id: {
            type: "string",
            description:
              "If provided, return the response body for this specific request ID instead of the listing",
          },
          clear: {
            type: "boolean",
            description: "Clear the buffer after reading (default false)",
          },
        },
        required: [],
      },
    },
  },

  async execute(input, _cwd, opts): Promise<ToolResult> {
    const result = await resolveSession(opts);
    if (isError(result)) return result;
    const state = result;

    const requestId = typeof input["request_id"] === "string" ? input["request_id"] : null;

    // Single request body retrieval mode
    if (requestId) {
      const entry = state.networkEntries.find((e) => e.id === requestId);
      if (!entry) return { toolCallId: "", content: `No request found with id: ${requestId}`, isError: true };
      if (!entry._responseRef) return { toolCallId: "", content: "Response body not available (no response received)", isError: true };
      try {
        const body = await (entry._responseRef as { text(): Promise<string> }).text();
        const capped = body.length > 50_000 ? body.slice(0, 50_000) + "\n[truncated]" : body;
        return { toolCallId: "", content: capped, isError: false };
      } catch (err) {
        return { toolCallId: "", content: `Failed to read response body: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    }

    // Listing mode
    const filter = typeof input["filter"] === "string" ? input["filter"] : "all";
    const urlPattern = typeof input["url_pattern"] === "string" ? input["url_pattern"] : null;
    const clear = input["clear"] === true;

    let entries: NetworkEntry[] = state.networkEntries;
    if (filter === "failed") {
      entries = entries.filter((e) => e.error || (e.status && e.status >= 400));
    }
    if (urlPattern) {
      entries = entries.filter((e) => e.url.includes(urlPattern));
    }

    if (clear) state.networkEntries.length = 0;

    if (entries.length === 0) {
      return { toolCallId: "", content: "(no network requests)", isError: false };
    }

    const listing = entries.map((e) => ({
      id: e.id,
      method: e.method,
      url: e.url,
      status: e.status ?? null,
      contentType: e.contentType ?? null,
      duration_ms: e.duration ?? null,
      error: e.error ?? undefined,
    }));
    return { toolCallId: "", content: JSON.stringify(listing, null, 2), isError: false };
  },
};

// ── Tool: browser_inspect ────────────────────────────────────────────────────

const DEFAULT_STYLES = [
  "color", "background-color", "font-size", "font-family",
  "padding", "margin", "display", "position",
  "width", "height", "border",
];

export const browserInspectTool: ToolExecutor = {
  definition: {
    type: "function",
    readonly: true,
    function: {
      name: "browser_inspect",
      description:
        "Inspect a DOM element's computed CSS styles and properties. " +
        "Returns tag name, id, class, text content preview, bounding box, and computed styles.",
      parameters: {
        type: "object",
        properties: {
          selector: {
            type: "string",
            description: "CSS selector of the element to inspect",
          },
          styles: {
            type: "array",
            items: { type: "string" },
            description:
              "CSS property names to retrieve (default: color, background-color, font-size, " +
              "font-family, padding, margin, display, position, width, height, border)",
          },
        },
        required: ["selector"],
      },
    },
  },

  async execute(input, _cwd, opts): Promise<ToolResult> {
    const selector = typeof input["selector"] === "string" ? input["selector"] : "";
    if (!selector) return { toolCallId: "", content: "selector is required", isError: true };

    const result = await resolveSession(opts);
    if (isError(result)) return result;
    const state = result;

    const styles = Array.isArray(input["styles"])
      ? (input["styles"] as string[])
      : DEFAULT_STYLES;

    try {
      const info = await state.page.evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const cs = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return {
          tagName: el.tagName.toLowerCase(),
          id: el.id || null,
          className: el.className || null,
          textContent: (el.textContent || "").trim().slice(0, 500),
          boundingBox: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
          computedStyles: Object.fromEntries(${JSON.stringify(styles)}.map(function(p) { return [p, cs.getPropertyValue(p)]; })),
        };
      })()`);

      if (info === null) {
        return { toolCallId: "", content: `No element found matching selector: ${selector}`, isError: true };
      }
      return { toolCallId: "", content: JSON.stringify(info, null, 2), isError: false };
    } catch (err) {
      return { toolCallId: "", content: `Inspect failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  },
};

// ── Tool: browser_snapshot ───────────────────────────────────────────────────

export const browserSnapshotTool: ToolExecutor = {
  definition: {
    type: "function",
    readonly: true,
    function: {
      name: "browser_snapshot",
      description:
        "Return the accessibility tree of the current page. " +
        "More useful than a screenshot for understanding page structure and text content. " +
        "The tree shows roles, names, and values of all accessible elements.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },

  async execute(_input, _cwd, opts): Promise<ToolResult> {
    const result = await resolveSession(opts);
    if (isError(result)) return result;
    const state = result;

    try {
      let tree: unknown;
      try {
        // Modern Playwright API (1.40+)
        tree = await (state.page as unknown as { locator(s: string): { ariaSnapshot(): Promise<unknown> } })
          .locator(":root").ariaSnapshot();
      } catch {
        // Fallback to deprecated accessibility.snapshot()
        tree = await state.page.accessibility.snapshot();
      }

      const output = JSON.stringify(tree, null, 2);
      const capped = output.length > 50_000 ? output.slice(0, 50_000) + "\n[truncated]" : output;
      return { toolCallId: "", content: capped, isError: false };
    } catch (err) {
      return { toolCallId: "", content: `Snapshot failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  },
};

// ── Tool: browser_resize ─────────────────────────────────────────────────────

const VIEWPORT_PRESETS: Record<string, { width: number; height: number }> = {
  mobile: { width: 375, height: 812 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1280, height: 800 },
};

export const browserResizeTool: ToolExecutor = {
  definition: {
    type: "function",
    function: {
      name: "browser_resize",
      description:
        "Change the browser viewport size and/or color scheme. " +
        "Use a preset (mobile, tablet, desktop) or specify custom width/height. " +
        "Optionally set color scheme to test dark/light mode.",
      parameters: {
        type: "object",
        properties: {
          preset: {
            type: "string",
            enum: ["mobile", "tablet", "desktop"],
            description: 'Viewport preset (overrides width/height): "mobile" (375×812), "tablet" (768×1024), "desktop" (1280×800)',
          },
          width: { type: "number", description: "Viewport width in pixels" },
          height: { type: "number", description: "Viewport height in pixels" },
          color_scheme: {
            type: "string",
            enum: ["light", "dark"],
            description: "Emulate color scheme preference",
          },
        },
        required: [],
      },
    },
  },

  async execute(input, _cwd, opts): Promise<ToolResult> {
    const result = await resolveSession(opts);
    if (isError(result)) return result;
    const state = result;

    const preset = typeof input["preset"] === "string" ? input["preset"] : null;
    const colorScheme = typeof input["color_scheme"] === "string" ? input["color_scheme"] : null;

    try {
      // Resolve viewport dimensions
      let size: { width: number; height: number } | null = null;
      if (preset) {
        size = VIEWPORT_PRESETS[preset];
        if (!size) return { toolCallId: "", content: `Unknown preset: ${preset}. Use mobile, tablet, or desktop.`, isError: true };
      } else if (typeof input["width"] === "number" && typeof input["height"] === "number") {
        size = { width: input["width"] as number, height: input["height"] as number };
      }

      const parts: string[] = [];

      if (size) {
        await state.page.setViewportSize(size);
        parts.push(`Viewport set to ${size.width}×${size.height}${preset ? ` (${preset})` : ""}`);
      }

      if (colorScheme) {
        await state.page.emulateMedia({ colorScheme });
        parts.push(`Color scheme set to ${colorScheme}`);
      }

      if (parts.length === 0) {
        const current = state.page.viewportSize();
        return {
          toolCallId: "",
          content: current ? `Current viewport: ${current.width}×${current.height}` : "No viewport set",
          isError: false,
        };
      }

      return { toolCallId: "", content: parts.join("\n"), isError: false };
    } catch (err) {
      return { toolCallId: "", content: `Resize failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  },
};

// ── Tool: browser_fill ───────────────────────────────────────────────────────

export const browserFillTool: ToolExecutor = {
  definition: {
    type: "function",
    function: {
      name: "browser_fill",
      description:
        "Smart form fill — automatically handles text inputs, selects, checkboxes, and radio buttons. " +
        "For text/textarea: clears and fills with the given value. " +
        'For select: selects the option matching the value. For checkbox: pass "true" or "false". ' +
        "For radio: selects the matching radio button.",
      parameters: {
        type: "object",
        properties: {
          selector: {
            type: "string",
            description: "CSS selector of the form element",
          },
          value: {
            type: "string",
            description: 'Value to fill/select. For checkbox, use "true" or "false".',
          },
        },
        required: ["selector", "value"],
      },
    },
  },

  async execute(input, _cwd, opts): Promise<ToolResult> {
    const selector = typeof input["selector"] === "string" ? input["selector"] : "";
    const value = typeof input["value"] === "string" ? input["value"] : "";
    if (!selector) return { toolCallId: "", content: "selector is required", isError: true };

    const result = await resolveSession(opts);
    if (isError(result)) return result;
    const state = result;

    try {
      // Detect element type
      const tagInfo = await state.page.evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        return { tag: el.tagName.toLowerCase(), type: el.type || "" };
      })()`) as { tag: string; type: string } | null;

      if (!tagInfo) {
        return { toolCallId: "", content: `No element found matching selector: ${selector}`, isError: true };
      }

      if (tagInfo.tag === "select") {
        await state.page.selectOption(selector, value);
        return { toolCallId: "", content: `Selected option "${value}" in ${selector}`, isError: false };
      } else if (tagInfo.type === "checkbox") {
        if (value === "true") {
          await state.page.check(selector);
        } else {
          await state.page.uncheck(selector);
        }
        return { toolCallId: "", content: `Checkbox ${selector} set to ${value}`, isError: false };
      } else if (tagInfo.type === "radio") {
        await state.page.check(selector);
        return { toolCallId: "", content: `Radio ${selector} selected`, isError: false };
      } else {
        await state.page.fill(selector, value);
        const preview = value.length > 80 ? value.slice(0, 80) + "…" : value;
        return { toolCallId: "", content: `Filled ${selector} with: ${preview}`, isError: false };
      }
    } catch (err) {
      return { toolCallId: "", content: `Fill failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  },
};

// ── Exported tool set ────────────────────────────────────────────────────────

export const BROWSER_DEV_TOOLS: ToolExecutor[] = [
  browserConsoleLogsTool,
  browserNetworkTool,
  browserInspectTool,
  browserSnapshotTool,
  browserResizeTool,
  browserFillTool,
];
