import React, { useEffect, useState, useCallback } from "react";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import { api, type IntelligenceResponse, type FileCluster, type Skill } from "../api";
// ── Helpers ───────────────────────────────────────────────────────────────────

function basename(p: string): string {
  return p.split("/").pop() ?? p;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatPill({ label, value, accent }: { label: string; value: string | number; accent?: boolean }) {
  return (
    <div style={{
      display: "flex", flexDirection: "column", gap: 2,
      background: accent ? "var(--accent-subtle)" : "var(--bg-elevated)",
      border: `1px solid ${accent ? "var(--accent)" : "var(--border)"}`,
      borderRadius: "var(--radius-sm)", padding: "10px 14px", minWidth: 80,
    }}>
      <span style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 500 }}>{label}</span>
      <span style={{ fontSize: 18, fontWeight: 700, color: accent ? "var(--accent)" : "var(--text)" }}>{value}</span>
    </div>
  );
}

function SectionHeader({ title, badge }: { title: string; badge?: string | number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
      <h2 style={{ fontSize: 13, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: "var(--text-secondary)" }}>
        {title}
      </h2>
      {badge != null && (
        <span style={{
          fontSize: 11, fontWeight: 600, background: "var(--accent-subtle)",
          color: "var(--accent)", borderRadius: 999, padding: "1px 8px", border: "1px solid var(--accent)",
        }}>{badge}</span>
      )}
    </div>
  );
}

// ── Project Map Panel ─────────────────────────────────────────────────────────

function ClusterCard({ cluster, hotFiles }: { cluster: FileCluster; hotFiles: string[] }) {
  const hotSet = new Set(hotFiles.map(f => basename(f)));
  const shownFiles = cluster.files.slice(0, 6);
  const more = cluster.files.length - shownFiles.length;

  return (
    <div style={{
      background: "var(--bg-elevated)", border: "1px solid var(--border)",
      borderRadius: "var(--radius-sm)", padding: "12px 14px",
    }}>
      <div style={{ fontWeight: 600, fontSize: 12, color: "var(--accent)", marginBottom: 8 }}>
        {cluster.name}
        <span style={{ fontWeight: 400, color: "var(--text-muted)", marginLeft: 6 }}>
          {cluster.files.length} file{cluster.files.length !== 1 ? "s" : ""}
        </span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {shownFiles.map(f => {
          const name = basename(f);
          const isHot = hotSet.has(name);
          return (
            <span key={f} style={{
              fontSize: 11, padding: "2px 7px", borderRadius: 4,
              background: isHot ? "var(--warn-bg)" : "var(--bg-card)",
              color: isHot ? "var(--warn)" : "var(--text-secondary)",
              border: `1px solid ${isHot ? "rgba(251,191,36,0.3)" : "var(--border-subtle)"}`,
              fontFamily: "monospace",
            }}>
              {name}{isHot ? " 🔥" : ""}
            </span>
          );
        })}
        {more > 0 && (
          <span style={{ fontSize: 11, color: "var(--text-muted)", padding: "2px 4px" }}>
            +{more} more
          </span>
        )}
      </div>
    </div>
  );
}

function ProjectMapPanel({ data }: { data: IntelligenceResponse }) {
  const { projectMap } = data;
  if (!projectMap) {
    return (
      <div style={{ color: "var(--text-muted)", fontSize: 13, padding: "24px 0" }}>
        No project index found for this directory. Run <code style={{ background: "var(--bg-elevated)", padding: "1px 5px", borderRadius: 3 }}>orager run</code> once to build it.
      </div>
    );
  }

  return (
    <div>
      {/* Stats row */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 20 }}>
        <StatPill label="Files" value={projectMap.totalFiles} accent />
        <StatPill label="Clusters" value={projectMap.clusters.length} />
        <StatPill label="Hot Files" value={projectMap.hotFiles.length} />
        <StatPill label="Entry Points" value={projectMap.entryPoints.length} />
        <StatPill label="Call Chains" value={projectMap.callChains.length} />
        <div style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-muted)", alignSelf: "flex-end", paddingBottom: 4 }}>
          {projectMap.fromCache ? "cached" : "fresh index"} · {formatDate(projectMap.indexedAt)}
        </div>
      </div>

      {/* Cluster grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 10, marginBottom: 20 }}>
        {projectMap.clusters.slice(0, 12).map(c => (
          <ClusterCard key={c.name} cluster={c} hotFiles={projectMap.hotFiles} />
        ))}
      </div>
      {projectMap.clusters.length > 12 && (
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 16 }}>
          … and {projectMap.clusters.length - 12} more clusters
        </div>
      )}

      {/* Call chains */}
      {projectMap.callChains.length > 0 && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 8 }}>Key call chains</div>
          <div style={{
            background: "var(--bg-elevated)", border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)", padding: "12px 16px",
            fontFamily: "monospace", fontSize: 12, lineHeight: 1.8,
          }}>
            {projectMap.callChains.map((c, i) => (
              <div key={i} style={{ color: "var(--text-secondary)" }}>
                {c.split("→").map((fn, j) => (
                  <span key={j}>
                    {j > 0 && <span style={{ color: "var(--text-muted)", margin: "0 4px" }}>→</span>}
                    <span style={{ color: j === 0 ? "var(--accent)" : "var(--text)" }}>{fn.trim()}</span>
                  </span>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Skills Panel ──────────────────────────────────────────────────────────────

function SkillCard({ skill }: { skill: Skill }) {
  const successColor = skill.successRate >= 0.7 ? "var(--success)" : skill.successRate >= 0.4 ? "var(--warn)" : "var(--error)";

  return (
    <div style={{
      background: "var(--bg-elevated)", border: "1px solid var(--border)",
      borderRadius: "var(--radius-sm)", padding: "14px 16px",
    }}>
      <p style={{ fontSize: 12, color: "var(--text)", lineHeight: 1.6, marginBottom: 10 }}>
        {skill.text.slice(0, 180)}{skill.text.length > 180 ? "…" : ""}
      </p>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{
          fontSize: 11, padding: "1px 7px", borderRadius: 999,
          background: "var(--accent-subtle)", color: "var(--accent)", border: "1px solid var(--accent)",
        }}>
          ×{skill.useCount} uses
        </span>
        <span style={{
          fontSize: 11, padding: "1px 7px", borderRadius: 999,
          background: `rgba(${successColor === "var(--success)" ? "52,211,153" : successColor === "var(--warn)" ? "251,191,36" : "248,113,113"},0.1)`,
          color: successColor, border: `1px solid ${successColor}`,
        }}>
          {pct(skill.successRate)} success
        </span>
        <span style={{ fontSize: 10, color: "var(--text-muted)", marginLeft: "auto" }}>
          {formatDate(skill.createdAt)}
        </span>
      </div>
    </div>
  );
}

function SkillsPanel({ data }: { data: IntelligenceResponse }) {
  const { skills, skillStats } = data;

  if (skills.length === 0) {
    return (
      <div style={{ color: "var(--text-muted)", fontSize: 13, padding: "24px 0" }}>
        No skills distilled yet. Skills accumulate automatically as the agent runs and learns from its mistakes.
      </div>
    );
  }

  return (
    <div>
      {/* Skill stats summary */}
      {skillStats && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 20 }}>
          <StatPill label="Total Skills" value={skillStats.total} accent />
          <StatPill label="Avg Success" value={pct(skillStats.avgSuccessRate)} />
          {skillStats.topByUse[0] && (
            <div style={{
              flex: 1, minWidth: 200,
              background: "var(--bg-elevated)", border: "1px solid var(--border)",
              borderRadius: "var(--radius-sm)", padding: "10px 14px",
            }}>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>Most used skill</div>
              <div style={{ fontSize: 12, color: "var(--text)", lineHeight: 1.5 }}>
                {skillStats.topByUse[0].text.slice(0, 100)}…
              </div>
            </div>
          )}
        </div>
      )}

      {/* Skill cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 10 }}>
        {skills.slice(0, 12).map(s => <SkillCard key={s.id} skill={s} />)}
      </div>
      {skills.length > 12 && (
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 10 }}>
          … and {skills.length - 12} more skills
        </div>
      )}
    </div>
  );
}

// ── Timeline Panel ────────────────────────────────────────────────────────────

function TimelinePanel({ data }: { data: IntelligenceResponse }) {
  const { sessionTimeline, memoryStats } = data;

  const chartData = sessionTimeline.map((s, i) => ({
    session: i + 1,
    memoryAdded: s.memoryAdded,
    cumulative: sessionTimeline.slice(0, i + 1).reduce((sum, r) => sum + r.memoryAdded, 0),
    date: formatDate(s.date),
  }));

  return (
    <div>
      {/* Memory stats */}
      {memoryStats && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 20 }}>
          <StatPill label="Total Memories" value={memoryStats.total} accent />
          {Object.entries(memoryStats.byType)
            .filter(([type]) => type !== "master_context")
            .sort((a, b) => b[1] - a[1])
            .slice(0, 4)
            .map(([type, count]) => (
              <StatPill key={type} label={type} value={count} />
            ))
          }
        </div>
      )}

      {sessionTimeline.length === 0 ? (
        <div style={{ color: "var(--text-muted)", fontSize: 13, padding: "24px 0" }}>
          No session history found. Memory accumulation will appear here as the agent runs.
        </div>
      ) : (
        <>
          <div style={{ fontSize: 12, color: "var(--text-secondary)", fontWeight: 600, marginBottom: 12 }}>
            Cumulative knowledge growth across {sessionTimeline.length} sessions
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={chartData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="memGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--accent)" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="var(--accent)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border-subtle)" />
              <XAxis
                dataKey="session" tick={{ fontSize: 11, fill: "var(--text-muted)" }}
                label={{ value: "Session", position: "insideBottom", offset: -2, fill: "var(--text-muted)", fontSize: 11 }}
              />
              <YAxis tick={{ fontSize: 11, fill: "var(--text-muted)" }} />
              <Tooltip
                contentStyle={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 6, fontSize: 12 }}
                labelFormatter={v => `Session ${v}`}
              />
              <Area
                type="monotone" dataKey="cumulative" name="Memories"
                stroke="var(--accent)" strokeWidth={2}
                fill="url(#memGrad)"
              />
            </AreaChart>
          </ResponsiveContainer>

          {/* Session list */}
          <div style={{ marginTop: 16 }}>
            {sessionTimeline.slice(-5).reverse().map(s => (
              <div key={s.sessionId} style={{
                display: "flex", justifyContent: "space-between", alignItems: "center",
                padding: "7px 0", borderBottom: "1px solid var(--border-subtle)", fontSize: 12,
              }}>
                <span style={{ color: "var(--text-muted)", fontFamily: "monospace", fontSize: 11 }}>
                  {s.sessionId.slice(0, 12)}…
                </span>
                <span style={{ color: "var(--text-secondary)" }}>{formatDate(s.date)}</span>
                <span style={{ color: "var(--accent)", fontWeight: 600 }}>+{s.memoryAdded} memories</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── Main Tab ──────────────────────────────────────────────────────────────────

type PanelKey = "map" | "skills" | "timeline";

export default function Intelligence() {
  const [data, setData] = useState<IntelligenceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<PanelKey>("map");
  const [cwd, setCwd] = useState("");
  const [inputCwd, setInputCwd] = useState("");

  const load = useCallback(async (targetCwd?: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.getIntelligence(targetCwd || undefined);
      setData(result);
      setCwd(result.cwd);
      setInputCwd(result.cwd);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleCwdSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (inputCwd.trim()) void load(inputCwd.trim());
  };

  const tabs: { key: PanelKey; label: string; badge?: string | number }[] = [
    { key: "map", label: "Project Map", badge: data?.projectMap?.totalFiles },
    { key: "skills", label: "Learned Skills", badge: data?.skills.length },
    { key: "timeline", label: "Session Timeline", badge: data?.sessionTimeline.length },
  ];

  return (
    <div style={{ padding: "28px 28px 48px", maxWidth: 980, margin: "0 auto" }}>

      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>Intelligence</h1>
        <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
          Live code intelligence, distilled skills, and memory growth for any orager project.
        </p>
      </div>

      {/* CWD picker */}
      <form onSubmit={handleCwdSubmit} style={{ display: "flex", gap: 8, marginBottom: 24 }}>
        <input
          type="text"
          value={inputCwd}
          onChange={e => setInputCwd(e.target.value)}
          placeholder="Project directory (default: server cwd)"
          style={{
            flex: 1, background: "var(--bg-input)", border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)", color: "var(--text)", padding: "7px 12px",
            fontSize: 13, outline: "none",
          }}
        />
        <button type="submit" disabled={loading} style={{
          background: "var(--accent)", color: "#fff", border: "none",
          borderRadius: "var(--radius-sm)", padding: "7px 16px",
          fontSize: 13, fontWeight: 600, cursor: "pointer", opacity: loading ? 0.6 : 1,
        }}>
          {loading ? "Loading…" : "Analyze"}
        </button>
        {data && (
          <button type="button" onClick={() => void load(cwd)} style={{
            background: "transparent", color: "var(--text-muted)", border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)", padding: "7px 12px", fontSize: 13, cursor: "pointer",
          }}>
            ↺
          </button>
        )}
      </form>

      {error && (
        <div style={{
          background: "var(--error-bg)", border: "1px solid var(--error)",
          borderRadius: "var(--radius-sm)", padding: "12px 16px",
          color: "var(--error)", fontSize: 13, marginBottom: 20,
        }}>
          {error}
        </div>
      )}

      {loading && !data && (
        <div style={{ color: "var(--text-muted)", fontSize: 13, padding: "40px 0", textAlign: "center" }}>
          Analyzing project…
        </div>
      )}

      {data && (
        <>
          {/* Panel tabs */}
          <div style={{
            display: "flex", gap: 2, marginBottom: 20,
            background: "var(--bg-elevated)", padding: 4,
            borderRadius: "var(--radius)", border: "1px solid var(--border)",
            width: "fit-content",
          }}>
            {tabs.map(t => (
              <button
                key={t.key}
                onClick={() => setPanel(t.key)}
                style={{
                  background: panel === t.key ? "var(--accent)" : "transparent",
                  color: panel === t.key ? "#fff" : "var(--text-muted)",
                  border: "none", borderRadius: 6, padding: "6px 14px",
                  fontSize: 13, fontWeight: panel === t.key ? 600 : 400,
                  cursor: "pointer", display: "flex", alignItems: "center", gap: 6,
                  transition: "all 0.15s ease",
                }}
              >
                {t.label}
                {t.badge != null && (
                  <span style={{
                    fontSize: 10, fontWeight: 700,
                    background: panel === t.key ? "rgba(255,255,255,0.2)" : "var(--accent-subtle)",
                    color: panel === t.key ? "#fff" : "var(--accent)",
                    borderRadius: 999, padding: "1px 6px",
                  }}>{t.badge}</span>
                )}
              </button>
            ))}
          </div>

          {/* Panel content */}
          <div style={{
            background: "var(--bg-card)", border: "1px solid var(--border)",
            borderRadius: "var(--radius)", padding: "20px 22px",
          }}>
            {panel === "map" && (
              <>
                <SectionHeader title="Project Structure" badge={data.projectMap?.clusters.length + " clusters"} />
                <ProjectMapPanel data={data} />
              </>
            )}
            {panel === "skills" && (
              <>
                <SectionHeader title="Distilled Skills" badge={data.skills.length} />
                <SkillsPanel data={data} />
              </>
            )}
            {panel === "timeline" && (
              <>
                <SectionHeader title="Knowledge Growth" badge={data.sessionTimeline.length + " sessions"} />
                <TimelinePanel data={data} />
              </>
            )}
          </div>

          {/* Footer metadata */}
          <div style={{ marginTop: 12, fontSize: 11, color: "var(--text-muted)", display: "flex", gap: 16 }}>
            <span>cwd: <code style={{ color: "var(--text-secondary)" }}>{data.cwd}</code></span>
            <span>memoryKey: <code style={{ color: "var(--text-secondary)" }}>{data.memoryKey}</code></span>
          </div>
        </>
      )}
    </div>
  );
}
