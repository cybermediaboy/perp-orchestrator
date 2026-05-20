/**
 * DS_INJECT metrics logger — per-cycle JSONL append + reader
 * Output: ~/data/ds_inject_metrics.jsonl
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ─── Types ────────────────────────────────────────────────────────────────────

export type CycleStatus =
  | "success"
  | "error"
  | "aborted_maxdup"
  | "aborted_stale_data"
  | "isolation_failed"
  | "compile_error"
  | "dispatch_timeout"
  | "data_read_failed";

export interface CycleMetrics {
  cycle_id: string;
  cycle_num: number;
  timestamp: string;
  status: CycleStatus;
  data_age_ms?: number;
  staleness_tier?: string;
  compile_ms?: number;
  total_cycle_ms?: number;
  isolation_verified?: boolean;
  maxDup?: number;
  imbalance?: number;
  bid_total?: number;
  ask_total?: number;
  error?: string;
  dispatch_id?: string;
}

// ─── Config ───────────────────────────────────────────────────────────────────

const METRICS_PATH =
  process.env.DS_INJECT_METRICS_PATH ??
  path.join(os.homedir(), "data", "ds_inject_metrics.jsonl");

// ─── Writer ───────────────────────────────────────────────────────────────────

export function logCycleMetrics(metrics: CycleMetrics): void {
  const line = JSON.stringify(metrics) + "\n";
  try {
    fs.mkdirSync(path.dirname(METRICS_PATH), { recursive: true });
    fs.appendFileSync(METRICS_PATH, line, "utf-8");
  } catch (err) {
    console.error(`[metrics] write failed: ${err}`);
  }
}

// ─── Reader ───────────────────────────────────────────────────────────────────

export function readRecentMetrics(last = 10): CycleMetrics[] {
  try {
    if (!fs.existsSync(METRICS_PATH)) return [];
    const lines = fs
      .readFileSync(METRICS_PATH, "utf-8")
      .split("\n")
      .filter((l) => l.trim());
    const all = lines.map((l) => {
      try {
        return JSON.parse(l) as CycleMetrics;
      } catch {
        return null;
      }
    }).filter((m): m is CycleMetrics => m !== null);
    return all.slice(-last);
  } catch {
    return [];
  }
}

export function readAllMetrics(): CycleMetrics[] {
  return readRecentMetrics(100_000);
}

// ─── maxDup computation ───────────────────────────────────────────────────────

/**
 * Compute maxDup: max consecutive successful cycles without payload change.
 * A "dup" is when the same imbalance (same payload timestamp) is compiled twice.
 * Resets to 0 on any different payload.
 */
export function computeMaxDup(recentMetrics: CycleMetrics[]): number {
  const successful = recentMetrics.filter((m) => m.status === "success");
  if (successful.length < 2) return 0;

  let maxDup = 0;
  let currentDup = 0;
  let prevImbalance: number | undefined;

  for (const m of successful) {
    if (
      prevImbalance !== undefined &&
      m.imbalance !== undefined &&
      Math.abs(m.imbalance - prevImbalance) < 1e-6
    ) {
      currentDup++;
      maxDup = Math.max(maxDup, currentDup);
    } else {
      currentDup = 0;
    }
    prevImbalance = m.imbalance;
  }
  return maxDup;
}
