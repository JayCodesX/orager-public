/**
 * Run tab — submit a prompt and watch the agent stream in real time.
 *
 * Flow:
 *   1. POST /api/run  → { runId }
 *   2. GET  /api/run/:runId/events (SSE) → stream of EmitEvent frames
 *   3. Render each event as it arrives, auto-scroll to bottom.
 *   4. When a ui_render event arrives, show an inline interactive component
 *      and POST the response to /api/run/:runId/ui_response.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { api, getToken } from "../api";
import type { UiComponentSpec, UiFormField } from "../../../src/types.js";

// ── Types ─────────────────────────────────────────────────────────────────────

interface RunEvent {
  type: string;
  // assistant
  message?: { role: string; content: Array<{ type: string; text?: string }> };
  // tool
  content?: unknown;
  // result
  total_cost_usd?: number;
  duration_ms?: number;
  turns?: number;
  stop_reason?: string;
  // text_delta / thinking_delta
  delta?: string;
  // system
  subtype?: string;
  model?: string;
  session_id?: string;
  // error / warn
  message_str?: string;
  // ui_render
  requestId?: string;
  spec?: UiComponentSpec;
  // generic
  [key: string]: unknown;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Pull the primary text out of an assistant event's content blocks. */
function extractAssistantText(event: RunEvent): string {
  const blocks = event.message?.content ?? [];
  return blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}

const MODELS = [
  "deepseek/deepseek-chat-v3-0324",
  "deepseek/deepseek-r1",
  "anthropic/claude-sonnet-4-5",
  "anthropic/claude-opus-4",
  "openai/gpt-4o",
  "openai/o3",
  "google/gemini-2.5-pro",
  "meta-llama/llama-4-maverick",
];

// ── Generative UI components ──────────────────────────────────────────────────

function UiConfirm({
  spec,
  onSubmit,
}: {
  spec: Extract<UiComponentSpec, { component: "confirm" }>;
  onSubmit: (value: unknown) => void;
}) {
  return (
    <div style={cardStyle}>
      {spec.title && <div style={titleStyle}>{spec.title}</div>}
      <div style={{ marginBottom: 12, fontSize: 13, color: "var(--text)" }}>{spec.message}</div>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button className="btn-ghost" onClick={() => onSubmit(false)}>Cancel</button>
        <button className="btn-primary" onClick={() => onSubmit(true)}>Confirm</button>
      </div>
    </div>
  );
}

function UiSelect({
  spec,
  onSubmit,
}: {
  spec: Extract<UiComponentSpec, { component: "select" }>;
  onSubmit: (value: unknown) => void;
}) {
  const [selected, setSelected] = useState(spec.options[0]?.value ?? "");
  return (
    <div style={cardStyle}>
      {spec.title && <div style={titleStyle}>{spec.title}</div>}
      {spec.message && <div style={{ marginBottom: 8, fontSize: 13, color: "var(--text-muted)" }}>{spec.message}</div>}
      <select
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
        style={{ width: "100%", marginBottom: 12 }}
      >
        {spec.options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button className="btn-primary" onClick={() => onSubmit(selected)}>Submit</button>
      </div>
    </div>
  );
}

function UiForm({
  spec,
  onSubmit,
}: {
  spec: Extract<UiComponentSpec, { component: "form" }>;
  onSubmit: (value: unknown) => void;
}) {
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(spec.fields.map((f) => [f.name, f.default ?? (f.type === "boolean" ? false : "")])),
  );

  const setField = (name: string, val: unknown) =>
    setValues((prev) => ({ ...prev, [name]: val }));

  return (
    <div style={cardStyle}>
      {spec.title && <div style={titleStyle}>{spec.title}</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 12 }}>
        {spec.fields.map((field: UiFormField) => (
          <label key={field.name} style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 12, color: "var(--text-muted)" }}>
            {field.label}{field.required && <span style={{ color: "var(--error)" }}> *</span>}
            {field.type === "boolean" ? (
              <input
                type="checkbox"
                checked={Boolean(values[field.name])}
                onChange={(e) => setField(field.name, e.target.checked)}
                style={{ width: 16, height: 16, marginTop: 2 }}
              />
            ) : field.type === "select" ? (
              <select
                value={String(values[field.name] ?? "")}
                onChange={(e) => setField(field.name, e.target.value)}
              >
                {(field.options ?? []).map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            ) : field.type === "textarea" ? (
              <textarea
                rows={3}
                placeholder={field.placeholder}
                value={String(values[field.name] ?? "")}
                onChange={(e) => setField(field.name, e.target.value)}
                style={{ resize: "vertical", fontFamily: "inherit", fontSize: 12 }}
              />
            ) : (
              <input
                type={field.type === "number" ? "number" : "text"}
                placeholder={field.placeholder}
                value={String(values[field.name] ?? "")}
                onChange={(e) => setField(field.name, field.type === "number" ? Number(e.target.value) : e.target.value)}
              />
            )}
          </label>
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button className="btn-primary" onClick={() => onSubmit(values)}>Submit</button>
      </div>
    </div>
  );
}

function UiTable({ spec }: { spec: Extract<UiComponentSpec, { component: "table" }> }) {
  return (
    <div style={cardStyle}>
      {spec.title && <div style={titleStyle}>{spec.title}</div>}
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr>
              {spec.columns.map((col) => (
                <th key={col} style={{ textAlign: "left", padding: "4px 8px", borderBottom: "1px solid var(--border)", color: "var(--text-muted)", fontWeight: 600 }}>{col}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {spec.rows.map((row, i) => (
              <tr key={i}>
                {(row as unknown[]).map((cell, j) => (
                  <td key={j} style={{ padding: "4px 8px", borderBottom: "1px solid var(--border)", color: "var(--text)" }}>{String(cell ?? "")}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  background: "var(--bg-input)",
  border: "1px solid var(--accent)",
  borderRadius: "var(--radius)",
  padding: "12px 14px",
  margin: "4px 12px",
};
const titleStyle: React.CSSProperties = {
  fontWeight: 600,
  fontSize: 13,
  color: "var(--accent)",
  marginBottom: 8,
};

function UiRenderBlock({
  runId,
  requestId,
  spec,
  onResolved,
}: {
  runId: string;
  requestId: string;
  spec: UiComponentSpec;
  onResolved: () => void;
}) {
  const [submitted, setSubmitted] = useState(false);

  const submit = useCallback(async (value: unknown) => {
    if (submitted) return;
    setSubmitted(true);
    try {
      await api.submitUiResponse(runId, requestId, value);
    } catch { /* error will surface as a warn event in the stream */ }
    onResolved();
  }, [submitted, runId, requestId, onResolved]);

  if (submitted) {
    return (
      <div style={{ ...cardStyle, color: "var(--text-muted)", fontSize: 12 }}>
        Response submitted ✓
      </div>
    );
  }

  if (spec.component === "confirm") return <UiConfirm spec={spec} onSubmit={submit} />;
  if (spec.component === "select")  return <UiSelect  spec={spec} onSubmit={submit} />;
  if (spec.component === "form")    return <UiForm    spec={spec} onSubmit={submit} />;
  if (spec.component === "table") {
    // Tables are display-only — auto-resolve immediately with null
    void submit(null);
    return <UiTable spec={spec} />;
  }
  return null;
}

// ── Event row renderer ────────────────────────────────────────────────────────

function EventRow({
  event,
  idx,
  runId,
}: {
  event: RunEvent;
  idx: number;
  runId: string | null;
}) {
  const [uiResolved, setUiResolved] = useState(false);

  if (event.type === "system" && event.subtype === "init") {
    return (
      <div key={idx} style={{ padding: "8px 12px", borderBottom: "1px solid var(--border)", color: "var(--text-muted)", fontSize: 12 }}>
        Starting · model: <code style={{ color: "var(--accent)" }}>{String(event.model ?? "")}</code>
        {event.session_id && (
          <> · session <code style={{ fontFamily: "monospace" }}>{String(event.session_id).slice(0, 12)}</code></>
        )}
      </div>
    );
  }

  if (event.type === "assistant") {
    const text = extractAssistantText(event);
    if (!text) return null;
    return (
      <div key={idx} style={{ padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
        <div style={{ fontSize: 11, color: "var(--accent)", fontWeight: 600, marginBottom: 4 }}>assistant</div>
        <pre style={{
          margin: 0,
          fontSize: 13,
          lineHeight: 1.65,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          color: "var(--text)",
        }}>
          {text}
        </pre>
      </div>
    );
  }

  if (event.type === "text_delta" || event.type === "thinking_delta") {
    return null;
  }

  if (event.type === "ui_render") {
    const spec = event.spec as UiComponentSpec | undefined;
    const requestId = event.requestId as string | undefined;
    if (!spec || !requestId || !runId) return null;
    return (
      <div key={idx} style={{ borderBottom: "1px solid var(--border)" }}>
        {!uiResolved && (
          <div style={{ padding: "6px 12px 0", fontSize: 11, color: "var(--accent)", fontWeight: 600 }}>
            agent is waiting for input
          </div>
        )}
        <UiRenderBlock
          runId={runId}
          requestId={requestId}
          spec={spec}
          onResolved={() => setUiResolved(true)}
        />
      </div>
    );
  }

  if (event.type === "tool") {
    const [expanded, setExpanded] = useState(false);
    const raw = JSON.stringify(event.content, null, 2);
    return (
      <div
        key={idx}
        style={{ padding: "6px 12px", borderBottom: "1px solid var(--border)", cursor: "pointer", background: expanded ? "var(--accent-subtle)" : undefined }}
        onClick={() => setExpanded((v) => !v)}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
          <span style={{ color: "var(--warn)", fontWeight: 600 }}>tool</span>
          <span style={{ color: "var(--text-muted)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {raw.slice(0, 100)}
          </span>
          <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{expanded ? "▲" : "▼"}</span>
        </div>
        {expanded && (
          <pre style={{
            marginTop: 6,
            fontSize: 11,
            color: "var(--text-muted)",
            background: "var(--bg-input)",
            borderRadius: 4,
            padding: "6px 8px",
            overflowX: "auto",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
          }}>
            {raw}
          </pre>
        )}
      </div>
    );
  }

  if (event.type === "result") {
    const cost = typeof event.total_cost_usd === "number"
      ? `$${event.total_cost_usd.toFixed(4)}`
      : "—";
    const ms = typeof event.duration_ms === "number"
      ? `${(event.duration_ms / 1000).toFixed(1)}s`
      : "—";
    const turns = typeof event.turns === "number" ? event.turns : "—";
    return (
      <div key={idx} style={{
        padding: "10px 12px",
        borderBottom: "1px solid var(--border)",
        background: "var(--accent-subtle)",
        fontSize: 12,
        display: "flex",
        gap: 20,
      }}>
        <span style={{ color: "var(--accent)", fontWeight: 600 }}>done</span>
        <span style={{ color: "var(--text-muted)" }}>cost: <strong style={{ color: "var(--text)" }}>{cost}</strong></span>
        <span style={{ color: "var(--text-muted)" }}>time: <strong style={{ color: "var(--text)" }}>{ms}</strong></span>
        <span style={{ color: "var(--text-muted)" }}>turns: <strong style={{ color: "var(--text)" }}>{String(turns)}</strong></span>
        {event.stop_reason && (
          <span style={{ color: "var(--text-muted)" }}>stop: <strong style={{ color: "var(--text)" }}>{String(event.stop_reason)}</strong></span>
        )}
      </div>
    );
  }

  if (event.type === "warn" || event.type === "error") {
    const msg = typeof event.message === "string" ? event.message : JSON.stringify(event);
    return (
      <div key={idx} style={{
        padding: "6px 12px",
        borderBottom: "1px solid var(--border)",
        fontSize: 12,
        color: event.type === "error" ? "var(--error)" : "var(--warn)",
      }}>
        <strong>{event.type}:</strong> {msg}
      </div>
    );
  }

  if (event.type === "done") return null;

  return null;
}

// ── Main component ────────────────────────────────────────────────────────────

export default function Run() {
  const [prompt, setPrompt]         = useState("");
  const [model, setModel]           = useState(MODELS[0]!);
  const [customModel, setCustomModel] = useState("");
  const [maxTurns, setMaxTurns]     = useState(20);
  const [maxCost, setMaxCost]       = useState(1.00);
  const [running, setRunning]       = useState(false);
  const [events, setEvents]         = useState<RunEvent[]>([]);
  const [error, setError]           = useState<string | null>(null);
  const [runId, setRunId]           = useState<string | null>(null);

  const esRef      = useRef<EventSource | null>(null);
  const bottomRef  = useRef<HTMLDivElement>(null);
  const autoScroll = useRef(true);

  // Auto-scroll to bottom when new events arrive
  useEffect(() => {
    if (autoScroll.current && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [events]);

  const stopStream = useCallback(() => {
    if (esRef.current) { esRef.current.close(); esRef.current = null; }
  }, []);

  useEffect(() => stopStream, [stopStream]);

  const handleSubmit = useCallback(async () => {
    if (running || !prompt.trim()) return;
    setRunning(true);
    setEvents([]);
    setError(null);
    setRunId(null);
    stopStream();

    const effectiveModel = customModel.trim() || model;

    try {
      const { runId: id } = await api.startRun({
        prompt: prompt.trim(),
        model: effectiveModel,
        maxTurns,
        maxCostUsd: maxCost,
      });
      setRunId(id);

      const token = getToken();
      const url = `/api/run/${encodeURIComponent(id)}/events` +
        (token ? `?token=${encodeURIComponent(token)}` : "");
      const es = new EventSource(url);
      esRef.current = es;

      es.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data as string) as RunEvent;
          if (event.type === "done") {
            setRunning(false);
            es.close();
            esRef.current = null;
          } else {
            setEvents((prev) => [...prev, event]);
          }
        } catch { /* ignore */ }
      };
      es.onerror = () => {
        setRunning(false);
        es.close();
        esRef.current = null;
      };
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRunning(false);
    }
  }, [running, prompt, model, customModel, maxTurns, maxCost, stopStream]);

  const handleStop = useCallback(() => {
    stopStream();
    setRunning(false);
  }, [stopStream]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 120px)", gap: 12 }}>

      {/* Input panel */}
      <div style={{
        background: "var(--bg-card)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        padding: 16,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}>
        <textarea
          placeholder="Enter a prompt…"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void handleSubmit();
          }}
          rows={4}
          disabled={running}
          style={{
            resize: "vertical",
            fontFamily: "inherit",
            fontSize: 13,
            lineHeight: 1.5,
          }}
        />

        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {/* Model select */}
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={running}
            style={{ flex: 2, minWidth: 200 }}
          >
            {MODELS.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>

          {/* Custom model override */}
          <input
            type="text"
            placeholder="or type model id…"
            value={customModel}
            onChange={(e) => setCustomModel(e.target.value)}
            disabled={running}
            style={{ flex: 2, minWidth: 160 }}
          />

          {/* Max turns */}
          <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
            max turns
            <input
              type="number"
              min={1}
              max={100}
              value={maxTurns}
              onChange={(e) => setMaxTurns(Number(e.target.value))}
              disabled={running}
              style={{ width: 60, textAlign: "right" }}
            />
          </label>

          {/* Max cost */}
          <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
            max $
            <input
              type="number"
              min={0.01}
              max={100}
              step={0.01}
              value={maxCost}
              onChange={(e) => setMaxCost(Number(e.target.value))}
              disabled={running}
              style={{ width: 70, textAlign: "right" }}
            />
          </label>

          <div style={{ flex: 1 }} />

          {running ? (
            <button className="btn-ghost" onClick={handleStop} style={{ whiteSpace: "nowrap" }}>
              Stop
            </button>
          ) : (
            <button
              className="btn-primary"
              disabled={!prompt.trim()}
              onClick={() => void handleSubmit()}
              style={{ whiteSpace: "nowrap" }}
            >
              Run  ⌘↵
            </button>
          )}
        </div>

        {error && (
          <div style={{ color: "var(--error)", fontSize: 12 }}>Error: {error}</div>
        )}
        {running && runId && (
          <div style={{ color: "var(--text-muted)", fontSize: 11, fontFamily: "monospace" }}>
            run {runId.slice(0, 8)}… streaming
            <span style={{ display: "inline-block", animation: "spin 1s linear infinite", marginLeft: 6 }}>⟳</span>
          </div>
        )}
      </div>

      {/* Output stream */}
      <div
        style={{
          flex: 1,
          overflow: "auto",
          background: "var(--bg-card)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
        }}
        onScroll={(e) => {
          const el = e.currentTarget;
          autoScroll.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {events.length === 0 && !running ? (
          <div style={{ padding: "40px 16px", color: "var(--text-muted)", textAlign: "center", fontSize: 13 }}>
            {error ? "Run failed — see error above." : "Enter a prompt and press Run."}
          </div>
        ) : (
          events.map((ev, idx) => <EventRow key={idx} event={ev} idx={idx} runId={runId} />)
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
