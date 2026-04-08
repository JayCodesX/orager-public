/**
 * Tournament tab — live prompt-variant leaderboard.
 *
 * Shows per-agent variant performance from the local agents.sqlite DB:
 * win rate, delta vs the original prompt, avg turns, cost, and
 * LLM-as-judge score when available. Also shows the vision model leaderboard.
 *
 * Data is fetched from GET /api/tournament (no auth required beyond the
 * standard UI token). Auto-refreshes every 60 s.
 */

import React, { useEffect, useState, useCallback } from "react";
import { api } from "../api";

// ── Types (mirrors ui-server.ts response) ────────────────────────────────────

type VariantRow = {
  variantId: string;
  strategy: string;
  runs: number;
  successRate: number;
  vsBaseline: number | null;
  avgTurns: number;
  avgCostUsd: number;
  avgJudgeScore: number | null;
};

type AgentBlock = {
  agentId: string;
  variants: VariantRow[];
};

type VisionModelRow = {
  modelId: string;
  shortName: string;
  runs: number;
  winRate: number;
  avgJudgeScore: number | null;
};

type TournamentData = {
  agents: AgentBlock[];
  visionModels: VisionModelRow[];
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function pct(n: number) {
  return `${(n * 100).toFixed(0)}%`;
}

function deltaBadge(delta: number | null, isOriginal: boolean) {
  if (isOriginal) return <span className="tournament-badge baseline">baseline</span>;
  if (delta == null) return null;
  const label = delta > 0 ? `+${pct(delta)}` : pct(delta);
  const cls = delta > 0.05 ? "win" : delta > 0 ? "slight-win" : delta < -0.01 ? "loss" : "neutral";
  return <span className={`tournament-badge ${cls}`}>{label}{delta > 0.05 ? " 🏆" : ""}</span>;
}

// ── Main component ────────────────────────────────────────────────────────────

export default function Tournament() {
  const [data, setData] = useState<TournamentData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedAgent, setSelectedAgent] = useState<string>("all");
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.getTournament();
      setData(result);
      setLastUpdated(new Date());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 60_000);
    return () => clearInterval(id);
  }, [load]);

  const agentIds = data?.agents.map((a) => a.agentId) ?? [];
  const visibleAgents = data?.agents.filter(
    (a) => selectedAgent === "all" || a.agentId === selectedAgent,
  ) ?? [];

  const totalRuns = data?.agents.reduce(
    (sum, a) => sum + a.variants.reduce((s, v) => s + v.runs, 0),
    0,
  ) ?? 0;

  return (
    <div className="tournament-page">
      <div className="tournament-header">
        <div>
          <h2 className="tournament-title">Prompt Tournament</h2>
          <p className="tournament-subtitle">
            Variant leaderboard from <code>agents.sqlite</code>
            {lastUpdated && (
              <span className="tournament-updated">
                {" "}· updated {lastUpdated.toLocaleTimeString()}
              </span>
            )}
          </p>
        </div>
        <div className="tournament-controls">
          <select
            className="tournament-filter"
            value={selectedAgent}
            onChange={(e) => setSelectedAgent(e.target.value)}
          >
            <option value="all">All agents</option>
            {agentIds.map((id) => (
              <option key={id} value={id}>{id}</option>
            ))}
          </select>
          <button className="tournament-refresh-btn" onClick={() => void load()} title="Refresh">
            ↻
          </button>
        </div>
      </div>

      {loading && <p className="tournament-loading">Loading tournament data…</p>}
      {error && (
        <div className="tournament-error">
          <strong>Could not load tournament data.</strong>
          <p>{error}</p>
          <p className="tournament-error-hint">
            Run the prompt tournament (<code>bun test tests/prompt-tournament.test.ts</code>)
            to populate the DB, then refresh.
          </p>
        </div>
      )}

      {!loading && !error && data && (
        <>
          <div className="tournament-summary-bar">
            <span><strong>{totalRuns}</strong> total runs</span>
            <span><strong>{data.agents.length}</strong> agents tracked</span>
            {data.visionModels.length > 0 && (
              <span><strong>{data.visionModels.length}</strong> vision models</span>
            )}
          </div>

          {visibleAgents.length === 0 && (
            <p className="tournament-empty">No data yet for this agent.</p>
          )}

          {visibleAgents.map((agent) => {
            const originalId = `${agent.agentId}-v0-original`;
            const hasJudge = agent.variants.some((v) => v.avgJudgeScore != null);

            return (
              <section key={agent.agentId} className="tournament-agent-block">
                <h3 className="tournament-agent-name">{agent.agentId}</h3>
                <div className="tournament-table-wrap">
                  <table className="tournament-table">
                    <thead>
                      <tr>
                        <th>Strategy</th>
                        <th>Runs</th>
                        <th>Win Rate</th>
                        <th>vs Baseline</th>
                        <th>Avg Turns</th>
                        <th>Avg Cost</th>
                        {hasJudge && <th>Avg Judge</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {agent.variants.map((v) => {
                        const isOriginal = v.variantId === originalId;
                        return (
                          <tr
                            key={v.variantId}
                            className={isOriginal ? "tournament-row-original" : ""}
                          >
                            <td className="tournament-strategy">
                              {v.strategy}
                              {isOriginal && (
                                <span className="tournament-strategy-tag">original</span>
                              )}
                            </td>
                            <td>{v.runs}</td>
                            <td>
                              <span className="tournament-win-rate">
                                {pct(v.successRate)}
                              </span>
                            </td>
                            <td>{deltaBadge(v.vsBaseline, isOriginal)}</td>
                            <td>{v.avgTurns.toFixed(1)}</td>
                            <td>${v.avgCostUsd.toFixed(4)}</td>
                            {hasJudge && (
                              <td>
                                {v.avgJudgeScore != null
                                  ? <span className="tournament-judge-score">
                                      {v.avgJudgeScore.toFixed(2)}
                                    </span>
                                  : <span className="tournament-no-data">—</span>}
                              </td>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            );
          })}

          {/* Vision model leaderboard — shown when selectedAgent is "all" */}
          {selectedAgent === "all" && data.visionModels.length > 0 && (
            <section className="tournament-agent-block">
              <h3 className="tournament-agent-name">vision <span className="tournament-agent-subtitle">(model leaderboard)</span></h3>
              <div className="tournament-table-wrap">
                <table className="tournament-table">
                  <thead>
                    <tr>
                      <th>Model</th>
                      <th>Runs</th>
                      <th>Win Rate</th>
                      {data.visionModels.some((m) => m.avgJudgeScore != null) && (
                        <th>Avg Judge</th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {data.visionModels.map((m) => (
                      <tr key={m.modelId}>
                        <td className="tournament-strategy" title={m.modelId}>{m.shortName}</td>
                        <td>{m.runs}</td>
                        <td><span className="tournament-win-rate">{pct(m.winRate)}</span></td>
                        {data.visionModels.some((x) => x.avgJudgeScore != null) && (
                          <td>
                            {m.avgJudgeScore != null
                              ? <span className="tournament-judge-score">{m.avgJudgeScore.toFixed(2)}</span>
                              : <span className="tournament-no-data">—</span>}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
