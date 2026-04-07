import React, { useCallback, useEffect, useState } from "react";
import { useToast } from "../components/Toast.tsx";
import { getKeychainStatus, setKeychainKey, deleteKeychainKey } from "../api.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

interface KeychainStatus {
  supported: boolean;
  providers: Record<string, { configured: boolean }>;
}

const PROVIDERS: { id: string; label: string; url: string }[] = [
  { id: "openrouter", label: "OpenRouter",    url: "https://openrouter.ai" },
  { id: "anthropic",  label: "Anthropic",     url: "https://anthropic.com" },
  { id: "openai",     label: "OpenAI",        url: "https://openai.com" },
  { id: "deepseek",   label: "DeepSeek",      url: "https://deepseek.com" },
  { id: "gemini",     label: "Google Gemini", url: "https://aistudio.google.com" },
];

// ── Provider card ─────────────────────────────────────────────────────────────

function ProviderCard({
  provider,
  configured,
  onSave,
  onRemove,
}: {
  provider: { id: string; label: string; url: string };
  configured: boolean;
  onSave: (provider: string, key: string) => Promise<void>;
  onRemove: (provider: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [keyValue, setKeyValue] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);

  const handleSave = useCallback(async () => {
    if (!keyValue.trim()) return;
    setSaving(true);
    try {
      await onSave(provider.id, keyValue.trim());
      setEditing(false);
      setKeyValue("");
    } finally {
      setSaving(false);
    }
  }, [keyValue, onSave, provider.id]);

  const handleRemove = useCallback(async () => {
    setRemoving(true);
    try {
      await onRemove(provider.id);
      setConfirming(false);
    } finally {
      setRemoving(false);
    }
  }, [onRemove, provider.id]);

  return (
    <div style={{
      background: "var(--bg-card)",
      border: "1px solid var(--border)",
      borderRadius: "var(--radius)",
      padding: "14px 16px",
    }}>
      {/* Header row */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <span style={{ fontSize: 18 }}>{configured ? "🔒" : "🔗"}</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>
            <a
              href={provider.url}
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--text)", textDecoration: "none" }}
            >
              {provider.label}
            </a>
          </div>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 1 }}>
            {provider.url.replace(/^https?:\/\//, "")}
          </div>
        </div>
        <span style={{
          fontSize: 11,
          fontWeight: 600,
          padding: "2px 8px",
          borderRadius: 4,
          background: configured ? "rgba(52, 199, 89, 0.15)" : "var(--bg-input)",
          color: configured ? "#34c759" : "var(--text-muted)",
          border: `1px solid ${configured ? "rgba(52, 199, 89, 0.3)" : "var(--border)"}`,
        }}>
          {configured ? "Configured" : "Not set"}
        </span>
      </div>

      {/* Edit area */}
      {editing && (
        <div style={{ marginBottom: 10 }}>
          <input
            type="password"
            value={keyValue}
            onChange={(e) => setKeyValue(e.target.value)}
            placeholder="sk-..."
            style={{ width: "100%", fontFamily: "monospace", fontSize: 12 }}
            onKeyDown={(e) => { if (e.key === "Enter") void handleSave(); if (e.key === "Escape") { setEditing(false); setKeyValue(""); } }}
            autoFocus
          />
        </div>
      )}

      {/* Action row */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {!editing ? (
          <button
            className="btn-ghost"
            style={{ fontSize: 12, padding: "4px 10px" }}
            onClick={() => { setEditing(true); setConfirming(false); }}
          >
            {configured ? "Update key" : "Set key"}
          </button>
        ) : (
          <>
            <button
              className="btn-primary"
              style={{ fontSize: 12, padding: "4px 10px" }}
              disabled={saving || !keyValue.trim()}
              onClick={() => void handleSave()}
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              className="btn-ghost"
              style={{ fontSize: 12, padding: "4px 10px" }}
              onClick={() => { setEditing(false); setKeyValue(""); }}
            >
              Cancel
            </button>
          </>
        )}

        {configured && !editing && (
          <>
            {!confirming ? (
              <button
                className="btn-ghost"
                style={{ fontSize: 12, padding: "4px 10px", color: "var(--error)" }}
                onClick={() => setConfirming(true)}
              >
                Remove
              </button>
            ) : (
              <>
                <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Are you sure?</span>
                <button
                  className="btn-ghost"
                  style={{ fontSize: 12, padding: "4px 10px", color: "var(--error)" }}
                  disabled={removing}
                  onClick={() => void handleRemove()}
                >
                  {removing ? "Removing…" : "Yes, remove"}
                </button>
                <button
                  className="btn-ghost"
                  style={{ fontSize: 12, padding: "4px 10px" }}
                  onClick={() => setConfirming(false)}
                >
                  Cancel
                </button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ApiKeys() {
  const { showToast } = useToast();
  const [status, setStatus] = useState<KeychainStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      const s = await getKeychainStatus();
      setStatus(s);
    } catch (err) {
      showToast(`Failed to load keychain status: ${(err as Error).message}`, "error");
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => { void loadStatus(); }, [loadStatus]);

  const handleSave = useCallback(async (provider: string, key: string) => {
    try {
      await setKeychainKey(provider, key);
      showToast(`${provider} key saved`, "success");
      await loadStatus();
    } catch (err) {
      showToast(`Failed to save key: ${(err as Error).message}`, "error");
      throw err;
    }
  }, [loadStatus, showToast]);

  const handleRemove = useCallback(async (provider: string) => {
    try {
      await deleteKeychainKey(provider);
      showToast(`${provider} key removed`, "success");
      await loadStatus();
    } catch (err) {
      showToast(`Failed to remove key: ${(err as Error).message}`, "error");
      throw err;
    }
  }, [loadStatus, showToast]);

  if (loading) {
    return <div className="placeholder"><p>Loading…</p></div>;
  }

  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0, marginBottom: 6 }}>API Keys</h2>
        <p style={{ fontSize: 13, color: "var(--text-muted)", margin: 0 }}>
          Per-provider API keys stored securely in the OS keychain. Keys set here take precedence over environment variables.
        </p>
      </div>

      {status && !status.supported && (
        <div style={{
          background: "rgba(255, 159, 10, 0.1)",
          border: "1px solid rgba(255, 159, 10, 0.3)",
          borderRadius: "var(--radius)",
          padding: "12px 16px",
          marginBottom: 20,
          fontSize: 13,
          color: "var(--text)",
        }}>
          OS keychain is not available on this system. Set API keys via environment variables
          (OPENROUTER_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, DEEPSEEK_API_KEY, GEMINI_API_KEY).
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {PROVIDERS.map((p) => (
          <ProviderCard
            key={p.id}
            provider={p}
            configured={status?.providers[p.id]?.configured ?? false}
            onSave={handleSave}
            onRemove={handleRemove}
          />
        ))}
      </div>
    </div>
  );
}
