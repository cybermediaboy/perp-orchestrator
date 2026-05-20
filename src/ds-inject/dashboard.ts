/**
 * DS_INJECT local metrics dashboard — Express on :9000
 *
 * Routes:
 *   GET /           HTML dashboard (auto-refreshes every 30s)
 *   GET /api/metrics  last 50 cycles as JSON array
 *   GET /health     {"status":"ok"}
 */
import "dotenv/config";
import express from "express";
import { readRecentMetrics, readAllMetrics } from "./metrics.js";

const PORT = parseInt(process.env.DS_DASHBOARD_PORT ?? "9000");

function statusColor(status: string): string {
  if (status === "success") return "#22c55e";
  if (status.startsWith("aborted")) return "#f59e0b";
  return "#ef4444";
}

function renderDashboard(): string {
  const metrics = readRecentMetrics(50).reverse(); // newest first
  const total = metrics.length;
  const successes = metrics.filter((m) => m.status === "success").length;
  const rate = total > 0 ? ((successes / total) * 100).toFixed(1) : "—";
  const lastUpdate = metrics.length > 0 ? metrics[0].timestamp : "—";

  const rows = metrics
    .map((m) => {
      const col = statusColor(m.status);
      const age = m.data_age_ms != null ? `${Math.round(m.data_age_ms / 1000)}s` : "—";
      const compile = m.compile_ms != null ? `${m.compile_ms}ms` : "—";
      const imb = m.imbalance != null ? m.imbalance.toFixed(4) : "—";
      const isolated = m.isolation_verified === true ? "✅" : m.isolation_verified === false ? "❌" : "—";
      return `<tr>
        <td style="color:${col};font-weight:600">${m.status}</td>
        <td>${m.cycle_id}</td>
        <td>${m.timestamp.replace("T", " ").replace("Z", "")}</td>
        <td>${m.staleness_tier ?? "—"}</td>
        <td>${age}</td>
        <td>${imb}</td>
        <td>${compile}</td>
        <td>${isolated}</td>
        <td style="color:#ef4444;font-size:11px">${m.error ?? ""}</td>
      </tr>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="30">
  <title>DS_INJECT Dashboard</title>
  <style>
    body { font-family: 'Courier New', monospace; background: #0f1117; color: #e2e8f0; margin: 0; padding: 20px; }
    h1 { color: #38bdf8; margin-bottom: 4px; }
    .subtitle { color: #64748b; font-size: 13px; margin-bottom: 24px; }
    .kpi { display: flex; gap: 24px; margin-bottom: 24px; }
    .kpi-box { background: #1e2330; border: 1px solid #2d3748; border-radius: 8px; padding: 16px 24px; min-width: 140px; }
    .kpi-label { font-size: 11px; color: #64748b; text-transform: uppercase; letter-spacing: 1px; }
    .kpi-value { font-size: 28px; font-weight: 700; color: #38bdf8; margin-top: 4px; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th { background: #1e2330; color: #64748b; padding: 8px 12px; text-align: left; border-bottom: 1px solid #2d3748; text-transform: uppercase; letter-spacing: 0.5px; }
    td { padding: 7px 12px; border-bottom: 1px solid #1a202c; }
    tr:hover td { background: #1a2035; }
  </style>
</head>
<body>
  <h1>DS_INJECT Orchestrator</h1>
  <div class="subtitle">Auto-refreshes every 30s | Last update: ${lastUpdate}</div>
  <div class="kpi">
    <div class="kpi-box"><div class="kpi-label">Success rate</div><div class="kpi-value">${rate}%</div></div>
    <div class="kpi-box"><div class="kpi-label">Total cycles</div><div class="kpi-value">${total}</div></div>
    <div class="kpi-box"><div class="kpi-label">Successes</div><div class="kpi-value" style="color:#22c55e">${successes}</div></div>
    <div class="kpi-box"><div class="kpi-label">Failures</div><div class="kpi-value" style="color:#ef4444">${total - successes}</div></div>
  </div>
  <table>
    <thead><tr>
      <th>Status</th><th>Cycle ID</th><th>Timestamp</th><th>Staleness</th>
      <th>Data age</th><th>Imbalance</th><th>Compile</th><th>Isolated</th><th>Error</th>
    </tr></thead>
    <tbody>${rows || '<tr><td colspan="9" style="color:#64748b;text-align:center;padding:40px">No cycles recorded yet</td></tr>'}</tbody>
  </table>
</body>
</html>`;
}

export function startDashboard(): void {
  const app = express();

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "ds-inject-dashboard", port: PORT });
  });

  app.get("/api/metrics", (_req, res) => {
    res.json(readAllMetrics());
  });

  app.get("/", (_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.send(renderDashboard());
  });

  app.listen(PORT, () => {
    console.log(`[dashboard] DS_INJECT dashboard → http://localhost:${PORT}`);
  });
}

// ── Standalone entry ─────────────────────────────────────────────────────────
if (process.argv[1]?.endsWith("ds-inject-dashboard.js") ||
    process.argv[1]?.endsWith("ds-inject/dashboard.js")) {
  startDashboard();
}
